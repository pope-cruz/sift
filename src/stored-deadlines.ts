const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function key(value: unknown): string {
  return typeof value === "string"
    ? value.toLocaleLowerCase("en-US").replace(/[.\s]+$/, "").trim()
    : "";
}

/** Recover an exact source-stated time without adding a database column. */
export function storedDueTime(
  extractedText: string | null | undefined,
  description: string,
  dueDate: string,
): string | null {
  if (!extractedText) return null;
  let stored: { candidates?: unknown; text_note_deadlines?: unknown };
  try {
    stored = JSON.parse(extractedText);
  } catch {
    return null;
  }

  const rows = [
    ...(Array.isArray(stored.candidates) ? stored.candidates : []),
    ...(Array.isArray(stored.text_note_deadlines) ? stored.text_note_deadlines : []),
  ] as Record<string, unknown>[];
  const wanted = key(description);
  const match = rows.find((row) => {
    const label = key(row.label ?? row.description);
    const date = row.normalized_date ?? row.due_date;
    return label === wanted && date === dueDate;
  });
  const time = match?.normalized_time ?? match?.due_time;
  return typeof time === "string" && TIME.test(time) ? time : null;
}
