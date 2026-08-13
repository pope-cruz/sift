// Model-backed tone acceptance for the response intents that are awkward to
// judge with exact strings. The production prompt, model loop, deterministic
// planner context, and reply validator are real. Persistence and delivery are
// deliberately replaced by in-memory boundaries: this file must never import
// db.ts, tools.ts, turn.ts, Spectrum, or a provider.
//
//   npm run tone:smoke

import assert from "node:assert/strict";

import type Anthropic from "@anthropic-ai/sdk";

import { respond } from "../llm.ts";
import {
  assembleContext,
  fallbackReply,
  renderContext,
  validateReply,
  type ContextActionRow,
  type ContextItemRow,
  type ContextMessageRow,
  type ContextRows,
  type StudentContext,
} from "../planner.ts";

const TODAY = "2026-08-12";
const TIMEZONE = "America/New_York";
const STUDENT_ID = "tone-smoke-student";

const SAVE_NOTE_TOOL: Anthropic.Tool = {
  name: "save_note",
  description:
    "Remember a new meeting or deadline the student just gave you. Call this before replying, " +
    "and include every explicit date and time.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      deadlines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            due_date: { type: "string", description: "ISO yyyy-mm-dd, or omit if undated" },
            due_time: {
              type: "string",
              description: "24-hour HH:mm only when the student gave an exact time; otherwise omit",
            },
          },
          required: ["description"],
        },
      },
    },
    required: ["title", "summary"],
  },
};

const RESCHEDULE_REMINDER_TOOL: Anthropic.Tool = {
  name: "reschedule_reminder",
  description:
    "Move one pending reminder to a different local calendar day. Resolve the action id from " +
    "evidence and pass the requested local date as ISO yyyy-mm-dd.",
  input_schema: {
    type: "object",
    properties: {
      action_id: { type: "string", description: "the action_id from an open date in evidence" },
      send_date: { type: "string", description: "requested local date, ISO yyyy-mm-dd" },
    },
    required: ["action_id", "send_date"],
  },
};

type ActionCall = { name: string; args: Record<string, unknown> };

/** Captures both side-effect boundaries without touching an external system. */
class InMemoryBoundaries {
  readonly actionCalls: ActionCall[] = [];
  readonly outbound: string[] = [];

  constructor(
    private readonly actionResult: (
      name: string,
      args: Record<string, unknown>,
    ) => string | Promise<string>,
  ) {}

  runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    this.actionCalls.push({ name, args });
    return this.actionResult(name, args);
  };

  send = async (text: string): Promise<void> => {
    this.outbound.push(text);
  };
}

function item(input: {
  id: string;
  title: string;
  summary?: string;
  type?: string;
  category?: string;
}): ContextItemRow {
  return {
    id: input.id,
    student_id: STUDENT_ID,
    type: input.type ?? "note",
    title: input.title,
    summary: input.summary ?? input.title,
    category: input.category ?? "coursework",
    extracted_text: "{}",
    created_at: `${TODAY}T12:00:00.000Z`,
  };
}

function action(input: {
  id: string;
  itemId: string;
  description: string;
  dueDate: string;
}): ContextActionRow {
  return {
    id: input.id,
    student_id: STUDENT_ID,
    item_id: input.itemId,
    description: input.description,
    due_date: input.dueDate,
    status: "open",
    created_at: `${TODAY}T12:00:00.000Z`,
  };
}

function message(
  id: string,
  direction: "inbound" | "outbound",
  content: string,
): ContextMessageRow {
  return {
    id,
    student_id: STUDENT_ID,
    direction,
    content,
    created_at: `${TODAY}T12:00:00.000Z`,
  };
}

function context(question: string, rows: Partial<ContextRows>): StudentContext {
  return assembleContext({
    student: {
      id: STUDENT_ID,
      name: "Alex",
      timezone: TIMEZONE,
      profile: {},
    },
    question,
    today: TODAY,
    rows: {
      items: rows.items ?? [],
      actions: rows.actions ?? [],
      messages: rows.messages ?? [],
    },
  });
}

type Intent = "mutation confirmation" | "reminder confirmation" | "honest empty state" | "multi-turn follow-up";
type Check = { criterion: string; passed: boolean };
type SmokeResult = {
  intent: Intent;
  output: string;
  checks: Check[];
  actionCalls: number;
  capturedMessages: number;
};

const INTERNAL_NARRATION =
  /\b(?:database|retrieved context|stored (?:item|items|record|records|data)|saved records?|open saved actions?|record ids?|persistence)\b/i;
const GENERIC_OFFER =
  /\b(?:would you like me to|do you want me to|let me know if|anything else|happy to help|need anything else|want help)\b/i;

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean).length;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function commonChecks(output: string, maxSentences: number, maxWords: number): Check[] {
  return [
    { criterion: "uses plain, non-empty iMessage text", passed: output.length > 0 && !/^\s*(?:#|\*|- )/m.test(output) },
    { criterion: "avoids database-like narration", passed: !INTERNAL_NARRATION.test(output) },
    { criterion: "does not append a generic offer", passed: !GENERIC_OFFER.test(output) },
    { criterion: "does not append an unnecessary question", passed: !output.includes("?") },
    {
      criterion: `stays within ${maxSentences} sentence(s) and ${maxWords} words`,
      passed: sentenceCount(output) <= maxSentences && wordCount(output) <= maxWords,
    },
  ];
}

function assertChecks(intent: Intent, output: string, checks: Check[]): void {
  const failures = checks.filter((check) => !check.passed).map((check) => check.criterion);
  assert.deepEqual(failures, [], `${intent} failed: ${failures.join("; ")}\nOutput: ${output}`);
}

async function generate(input: {
  intent: Intent;
  context: StudentContext;
  tools?: Anthropic.Tool[];
  boundaries: InMemoryBoundaries;
  requireAction?: string;
  checks: (output: string) => Check[];
}): Promise<SmokeResult> {
  const output = await respond({
    history: input.context.messages.map(({ direction, content }) => ({ direction, content })),
    text: input.context.question,
    context: renderContext(input.context),
    timezone: input.context.student.timezone,
    tools: input.tools ?? [],
    runTool: input.boundaries.runTool,
    validateReply: (text, attempt) => validateReply(input.context, text, attempt),
    fallbackReply: fallbackReply(input.context),
  });

  await input.boundaries.send(output);
  assert.equal(input.boundaries.outbound.length, 1, `${input.intent} must capture exactly one outbound message`);
  assert.equal(input.boundaries.outbound[0], output);
  if (input.requireAction) {
    assert.equal(input.boundaries.actionCalls.length, 1, `${input.intent} must make one mocked action call`);
    assert.equal(input.boundaries.actionCalls[0]?.name, input.requireAction);
  } else {
    assert.equal(input.boundaries.actionCalls.length, 0, `${input.intent} must not invoke persistence`);
  }

  const checks = input.checks(output);
  assertChecks(input.intent, output, checks);
  return {
    intent: input.intent,
    output,
    checks,
    actionCalls: input.boundaries.actionCalls.length,
    capturedMessages: input.boundaries.outbound.length,
  };
}

const unrelatedItems = [
  item({ id: "item-reading-quiz", title: "Reading quiz", summary: "CS 4414 reading quiz" }),
  item({ id: "item-project-1", title: "Project 1", summary: "CS 4414 Project 1" }),
  item({ id: "item-juniper", title: "Juniper Study Cafe", summary: "Quiet study cafe", category: "place" }),
];
const unrelatedActions = [
  action({ id: "action-reading-quiz", itemId: "item-reading-quiz", description: "Reading quiz", dueDate: "2026-08-14" }),
  action({ id: "action-project-1", itemId: "item-project-1", description: "Project 1", dueDate: "2026-08-17" }),
];

const mutationQuestion = "Add the graduate club meeting for Saturday, August 15 at 3:00 PM.";
const mutationContext = context(mutationQuestion, {
  items: unrelatedItems,
  actions: unrelatedActions,
  messages: [message("mutation-in", "inbound", mutationQuestion)],
});
const mutationBoundaries = new InMemoryBoundaries((name, args) => {
  assert.equal(name, "save_note");
  const deadlines = Array.isArray(args.deadlines) ? args.deadlines as Record<string, unknown>[] : [];
  assert.equal(deadlines[0]?.due_date, "2026-08-15", "mutation must preserve the requested date at the mock boundary");
  assert.equal(deadlines[0]?.due_time, "15:00", "mutation must preserve the requested time at the mock boundary");
  return JSON.stringify({
    ok: true,
    kind: "mutation",
    saved: true,
    confirmation: "Done — Graduate club meeting added for Sat, Aug 15 at 3:00 PM.",
    required_terms: ["Graduate club meeting", "Sat, Aug 15", "3:00 PM"],
  });
});

const reminderQuestion = "Remind me tomorrow instead.";
const reminderContext = context(reminderQuestion, {
  items: unrelatedItems.slice(0, 2),
  actions: unrelatedActions,
  messages: [
    message("reminder-q1", "inbound", "When is Project 1 due?"),
    message("reminder-a1", "outbound", "Project 1 is due Mon, Aug 17."),
    message("reminder-q2", "inbound", reminderQuestion),
  ],
});
const reminderBoundaries = new InMemoryBoundaries((name, args) => {
  assert.equal(name, "reschedule_reminder");
  assert.equal(args.action_id, "action-project-1", "reminder must use the grounded action id");
  assert.equal(args.send_date, "2026-08-13", "tomorrow must resolve in the student's local timezone");
  return JSON.stringify({
    ok: true,
    kind: "reminder",
    rescheduled: true,
    send_at: "2026-08-13T22:00:00.000Z",
    confirmation: "Done — I’ll remind you Thu, Aug 13, 6:00 PM.",
    required_terms: ["Thu, Aug 13, 6:00 PM"],
  });
});

const emptyQuestion = "What is due this week?";
const emptyContext = context(emptyQuestion, {
  messages: [message("empty-in", "inbound", emptyQuestion)],
});
const emptyBoundaries = new InMemoryBoundaries(() => {
  throw new Error("empty-state generation must not reach persistence");
});

const followUpQuestion = "What’s next after that?";
const followUpContext = context(followUpQuestion, {
  items: unrelatedItems.slice(0, 2),
  actions: unrelatedActions,
  messages: [
    message("follow-q1", "inbound", "What is due first?"),
    message("follow-a1", "outbound", "Reading quiz is due Fri, Aug 14."),
    message("follow-q2", "inbound", followUpQuestion),
  ],
});
const followUpBoundaries = new InMemoryBoundaries(() => {
  throw new Error("follow-up generation must not reach persistence");
});

const results: SmokeResult[] = [];

results.push(await generate({
  intent: "mutation confirmation",
  context: mutationContext,
  tools: [SAVE_NOTE_TOOL],
  boundaries: mutationBoundaries,
  requireAction: "save_note",
  checks: (output) => [
    ...commonChecks(output, 2, 34),
    { criterion: "confirms the completed action directly", passed: /^(?:done\b|graduate club meeting\b)/i.test(output) },
    { criterion: "preserves the meeting and exact date", passed: /graduate club meeting/i.test(output) && /(?:Sat(?:urday)?[,.]?\s+Aug(?:ust)?\s+15|Aug(?:ust)?\s+15)/i.test(output) },
    { criterion: "does not recap unrelated context", passed: !/reading quiz|project 1|juniper/i.test(output) },
  ],
}));

results.push(await generate({
  intent: "reminder confirmation",
  context: reminderContext,
  tools: [RESCHEDULE_REMINDER_TOOL],
  boundaries: reminderBoundaries,
  requireAction: "reschedule_reminder",
  checks: (output) => [
    ...commonChecks(output, 2, 28),
    { criterion: "confirms the reminder directly", passed: /^(?:done\b|i[’']ll remind\b)/i.test(output) },
    { criterion: "preserves the exact local date and time", passed: /Thu(?:rsday)?[,.]?\s+Aug(?:ust)?\s+13/i.test(output) && /6:00\s*PM/i.test(output) },
    { criterion: "does not recap the deadline or unrelated context", passed: !/Aug(?:ust)?\s+17|reading quiz|juniper/i.test(output) },
  ],
}));

results.push(await generate({
  intent: "honest empty state",
  context: emptyContext,
  boundaries: emptyBoundaries,
  checks: (output) => [
    ...commonChecks(output, 2, 22),
    { criterion: "answers the empty state directly and honestly", passed: /^(?:nothing\b|no\b|you (?:don[’']t|do not) have\b)/i.test(output) && /due|deadline/i.test(output) },
    { criterion: "does not invent a date or task", passed: !/(?:19|20)\d{2}|reading quiz|project 1|meeting/i.test(output) },
  ],
}));

results.push(await generate({
  intent: "multi-turn follow-up",
  context: followUpContext,
  boundaries: followUpBoundaries,
  checks: (output) => [
    ...commonChecks(output, 2, 28),
    { criterion: "answers the new part directly", passed: /^(?:next\b|project 1\b)/i.test(output) },
    { criterion: "preserves the next item and exact date", passed: /project 1/i.test(output) && /Mon(?:day)?[,.]?\s+Aug(?:ust)?\s+17/i.test(output) },
    { criterion: "does not repeat the prior answer", passed: !/reading quiz|Aug(?:ust)?\s+14/i.test(output) },
  ],
}));

console.log(JSON.stringify({
  tone_smoke: "passed",
  model_backed: true,
  external_persistence_calls: 0,
  external_message_sends: 0,
  scenarios: results,
}, null, 2));
