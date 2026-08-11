// Single source of truth for every LLM output shape. Nothing gets written to
// the database that hasn't come through one of these.
//
// One schema covers every attachment. MIME type decides how bytes reach the
// model (document block vs image block) and nothing else — what the artifact
// *means* is the model's job, reported along independent axes so that a "PDF"
// is no longer a synonym for "syllabus with deadlines".
import { z } from "zod";

/**
 * What the artifact IS. Deliberately not a proxy for "does this produce
 * deadlines" — a syllabus might produce none and a caption alone might produce
 * one.
 */
export const ArtifactPurpose = z.enum([
  "syllabus",
  "assignment_instructions",
  "exam_information",
  "practice_material",
  "reference_material",
  "event_flyer",
  "place",
  "article",
  "receipt",
  "personal_note",
  "other",
]);
export type ArtifactPurpose = z.infer<typeof ArtifactPurpose>;

/** What the student appears to want done with it. The caption dominates here. */
export const UserIntent = z.enum([
  "save_for_later",
  "extract_deadlines",
  "remember_fact",
  "remember_place",
  "plan_around",
  "create_reminder",
  "ambiguous",
]);
export type UserIntent = z.infer<typeof UserIntent>;

/**
 * Why a date appears. This is the axis that stops "Sample Midterm 2018" from
 * becoming an exam: the 2018 is a `title_or_filename_year`, not a
 * `scheduled_event`.
 */
export const DateRole = z.enum([
  "deadline",
  "scheduled_event",
  "reminder_request",
  "publication_date",
  "historical_date",
  "academic_term",
  "title_or_filename_year",
  "recurring_schedule",
  "identifier",
  "course_number",
  "price",
  "page_reference",
  "incidental_number",
  "ambiguous",
]);
export type DateRole = z.infer<typeof DateRole>;

/** Where the evidence came from, in descending trust order. */
export const EvidenceSource = z.enum([
  "user_caption",
  "user_message",
  "document_body",
  "image_text",
  "visible_page",
  "embedded_content",
  "filename",
  "attachment_name",
  "url_slug",
  "transport_metadata",
]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Scalar metadata is observed as candidates, never accepted as a naked value. */
export const MetadataField = z.enum([
  "title",
  "author",
  "category",
  "publication_date",
  "source",
]);
export type MetadataField = z.infer<typeof MetadataField>;

export const MetadataCandidate = z.object({
  field: MetadataField,
  value: z.string().min(1),
  source: EvidenceSource,
  evidence_excerpt: z.string(),
  explicit: z.boolean().describe("whether the source directly asserts this field/value pair"),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type MetadataCandidate = z.infer<typeof MetadataCandidate>;

export const DateCandidate = z.object({
  label: z
    .string()
    .describe(
      "short noun phrase for what happens on this date, as the student would say it: " +
        "'Problem Set 1 due', 'Midterm 2', 'housing form'. No date in the label, no " +
        "trailing punctuation.",
    ),
  original_text: z
    .string()
    .describe("the date exactly as it appears, e.g. '2018', 'Sept 18', 'due Friday'"),
  normalized_date: z
    .string()
    .nullable()
    .describe(
      "ISO yyyy-mm-dd, or null when the year or day genuinely cannot be resolved. " +
        "Null is the correct answer for an ambiguous date — never guess to fill this in.",
    ),
  normalized_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .describe(
      "24-hour HH:mm only when the source states an exact due/event time; otherwise null. " +
        "Never infer a typical time.",
    ),
  role: DateRole,
  source: EvidenceSource,
  evidence_excerpt: z
    .string()
    .describe(
      "a short verbatim quote from the caption, body, image text, or filename that " +
        "contains this date. Quote only text that is actually present — never invent one.",
    ),
  explicit: z
    .boolean()
    .describe(
      "true only when the artifact or caption states in words that something happens or " +
        "is owed on this date ('due', 'submit by', 'exam on', 'remind me'). A date sitting " +
        "in a title, header, or filename is not explicit.",
    ),
  confidence: z.number().min(0).max(1).describe("0 to 1, how sure you are of role and normalization"),
  recommended_actionable: z
    .boolean()
    .describe("your recommendation only; code decides independently"),
  reason: z.string().describe("one short sentence on why this role and this recommendation"),
});
export type DateCandidate = z.infer<typeof DateCandidate>;

/** Only populated when the artifact is somewhere the student could go. */
export const PlaceDetail = z.object({
  name: z.string(),
  location: z.string().nullable(),
  caption: z.string(),
});
export type PlaceDetail = z.infer<typeof PlaceDetail>;

export const ArtifactAnalysis = z.object({
  item_key: z
    .string()
    .min(1)
    .describe("stable local key for this distinct item inside the attachment, e.g. item-1"),
  summary: z.string().describe("one or two sentences on what this artifact is"),
  purpose: ArtifactPurpose,
  secondary_tags: z
    .array(ArtifactPurpose)
    .describe("other purposes that also apply, if any; empty is fine"),
  user_intent: UserIntent,
  topics: z.array(z.string()).describe("subjects covered, for a syllabus or article"),
  place: PlaceDetail.nullable().describe("null unless this is somewhere the student could go"),
  metadata_candidates: z
    .array(MetadataCandidate)
    .describe(
      "all plausible title, author, category, publication-date, and source candidates; " +
        "preserve conflicts instead of choosing here",
    ),
  date_candidates: z
    .array(DateCandidate)
    .describe(
      "every date mentioned anywhere, including ones in the title or filename. " +
        "Report them all with an honest role — do not filter, and do not omit a date " +
        "because it looks unimportant.",
    ),
});
export type ArtifactAnalysis = z.infer<typeof ArtifactAnalysis>;

/** A single attachment can contain several clearly distinct saved items. */
export const ArtifactAnalysisBatch = z.object({
  items: z.array(ArtifactAnalysis).min(1).max(20),
});
export type ArtifactAnalysisBatch = z.infer<typeof ArtifactAnalysisBatch>;
