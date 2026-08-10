import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { env } from "./env.ts";
import { Intent, PlaceExtraction, SyllabusExtraction } from "./schemas.ts";

// Two models, split by what the call actually needs.
//
// FAST handles the cheap, high-frequency turns — a 5-way label and a few
// sentences of prose. Haiku 4.5 rejects output_config.effort, so those calls
// pass no effort at all.
//
// READER handles extraction from a PDF or screenshot, the one place accuracy
// shows in the demo. Sonnet 5 runs adaptive thinking by default; `effort`
// controls its depth, and max_tokens has to cover thinking AND the answer —
// hence the generous ceilings below.
const FAST = "claude-haiku-4-5";
const READER = "claude-sonnet-5";
const READER_EFFORT = "medium" as const;

// Built on first use so the worker still boots without a key (Phase 1 has no
// LLM calls); a missing key then fails one turn instead of the whole process.
let client: Anthropic | undefined;

function anthropic(): Anthropic {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set — add it to .env (see .env.example).");
    }
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
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

const CLASSIFY_SYSTEM = `You route incoming messages for Sift, a texting assistant for a student.
Pick the single best intent:
- ingest: they are handing you something to remember (a file, a screenshot, a fact about their schedule).
- retrieve: they are asking about something they already gave you.
- plan: they want help organizing time or deciding what to work on.
- clarify: the message is too vague to act on.
- chitchat: social or conversational, with nothing to store or look up.`;

export async function classify(input: {
  text: string;
  attachments: { name: string; mimeType: string }[];
}): Promise<Intent> {
  const files = input.attachments.map((file) => `${file.name} (${file.mimeType})`).join(", ");
  const described = [input.text, files && `Attached: ${files}`].filter(Boolean).join("\n");

  const response = await anthropic().messages.parse({
    model: FAST,
    max_tokens: 200,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: described || "(empty message)" }],
    output_config: { format: zodOutputFormat(Intent) },
  });

  return parsedOrThrow(response, "classify");
}

const SYLLABUS_SYSTEM = `You read a course syllabus and pull out what a student needs to remember.
Normalize every date to ISO yyyy-mm-dd. Syllabi often omit the year — infer it from today's date and the academic calendar the syllabus implies.
Include only dated, actionable items as events. Skip office hours and recurring lecture times.`;

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

const ANSWER_SYSTEM = `You are Sift, answering a student over iMessage.
Write 2-5 sentences of plain text. No markdown, no headers, no bullet lists — iMessage renders none of it.
Answer only from the context provided. If it isn't there, say you don't have it yet.`;

/** Phase 3 uses this for both retrieve and plan turns. */
export async function answer(input: { context: string; question: string }): Promise<string> {
  const response = await anthropic().messages.create({
    model: FAST,
    max_tokens: 1000,
    system: ANSWER_SYSTEM,
    messages: [
      { role: "user", content: `What I know about this student:\n${input.context}\n\nThey asked: ${input.question}` },
    ],
  });

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
