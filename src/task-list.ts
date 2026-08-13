export type ListedTask = { description: string; due_date?: string; due_time?: string };

const SAVE_INTENT = /\b(save|remember|keep|add|track|note)\b/i;
const TASK_NOUN = /\b(tasks?|to-?dos?|chores?|task list)\b/i;

function identity(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(end of (?:day|week))\b/g, "")
    .replace(/\((?:eod|eow)\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^to\s+/, "")
    .trim();
}

type VisibleTask = {
  description: string;
  hasTrailingGroupDeadline: boolean;
};

/**
 * A deadline instruction after the final bullet applies to the list; it is not
 * another part of that task's name. Messages flattens pasted lists often, so
 * this has to work without relying on a newline before "set deadline".
 */
function visibleTask(value: string): VisibleTask {
  const cleaned = value.trim().replace(/[.;,]+$/, "");
  const groupDeadline = cleaned.match(
    /\s+(?:(?:set|make|give|put|use)\s+(?:the\s+)?(?:same\s+)?(?:deadline|due\s+date)\s+(?:to|as|for|on)|(?:set|make)\s+(?:all|each|every|these|them)\s+due\s+(?:to|by|on)?|(?:all|each|every|these|them)\s+(?:are\s+)?due\s+(?:by|on))\s+.+$/i,
  );
  if (!groupDeadline?.index) return { description: cleaned, hasTrailingGroupDeadline: false };
  return {
    description: cleaned.slice(0, groupDeadline.index).trim().replace(/[.;,]+$/, ""),
    hasTrailingGroupDeadline: true,
  };
}

/**
 * Preserve explicitly enumerated tasks before a save_note tool call reaches
 * storage. Models can over-focus on the final bullet in a compact text; this
 * guard is intentionally narrow and only activates for a save/todo request
 * containing at least two visible list markers.
 */
export function mergeListedTasks(
  text: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!SAVE_INTENT.test(text) || !TASK_NOUN.test(text)) return input;

  const marker = /(?:^|[\s\n])(?:[-–—*•]|\d+[.)]|[☐☑]|\[[ xX]\])\s+/gm;
  const matches = [...text.matchAll(marker)];
  let candidates = matches.length >= 2
    ? matches.map((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? text.length;
        return text.slice(start, end);
      })
    : [];

  // Compact messages are often written as "tasks: email Jen; submit form; eat".
  // Only split delimiter prose when the task noun introduces at least three
  // independent fragments; this keeps ordinary commas in a single note intact.
  if (candidates.length < 2) {
    const tail = text.match(/\b(?:task list|tasks?|to-?do list|to-?dos?|chores?)\b\s*[:,\-]?\s*(.+)$/is)?.[1] ?? "";
    const delimiter = tail.includes(";") ? /\s*;\s*/ : /\s*,\s*/;
    const split = tail.split(delimiter);
    if (split.length >= 3) candidates = split;
  }

  const visible = candidates.map(visibleTask);
  const listed = visible
    .map(({ description }) => description)
    .filter((description) => description.length > 0 && description.length <= 240)
    .slice(0, 20);
  if (listed.length < 2) return input;

  const existing = Array.isArray(input.deadlines)
    ? (input.deadlines as ListedTask[]).filter((task) => task && typeof task.description === "string")
    : [];
  const trailingGroupDeadline = visible.some((task) => task.hasTrailingGroupDeadline);
  const dated = existing.filter((task) => task.due_date);
  const sharedDate = trailingGroupDeadline && dated.length > 0 && dated.every((task) => task.due_date === dated[0]!.due_date)
    ? { due_date: dated[0]!.due_date, ...(dated[0]!.due_time ? { due_time: dated[0]!.due_time } : {}) }
    : {};
  const merged = listed.map((description) => {
    const selected = existing.find((task) => identity(task.description) === identity(description));
    return selected ?? { description, ...sharedDate };
  });
  for (const task of existing) {
    if (!merged.some((candidate) => identity(candidate.description) === identity(task.description))) merged.push(task);
  }

  return {
    ...input,
    title: listed.length > 1 ? "Task list" : input.title,
    summary: `Tasks: ${listed.join("; ")}`,
    deadlines: merged,
  };
}
