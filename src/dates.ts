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

/** Convert a wall-clock date/time in an IANA timezone into one UTC instant. */
export function localInstant(
  date: string,
  time: string,
  timezone: string,
): Date | null {
  if (!isIsoDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;

  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const guess = new Date(wall.getTime() - offsetMs(wall, timezone));
  return new Date(wall.getTime() - offsetMs(guess, timezone));
}

function shiftDate(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** Today in the student's timezone, ISO yyyy-mm-dd. Dates in a document are
 *  usually bare ("Oct 14"), so the model needs the current date to resolve a
 *  year — and "next Thursday" needs it too. */
export function today(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Infer one Phase 4 reminder instant.
 *
 * Actions currently store calendar dates, not exact due times, so 8pm is the
 * single documented local default. The send choice is deterministic inside
 * the product bounds: two hours from now inside 24h, 6pm the evening before
 * inside three days, otherwise 6pm two days before. An imminent deadline uses
 * the midpoint rather than scheduling after it.
 */
export function remindAtFor(
  dueDate: string,
  timezone: string,
  now: Date = new Date(),
  dueTime: string | null = null,
): string | null {
  const due = localInstant(dueDate, dueTime ?? "20:00", timezone);
  if (!due || due.getTime() <= now.getTime()) return null;

  const hour = 3600_000;
  const remaining = due.getTime() - now.getTime();
  let planned: Date;

  if (remaining <= 24 * hour) {
    // Keep the normal choice in the requested 1–3h range. If less than two
    // hours remain, the midpoint is the only useful future time before due.
    planned = new Date(now.getTime() + Math.min(2 * hour, remaining / 2));
  } else if (remaining <= 72 * hour) {
    planned = localInstant(shiftDate(dueDate, -1), "18:00", timezone)!;
  } else {
    planned = localInstant(shiftDate(dueDate, -2), "18:00", timezone)!;
  }

  // DST and edge-of-band wall times can put the nominal evening choice behind
  // now. Fall back to the same near-term rule, always before the deadline.
  if (planned.getTime() <= now.getTime()) {
    planned = new Date(now.getTime() + Math.min(2 * hour, remaining / 2));
  }

  return planned.getTime() < due.getTime() ? planned.toISOString() : null;
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
