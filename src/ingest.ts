// Ingest: a turn carrying something to remember becomes rows in items /
// actions / attachments, plus the sentence Sift texts back.
//
// Scope is the locked demo per the plan: one syllabus PDF and one screenshot.
// Generality is explicitly not the goal.
import type { Attachment } from "spectrum-ts";

import {
  insertActions,
  insertItem,
  saveAttachment,
  setPending,
  type Pending,
  type Student,
} from "./db.ts";
import {
  classifyPendingAnswer,
  extractNote,
  extractPlace,
  extractSyllabus,
  today,
} from "./llm.ts";

// What Claude vision accepts. iPhone photos arrive as image/heic, which it does
// not — the demo's screenshot is a PNG, so we say so plainly instead of failing.
const VISION_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const isPdf = (mimeType: string) => mimeType === "application/pdf";
const isImage = (mimeType: string) => mimeType.startsWith("image/");

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

async function ingestSyllabus(
  student: Student,
  file: Attachment,
  caption: string,
): Promise<string> {
  const bytes = await file.read();
  const extraction = await extractSyllabus({
    pdf: bytes,
    caption,
    timezone: student.timezone,
  });

  const itemId = await insertItem({
    studentId: student.id,
    type: "syllabus",
    title: extraction.title,
    summary: extraction.topics.join(", "),
    category: "course",
  });

  await saveAttachment({
    studentId: student.id,
    itemId,
    filename: file.name,
    mimeType: file.mimeType,
    bytes,
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

    await setPending(student.id, { kind: "stale_syllabus", question, itemId });

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
  const bytes = await file.read();
  const extraction = await extractPlace({
    image: bytes,
    mimeType: file.mimeType,
    caption,
  });

  const itemId = await insertItem({
    studentId: student.id,
    type: "place",
    title: extraction.name,
    summary: extraction.caption,
    extractedText: extraction.location,
    category: extraction.category,
  });

  await saveAttachment({
    studentId: student.id,
    itemId,
    filename: file.name,
    mimeType: file.mimeType,
    bytes,
  });

  const where = extraction.location ? `${extraction.name} (${extraction.location})` : extraction.name;
  return `Saved ${where} as a study spot. ${extraction.caption} I'll bring it up when you're deciding where to work.`;
}

async function ingestNote(student: Student, text: string): Promise<string> {
  const extraction = await extractNote({ text, timezone: student.timezone });

  const itemId = await insertItem({
    studentId: student.id,
    type: "note",
    title: extraction.title,
    summary: extraction.summary,
    extractedText: text,
    category: "note",
  });

  // Same rule as a syllabus: a date that has gone by is remembered, not
  // reminded on. A one-line note isn't worth a follow-up question, though.
  const now = today(student.timezone);
  const written = await insertActions(
    student.id,
    itemId,
    extraction.actions.map((action) => {
      const stale = action.due_date !== null && action.due_date < now;
      return {
        description: action.description,
        dueDate: action.due_date,
        remindAt:
          action.due_date && !stale ? remindAtFor(action.due_date, student.timezone) : null,
        status: stale ? ("reference" as const) : ("open" as const),
      };
    }),
  );

  if (written.length === 0) return `Noted — ${extraction.summary}`;

  const soonest = extraction.actions
    .map((action) => action.due_date)
    .filter((date): date is string => date !== null && date >= now)
    .sort()[0];

  return soonest
    ? `Noted — ${extraction.summary} I've got ${friendly(soonest, student.timezone)} down and I'll remind you.`
    : `Noted — ${extraction.summary} I'll keep track of it.`;
}

/**
 * Answer to a question Sift asked last turn. Returns the reply, or null when
 * the student ignored the question — the caller then routes the turn normally,
 * so a pending question can never trap the conversation.
 */
export async function resolvePending(input: {
  student: Student;
  pending: Pending;
  text: string;
}): Promise<string | null> {
  const { student, pending, text } = input;

  const answer = await classifyPendingAnswer({ question: pending.question, text });
  await setPending(student.id, null);

  switch (answer) {
    case "reference":
      return "Keeping it as reference — I'll remember what's in it, but I won't treat those dates as deadlines or remind you about them.";
    case "current":
      // Sift can't recover the right dates from a file whose dates are wrong,
      // and guessing them is how a student ends up trusting a deadline nobody
      // wrote down. Ask.
      return "Then the dates in that file are off — I don't want to guess at them. Text me the ones that actually matter and I'll track those.";
    case "unrelated":
      return null; // They've moved on; the caller routes the turn normally.
  }
}

/**
 * Route the turn's parts. Attachments win: a captioned file is one ingest, and
 * the caption is context for the extraction rather than a turn of its own.
 */
export async function ingest(input: {
  student: Student;
  text: string;
  files: Attachment[];
}): Promise<string> {
  const { student, text, files } = input;

  if (files.length === 0) return ingestNote(student, text);

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
