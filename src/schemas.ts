// Single source of truth for every LLM output shape. Each schema is handed to
// `zodOutputFormat()` so the model is constrained to it server-side, and the
// SDK re-validates the reply — `parsed_output` is null when that fails, which
// ingest treats as an extraction error rather than writing unvalidated data.
import { z } from "zod";

export const Intent = z.object({
  intent: z.enum(["ingest", "retrieve", "plan", "clarify", "chitchat"]),
});
export type Intent = z.infer<typeof Intent>["intent"];

export const SyllabusExtraction = z.object({
  title: z.string(), // e.g. "CS 4414: Operating Systems"
  topics: z.array(z.string()),
  events: z.array(
    z.object({
      name: z.string(),
      date: z.string(), // ISO yyyy-mm-dd; the prompt tells the model to normalize.
      kind: z.enum(["assignment", "exam", "project", "reading", "other"]),
    }),
  ),
});
export type SyllabusExtraction = z.infer<typeof SyllabusExtraction>;

export const PlaceExtraction = z.object({
  name: z.string(),
  location: z.string().nullable(),
  caption: z.string(),
  category: z.literal("study_spot"),
});
export type PlaceExtraction = z.infer<typeof PlaceExtraction>;

// A text-only turn the classifier called `ingest` — "remind me the group meets
// Thursday". Not part of the demo script, but the classifier can emit it, so it
// needs somewhere to land.
/**
 * The student's answer to "is this syllabus current, or reference?". `unrelated`
 * is the escape hatch — a pending question must never trap the conversation, so
 * anything that isn't an answer falls through to the normal router.
 */
export const PendingAnswer = z.object({
  answer: z.enum(["reference", "current", "unrelated"]),
});
export type PendingAnswer = z.infer<typeof PendingAnswer>["answer"];

export const NoteExtraction = z.object({
  title: z.string(),
  summary: z.string(),
  actions: z.array(
    z.object({
      description: z.string(),
      // ISO yyyy-mm-dd, or null when the note carries no date.
      due_date: z.string().nullable(),
    }),
  ),
});
export type NoteExtraction = z.infer<typeof NoteExtraction>;
