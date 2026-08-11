// Ingest: a turn carrying something to remember becomes rows in items /
// actions / attachments, plus the sentence Sift texts back.
//
// The pipeline is evidence-first, in four stages:
//
//   observe   read the bytes, the caption, the filename, today's date
//   classify  one reader call describes the artifact along independent axes
//   rule      analysis.ts decides which date candidates may become actions
//   persist   write the item always, actions only where evidence justified them
//
// The thing this replaced routed on MIME type: every PDF was a syllabus, every
// image was a place, and every extracted date became a row in `actions`. That
// made "Sample Midterm 2018.pdf" an upcoming 2018 exam, because nothing in the
// path could distinguish a year in a title from a date something happens on.
// MIME type now decides one thing only — document block or image block.
import sharp from "sharp";
import type { Attachment } from "spectrum-ts";

import { aggregate, type AdmissionContext } from "./analysis.ts";
import { today } from "./dates.ts";
import {
  deleteItemCascade,
  insertActions,
  insertItem,
  recordAttachment,
  uploadAttachmentBytes,
  type Student,
} from "./db.ts";
import { analyzeArtifact } from "./llm.ts";

// What Claude vision accepts. iPhone photos arrive as image/heic, which it does
// not — a screenshot is a PNG, so we say so plainly instead of failing.
const VISION_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const isPdf = (mimeType: string) => mimeType === "application/pdf";
const isImage = (mimeType: string) => mimeType.startsWith("image/");

/**
 * The Anthropic request ceiling is 32MB, and base64 inflates bytes by 4/3 — so
 * the raw file has to clear roughly 24MB before the prompt is even added. 20MB
 * leaves room for that and fails with a sentence the student can act on,
 * rather than reading the whole file into memory to earn a 413.
 *
 * A PDF also has to stay under 600 pages on a 1M-context model. We don't count
 * pages here (no PDF parser in the dependency set) — a syllabus that long is
 * not a case worth carrying code for, and the API's own error is the backstop.
 */
const MAX_BYTES = 20 * 1024 * 1024;

const tooBig = (name: string) =>
  `${name} is too big for me to read — anything under 20MB works. ` +
  `If it's a long PDF, the pages with the dates on them are enough.`;

/**
 * Claude downsamples anything larger than 1568px on the long edge anyway, so a
 * full-resolution phone screenshot spends seconds uploading pixels the model
 * discards. Shrinking first cut the vision call from ~4.5s to ~2.6s on a
 * 1290x2796 screenshot, at ~30ms of CPU. The original bytes still go to
 * storage — this smaller copy exists only for the API call.
 */
async function forVision(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const resized = await sharp(bytes)
      .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { bytes: resized, mimeType: "image/jpeg" };
  } catch {
    // An image sharp can't decode may still be one Claude accepts. Send it as
    // it came rather than failing the whole ingest over an optimisation.
    return { bytes, mimeType };
  }
}

/**
 * Time each stage of an ingest to the log. The pipeline measures ~3s locally
 * while a real turn has been reported at ~45s, and the gap is upstream of any
 * code here — pulling the bytes from the provider. Guessing which stage is slow
 * is how you optimise the wrong one, so every stage reports.
 */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[ingest] ${label} ${Date.now() - started}ms`);
  }
}

/**
 * One attachment, end to end. Every artifact takes this path — there is no
 * syllabus branch and no place branch, because which of those it is was the
 * question, not the premise.
 */
async function ingestArtifact(
  student: Student,
  file: Attachment,
  caption: string,
): Promise<string> {
  // `size` is optional on the provider's attachment, so it's a cheap early
  // out, not the check itself — the real one is on the bytes we actually got.
  if (file.size !== undefined && file.size > MAX_BYTES) return tooBig(file.name);

  const bytes = await timed(`read ${file.name}`, () => file.read());

  // An image gets downscaled below, so only an oversized PDF is fatal here.
  if (isPdf(file.mimeType) && bytes.length > MAX_BYTES) return tooBig(file.name);

  // Vision needs the shrunken copy; a PDF goes as it came.
  const forModel = isPdf(file.mimeType)
    ? { bytes, mimeType: file.mimeType }
    : await timed("downscale", () => forVision(bytes, file.mimeType));

  // The upload needs nothing from the analysis, and the student is waiting on
  // the analysis alone — so pay for them once, not back to back.
  const [analysis, storagePath] = await Promise.all([
    timed("analyze", () =>
      analyzeArtifact({
        bytes: forModel.bytes,
        mimeType: forModel.mimeType,
        filename: file.name,
        caption,
        timezone: student.timezone,
      }),
    ),
    // The full-resolution original goes to storage, not the shrunken copy.
    timed("upload", () =>
      uploadAttachmentBytes({
        studentId: student.id,
        filename: file.name,
        mimeType: file.mimeType,
        bytes,
      }),
    ),
  ]);

  // Everything below is deterministic. The model has had its say; from here the
  // rules decide, and the reply is built from what was actually written.
  const context: AdmissionContext = {
    today: today(student.timezone),
    timezone: student.timezone,
    filename: file.name,
    caption,
  };

  const result = aggregate(analysis, context);

  for (const decision of result.decisions) {
    console.log(
      `[ingest] date "${decision.candidate.original_text}" ` +
        `(${decision.candidate.role}, ${decision.candidate.source}) -> ` +
        `${decision.outcome}: ${decision.reason}`,
    );
  }

  // The item is written whether or not anything became actionable — an artifact
  // that produces zero actions is still an artifact the student wanted kept.
  const itemId = await insertItem({
    studentId: student.id,
    type: result.item.type,
    title: result.item.title,
    summary: result.item.summary,
    extractedText: result.item.extractedText,
    category: result.item.category,
  });

  // No transactions in Supabase JS, so a failure after insertItem would leave
  // an item whose dates never made it into `actions` — SAVED would then show a
  // syllabus Sift silently isn't tracking. Compensate: remove the item so the
  // student's resend starts clean, and let the turn's catch send TROUBLE.
  try {
    await recordAttachment({
      studentId: student.id,
      itemId,
      filename: file.name,
      mimeType: file.mimeType,
      storagePath,
    });

    await insertActions(student.id, itemId, result.actions);
  } catch (error) {
    await deleteItemCascade(student.id, itemId).catch((cleanupError) => {
      console.error("[ingest] cleanup after failed write also failed", { itemId, cleanupError });
    });
    throw error;
  }

  return result.confirmation;
}

/**
 * Route the turn's files. A captioned attachment is one ingest, and the caption
 * is context for the analysis rather than a turn of its own. Text-only turns
 * never reach here — those go to the tool-calling loop, which can save a note
 * itself when that is genuinely what the message is.
 */
export async function ingest(input: {
  student: Student;
  text: string;
  files: Attachment[];
}): Promise<string> {
  const started = Date.now();
  try {
    return await route(input);
  } finally {
    console.log(`[ingest] TOTAL ${Date.now() - started}ms`);
  }
}

async function route(input: {
  student: Student;
  text: string;
  files: Attachment[];
}): Promise<string> {
  const { student, text, files } = input;

  const replies: string[] = [];

  for (const file of files) {
    // The only decision MIME type gets to make: can the model read these bytes,
    // and as which block type. What the content *means* is decided downstream.
    if (isPdf(file.mimeType) || (isImage(file.mimeType) && VISION_MIME.has(file.mimeType))) {
      replies.push(await ingestArtifact(student, file, text));
    } else if (isImage(file.mimeType)) {
      replies.push(
        `I can't read ${file.name} — it came through as ${file.mimeType}. A screenshot works better than a photo.`,
      );
    } else {
      replies.push(`I can't read ${file.name} yet — send me a PDF or a screenshot.`);
    }
  }

  return replies.join(" ");
}
