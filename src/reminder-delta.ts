export type PendingReminderState = { actionId: string; targetTime: string };

export type ReminderPresentationDelta =
  | { type: "show"; reminder: PendingReminderState }
  | { type: "clear" }
  | null;

/**
 * The demo control follows changes made by this turn only. Merely saving a
 * café or asking a question must not surface some older pending reminder and
 * imply that the current message scheduled it.
 */
export function reminderPresentationDelta(
  before: PendingReminderState[],
  after: PendingReminderState[],
): ReminderPresentationDelta {
  const signature = (rows: PendingReminderState[]) => rows
    .map((row) => `${row.actionId}:${row.targetTime}`)
    .join("|");
  if (signature(before) === signature(after)) return null;
  if (after.length === 0) return { type: "clear" };
  return { type: "show", reminder: after[0]! };
}
