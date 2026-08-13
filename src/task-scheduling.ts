import { remindAtFor, today } from "./dates.ts";

export function scheduleTask(
  dueDate: string | null,
  timezone: string,
  options: { tracked: boolean; reminder: boolean },
  dueTime: string | null = null,
  now: Date = new Date(),
) {
  const stale = dueDate !== null && dueDate < today(timezone, now);
  const tracked = options.tracked && !stale;
  return {
    status: tracked ? ("open" as const) : ("reference" as const),
    remindAt: tracked && options.reminder && dueDate
      ? remindAtFor(dueDate, timezone, now, dueTime)
      : null,
  };
}
