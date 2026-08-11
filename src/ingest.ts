// Ingest: a turn carrying something to remember becomes rows in items /
// actions / attachments, plus the sentence Sift texts back.
//
// Scope is the locked demo per the plan: one syllabus PDF and one screenshot.
// Generality is explicitly not the goal.
import sharp from "sharp";
import type { Attachment } from "spectrum-ts";

import {
  insertActions,
  insertItem,
  recordAttachment,
  uploadAttachmentBytes,
  type Student,
} from "./db.ts";
import { extractPlace, extractSyllabus, today } from "./llm.ts";

// What Claude vision accepts. iPhone photos arrive as image/heic, which it does
// not — the demo's screenshot is a PNG, so we say so plainly instead of failing.
const VISION_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const isPdf = (mimeType: string) => mimeType === "application/pdf";
const isImage = (mimeType: string) => mimeType.startsWith("image/");

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

/** Local time-zone offset, in ms, at a given instant. */
function offsetMs(instant: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Some engines render midnight as hour 24.
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - instant.getTime();
}

/**
 * 9am the day before it's due, in the student's timezone. The Phase 4 cron
 * fires on this; `npm run remind:now` overrides it for the recording so the
 * demo never waits on wall-clock time.
 */
export function remindAtFor(dueDate: string, timezone: string): string | null {
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;

  const wall = new Date(due.getTime() - 24 * 3600_000 + 9 * 3600_000);
  // Second pass so a DST boundary between the guess and the real instant
  // doesn't shift the reminder by an hour.
  const guess = new Date(wall.getTime() - offsetMs(wall, timezone));
  return new Date(wall.getTime() - offsetMs(guess, timezone)).toISOString();
}

/**
 * "Thu, Oct 14", or "Thu, Oct 14, 2021" with `year`. iMessage renders plain
 * text, so no markdown anywhere. The year is worth the extra words whenever the
 * date isn't in the current term — a bare "Mar 30" reads as upcoming, which is
 * exactly the confusion the stale-date question exists to resolve.
 */
function friendly(dueDate: string, timezone: string, options?: { year?: boolean }): string {
  const date = new Date(`${dueDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dueDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(options?.year ? { year: "numeric" as const } : {}),
  }).format(date);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

async function ingestSyllabus(
  student: Student,
  file: Attachment,
  caption: string,
): Promise<string> {
  const bytes = await timed(`read ${file.name}`, () => file.read());

  // The upload needs nothing from the extraction, and the student is waiting on
  // the extraction alone — so pay for them once, not back to back.
  const [extraction, storagePath] = await Promise.all([
    timed("extract syllabus", () =>
      extractSyllabus(bytes, {
        caption,
        today: today(student.timezone),
        timezone: student.timezone,
      }),
    ),
    timed("upload", () =>
      uploadAttachmentBytes({
      studentId: student.id,
      filename: file.name,
        mimeType: file.mimeType,
        bytes,
      }),
    ),
  ]);

  const itemId = await insertItem({
    studentId: student.id,
    type: "syllabus",
    title: extraction.title,
    summary: extraction.topics.join(", "),
    category: "course",
  });

  await recordAttachment({
    studentId: student.id,
    itemId,
    filename: file.name,
    mimeType: file.mimeType,
    storagePath,
  });

  // A date that has already gone by is never a live deadline. It usually means
  // one of two things — an old syllabus, or a bare date the model dated to the
  // wrong year — and those want opposite handling, so past events are parked as
  // reference with no remind_at rather than guessed at. Without this, Phase 4's
  // cron would fire a reminder for every stale deadline on its first tick.
  const now = today(student.timezone);
  const events = [...extraction.events].sort((a, b) => a.date.localeCompare(b.date));
  const past = events.filter((event) => event.date < now);
  const upcoming = events.filter((event) => event.date >= now);

  const describe = (event: (typeof events)[number]) => `${event.name} (${event.kind})`;

  await insertActions(
    student.id,
    itemId,
    past.map((event) => ({
      description: describe(event),
      dueDate: event.date,
      remindAt: null,
      status: "reference" as const,
    })),
  );

  await insertActions(
    student.id,
    itemId,
    upcoming.map((event) => ({
      description: describe(event),
      dueDate: event.date,
      remindAt: remindAtFor(event.date, student.timezone),
    })),
  );

  const pulled = `I pulled ${count(extraction.topics.length, "topic", "topics")} and ${count(
    events.length,
    "date",
    "dates",
  )}.`;

  // Everything is stale — ask rather than decide. The student is the only one
  // who knows whether this is last term's file or this term's with bad years.
  if (past.length > 0 && upcoming.length === 0) {
    const withYear = { year: true };
    const span =
      past.length === 1
        ? `on ${friendly(past[0]!.date, student.timezone, withYear)}`
        : `between ${friendly(past[0]!.date, student.timezone, withYear)} and ${friendly(
            past[past.length - 1]!.date,
            student.timezone,
            withYear,
          )}`;

    const question =
      `Got it — ${extraction.title}. ${pulled} They all land ${span}, which has already passed. ` +
      `Want me to keep this as reference only, or are those dates supposed to be current?`;

    return question;
  }

  // Lead with the soonest deadline — it's the thing the student actually cares
  // about, and it's the callback the weekly plan and the reminder both reuse.
  const next = upcoming[0];

  return [
    `Got it — ${extraction.title}.`,
    pulled,
    past.length > 0
      ? `${count(past.length, "of them has", "of them have")} already passed, so I've kept ${
          past.length === 1 ? "it" : "those"
        } as reference and I'm tracking the ${count(upcoming.length, "other", "others")}.`
      : "",
    next ? `Next up is ${next.name} on ${friendly(next.date, student.timezone)}.` : "",
    next ? "I'll nudge you before each one." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function ingestPlace(student: Student, file: Attachment, caption: string): Promise<string> {
  const bytes = await timed(`read ${file.name}`, () => file.read());
  const shrunk = await timed("downscale", () => forVision(bytes, file.mimeType));

  const [extraction, storagePath] = await Promise.all([
    timed("extract place", () =>
      extractPlace(shrunk.bytes, { mimeType: shrunk.mimeType, caption }),
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

  const itemId = await insertItem({
    studentId: student.id,
    type: "place",
    title: extraction.name,
    summary: extraction.caption,
    extractedText: extraction.location,
    category: extraction.category,
  });

  await recordAttachment({
    studentId: student.id,
    itemId,
    filename: file.name,
    mimeType: file.mimeType,
    storagePath,
  });

  const where = extraction.location ? `${extraction.name} (${extraction.location})` : extraction.name;
  return `Saved ${where} as a study spot. ${extraction.caption} I'll bring it up when you're deciding where to work.`;
}

/**
 * Route the turn's files. A captioned attachment is one ingest, and the caption
 * is context for the extraction rather than a turn of its own. Text-only turns
 * never reach here — those go to the tool-calling loop, which can save a note
 * itself when that is genuinely what the message is.
 */
export async function ingest(input: {
  student: Student;
  text: string;
  files: Attachment[];
}): Promise<string> {
  const { student, text, files } = input;
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
    if (isPdf(file.mimeType)) {
      replies.push(await ingestSyllabus(student, file, text));
    } else if (isImage(file.mimeType) && VISION_MIME.has(file.mimeType)) {
      replies.push(await ingestPlace(student, file, text));
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
