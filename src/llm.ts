// Every Claude call Sift makes: one conversational turn, and two extractions.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { env } from "./env.ts";
import { PlaceExtraction, SyllabusExtraction } from "./schemas.ts";

// Two models, split by what the call actually needs.
//
// FAST handles the conversational turn — reading the thread, calling a tool,
// writing a few sentences of prose. Haiku 4.5 rejects output_config.effort, so
// that call passes no effort at all.
//
// READER handles extraction from a PDF or screenshot, the one place accuracy
// shows in the demo. Sonnet 5 runs adaptive thinking by default; `effort`
// controls its depth, and max_tokens has to cover thinking AND the answer —
// hence the generous ceilings below.
const FAST = "claude-haiku-4-5";
const READER = "claude-sonnet-5";
const READER_EFFORT = "medium" as const;

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Structured outputs give back `parsed_output: null` when the model's response
 * doesn't validate. Treat that as an extraction failure — never write
 * unvalidated data — and name the refusal and truncation cases separately so
 * the logs say which one happened.
 */
function parsedOrThrow<T>(
  response: { parsed_output: T | null; stop_reason: string | null },
  label: string,
): T {
  if (response.stop_reason === "refusal") {
    throw new Error(`${label}: model declined the request`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`${label}: response hit max_tokens before completing`);
  }
  if (response.parsed_output === null) {
    throw new Error(`${label}: response failed schema validation`);
  }
  return response.parsed_output;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

function asImageType(mimeType: string): ImageType {
  const match = IMAGE_TYPES.find((type) => type === mimeType);
  if (!match) {
    // iPhones can send HEIC; the API takes none of it. Callers convert or skip.
    throw new Error(`unsupported image type: ${mimeType}`);
  }
  return match;
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
 * One text turn. The model sees the real conversation and picks an action.
 *
 * This replaced a 5-way intent classifier feeding hardcoded per-intent
 * handlers: a misread message got the wrong handler, and the only lever was
 * rewording the classifier, which traded failures rather than removing them.
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
    // Merging same-role turns reads more naturally to the model than
    // interleaving blanks, and keeps the alternation the API expects.
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
    const response = await anthropic().messages.create({
      model: FAST,
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

const SYLLABUS_SYSTEM = `You read a course syllabus and pull out what a student needs to remember.
Normalize every date to ISO yyyy-mm-dd. Syllabi often write dates bare ("Oct 14", "4/19"), so infer the year: use the term the document states if it states one, otherwise the year that puts the date in the term closest to today.
Report every dated item you find, including ones already past — do not drop an event because its date has gone by.
Include only dated, actionable items as events: assignments, labs, exams, projects, readings. Skip office hours, recurring lecture times, and textbook publication dates.`;

export async function extractSyllabus(
  pdf: Buffer,
  context: { caption?: string; today: string; timezone: string },
): Promise<SyllabusExtraction> {
  const response = await anthropic().messages.parse({
    model: READER,
    max_tokens: 8000, // thinking + extraction share this ceiling
    system: SYLLABUS_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          // The document block goes before the text block.
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdf.toString("base64"),
            },
          },
          {
            type: "text",
            text: [
              `Today is ${context.today} (${context.timezone}).`,
              context.caption && `The student said: "${context.caption}"`,
              "Extract the course title, its topics, and every dated item.",
            ]
              .filter(Boolean)
              .join(" "),
          },
        ],
      },
    ],
    output_config: { effort: READER_EFFORT, format: zodOutputFormat(SyllabusExtraction) },
  });

  return parsedOrThrow(response, "extractSyllabus");
}

const PLACE_SYSTEM = `You look at a screenshot of a place a student wants to remember — usually a café or somewhere to study.
Pull out its name, where it is if the image says, and a short caption in the student's own framing.
Use null for location when the image doesn't show one; don't guess.`;

export async function extractPlace(
  image: Buffer,
  context: { mimeType: string; caption?: string },
): Promise<PlaceExtraction> {
  const response = await anthropic().messages.parse({
    model: READER,
    max_tokens: 4000, // thinking + extraction share this ceiling
    system: PLACE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: asImageType(context.mimeType),
              data: image.toString("base64"),
            },
          },
          {
            type: "text",
            text: context.caption
              ? `The student said: "${context.caption}"`
              : "Describe this place.",
          },
        ],
      },
    ],
    output_config: { effort: READER_EFFORT, format: zodOutputFormat(PlaceExtraction) },
  });

  return parsedOrThrow(response, "extractPlace");
}
