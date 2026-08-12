import { friendly, today } from "./dates.ts";

export const REMINDER_CLAIMED_STATUS = "reminder_claimed";

export type ReminderClaim = {
  actionId: string;
  studentId: string;
  itemId: string | null;
  spaceId: string;
  timezone: string;
  description: string;
  dueDate: string;
  dueTime: string | null;
  plannedSendAt: string;
  itemTitle: string | null;
  itemSummary: string | null;
};

export type ReminderStore = {
  /** Atomically moves due actions from open to reminder_claimed. */
  claimDue(now: Date, limit: number): Promise<ReminderClaim[]>;
  /** Sets reminder_sent only after the provider callback resolves. */
  markDelivered(claim: ReminderClaim, providerMessageId: string | null): Promise<void>;
  /** Makes a failed callback pending again at a future instant. */
  releaseForRetry(claim: ReminderClaim, retryAt: Date, error: unknown): Promise<void>;
};

function subjectFor(claim: ReminderClaim): string {
  const description = claim.description
    .replace(/\s+(?:is\s+)?due(?:\s+(?:on|by))?\s*$/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (description && !/^(?:task|deadline|due)$/i.test(description)) return description;
  return claim.itemTitle?.trim() || "saved task";
}

function duePhrase(claim: ReminderClaim, now: Date): string {
  const localToday = today(claim.timezone, now);
  const tomorrow = new Date(`${localToday}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = tomorrow.toISOString().slice(0, 10);

  const clock = claim.dueTime
    ? ` at ${new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(`2000-01-01T${claim.dueTime}:00Z`))}`
    : "";
  if (claim.dueDate === localToday) return `today${clock}`;
  if (claim.dueDate === next) return `tomorrow${clock}`;
  return `on ${friendly(claim.dueDate, claim.timezone)}${clock}`;
}

/** Plain, concise copy whose subject and date both come from the claimed row. */
export function composeReminder(claim: ReminderClaim, now: Date = new Date()): string {
  const rawSubject = subjectFor(claim);
  const subject = rawSubject.charAt(0).toLocaleUpperCase("en-US") + rawSubject.slice(1);
  const event = /\b(exam|midterm|final|meeting|interview|presentation)\b/i.test(subject);
  const deadline = event
    ? `${subject} is ${duePhrase(claim, now)}.`
    : `${subject} is due ${duePhrase(claim, now)}.`;
  return `${deadline} ${event ? "Time to get ready." : "Good time to finish it."}`;
}

export type ReminderBatchResult = {
  claimed: number;
  delivered: number;
  retryable: number;
  completionFailures: number;
};

/**
 * The one production send path, shared by the cron tick and remind:now.
 *
 * A callback failure releases the claim for retry. A database failure after a
 * successful callback deliberately does not release it: sending again would
 * be worse than leaving the row claimed for operator reconciliation.
 */
export async function runReminderBatch(input: {
  store: ReminderStore;
  deliver: (claim: ReminderClaim, text: string) => Promise<string | null>;
  now?: Date;
  limit?: number;
  retryDelayMs?: number;
  onError?: (stage: "deliver" | "complete" | "release", error: unknown, claim: ReminderClaim) => void;
}): Promise<ReminderBatchResult> {
  const now = input.now ?? new Date();
  const claims = await input.store.claimDue(now, input.limit ?? 10);
  const result: ReminderBatchResult = {
    claimed: claims.length,
    delivered: 0,
    retryable: 0,
    completionFailures: 0,
  };

  for (const claim of claims) {
    let providerMessageId: string | null;
    try {
      providerMessageId = await input.deliver(claim, composeReminder(claim, now));
    } catch (error) {
      input.onError?.("deliver", error, claim);
      try {
        await input.store.releaseForRetry(
          claim,
          new Date(now.getTime() + (input.retryDelayMs ?? 5 * 60_000)),
          error,
        );
        result.retryable += 1;
      } catch (releaseError) {
        input.onError?.("release", releaseError, claim);
      }
      continue;
    }

    try {
      await input.store.markDelivered(claim, providerMessageId);
      result.delivered += 1;
    } catch (error) {
      result.completionFailures += 1;
      input.onError?.("complete", error, claim);
    }
  }

  return result;
}
