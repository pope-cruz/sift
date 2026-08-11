// Single source of truth for every LLM output shape. Nothing gets written to
// the database that hasn't come through one of these.
import { z } from "zod";

export const SyllabusExtraction = z.object({
  title: z.string(), // e.g. "CS 4414: Operating Systems"
  topics: z.array(z.string()),
  events: z.array(
    z.object({
      name: z.string(),
      date: z.string(), // ISO yyyy-mm-dd; the prompt passes today's date so the model can resolve the year
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
