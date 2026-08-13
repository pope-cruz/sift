import assert from "node:assert/strict";
import test from "node:test";

import { reminderPresentationDelta } from "./reminder-delta.ts";

const OLD = { actionId: "old", targetTime: "2026-08-14T10:00:00.000Z" };
const NEW = { actionId: "new", targetTime: "2026-08-16T10:00:00.000Z" };

test("an unrelated turn does not surface a pre-existing reminder", () => {
  assert.equal(reminderPresentationDelta([OLD], [OLD]), null);
});

test("a newly scheduled or rescheduled reminder updates the demo control", () => {
  assert.deepEqual(reminderPresentationDelta([], [NEW]), { type: "show", reminder: NEW });
  const moved = { ...OLD, targetTime: "2026-08-15T10:00:00.000Z" };
  assert.deepEqual(reminderPresentationDelta([OLD], [moved]), { type: "show", reminder: moved });
});

test("cancelling the last reminder clears the demo control", () => {
  assert.deepEqual(reminderPresentationDelta([OLD], []), { type: "clear" });
});
