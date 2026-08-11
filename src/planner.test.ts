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
  assert.match(answer, /no open saved due date/i);
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
  assert.match(validateReply(result, "You saved a nice coffee shop.") ?? "", /Common Grounds/);
  assert.equal(validateReply(result, "You saved Common Grounds as a study spot."), null);
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
  assert.match(validateReply(result, "Work on Project 1 this week. Take breaks." ) ?? "", /date/);
  assert.match(
    validateReply(result, "Prioritize Project 1, due Mon, Aug 17. Work somewhere quiet.") ?? "",
    /Juniper Study Cafe/,
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
  assert.match(answer, /Thursday is your lightest stored day/);
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
