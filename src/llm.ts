// Every Claude call Sift makes. Three shapes: classify a turn, extract from a
// file, and (Phase 3) answer with assembled context.
//
// Model is claude-haiku-4-5 per the plan — it covers everything Sift needs
// (structured outputs, vision, PDF input) and a full demo run costs cents.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { env } from "./env.ts";
import {
  Intent,
  NoteExtraction,
  PendingAnswer,
  PlaceExtraction,
  SyllabusExtraction,
} from "./schemas.ts";

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

export async function classify(input: {
  text: string;
  files: { name: string; mimeType: string }[];
}): Promise<Intent> {
  const fileList = input.files.map((file) => `${file.name} (${file.mimeType})`).join(", ");

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 200,
    system:
      "You classify a single message a student sent to Sift, a study assistant.\n" +
      "- ingest: they are giving you something to remember (a file, a link, a fact, a deadline).\n" +
      "- retrieve: they are asking about something they already sent you.\n" +
      "- plan: they want help organising their time or deciding what to work on.\n" +
      "- clarify: the message is too vague to act on and needs a follow-up question.\n" +
      "- chitchat: anything else — greetings, thanks, small talk.",
    messages: [
      {
        role: "user",
        content:
          [input.text, fileList && `Attached files: ${fileList}`].filter(Boolean).join("\n") ||
          "(empty message)",
      },
    ],
    output_config: { format: zodOutputFormat(Intent) },
  });

  // A classifier failure shouldn't kill the turn — chitchat is the harmless
  // default (the audit's "none of the above" case).
  return message.parsed_output?.intent ?? "chitchat";
}

/**
 * Read the student's reply to Sift's own question about a stale syllabus.
 * Separate from `classify` because the space of sensible answers is different:
 * here a bare "yeah" is meaningful, and it means the thing Sift just asked.
 */
export async function classifyPendingAnswer(input: {
  question: string;
  text: string;
}): Promise<PendingAnswer> {
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 200,
    system:
      "Sift asked the student a question and this is their reply. Decide which way they answered.\n" +
      "- reference: keep the material but don't track the dates as live deadlines " +
      "(the syllabus is old, from a past term, just for reference).\n" +
      "- current: the dates are real and Sift should track them and send reminders.\n" +
      "- unrelated: they ignored the question and said something else entirely.\n" +
      "A bare yes/no answers whichever option Sift's question put first.",
    messages: [
      {
        role: "user",
        content: `Sift asked: "${input.question}"\n\nThe student replied: "${input.text}"`,
      },
    ],
    output_config: { format: zodOutputFormat(PendingAnswer) },
  });

  // Falling back to `unrelated` keeps the student out of a dead end when the
  // classifier fails — the turn just routes normally instead.
  return message.parsed_output?.answer ?? "unrelated";
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

export async function extractNote(input: {
  text: string;
  timezone: string;
}): Promise<NoteExtraction> {
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system:
      "A student is telling Sift something to remember. Capture it.\n" +
      `Today is ${today(input.timezone)} (${input.timezone}).\n` +
      "`title` is a short label. `summary` restates the note in one or two sentences. " +
      "Add an entry to `actions` only for something the student actually has to do; resolve " +
      "relative dates like \"Thursday\" against today and write them as ISO yyyy-mm-dd, " +
      "or use null when the note carries no date.",
    messages: [{ role: "user", content: input.text }],
    output_config: { format: zodOutputFormat(NoteExtraction) },
  });

  if (!message.parsed_output) throw new ExtractionError("that note");
  return message.parsed_output;
}
