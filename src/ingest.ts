// Ingest: a turn carrying something to remember becomes rows in items /
// actions / attachments, plus the sentence sort texts back.
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

import { aggregate, type AdmissionContext } from "./analysis.ts";
import { mapWithLimit } from "./concurrency.ts";
import { friendly, today } from "./dates.ts";
import { InputDiagnosticError, safeDiagnostic } from "./diagnostics.ts";
import {
  deleteAttachmentBytes,
  deleteItemCascade,
  saveIngestItemAtomic,
  uploadAttachmentBytes,
  type Student,
} from "./db.ts";
import { analyzeArtifact } from "./llm.ts";
import {
  classifyInputMime,
  shouldPersistArtifact,
  uniqueAttachments,
  validateReadableBytes,
} from "./input.ts";
import { rollbackArtifact, settleArtifactPreparation } from "./rollback.ts";
import type { TurnAttachment } from "./turn-core.ts";

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
 *
 * Every stage names its file. Attachments are read concurrently now, so a
 * multi-file turn interleaves these lines — and a bare "analyze 8123ms" among
 * three of them says nothing about which file was slow. LIVE_VALIDATION.md
 * reads stage latency straight off this output.
 */
async function timed<T>(stage: string, filename: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[ingest] ${stage} ${filename} ${Date.now() - started}ms`);
  }
}

/**
 * One attachment, end to end. Every artifact takes this path — there is no
 * syllabus branch and no place branch, because which of those it is was the
 * question, not the premise.
 */
async function ingestArtifact(
  student: Student,
  file: TurnAttachment,
  caption: string,
  captionScope: AdmissionContext["captionScope"],
  sourceMessageId: string,
  sourceTurnId: string,
  persist: boolean,
): Promise<string> {
  // `size` is optional on the provider's attachment, so it's a cheap early
  // out, not the check itself — the real one is on the bytes we actually got.
  if (file.size !== undefined && file.size > MAX_BYTES) return tooBig(file.name);

  const bytes = await timed("read", file.name, () => file.read());

  await timed("validate", file.name, () => validateReadableBytes(bytes, file.mimeType, file.name));

  // An image gets downscaled below, so only an oversized PDF is fatal here.
  if (isPdf(file.mimeType) && bytes.length > MAX_BYTES) return tooBig(file.name);

  // Vision needs the shrunken copy; a PDF goes as it came.
  const forModel = isPdf(file.mimeType)
    ? { bytes, mimeType: file.mimeType }
    : await timed("downscale", file.name, () => forVision(bytes, file.mimeType));

  // The upload needs nothing from the analysis, and the student is waiting on
  // the analysis alone — so pay for them once, not back to back.
  const analysisWork = timed("analyze", file.name, () =>
    analyzeArtifact({
        bytes: forModel.bytes,
        mimeType: forModel.mimeType,
        filename: file.name,
        caption,
        timezone: student.timezone,
      }));
  const prepared = persist
    ? await settleArtifactPreparation({
        analysis: analysisWork,
        // The full-resolution original goes to storage, not the shrunken copy.
        upload: timed("upload", file.name, () => uploadAttachmentBytes({
        studentId: student.id,
        filename: file.name,
        mimeType: file.mimeType,
        bytes,
        })),
        deleteUpload: deleteAttachmentBytes,
      })
    : { analysis: await analysisWork, storagePath: null };
  const { analysis: analyses, storagePath } = prepared;

  // Everything below is deterministic. The model has had its say; from here the
  // rules decide, and the reply is built from what was actually written.
  const context: AdmissionContext = {
    today: today(student.timezone),
    timezone: student.timezone,
    filename: file.name,
    caption,
    captionScope,
  };

  const results = analyses.map((analysis) => aggregate(analysis, context));

  if (!persist) {
    return results.map((result) => {
      const dates = result.actions
        .filter((action) => action.dueDate)
        .slice(0, 4)
        .map((action) => `${action.description} (${friendly(action.dueDate!, student.timezone)})`);
      return [result.item.summary, dates.length ? `Dates: ${dates.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" ");
    }).join(" ");
  }
  if (!storagePath) throw new Error("Attachment storage did not complete.");

  for (const result of results) {
    for (const decision of result.decisions) {
      console.log(
        `[ingest] date ${file.name} (${decision.candidate.role}, ${decision.candidate.source}) -> ` +
          `${decision.outcome}: ${decision.reason}`,
      );
    }
  }

  // One attachment can yield several isolated items. Each write is atomic on its
  // own, so they go out together rather than one round trip after another.
  //
  // `allSettled` rather than `all`: if any write fails we roll every item from
  // this attachment back, and that needs the ids of the writes that *succeeded*.
  // `all` rejects while its siblings are still in flight, which would leave a
  // just-created row invisible to the rollback and a resend duplicating a subset.
  const written = await Promise.allSettled(
    results.map((result, index) =>
      saveIngestItemAtomic({
        studentId: student.id,
        sourceMessageId: `${sourceMessageId}:${index}`,
        sourceTurnId,
        type: result.item.type,
        title: result.item.title,
        summary: result.item.summary,
        extractedText: result.item.extractedText,
        category: result.item.category,
        filename: file.name,
        mimeType: file.mimeType,
        storagePath,
        actions: result.actions,
      })),
  );

  const itemIds = written.flatMap((outcome) =>
    outcome.status === "fulfilled" && !outcome.value.duplicate ? [outcome.value.itemId] : [],
  );
  const createdAny = itemIds.length > 0;

  const failed = written.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failed) {
    const cleanupFailures = await rollbackArtifact({
      itemIds,
      storagePath,
      deleteItem: (itemId) => deleteItemCascade(student.id, itemId),
      deleteUpload: deleteAttachmentBytes,
    });
    for (const failure of cleanupFailures) {
      console.error("[ingest] cleanup failed", {
        target: failure.target,
        error: safeDiagnostic(failure.error),
      });
    }
    throw failed.reason;
  }

  // Every item was a duplicate resend, so nothing references these bytes and the
  // orphaned upload goes. Logged the way the rollback path logs it rather than
  // surfacing as a bare storage error, which is what the old try/catch did.
  if (!createdAny) {
    try {
      await deleteAttachmentBytes(storagePath);
    } catch (error) {
      console.error("[ingest] cleanup failed", {
        target: `storage:${storagePath}`,
        error: safeDiagnostic(error),
      });
      throw error;
    }
  }

  return results.map((result) => result.confirmation).join(" ");
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
  files: TurnAttachment[];
  sourceMessageId?: string;
}): Promise<string> {
  const started = Date.now();
  try {
    return await route(input);
  } finally {
    console.log(`[ingest] TOTAL ${Date.now() - started}ms`);
  }
}

/**
 * How many attachments are read and analyzed at once.
 *
 * Files used to go one at a time, so a three-screenshot turn paid three
 * provider downloads and three vision calls back to back — and the download is
 * the dominant cost (see `timed`). The work is independent per file, so the
 * only reason to bound it at all is resources: each slot can hold a 20MB buffer
 * plus its base64 copy, and the reader calls share one API rate limit. Three is
 * the point where a normal multi-file turn is fully parallel and a pathological
 * one still can't exhaust memory.
 */
const MAX_CONCURRENT_ARTIFACTS = 3;

async function route(input: {
  student: Student;
  text: string;
  files: TurnAttachment[];
  sourceMessageId?: string;
}): Promise<string> {
  const { student, text } = input;
  const files = uniqueAttachments(input.files);

  const persist = shouldPersistArtifact(text);

  // Per-file failures are caught inside the mapper, never thrown out of it: one
  // unreadable screenshot in a three-file turn should cost that file's sentence,
  // not the other two files' work.
  const replies = await mapWithLimit(files, MAX_CONCURRENT_ARTIFACTS, async (file, fileIndex) => {
    // The only decision MIME type gets to make: can the model read these bytes,
    // and as which block type. What the content *means* is decided downstream.
    const kind = classifyInputMime(file.mimeType);
    if (kind === "unsupported_image") {
      return `I can't read ${file.name} — it came through as ${file.mimeType}. A screenshot works better than a photo.`;
    }
    if (kind !== "pdf" && kind !== "image") {
      return `I can't read ${file.name} yet — send me a PDF or a screenshot.`;
    }

    try {
      return await ingestArtifact(
        student,
        file,
        text,
        files.length === 1 ? "single_artifact" : "multi_artifact_turn",
        `${input.sourceMessageId ?? "attachment"}:${file.id}:${fileIndex}`,
        input.sourceMessageId ?? "attachment",
        persist,
      );
    } catch (error) {
      const diagnostic = safeDiagnostic(error);
      console.error("[ingest] artifact failed", { code: diagnostic.code, error: diagnostic });
      if (error instanceof InputDiagnosticError) return error.userMessage;
      return `I couldn't finish reading ${file.name}. Try sending it again.`;
    }
  });

  return replies.join(" ");
}
