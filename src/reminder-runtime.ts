import { randomUUID } from "node:crypto";

import cron, { type ScheduledTask } from "node-cron";
import type { Space, SpectrumInstance } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import {
  claimDueReminders,
  markReminderDelivered,
  recordMessage,
  releaseReminderForRetry,
} from "./db.ts";
import { safeDiagnostic } from "./diagnostics.ts";
import {
  runReminderBatch,
  type ReminderBatchResult,
  type ReminderClaim,
  type ReminderStore,
} from "./reminders.ts";

const store: ReminderStore = {
  claimDue: claimDueReminders,
  markDelivered: (claim) => markReminderDelivered(claim),
  releaseForRetry: (claim, retryAt) => releaseReminderForRetry(claim, retryAt),
};

/** Shared by the minute worker and the remind:now CLI. */
export async function runProductionReminderBatch(
  app: SpectrumInstance,
  options?: { now?: Date; limit?: number },
): Promise<ReminderBatchResult> {
  const spaces = new Map<string, Promise<Space>>();

  return runReminderBatch({
    store,
    now: options?.now,
    limit: options?.limit,
    deliver: async (claim: ReminderClaim, text: string) => {
      let pending = spaces.get(claim.spaceId);
      if (!pending) {
        // `space.get` is the proactive iMessage path. A single-line/shared
        // project needs no phone routing argument.
        pending = imessage(app).space.get(claim.spaceId) as Promise<Space>;
        spaces.set(claim.spaceId, pending);
      }
      const space = await pending;
      const sent = await space.send(text);

      // Transcript persistence is useful grounding for "cancel that" on the
      // next turn, but it must not turn an acknowledged provider callback into
      // a retry and duplicate the visible message.
      try {
        await recordMessage({
          studentId: claim.studentId,
          photonMessageId: sent?.id ?? `reminder-${claim.actionId}-${randomUUID()}`,
          direction: "outbound",
          content: text,
        });
      } catch (error) {
        console.error("failed to persist delivered reminder transcript", {
          actionId: claim.actionId,
          error: safeDiagnostic(error),
        });
      }

      return sent?.id ?? null;
    },
    onError: (stage, error, claim) => {
      console.error("reminder worker error", {
        stage,
        actionId: claim.actionId,
        error: safeDiagnostic(error),
      });
    },
  });
}

export type ReminderWorker = { stop(): void; tick(): Promise<ReminderBatchResult | null> };

/** One in-process minute tick; database claiming makes multiple app workers safe. */
export function startReminderWorker(app: SpectrumInstance): ReminderWorker {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<ReminderBatchResult | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      const result = await runProductionReminderBatch(app);
      if (result.claimed > 0) console.log({ reminder_batch: result });
      return result;
    } catch (error) {
      console.error("reminder tick failed", { error: safeDiagnostic(error) });
      return null;
    } finally {
      running = false;
    }
  };

  const task: ScheduledTask = cron.schedule("* * * * *", () => void tick(), {
    noOverlap: true,
  });
  void tick();

  return {
    tick,
    stop() {
      stopped = true;
      task.stop();
    },
  };
}
