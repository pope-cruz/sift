import { randomUUID } from "node:crypto";

import {
  claimWebDemoReminders,
  markReminderDelivered,
  nextPendingReminder,
  recordMessage,
  releaseReminderForRetry,
} from "./db.ts";
import { runReminderBatch, type ReminderStore } from "./reminders.ts";

export async function runWebDemoReminder(studentId: string): Promise<{ text: string | null; targetTime: string | null }> {
  const pending = await nextPendingReminder(studentId);
  if (!pending) return { text: null, targetTime: null };

  const now = new Date(pending.targetTime);
  let deliveredText: string | null = null;
  const store: ReminderStore = {
    claimDue: (batchNow, limit) => claimWebDemoReminders(studentId, batchNow, limit),
    markDelivered: (claim) => markReminderDelivered(claim),
    releaseForRetry: (claim, retryAt) => releaseReminderForRetry(claim, retryAt),
  };

  await runReminderBatch({
    store,
    now,
    limit: 1,
    deliver: async (claim, text) => {
      deliveredText = text;
      await recordMessage({
        studentId,
        photonMessageId: `web-reminder-${claim.actionId}-${randomUUID()}`,
        direction: "outbound",
        content: text,
      });
      return `web:${claim.actionId}`;
    },
  });
  return { text: deliveredText, targetTime: pending.targetTime };
}
