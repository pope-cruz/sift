// Every Claude call Sift makes. Three shapes: classify a turn, extract from a
// file, and (Phase 3) answer with assembled context.
//
// Model is claude-haiku-4-5 per the plan — it covers everything Sift needs
// (structured outputs, vision, PDF input) and a full demo run costs cents.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { env } from "./env.ts";
import { PlaceExtraction, SyllabusExtraction } from "./schemas.ts";

const MODEL = "claude-haiku-4-5";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** Thrown when the model returns something the schema rejects. */
export class ExtractionError extends Error {
  constructor(what: string) {
    super(`Could not extract ${what} — parsed_output was null.`);
    this.name = "ExtractionError";
  }
}

/** Today in the student's timezone, ISO yyyy-mm-dd. Dates in a syllabus are
 *  usually bare ("Oct 14"), so the model needs the current date to resolve a
 *  year — and "next Thursday" needs it too. */
export function today(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const SIFT_SYSTEM = `You are Sift, a study assistant a student texts over iMessage. You
remember their coursework, deadlines, and places they want to study, and you remind them
when something is due.

Replying:
- Plain text only. iMessage renders no markdown, so never use headers, bullets, or asterisks.
- Two to five sentences. You are a text message, not a document.
- Everything the student has saved is listed under SAVED below, with its ids. That list is
  the truth about what you have — answer from it, not from what you remember saying. If it
  is empty, you have nothing saved, whatever the conversation implies.
- When they are just being friendly, be friendly back and stop there. Don't recap what you
  have, and don't push them to act on something they didn't ask about.
- Never tell the student something changed unless a tool call confirmed it. If a tool
  reports a failure, say what went wrong instead of claiming success.
- Don't end every message with a question. Ask when you genuinely need an answer.

Dates:
- A date that has already passed is never a live deadline. If a student sends a file whose
  dates have all passed, say so and ask whether it is an old file to keep for reference or
  a current one whose dates are wrong — do not guess.
- When they tell you the right year, use update_dates. That is an instruction, not a guess.
- Never invent a date the student did not give you.`;

/**
 * One text turn. The model sees the real conversation and picks an action,
 * instead of a classifier sorting the message into a fixed box first.
 */
export async function respond(input: {
  history: { direction: string; content: string }[];
  text: string;
  saved: string;
  timezone: string;
  tools: Anthropic.Tool[];
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<string> {
  const messages: Anthropic.MessageParam[] = [];

  for (const turn of input.history) {
    const role = turn.direction === "outbound" ? "assistant" : "user";
    // The API rejects two turns of the same role in a row on some paths, and
    // merging reads more naturally to the model than interleaving blanks.
    const last = messages[messages.length - 1];
    if (last?.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n${turn.content}`;
    } else {
      messages.push({ role, content: turn.content });
    }
  }

  if (messages[messages.length - 1]?.role !== "user") {
    messages.push({ role: "user", content: input.text });
  }

  // Bounded so a confused model can't spin. Four is comfortably more than the
  // deepest real path is one change then a reply.
  for (let iteration = 0; iteration < 4; iteration++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system:
        `${SIFT_SYSTEM}\n\nToday is ${today(input.timezone)} (${input.timezone}).` +
        `\n\nSAVED:\n${input.saved}`,
      tools: input.tools,
      messages,
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (text) return text;
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let content: string;
      try {
        content = await input.runTool(use.name, (use.input ?? {}) as Record<string, unknown>);
      } catch (error) {
        // Hand the failure back rather than throwing — the model can tell the
        // student something useful instead of the turn dying.
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content });
    }

    messages.push({ role: "user", content: results });
  }

  return "Hmm, I got tangled up on that one — mind saying it another way?";
}

export async function extractSyllabus(input: {
  pdf: Buffer;
  caption: string;
  timezone: string;
}): Promise<SyllabusExtraction> {
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system:
      "You read a course syllabus and pull out what a student needs to remember.\n" +
      `Today is ${today(input.timezone)} (${input.timezone}).\n` +
      "Every date must be normalised to ISO yyyy-mm-dd. Syllabi often write dates bare " +
      '("Oct 14", "4/19"), so infer the year: use the term the document states if it states ' +
      "one, otherwise the year that puts the date in the term closest to today.\n" +
      "Report every dated item you find, including ones already past — do not drop an event " +
      "because its date has gone by.\n" +
      "`events` is work with a deadline: assignments, labs, exams, projects, readings. It is " +
      "not recurring logistics — skip lecture times, office hours, and textbook publication " +
      "dates. Put the course's subject matter in `topics`.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: input.pdf.toString("base64"),
            },
          },
          {
            type: "text",
            text: input.caption
              ? `The student said: "${input.caption}"\n\nExtract the course and its dated work.`
              : "Extract the course and its dated work.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(SyllabusExtraction) },
  });

  if (!message.parsed_output) throw new ExtractionError("that syllabus");
  return message.parsed_output;
}

export async function extractPlace(input: {
  image: Buffer;
  mimeType: string;
  caption: string;
}): Promise<PlaceExtraction> {
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system:
      "You look at a screenshot a student saved — usually a café, library, or other place " +
      "they want to study at — and describe it so it can be recalled later.\n" +
      "`caption` is one sentence in the student's voice about why this place is worth remembering " +
      "(hours, wifi, atmosphere, whatever the screenshot shows). Use null for `location` when " +
      "the screenshot doesn't show one.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              // The Zod literal on `category` is what pins the shape; the mime
              // type comes straight from the provider's attachment metadata.
              media_type: input.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: input.image.toString("base64"),
            },
          },
          {
            type: "text",
            text: input.caption
              ? `The student said: "${input.caption}"\n\nDescribe this place.`
              : "Describe this place.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(PlaceExtraction) },
  });

  if (!message.parsed_output) throw new ExtractionError("that screenshot");
  return message.parsed_output;
}


