import assert from "node:assert/strict";
import test from "node:test";

import { scheduleTask } from "./task-scheduling.ts";

const NOW = new Date("2026-08-13T12:00:00.000Z");

test("a due date stays actionable without silently scheduling a reminder", () => {
  const result = scheduleTask(
    "2026-08-16",
    "UTC",
    { tracked: true, reminder: false },
    null,
    NOW,
  );
  assert.equal(result.status, "open");
  assert.equal(result.remindAt, null);
});

test("an explicit reminder request schedules the same due task", () => {
  const result = scheduleTask(
    "2026-08-16",
    "UTC",
    { tracked: true, reminder: true },
    null,
    NOW,
  );
  assert.equal(result.status, "open");
  assert.ok(result.remindAt);
});

test("a past date cannot schedule a reminder", () => {
  const result = scheduleTask(
    "2026-08-12",
    "UTC",
    { tracked: true, reminder: true },
    null,
    NOW,
  );
  assert.equal(result.status, "reference");
  assert.equal(result.remindAt, null);
});
