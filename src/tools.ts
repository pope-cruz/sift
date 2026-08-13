// The tools Sift can call on a text turn.
//
// This replaces the intent classifier. Sorting every message into one of six
// boxes before anything could happen meant a misread message got the wrong
// handler, and the only lever was rewording the classifier prompt — which
// traded failures rather than removing them. Here the model sees the actual
// conversation and picks an action, so "make the 2025 into 2026" and "cafe
// recs?" work for the same reason a person would understand them.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import {
  cancelActionReminder,
  getItemEvidence,
  listSavedItems,
  rescheduleActionReminder,
  rescheduleActions,
  saveNoteAtomic,
  type Student,
} from "./db.ts";
import { friendly, isIsoDate, localInstant } from "./dates.ts";
import { scheduleTask } from "./task-scheduling.ts";

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
      "item already in SAVED, so it belongs in the tool that changes that item. When the " +
      "message contains a list of tasks, include every task in deadlines, including undated " +
      "ones; never keep only the last list item.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 120, description: "short label for the thing itself" },
        summary: {
          type: "string",
          maxLength: 2000,
          description:
            "the substance in a sentence or two, in the student's own words. Write the thing " +
            'itself ("Chem midterm moved to the 14th"), not a description of who said it ' +
            '("The student wants..."). This text gets read back to them.',
        },
        deadlines: {
          type: "array",
          maxItems: 20,
          description: "every independent task they have to do, with a date when one was given; undated tasks still belong here",
          items: {
            type: "object",
            properties: {
              description: { type: "string", maxLength: 240 },
              due_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "ISO yyyy-mm-dd, or omit if undated" },
              due_time: {
                type: "string",
                pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                description: "24-hour HH:mm only when the student gave an exact time; otherwise omit",
              },
            },
            required: ["description"],
          },
        },
        reminder_requested: {
          type: "boolean",
          description: "true only when the student explicitly asked to be reminded",
        },
      },
      required: ["title", "summary"],
    },
  },
  {
    name: "reschedule_reminder",
    description:
      "Move one pending reminder to a different local calendar day. Use for requests like " +
      '"remind me tomorrow instead". Resolve the action from SAVED and pass the requested ' +
      "date as ISO yyyy-mm-dd. This changes the reminder only, not the deadline.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string", description: "the action_id from an open date in SAVED" },
        send_date: { type: "string", description: "requested local date, ISO yyyy-mm-dd" },
      },
      required: ["action_id", "send_date"],
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel one pending reminder without deleting or completing its saved action. Use when " +
      'the student says "cancel that reminder" or "don\'t remind me about it" and means one action.',
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string", description: "the action_id from an open date in SAVED" },
      },
      required: ["action_id"],
    },
  },
];

/**
 * Nothing changed, and the model needs to know that plainly enough not to
 * report success anyway — which is exactly what it did when the error was a
 * bare sentence.
 */
function badId(given: string, items: { id: string; title: string | null }[]): string {
  return JSON.stringify({
    ok: false,
    needs_clarification: true,
    user_message: "I couldn’t tell which item you meant. Which one should I change?",
    invalid_item_id: given,
    valid_items: items.map((item) => ({ id: item.id, title: item.title })),
  });
}

function badActionId(
  given: string,
  items: { title: string | null; actions: { id: string; description: string }[] }[],
): string {
  const valid = items.flatMap((item) =>
    item.actions.map((action) => `${action.id} (${item.title ?? action.description})`),
  );
  return JSON.stringify({
    ok: false,
    needs_clarification: true,
    user_message: "I couldn’t tell which deadline you meant. Which one should I change?",
    invalid_action_id: given,
    valid_actions: valid,
  });
}

function toolFailure(userMessage: string, needsClarification = false): string {
  return JSON.stringify({ ok: false, needs_clarification: needsClarification, user_message: userMessage });
}

const SaveNoteInput = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(2000),
  deadlines: z.array(z.object({
    description: z.string().trim().min(1).max(240),
    due_date: z.string().refine(isIsoDate, "invalid due date").optional(),
    due_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  })).max(20).default([]),
  reminder_requested: z.boolean().default(false),
});

function naturalInstant(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * A past date is never a live deadline, whichever path set it. Keeping this in
 * one place is what stops Phase 4's cron from firing a backlog of reminders for
 * work that is already over.
 */
function scheduleFor(
  dueDate: string | null,
  student: Student,
  options: { tracked: boolean; reminder: boolean },
  dueTime: string | null = null,
) {
  return scheduleTask(dueDate, student.timezone, options, dueTime);
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
  sourceTurnId: string,
): Promise<string> {
  switch (name) {
    case "update_dates": {
      const itemId = String(input.item_id ?? "");
      const year = Number(input.year);
      if (!Number.isFinite(year)) return toolFailure("I need a valid year to make that change.", true);

      const items = await listSavedItems(student.id);
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return badId(itemId, items);

      const dated = item.actions.filter(
        (action): action is typeof action & { due_date: string } => action.due_date !== null,
      );
      if (dated.length === 0) return toolFailure(`${item.title ?? "That item"} has no dates to move.`);

      const moved = dated.map((action) => {
        const dueDate = `${String(year).padStart(4, "0")}${action.due_date.slice(4)}`;
        return {
          id: action.id,
          dueDate,
          ...scheduleFor(dueDate, student, {
            tracked: true,
            reminder: action.remind_at !== null,
          }, action.due_time),
        };
      });

      await rescheduleActions(student.id, moved);

      const tracked = moved.filter((row) => row.status === "open").length;
      const title = item.title ?? "that item";
      return JSON.stringify({
        ok: true,
        moved: moved.length,
        year,
        now_tracked: tracked,
        left_as_reference: moved.length - tracked,
        confirmation: tracked === 0
          ? `Done — moved ${title} to ${year}, but those dates are still past, so reminders stay off.`
          : `Done — moved ${title} to ${year}.`,
        required_terms: [title, String(year)],
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
          ...scheduleFor(action.due_date, student, {
            tracked: wanted,
            reminder: wanted,
          }, action.due_time),
        })),
      );

      const tracked = dated.filter(
        (action) => scheduleFor(action.due_date, student, {
          tracked: wanted,
          reminder: wanted,
        }, action.due_time).status === "open",
      ).length;

      const title = item.title ?? "that item";
      if (wanted && tracked === 0) {
        return toolFailure("Those dates are still in the past. What year should they use?", true);
      }
      return JSON.stringify({
        ok: true,
        updated: dated.length,
        now_tracked: tracked,
        confirmation: wanted
          ? `Done — tracking ${tracked} ${tracked === 1 ? "deadline" : "deadlines"} for ${title}.`
          : `Done — reminders are off for ${title}.`,
        required_terms: [title],
      });
    }

    case "why_saved": {
      const itemId = String(input.item_id ?? "");

      const items = await listSavedItems(student.id);
      if (!items.some((candidate) => candidate.id === itemId)) return badId(itemId, items);

      const evidence = await getItemEvidence(student.id, itemId);
      if (!evidence?.extractedText) {
        return "No reading notes are available for that one, so say you can’t verify it rather than guessing.";
      }

      return renderEvidence(evidence.title, evidence.extractedText);
    }

    case "save_note": {
      const parsed = SaveNoteInput.safeParse(input);
      if (!parsed.success) {
        return toolFailure("I couldn’t safely read every task in that list. Send the list once more.");
      }
      const { deadlines, title, summary, reminder_requested: reminderRequested } = parsed.data;

      const scheduled = deadlines
        .map((entry) => {
          const dueDate = entry.due_date ?? null;
          return {
            description: entry.description as string,
            dueDate,
            // A deadline is stored as an open task, but it becomes a scheduled
            // reminder only when the student's words explicitly requested one.
            ...scheduleFor(dueDate, student, {
              tracked: true,
              reminder: reminderRequested,
            }, entry.due_time ?? null),
          };
        });

      const stored = await saveNoteAtomic({
        studentId: student.id,
        sourceMessageId: sourceTurnId,
        title,
        summary,
        extractedText: JSON.stringify({ text_note_deadlines: deadlines }),
        actions: scheduled,
      });
      const itemId = stored.itemId;

      const first = scheduled.find((entry) => entry.dueDate !== null);
      const reminder = first?.remindAt ? naturalInstant(first.remindAt, student.timezone) : null;
      const due = first?.dueDate ? friendly(first.dueDate, student.timezone) : null;
      if (reminderRequested && !reminder) {
        return JSON.stringify({
          ok: true,
          kind: "reminder",
          needs_clarification: true,
          saved: true,
          duplicate: stored.duplicate,
          item_id: itemId,
          confirmation: `${title} is saved — when should I remind you?`,
          required_terms: [title],
        });
      }
      const taskNames = scheduled.map((entry) => entry.description);
      const taskList = taskNames.length < 2
        ? ""
        : taskNames.length === 2
          ? `${taskNames[0]} and ${taskNames[1]}`
          : `${taskNames.slice(0, -1).join(", ")}, and ${taskNames.at(-1)}`;
      const commonDueDate = scheduled.length > 1 && scheduled[0]?.dueDate &&
        scheduled.every((entry) => entry.dueDate === scheduled[0]!.dueDate)
        ? scheduled[0].dueDate
        : null;
      const confirmation = taskNames.length > 1
        ? `Done — saved ${taskNames.length} tasks${commonDueDate ? ` for ${friendly(commonDueDate, student.timezone)}` : ""}: ${taskList}.` +
          (reminderRequested && reminder ? ` I’ll remind you ${reminder}.` : "")
        : first && due
          ? `Done — ${title} added for ${due}.` +
            (reminderRequested && reminder ? ` I’ll remind you ${reminder}.` : "")
          : `Done — ${title} saved.`;
      return JSON.stringify({
        ok: true,
        kind: reminderRequested ? "reminder" : "mutation",
        saved: true,
        duplicate: stored.duplicate,
        item_id: itemId,
        deadlines: scheduled,
        confirmation,
        required_terms: taskNames.length > 1
          ? taskNames
          : [title, ...(due ? [due] : []), ...(reminderRequested && reminder ? [reminder] : [])],
      });
    }

    case "reschedule_reminder": {
      const actionId = String(input.action_id ?? "");
      const sendDate = String(input.send_date ?? "");
      if (!isIsoDate(sendDate)) return toolFailure("I need a valid date for that reminder.", true);

      const items = await listSavedItems(student.id);
      const action = items.flatMap((item) => item.actions).find((row) => row.id === actionId);
      if (!action) return badActionId(actionId, items);
      if (!action.due_date) return toolFailure("That task has no deadline, so there isn’t a reminder to move.");

      const planned = localInstant(sendDate, "18:00", student.timezone);
      const due = localInstant(action.due_date, action.due_time ?? "20:00", student.timezone);
      const now = new Date();
      if (!planned || !due || planned.getTime() <= now.getTime()) {
        return toolFailure("That reminder time has already passed. When should I move it to?", true);
      }
      if (planned.getTime() >= due.getTime()) {
        return toolFailure("That would be after the deadline. What earlier day should I use?", true);
      }

      const changed = await rescheduleActionReminder({
        studentId: student.id,
        actionId,
        plannedSendAt: planned.toISOString(),
      });
      const when = naturalInstant(planned.toISOString(), student.timezone);
      return changed
        ? JSON.stringify({
            ok: true,
            kind: "reminder",
            rescheduled: true,
            send_at: planned.toISOString(),
            confirmation: `Done — I’ll remind you ${when}.`,
            required_terms: [when],
          })
        : toolFailure("That reminder is no longer pending, so I couldn’t move it.");
    }

    case "cancel_reminder": {
      const actionId = String(input.action_id ?? "");
      const items = await listSavedItems(student.id);
      if (!items.flatMap((item) => item.actions).some((row) => row.id === actionId)) {
        return badActionId(actionId, items);
      }

      const cancelled = await cancelActionReminder(student.id, actionId);
      return cancelled
        ? JSON.stringify({
            ok: true,
            kind: "reminder",
            cancelled: true,
            confirmation: "Done — reminder cancelled.",
            required_terms: ["cancelled"],
          })
        : toolFailure("That reminder is no longer pending, so there’s nothing to cancel.");
    }

    default:
      return `Error: unknown tool ${name}.`;
  }
}
