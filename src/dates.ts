// Date helpers, dependency-free on purpose.
//
// These used to live in llm.ts and ingest.ts, which drag in env.ts, the Supabase
// client and sharp. The action-admission logic needs them and is the part worth
// unit-testing, so they live here where a test can import them without a
// database or an API key.

/** Local time-zone offset, in ms, at a given instant. */
function offsetMs(instant: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Some engines render midnight as hour 24.
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - instant.getTime();
}

/** Today in the student's timezone, ISO yyyy-mm-dd. Dates in a document are
 *  usually bare ("Oct 14"), so the model needs the current date to resolve a
 *  year — and "next Thursday" needs it too. */
export function today(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * 9am the day before it's due, in the student's timezone. The Phase 4 cron
 * fires on this; `npm run remind:now` overrides it for the recording so the
 * demo never waits on wall-clock time.
 */
export function remindAtFor(dueDate: string, timezone: string): string | null {
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;

  const wall = new Date(due.getTime() - 24 * 3600_000 + 9 * 3600_000);
  // Second pass so a DST boundary between the guess and the real instant
  // doesn't shift the reminder by an hour.
  const guess = new Date(wall.getTime() - offsetMs(wall, timezone));
  return new Date(wall.getTime() - offsetMs(guess, timezone)).toISOString();
}

/**
 * "Thu, Oct 14", or "Thu, Oct 14, 2021" with `year`. iMessage renders plain
 * text, so no markdown anywhere. The year is worth the extra words whenever the
 * date isn't in the current term — a bare "Mar 30" reads as upcoming, which is
 * exactly the confusion the stale-date question exists to resolve.
 */
export function friendly(
  dueDate: string,
  timezone: string,
  options?: { year?: boolean },
): string {
  const date = new Date(`${dueDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dueDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(options?.year ? { year: "numeric" as const } : {}),
  }).format(date);
}

/** ISO yyyy-mm-dd, and a real calendar day. Guards anything the model hands us. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
