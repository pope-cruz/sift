// Single source of truth for every LLM output shape. Each schema is handed to
// `zodOutputFormat()` so the model is constrained to it server-side, and the
// SDK re-validates the reply — `parsed_output` is null when that fails, which
// ingest treats as an extraction error rather than writing unvalidated data.
import { z } from "zod";

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
