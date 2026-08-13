import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assembleContext,
  fallbackReply,
  renderContext,
  validateReply,
  type ContextActionRow,
  type ContextItemRow,
  type ContextMessageRow,
  type ContextRows,
} from "./planner.ts";

const STUDENT = {
  id: "student-a",
  name: "Ari",
  timezone: "America/New_York",
  profile: { major: "Computer Science", year: 2 },
};
const TODAY = "2026-08-11";

function item(input: {
  id: string;
  title: string;
  summary: string;
  type?: string;
  category?: string | null;
  studentId?: string;
  place?: { name: string; location?: string | null; caption?: string };
  topics?: string[];
  createdAt?: string;
}): ContextItemRow {
  return {
    id: input.id,
    student_id: input.studentId ?? STUDENT.id,
    type: input.type ?? "reference_material",
    title: input.title,
    summary: input.summary,
    category: input.category ?? null,
    extracted_text: JSON.stringify({ place: input.place ?? null, topics: input.topics ?? [] }),
    created_at: input.createdAt ?? "2026-08-10T12:00:00Z",
  };
}

function action(input: {
  id: string;
  itemId: string;
  description: string;
  due: string | null;
  status?: string;
  studentId?: string;
}): ContextActionRow {
  return {
    id: input.id,
    student_id: input.studentId ?? STUDENT.id,
    item_id: input.itemId,
    description: input.description,
    due_date: input.due,
    status: input.status ?? "open",
    created_at: "2026-08-10T12:00:00Z",
  };
}

function message(input: {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  studentId?: string;
}): ContextMessageRow {
  return {
    id: input.id,
    student_id: input.studentId ?? STUDENT.id,
    direction: input.direction,
    content: input.content,
    created_at: "2026-08-11T12:00:00Z",
  };
}

function context(question: string, rows: Partial<ContextRows>) {
  return assembleContext({
    student: STUDENT,
    question,
    today: TODAY,
    rows: { items: rows.items ?? [], actions: rows.actions ?? [], messages: rows.messages ?? [] },
  });
}

const PROJECT = item({
  id: "project-1",
  title: "Project 1",
  summary: "Build the shell for CS 4414 Operating Systems.",
  type: "assignment_instructions",
  topics: ["operating systems", "processes"],
});
const PROJECT_DUE = action({
  id: "action-project-1",
  itemId: "project-1",
  description: "Project 1 due",
  due: "2026-08-17",
});

test("retrieve an exact saved item by title", () => {
  const result = context("When is Project 1 due?", { items: [PROJECT], actions: [PROJECT_DUE] });
  assert.equal(result.request.matchStatus, "matched");
  assert.deepEqual(result.request.candidateItemIds, ["project-1"]);
  assert.equal(result.savedItems[0]?.actions[0]?.dueDate, "2026-08-17");
});

test("retrieve a saved item through a paraphrase rather than its exact title", () => {
  const cafe = item({
    id: "cafe-1",
    title: "Common Grounds",
    summary: "A quiet neighborhood café with outlets and long tables.",
    type: "place",
    category: "study_spot",
    place: { name: "Common Grounds", location: "Oak Street", caption: "Quiet in the afternoon" },
  });
  const result = context("What was that coffee shop for studying?", { items: [cafe] });
  assert.equal(result.request.matchStatus, "matched");
  assert.deepEqual(result.request.candidateItemIds, ["cafe-1"]);
});

test("retrieve what was saved about operating systems", () => {
  const result = context("What did I save about operating systems?", { items: [PROJECT] });
  assert.equal(result.request.matchStatus, "matched");
  assert.deepEqual(result.request.candidateItemIds, ["project-1"]);
  assert.match(fallbackReply(result), /Project 1/);
});

test("retrieve an upcoming deadline in chronological context", () => {
  const result = context("What assignments do I have coming up?", {
    items: [PROJECT],
    actions: [
      action({ id: "later", itemId: "project-1", description: "Project report due", due: "2026-08-20" }),
      PROJECT_DUE,
    ],
  });
  assert.deepEqual(result.upcomingDeadlines.map((entry) => entry.actionId), ["action-project-1", "later"]);
});

test("asking for upcoming work with no actions produces an explicit empty state", () => {
  const result = context("Do I have anything due this week?", { items: [PROJECT] });
  assert.equal(result.request.intent, "retrieve");
  assert.deepEqual(result.upcomingDeadlines, []);
  assert.match(renderContext(result), /UPCOMING_DEADLINES_NEXT_14_DAYS[^]*NONE/);
});

test("a broad saved-items request returns recent persistence rather than a false empty state", () => {
  const result = context("What did I save?", { items: [PROJECT] });
  assert.equal(result.request.matchStatus, "matched");
  assert.deepEqual(result.request.candidateItemIds, ["project-1"]);
});

test("a generic saved-place question acknowledges multiple plausible places", () => {
  const places = [
    item({
      id: "cafe-a",
      title: "Common Grounds",
      summary: "Café with outlets.",
      type: "place",
      category: "study_spot",
      place: { name: "Common Grounds" },
    }),
    item({
      id: "cafe-b",
      title: "Daily Grind",
      summary: "Coffee shop near campus.",
      type: "place",
      category: "study_spot",
      place: { name: "Daily Grind" },
    }),
  ];
  const result = context("What was the café I saved?", { items: places });
  assert.equal(result.request.matchStatus, "ambiguous");
  assert.deepEqual(new Set(result.request.candidateItemIds), new Set(["cafe-a", "cafe-b"]));
});

test("plural retrieval returns supported results instead of treating them as ambiguous", () => {
  const projectTwo = item({
    id: "project-2",
    title: "Project 2",
    summary: "Build a virtual-memory simulator.",
    type: "assignment_instructions",
  });
  const result = context("What assignments do I have coming up?", {
    items: [PROJECT, projectTwo],
    actions: [
      PROJECT_DUE,
      action({ id: "action-project-2", itemId: "project-2", description: "Project 2 due", due: "2026-08-20" }),
    ],
  });
  assert.equal(result.request.matchStatus, "matched");
  assert.equal(result.request.candidateItemIds.length, 2);
});

test("a complete task-list request preserves dated and undated tasks", () => {
  const taskList = item({
    id: "task-list",
    title: "Task list",
    summary: "Tasks: Email Jen; Email Carys; Eat dinner",
    type: "note",
  });
  const result = context("List every task from the task list I just saved.", {
    items: [taskList],
    actions: [
      action({ id: "jen", itemId: "task-list", description: "Email Jen about work", due: "2026-08-13" }),
      action({ id: "carys", itemId: "task-list", description: "Email Carys about work", due: "2026-08-14" }),
      action({ id: "dinner", itemId: "task-list", description: "Eat dinner", due: null }),
    ],
  });

  assert.equal(result.request.intent, "retrieve");
  const answer = fallbackReply(result);
  assert.match(answer, /3 tasks/);
  assert.match(answer, /Email Jen about work/);
  assert.match(answer, /Email Carys about work/);
  assert.match(answer, /Eat dinner/);
  assert.match(validateReply(result, "Email Jen about work and Email Carys about work.") ?? "", /Eat dinner/);
  assert.equal(validateReply(result, answer), null);
});

test("friendly questions remain chitchat rather than false retrieval misses", () => {
  const result = context("How are you?", { items: [PROJECT] });
  assert.equal(result.request.intent, "chitchat");
  assert.equal(result.request.matchStatus, "not_applicable");
});

test("an item absent from persistence is reported as not found", () => {
  const result = context("What did I save about calculus?", { items: [PROJECT] });
  assert.equal(result.request.matchStatus, "not_found");
  assert.deepEqual(result.request.candidateItemIds, []);
});

test("retrieval reply contracts preserve exact saved titles and dates", () => {
  const result = context("When is Project 1 due?", { items: [PROJECT], actions: [PROJECT_DUE] });
  assert.match(validateReply(result, "It's coming up soon. Check your schedule.") ?? "", /Project 1/);
  assert.match(validateReply(result, "Project 1 is coming up soon. Check your schedule.") ?? "", /date/);
  const answer = fallbackReply(result);
  assert.match(answer, /Project 1/);
  assert.match(answer, /Mon, Aug 17/);
  assert.equal(validateReply(result, answer), null);
});

test("retrieval fallback clearly reports an item with no supported due date", () => {
  const result = context("When is Project 1 due?", { items: [PROJECT] });
  const answer = fallbackReply(result);
  assert.equal(answer, "Project 1 doesn’t have a due date yet.");
  assert.doesNotMatch(answer, /saved|record|stored/i);
  assert.equal(validateReply(result, answer), null);
});

test("saved-place retrieval cannot silently substitute an unsupported place", () => {
  const cafe = item({
    id: "cafe-retrieve-contract",
    title: "Common Grounds",
    summary: "A quiet café with outlets.",
    type: "place",
    category: "study_spot",
    place: { name: "Common Grounds" },
  });
  const result = context("What was the café I saved?", { items: [cafe] });
  assert.match(validateReply(result, "A quiet coffee shop.") ?? "", /Common Grounds/);
  assert.equal(validateReply(result, "Common Grounds is a quiet study spot."), null);
});

test("weekly planning exposes several real deadlines in date order", () => {
  const result = context("Plan my week", {
    items: [PROJECT],
    actions: [
      action({ id: "third", itemId: "project-1", description: "Demo due", due: "2026-08-21" }),
      PROJECT_DUE,
      action({ id: "second", itemId: "project-1", description: "Draft due", due: "2026-08-19" }),
    ],
  });
  assert.equal(result.request.intent, "plan");
  assert.deepEqual(result.upcomingDeadlines.map((entry) => entry.dueDate), [
    "2026-08-17",
    "2026-08-19",
    "2026-08-21",
  ]);
});

test("'What should I work on Thursday?' routes to planning", () => {
  const result = context("What should I work on Thursday?", { items: [PROJECT], actions: [PROJECT_DUE] });
  assert.equal(result.request.intent, "plan");
});

test("the mandatory plan callback carries both Project 1 and the saved café by name", () => {
  const cafe = item({
    id: "cafe-1",
    title: "Common Grounds",
    summary: "A quiet café for study sessions.",
    type: "place",
    category: "study_spot",
    place: { name: "Common Grounds", location: "Oak Street" },
  });
  const rendered = renderContext(context("Could you plan my week?", {
    items: [PROJECT, cafe],
    actions: [PROJECT_DUE],
  }));
  assert.match(rendered, /Project 1/);
  assert.match(rendered, /2026-08-17/);
  assert.match(rendered, /Common Grounds/);
});

test("the plan reply contract rejects omitted facts and accepts the grounded callback", () => {
  const cafe = item({
    id: "cafe-contract",
    title: "Juniper Study Cafe",
    summary: "A quiet café for studying.",
    type: "place",
    category: "study_spot",
    place: { name: "Juniper Study Cafe" },
  });
  const result = context("Plan my week", { items: [PROJECT, cafe], actions: [PROJECT_DUE] });
  assert.match(validateReply(result, "Project 1 is due Mon, Aug 17." ) ?? "", /recommendation/i);
  assert.equal(
    validateReply(result, "I’d prioritize Project 1, due Mon, Aug 17. Use somewhere quiet."),
    null,
  );
  assert.equal(
    validateReply(
      result,
      "Prioritize Project 1, due Mon, Aug 17. Use Juniper Study Cafe for a focused session.",
    ),
    null,
  );
});

test("the deterministic planning fallback preserves the deadline and saved café callback", () => {
  const cafe = item({
    id: "cafe-fallback",
    title: "Juniper Study Cafe",
    summary: "A quiet café for studying.",
    type: "place",
    category: "study_spot",
    place: { name: "Juniper Study Cafe" },
  });
  const result = context("Plan my week", { items: [PROJECT, cafe], actions: [PROJECT_DUE] });
  const answer = fallbackReply(result);
  assert.match(answer, /Project 1/);
  assert.match(answer, /Mon, Aug 17/);
  assert.match(answer, /Juniper Study Cafe/);
  assert.equal(validateReply(result, answer), null);
});

test("completed, past, and beyond-horizon actions cannot distort the plan", () => {
  const result = context("Plan my week", {
    items: [PROJECT],
    actions: [
      PROJECT_DUE,
      action({ id: "done", itemId: "project-1", description: "Done task", due: "2026-08-12", status: "completed" }),
      action({ id: "past", itemId: "project-1", description: "Past task", due: "2026-08-01" }),
      action({ id: "far", itemId: "project-1", description: "Far task", due: "2026-09-30" }),
    ],
  });
  assert.deepEqual(result.upcomingDeadlines.map((entry) => entry.actionId), ["action-project-1"]);
  assert.deepEqual(result.savedItems[0]?.actions.map((entry) => entry.actionId), ["action-project-1", "far"]);
});

test("one student cannot retrieve another student's items, actions, or messages", () => {
  const foreign = item({
    id: "foreign-secret",
    title: "Other Student Project",
    summary: "Private work.",
    studentId: "student-b",
  });
  const result = context("What did I save?", {
    items: [PROJECT, foreign],
    actions: [
      PROJECT_DUE,
      action({ id: "foreign-action", itemId: "foreign-secret", description: "Secret due", due: "2026-08-13", studentId: "student-b" }),
    ],
    messages: [
      message({ id: "mine", direction: "inbound", content: "My message" }),
      message({ id: "theirs", direction: "inbound", content: "Private message", studentId: "student-b" }),
    ],
  });
  const rendered = renderContext(result);
  assert.doesNotMatch(rendered, /foreign-secret|Other Student|Secret due|Private message/);
  assert.deepEqual(result.savedItems.map((entry) => entry.itemId), ["project-1"]);
});

test("an action linked to an item outside the student's item set is excluded conservatively", () => {
  const result = context("What is due?", {
    items: [PROJECT],
    actions: [
      PROJECT_DUE,
      action({ id: "bad-link", itemId: "foreign-item", description: "Foreign work due", due: "2026-08-12" }),
    ],
  });
  assert.deepEqual(result.upcomingDeadlines.map((entry) => entry.actionId), ["action-project-1"]);
});

test("a follow-up reference such as 'When is it due?' resolves from recent conversation", () => {
  const other = item({ id: "essay", title: "History Essay", summary: "An essay on trade routes." });
  const result = context("When is it due?", {
    items: [other, PROJECT],
    actions: [PROJECT_DUE],
    messages: [
      message({ id: "m1", direction: "inbound", content: "What about Project 1?" }),
      message({ id: "m2", direction: "outbound", content: "I found Project 1 in your saved syllabus." }),
      message({ id: "m3", direction: "inbound", content: "When is it due?" }),
    ],
  });
  assert.equal(result.request.matchStatus, "matched");
  assert.equal(result.request.resolvedReferenceItemId, "project-1");
});

test("malformed stored data fails conservatively instead of becoming evidence", () => {
  const malformedItem = { ...PROJECT, id: null, summary: null };
  const malformedAction = { ...PROJECT_DUE, due_date: "August someday" };
  const malformedMessage = { ...message({ id: "bad-message", direction: "inbound", content: "hello" }), direction: "sideways" };
  const result = context("What did I save?", {
    items: [malformedItem, PROJECT],
    actions: [malformedAction],
    messages: [malformedMessage],
  });
  assert.equal(result.droppedMalformedRows, 3);
  assert.deepEqual(result.savedItems.map((entry) => entry.itemId), ["project-1"]);
  assert.deepEqual(result.upcomingDeadlines, []);
});

test("context stays within its deliberate budget under token pressure", () => {
  const items = Array.from({ length: 50 }, (_, index) => item({
    id: `item-${index}`,
    title: `Long saved item ${index}`,
    summary: "x".repeat(2_000),
    createdAt: `2026-08-${String(10 - Math.min(index, 9)).padStart(2, "0")}T12:00:00Z`,
  }));
  const messages = Array.from({ length: 20 }, (_, index) => message({
    id: `message-${index}`,
    direction: index % 2 ? "outbound" : "inbound",
    content: "y".repeat(1_000),
  }));
  const rendered = renderContext(context("What did I save?", { items, messages }));
  assert.ok(rendered.length <= 8_000);
  assert.match(rendered, /omitted|clipped/);
});

test("compact profile preserves stored schedule evidence for a supported lighter day", () => {
  const result = assembleContext({
    student: {
      ...STUDENT,
      profile: { schedule: { Thursday: ["class at 10"], Friday: ["class at 9", "lab at 2"] } },
    },
    question: "Plan my week",
    today: TODAY,
    rows: { items: [PROJECT], actions: [PROJECT_DUE], messages: [] },
  });
  const rendered = renderContext(result);
  assert.deepEqual(result.lighterDay, { day: "Thursday", storedCommitments: 1 });
  assert.match(rendered, /Thursday/);
  assert.match(rendered, /class at 10/);
  const answer = fallbackReply(result);
  assert.match(answer, /Thursday is lighter/);
  assert.equal(validateReply(result, answer), null);
});

test("a tied or underspecified schedule does not manufacture a lighter day", () => {
  const tied = assembleContext({
    student: { ...STUDENT, profile: { schedule: { Monday: ["class"], Thursday: ["lab"] } } },
    question: "Plan my week",
    today: TODAY,
    rows: { items: [PROJECT], actions: [PROJECT_DUE], messages: [] },
  });
  assert.equal(tied.lighterDay, null);
});

test("plural deadline fallback answers directly without database-like narration", () => {
  const second = action({
    id: "quiz",
    itemId: "project-1",
    description: "Reading quiz due",
    due: "2026-08-14",
  });
  const result = context("What do I have coming up?", {
    items: [PROJECT],
    actions: [second, PROJECT_DUE],
  });
  const answer = fallbackReply(result);
  assert.equal(answer, "2 coming up: Reading quiz Fri, Aug 14, then Project 1 Mon, Aug 17.");
  assert.doesNotMatch(answer, /stored|saved action|record|retriev/i);
  assert.equal(validateReply(result, answer), null);
});

test("honest empty states are short and do not append an offer", () => {
  const result = context("What is due this week?", {});
  const answer = fallbackReply(result);
  assert.equal(answer, "Nothing due in the next two weeks.");
  assert.doesNotMatch(answer, /would you|let me know|anything else/i);
  assert.equal(validateReply(result, answer), null);
});

test("planning fallback chooses a priority and sequence instead of listing", () => {
  const second = action({
    id: "project-2",
    itemId: "project-1",
    description: "Project 2 due",
    due: "2026-08-20",
  });
  const result = context("Plan my week", { items: [PROJECT], actions: [PROJECT_DUE, second] });
  const answer = fallbackReply(result);
  assert.match(answer, /^I’d start with Project 1/);
  assert.match(answer, /Then move to Project 2/);
  assert.equal(validateReply(result, answer), null);
});

test("every later deadline a plan mentions must preserve its own date", () => {
  const meeting = action({
    id: "club-meeting",
    itemId: "project-1",
    description: "Club meeting",
    due: "2026-08-15",
  });
  const result = context("Plan my week", { items: [PROJECT], actions: [PROJECT_DUE, meeting] });
  assert.match(
    validateReply(
      result,
      "I’d start with Club meeting on Thu, Aug 15, then move to Project 1, due Mon, Aug 17.",
    ) ?? "",
    /2026-08-15/,
  );
  assert.equal(
    validateReply(
      result,
      "I’d start with Club meeting on Sat, Aug 15, then move to Project 1, due Mon, Aug 17.",
    ),
    null,
  );
});

test("a useful place is optional in a plan rather than mandatory memory display", () => {
  const cafe = item({
    id: "cafe-optional",
    title: "Juniper",
    summary: "A quiet café.",
    type: "place",
    place: { name: "Juniper" },
  });
  const result = context("What should I do first?", { items: [PROJECT, cafe], actions: [PROJECT_DUE] });
  assert.equal(validateReply(result, "I’d start with Project 1, due Mon, Aug 17."), null);
});

test("questions are rejected after a complete answer but required for true ambiguity", () => {
  const complete = context("When is Project 1 due?", { items: [PROJECT], actions: [PROJECT_DUE] });
  assert.match(
    validateReply(complete, "Project 1 is due Mon, Aug 17. Want help planning?") ?? "",
    /generic offer|question is needed/i,
  );

  const places = [
    item({ id: "p1", title: "Juniper", summary: "Quiet.", type: "place", place: { name: "Juniper" } }),
    item({ id: "p2", title: "Common Grounds", summary: "Outlets.", type: "place", place: { name: "Common Grounds" } }),
  ];
  const ambiguous = context("What was the café I saved?", { items: places });
  assert.match(validateReply(ambiguous, "Juniper and Common Grounds both fit.") ?? "", /question/i);
  assert.equal(validateReply(ambiguous, "Juniper or Common Grounds — which one do you mean?"), null);
});

test("multi-turn 'what is next' skips the answer the user just saw", () => {
  const quiz = action({
    id: "quiz-follow-up",
    itemId: "project-1",
    description: "Reading quiz due",
    due: "2026-08-14",
  });
  const result = context("What’s next after that?", {
    items: [PROJECT],
    actions: [quiz, PROJECT_DUE],
    messages: [
      message({ id: "u1", direction: "inbound", content: "What is due first?" }),
      message({ id: "a1", direction: "outbound", content: "Reading quiz is due Fri, Aug 14." }),
      message({ id: "u2", direction: "inbound", content: "What’s next after that?" }),
    ],
  });
  const answer = fallbackReply(result);
  assert.equal(answer, "Project 1 is due Mon, Aug 17.");
  assert.doesNotMatch(answer, /Reading quiz/);
  assert.equal(validateReply(result, answer), null);
});

test("mutation validation keeps confirmations short and prevents recap", () => {
  const result = context("Add the club meeting for August 15", { items: [PROJECT], actions: [PROJECT_DUE] });
  const attempt = {
    completedTools: [{
      name: "save_note",
      result: JSON.stringify({
        ok: true,
        kind: "mutation",
        confirmation: "Done — club meeting added for Sat, Aug 15.",
        required_terms: ["club meeting", "Sat, Aug 15"],
      }),
    }],
  };
  assert.equal(validateReply(result, "Done — club meeting added for Sat, Aug 15.", attempt), null);
  assert.match(
    validateReply(
      result,
      "Done — club meeting added for Sat, Aug 15. Project 1 is still due Mon, Aug 17. Want help planning?",
      attempt,
    ) ?? "",
    /generic offer|too long/i,
  );
});

test("a resolved successful mutation does not ask again just because retrieval was ambiguous", () => {
  const places = [
    item({ id: "m1", title: "Juniper", summary: "Quiet.", type: "place", place: { name: "Juniper" } }),
    item({ id: "m2", title: "Common Grounds", summary: "Outlets.", type: "place", place: { name: "Common Grounds" } }),
  ];
  const result = context("What was the cafe I saved?", { items: places });
  assert.equal(result.request.matchStatus, "ambiguous");
  const attempt = {
    completedTools: [{
      name: "cancel_reminder",
      result: JSON.stringify({
        ok: true,
        kind: "reminder",
        confirmation: "Done — reminder cancelled.",
        required_terms: ["cancelled"],
      }),
    }],
  };
  assert.equal(validateReply(result, "Done — reminder cancelled.", attempt), null);
});

test("reminder confirmation requires the exact chosen time and no generic closer", () => {
  const result = context("Remind me tomorrow instead", { items: [PROJECT], actions: [PROJECT_DUE] });
  const attempt = {
    completedTools: [{
      name: "reschedule_reminder",
      result: JSON.stringify({
        ok: true,
        kind: "reminder",
        confirmation: "Done — I’ll remind you Thu, Aug 13 at 6:00 PM.",
        required_terms: ["Thu, Aug 13 at 6:00 PM"],
      }),
    }],
  };
  assert.match(validateReply(result, "Done — reminder moved.", attempt) ?? "", /Thu, Aug 13/);
  assert.equal(validateReply(result, "Done — I’ll remind you Thu, Aug 13 at 6:00 PM.", attempt), null);
});

test("a failed mutation cannot be phrased as completed", () => {
  const result = context("Move the reminder to yesterday", { items: [PROJECT], actions: [PROJECT_DUE] });
  const attempt = {
    completedTools: [{
      name: "reschedule_reminder",
      result: JSON.stringify({
        ok: false,
        user_message: "That reminder time has already passed. When should I move it to?",
        needs_clarification: true,
      }),
    }],
  };
  assert.match(validateReply(result, "Done — reminder moved?", attempt) ?? "", /do not claim success/i);
  assert.equal(validateReply(result, "That time has already passed — when should I move it to?", attempt), null);
});

test("an undated reminder request asks only for the missing time", () => {
  const result = context("Remind me about the club meeting", {});
  const attempt = {
    completedTools: [{
      name: "save_note",
      result: JSON.stringify({
        ok: true,
        kind: "reminder",
        needs_clarification: true,
        confirmation: "Club meeting is saved — when should I remind you?",
        required_terms: ["Club meeting"],
      }),
    }],
  };
  assert.equal(validateReply(result, "Club meeting is saved — when should I remind you?", attempt), null);
});

test("undo confirmation is mutation-gated and must preserve the removed item", () => {
  const result = context("Actually don't save that", { items: [PROJECT], actions: [PROJECT_DUE] });
  const attempt = {
    completedTools: [{
      name: "undo_last_save",
      result: JSON.stringify({
        ok: true,
        kind: "mutation",
        confirmation: "Done — removed Project 1.",
        required_terms: ["removed", "Project 1"],
      }),
    }],
  };
  assert.equal(validateReply(result, "Done — removed Project 1.", attempt), null);
  assert.match(validateReply(result, "Done — removed it.", attempt) ?? "", /Project 1/);
});

test("a failed undo cannot be phrased as a deletion", () => {
  const result = context("Actually don't save that", {});
  const attempt = {
    completedTools: [{
      name: "undo_last_save",
      result: JSON.stringify({
        ok: false,
        user_message: "I couldn’t find a recent save to remove.",
      }),
    }],
  };
  assert.match(validateReply(result, "Done — deleted it.", attempt) ?? "", /do not claim success/i);
  assert.equal(validateReply(result, "I couldn’t find a recent save to remove.", attempt), null);
});
