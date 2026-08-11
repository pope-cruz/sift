// The tools Sift can call on a text turn.
//
// This replaces the intent classifier. Sorting every message into one of six
// boxes before anything could happen meant a misread message got the wrong
// handler, and the only lever was rewording the classifier prompt — which
// traded failures rather than removing them. Here the model sees the actual
// conversation and picks an action, so "make the 2025 into 2026" and "cafe
// recs?" work for the same reason a person would understand them.
import type Anthropic from "@anthropic-ai/sdk";

import {
  getItemEvidence,
  insertActions,
  insertItem,
  listSavedItems,
  rescheduleActions,
  type Student,
} from "./db.ts";
import { remindAtFor, today } from "./dates.ts";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "update_dates",
    description:
      "Move every date on a saved item to a different calendar year, keeping the same " +
      "day and month. Use when the student says the dates are off by a year — " +
      '"make those 2026", "change it from 2025 to 2026", "shift the schedule a year".',
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "the id of the item from SAVED" },
        year: { type: "integer", description: "the calendar year the dates should land in" },
      },
      required: ["item_id", "year"],
    },
  },
  {
    name: "set_tracking",
    description:
      "Choose whether an item's dates are live deadlines Sift reminds about, or kept " +
      "for reference only. Use `tracked: false` when the student says it's an old file " +
      "they just want remembered — \"keep it as reference\", \"just for ref\", \"that's " +
      "last term's\", \"don't remind me about it\". This is the tool that answers your own " +
      "question about whether a file is reference or current: a reply meaning reference is " +
      "always this call on the item you asked about, never a new note.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "the id of the item from SAVED" },
        tracked: { type: "boolean" },
      },
      required: ["item_id", "tracked"],
    },
  },
  {
    name: "why_saved",
    description:
      "Look up what a saved file actually said and how each date in it was ruled on. Use when " +
      'the student questions what you did with something — "why isn\'t the final on there", ' +
      '"where did that date come from", "did you miss the lab?". Read the result before you ' +
      "answer; never explain a decision from memory.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "the id of the item from SAVED" },
      },
      required: ["item_id"],
    },
  },
  {
    name: "save_note",
    description:
      "Remember something new the student told you in a message — a fact, a meeting, a " +
      "deadline that isn't already saved. Do not use this to record a change to " +
      "something that already exists; use update_dates or set_tracking for that. Do not " +
      "use it to record an answer to a question you just asked: that answer is about an " +
      "item already in SAVED, so it belongs in the tool that changes that item.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short label for the thing itself" },
        summary: {
          type: "string",
          description:
            "the substance in a sentence or two, in the student's own words. Write the thing " +
            'itself ("Chem midterm moved to the 14th"), not a description of who said it ' +
            '("The student wants..."). This text gets read back to them.',
        },
        deadlines: {
          type: "array",
          description: "anything they actually have to do, with a date when one was given",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              due_date: { type: "string", description: "ISO yyyy-mm-dd, or omit if undated" },
            },
            required: ["description"],
          },
        },
      },
      required: ["title", "summary"],
    },
  },
];

/**
 * Nothing changed, and the model needs to know that plainly enough not to
 * report success anyway — which is exactly what it did when the error was a
 * bare sentence.
 */
function badId(given: string, items: { id: string; title: string | null }[]): string {
  return (
    `FAILED — nothing was changed. "${given}" is not a valid item_id. ` +
    `Valid ids: ${items.map((item) => `${item.id} (${item.title})`).join("; ")}. ` +
    `Retry with one of these, and do not tell the student anything changed unless it did.`
  );
}

/**
 * A past date is never a live deadline, whichever path set it. Keeping this in
 * one place is what stops Phase 4's cron from firing a backlog of reminders for
 * work that is already over.
 */
function scheduleFor(dueDate: string | null, student: Student, wanted: boolean) {
  const stale = dueDate !== null && dueDate < today(student.timezone);
  const tracked = wanted && !stale;
  return {
    status: tracked ? ("open" as const) : ("reference" as const),
    remindAt: tracked && dueDate ? remindAtFor(dueDate, student.timezone) : null,
  };
}

/** What each ruling meant, in words the model can repeat to the student. */
const OUTCOMES: Record<string, string> = {
  open: "tracked as a live deadline",
  reference: "kept but not reminded about",
  evidence_only: "not treated as a deadline",
};

type StoredCandidate = {
  original_text?: string;
  role?: string;
  source?: string;
  normalized_date?: string | null;
  outcome?: string;
  decision_reason?: string;
};

/**
 * Turn the stored ingest record into something worth reading. The raw JSON
 * would work, but it invites the model to quote field names at a student over
 * iMessage; this states the same facts as sentences.
 */
function renderEvidence(title: string | null, extractedText: string): string {
  let stored: { filename?: string; caption?: string; evaluated_at?: string; candidates?: unknown };
  try {
    stored = JSON.parse(extractedText);
  } catch {
    return "The reading notes for that one are unreadable, so say you can't check rather than guessing.";
  }

  const candidates = Array.isArray(stored.candidates)
    ? (stored.candidates as StoredCandidate[])
    : [];

  const lines = [
    `Reading notes for "${title ?? "untitled"}"${stored.filename ? ` (${stored.filename})` : ""}, read on ${stored.evaluated_at ?? "an unrecorded date"}.`,
    stored.caption ? `The student sent it saying: "${stored.caption}"` : "It arrived with no caption.",
    "",
    candidates.length
      ? `Every date found in it (${candidates.length}):`
      : "No dates were found in it at all.",
  ];

  for (const candidate of candidates) {
    const seen = candidate.original_text ?? "(unquoted)";
    const where = candidate.source ? ` in the ${candidate.source}` : "";
    const resolved = candidate.normalized_date ? `, read as ${candidate.normalized_date}` : "";
    const ruling = OUTCOMES[candidate.outcome ?? ""] ?? candidate.outcome ?? "unruled";
    lines.push(`- "${seen}"${where}${resolved} — ${ruling}. Why: ${candidate.decision_reason ?? "no reason recorded"}.`);
  }

  lines.push(
    "",
    "Answer from these notes only. If the student is right that something was missed, say so plainly instead of defending the call.",
  );

  return lines.join("\n");
}

export async function runTool(
  student: Student,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "update_dates": {
      const itemId = String(input.item_id ?? "");
      const year = Number(input.year);
      if (!Number.isFinite(year)) return "Error: year must be a number.";

      const items = await listSavedItems(student.id);
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return badId(itemId, items);

      const dated = item.actions.filter(
        (action): action is typeof action & { due_date: string } => action.due_date !== null,
      );
      if (dated.length === 0) return "That item has no dates to move.";

      const moved = dated.map((action) => {
        const dueDate = `${String(year).padStart(4, "0")}${action.due_date.slice(4)}`;
        return { id: action.id, dueDate, ...scheduleFor(dueDate, student, true) };
      });

      await rescheduleActions(student.id, moved);

      const tracked = moved.filter((row) => row.status === "open").length;
      return JSON.stringify({
        moved: moved.length,
        year,
        now_tracked: tracked,
        left_as_reference: moved.length - tracked,
        note:
          tracked === 0
            ? "Every date is still in the past even after the move, so none are being tracked. Tell the student."
            : undefined,
      });
    }

    case "set_tracking": {
      const itemId = String(input.item_id ?? "");
      const wanted = input.tracked === true;

      const items = await listSavedItems(student.id);
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return badId(itemId, items);

      const dated = item.actions.filter(
        (action): action is typeof action & { due_date: string } => action.due_date !== null,
      );

      await rescheduleActions(
        student.id,
        dated.map((action) => ({
          id: action.id,
          dueDate: action.due_date,
          ...scheduleFor(action.due_date, student, wanted),
        })),
      );

      const tracked = dated.filter(
        (action) => scheduleFor(action.due_date, student, wanted).status === "open",
      ).length;

      return JSON.stringify({
        updated: dated.length,
        now_tracked: tracked,
        note:
          wanted && tracked === 0
            ? "Every date has already passed, so nothing can be tracked. Ask which year they should be."
            : undefined,
      });
    }

    case "why_saved": {
      const itemId = String(input.item_id ?? "");

      const items = await listSavedItems(student.id);
      if (!items.some((candidate) => candidate.id === itemId)) return badId(itemId, items);

      const evidence = await getItemEvidence(student.id, itemId);
      if (!evidence?.extractedText) {
        return "No reading notes were kept for that one — it was saved before, or without, a file.";
      }

      return renderEvidence(evidence.title, evidence.extractedText);
    }

    case "save_note": {
      const deadlines = Array.isArray(input.deadlines)
        ? (input.deadlines as { description?: string; due_date?: string }[])
        : [];

      const itemId = await insertItem({
        studentId: student.id,
        type: "note",
        title: String(input.title ?? "Note"),
        summary: String(input.summary ?? ""),
        category: "note",
      });

      await insertActions(
        student.id,
        itemId,
        deadlines
          .filter((entry) => entry.description)
          .map((entry) => {
            const dueDate = entry.due_date ?? null;
            return {
              description: entry.description as string,
              dueDate,
              ...scheduleFor(dueDate, student, true),
            };
          }),
      );

      return JSON.stringify({ saved: true, item_id: itemId, deadlines: deadlines.length });
    }

    default:
      return `Error: unknown tool ${name}.`;
  }
}
