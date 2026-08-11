import assert from "node:assert/strict";
import { test } from "node:test";

import { localInstant, remindAtFor } from "./dates.ts";
import {
  composeReminder,
  runReminderBatch,
  type ReminderClaim,
  type ReminderStore,
} from "./reminders.ts";
import { storedDueTime } from "./stored-deadlines.ts";

const ZONE = "America/New_York";

function instant(date: string, time: string): Date {
  const result = localInstant(date, time, ZONE);
  assert.ok(result);
  return result;
}

test("a deadline inside 24 hours schedules one reminder two hours from now", () => {
  const now = instant("2026-08-11", "08:00");
  assert.equal(remindAtFor("2026-08-11", ZONE, now), instant("2026-08-11", "10:00").toISOString());
});

test("an exact due time is preserved when choosing the timing band", () => {
  const now = instant("2026-08-11", "08:00");
  assert.equal(
    remindAtFor("2026-08-12", ZONE, now, "07:00"),
    instant("2026-08-11", "10:00").toISOString(),
  );
});

test("a deadline two to three days away schedules the evening before", () => {
  const now = instant("2026-08-11", "08:00");
  assert.equal(remindAtFor("2026-08-13", ZONE, now), instant("2026-08-12", "18:00").toISOString());
});

test("a later deadline schedules two days before in the student's timezone", () => {
  const now = instant("2026-08-11", "08:00");
  assert.equal(remindAtFor("2026-08-20", ZONE, now), instant("2026-08-18", "18:00").toISOString());
});

test("an expired deadline cannot produce a reminder", () => {
  assert.equal(remindAtFor("2026-08-10", ZONE, instant("2026-08-11", "08:00")), null);
});

function claim(overrides: Partial<ReminderClaim> = {}): ReminderClaim {
  return {
    actionId: "action-1",
    studentId: "student-1",
    itemId: "item-1",
    spaceId: "space-1",
    timezone: ZONE,
    description: "CS 4414 reading quiz due",
    dueDate: "2026-08-12",
    dueTime: null,
    plannedSendAt: instant("2026-08-11", "18:00").toISOString(),
    itemTitle: "CS 4414 syllabus",
    itemSummary: "The reading quiz covers process scheduling.",
    ...overrides,
  };
}

test("reminder copy is concise and grounded in the saved action and date", () => {
  assert.equal(
    composeReminder(claim(), instant("2026-08-11", "18:00")),
    "Your CS 4414 reading quiz is due tomorrow. This is a good time to finish it.",
  );
});

test("an exact source-stated time survives storage and appears in the reminder", () => {
  const extracted = JSON.stringify({
    candidates: [{
      label: "CS 4414 reading quiz due",
      normalized_date: "2026-08-12",
      normalized_time: "09:30",
    }],
  });
  const dueTime = storedDueTime(extracted, "CS 4414 reading quiz due", "2026-08-12");
  assert.equal(dueTime, "09:30");
  assert.equal(
    composeReminder(claim({ dueTime }), instant("2026-08-11", "18:00")),
    "Your CS 4414 reading quiz is due tomorrow at 9:30 AM. This is a good time to finish it.",
  );
});

class MemoryStore implements ReminderStore {
  state: "pending" | "claimed" | "delivered" = "pending";
  planned = instant("2026-08-11", "18:00");
  readonly value = claim();

  async claimDue(now: Date): Promise<ReminderClaim[]> {
    if (this.state !== "pending" || this.planned.getTime() > now.getTime()) return [];
    this.state = "claimed";
    return [this.value];
  }

  async markDelivered(): Promise<void> {
    assert.equal(this.state, "claimed");
    this.state = "delivered";
  }

  async releaseForRetry(_claim: ReminderClaim, retryAt: Date): Promise<void> {
    assert.equal(this.state, "claimed");
    this.state = "pending";
    this.planned = retryAt;
  }
}

test("concurrent workers claim and send an action exactly once", async () => {
  const store = new MemoryStore();
  const sent: string[] = [];
  const now = instant("2026-08-11", "18:00");
  const run = () => runReminderBatch({
    store,
    now,
    deliver: async (_claim, text) => {
      sent.push(text);
      return "provider-1";
    },
  });

  const results = await Promise.all([run(), run()]);
  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1);
  assert.equal(sent.length, 1);
  assert.equal(store.state, "delivered");
});

test("a provider failure stays retryable and only the successful callback is delivered", async () => {
  const store = new MemoryStore();
  const firstNow = instant("2026-08-11", "18:00");
  let callbacks = 0;

  const failed = await runReminderBatch({
    store,
    now: firstNow,
    retryDelayMs: 60_000,
    deliver: async () => {
      callbacks += 1;
      throw new Error("provider unavailable");
    },
  });
  assert.equal(failed.retryable, 1);
  assert.equal(store.state, "pending");

  const delivered = await runReminderBatch({
    store,
    now: new Date(firstNow.getTime() + 60_000),
    deliver: async () => {
      callbacks += 1;
      return "provider-2";
    },
  });
  assert.equal(delivered.delivered, 1);
  assert.equal(callbacks, 2, "one rejected attempt and one successful provider callback");
  assert.equal(store.state, "delivered");
});

test("a post-send completion failure is not released into a duplicate retry", async () => {
  const store = new MemoryStore();
  store.markDelivered = async () => { throw new Error("database unavailable"); };
  let sends = 0;

  const result = await runReminderBatch({
    store,
    now: instant("2026-08-11", "18:00"),
    deliver: async () => {
      sends += 1;
      return "provider-1";
    },
  });

  assert.equal(result.completionFailures, 1);
  assert.equal(sends, 1);
  assert.equal(store.state, "claimed");
});
