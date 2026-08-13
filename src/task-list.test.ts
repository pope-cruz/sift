import assert from "node:assert/strict";
import test from "node:test";

import { mergeListedTasks } from "./task-list.ts";

test("compact task lists keep every item when the model only selected the last one", () => {
  const result = mergeListedTasks(
    "Hi can you save my tasks, - email Jen about work (eod) - email Carys about work (eow) - eat dinner",
    { title: "Eat dinner", summary: "Eat dinner", deadlines: [{ description: "Eat dinner" }] },
  );

  assert.equal(result.title, "Task list");
  assert.equal(result.summary, "Tasks: email Jen about work (eod); email Carys about work (eow); eat dinner");
  assert.deepEqual(result.deadlines, [
    { description: "email Jen about work (eod)" },
    { description: "email Carys about work (eow)" },
    { description: "Eat dinner" },
  ]);
});

test("ordinary prose and single-item saves are untouched", () => {
  const input = { title: "Café", summary: "Try the croissant" };
  assert.equal(mergeListedTasks("Remember this café", input), input);
  assert.equal(mergeListedTasks("Save my task - eat dinner", input), input);
});

test("checkbox, em-dash, semicolon, and compact comma lists retain cardinality", () => {
  const selectedLast = { title: "Eat dinner", summary: "Eat dinner", deadlines: [{ description: "Eat dinner" }] };
  const checkbox = mergeListedTasks(
    "Track my chores:\n[ ] wash clothes\n☐ call Mom\n— eat dinner",
    selectedLast,
  );
  assert.equal((checkbox.deadlines as unknown[]).length, 3);

  const semicolons = mergeListedTasks(
    "Save my tasks: email Jen; email Carys; eat dinner",
    selectedLast,
  );
  assert.equal((semicolons.deadlines as unknown[]).length, 3);

  const commas = mergeListedTasks(
    "Remember my todo list, email Jen, email Carys, eat dinner",
    selectedLast,
  );
  assert.equal((commas.deadlines as unknown[]).length, 3);
});

test("a trailing group deadline is not saved as part of the final task", () => {
  const result = mergeListedTasks(
    "can you save these tasks: - schedule axal call - make marketing tasks - play tft with carys set deadline to sunday",
    {
      title: "Task list",
      summary: "Three tasks due Sunday",
      deadlines: [{ description: "Play tft with carys", due_date: "2026-08-16" }],
    },
  );

  assert.deepEqual(result.deadlines, [
    { description: "schedule axal call", due_date: "2026-08-16" },
    { description: "make marketing tasks", due_date: "2026-08-16" },
    { description: "Play tft with carys", due_date: "2026-08-16" },
  ]);
  assert.equal(result.summary, "Tasks: schedule axal call; make marketing tasks; play tft with carys");
});
