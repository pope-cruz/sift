// Deterministic context assembly for every retrieve and plan turn.
//
// The database is an evidence store, not a prompt. This module turns its rows
// into one compact, identity-scoped context with explicit provenance. It has no
// database or model dependency, so filtering, ordering, ambiguity, malformed
// data, and the prompt budget are all reproducible in tests.

import { friendly, isIsoDate } from "./dates.ts";
import {
  mutationTools,
  needsClarification,
  parsedToolResult,
  validateConversationalEconomy,
  type ReplyAttempt,
  type ResponseMode,
} from "./response-policy.ts";

export type ContextStudent = {
  id: string;
  name: string | null;
  timezone: string;
  profile: Record<string, unknown>;
};

export type ContextItemRow = {
  id: unknown;
  student_id: unknown;
  type: unknown;
  title: unknown;
  summary: unknown;
  category: unknown;
  extracted_text: unknown;
  created_at: unknown;
};

export type ContextActionRow = {
  id: unknown;
  student_id: unknown;
  item_id: unknown;
  description: unknown;
  due_date: unknown;
  status: unknown;
  created_at: unknown;
};

export type ContextMessageRow = {
  id: unknown;
  student_id: unknown;
  direction: unknown;
  content: unknown;
  created_at: unknown;
};

export type ContextRows = {
  items: ContextItemRow[];
  actions: ContextActionRow[];
  messages: ContextMessageRow[];
};

export type ContextAction = {
  actionId: string;
  itemId: string | null;
  itemTitle: string | null;
  description: string;
  dueDate: string | null;
  source: "actions";
};

export type ContextItem = {
  itemId: string;
  type: string | null;
  title: string | null;
  summary: string;
  category: string | null;
  createdAt: string | null;
  place: { name: string; location: string | null; caption: string | null } | null;
  topics: string[];
  actions: ContextAction[];
  source: "items";
};

export type ContextMessage = {
  messageId: string;
  direction: "inbound" | "outbound";
  content: string;
  source: "messages";
};

export type RequestGrounding = {
  intent: "retrieve" | "plan" | "chitchat";
  candidateItemIds: string[];
  matchStatus: "matched" | "ambiguous" | "not_found" | "not_applicable";
  resolvedReferenceItemId: string | null;
};

export type StudentContext = {
  student: ContextStudent;
  question: string;
  today: string;
  horizonEnd: string;
  request: RequestGrounding;
  lighterDay: { day: string; storedCommitments: number } | null;
  upcomingDeadlines: ContextAction[];
  undatedOpenActions: ContextAction[];
  places: ContextItem[];
  savedItems: ContextItem[];
  messages: ContextMessage[];
  droppedMalformedRows: number;
};

export type ContextOptions = {
  horizonDays?: number;
  maxItems?: number;
  maxPlaces?: number;
  maxMessages?: number;
};

const STOP_WORDS = new Set([
  "a", "about", "am", "an", "and", "anything", "are", "as", "at", "be", "did", "do",
  "for", "have", "i", "in", "is", "it", "me", "my", "of", "on", "please", "saved",
  "that", "the", "this", "to", "was", "what", "when", "where", "which", "with", "you",
]);

const TERM_GROUPS = [
  ["assignment", "assignments", "deadline", "deadlines", "due", "homework", "project", "projects", "task", "tasks", "work"],
  ["cafe", "coffee", "location", "place", "places", "spot", "spots", "study"],
  ["course", "class", "syllabus"],
  ["exam", "exams", "final", "midterm", "test"],
] as const;

const PLAN_PATTERN = /\b(plan|planning|schedule|prioriti[sz]e)\b|\bwork on\b|\bshould i work\b/i;
const DAY_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i;
const RETRIEVE_PATTERN = /\b(assignment|deadline|due|save|saved|remember|cafe|coffee|place|spot|document|note|syllabus|exam|final|midterm|task|tasks|todo|to-do|anything)\b|\b(do i have|did i save|tell me about)\b/i;
const REFERENCE_PATTERN = /\b(it|that|this|those|them|the assignment|the project|the place)\b/i;
const PLACE_PATTERN = /\b(cafe|coffee|place|spot|location|study)\b/i;
const TASK_PATTERN = /\b(tasks?|to-?dos?|chores?|things? (?:to do|i need to do))\b/i;
const COMPLETE_LIST_PATTERN = /\b(all|every|each|entire|complete|everything)\b|\blist\b|\bshow me\b/i;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function folded(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  const result = new Set(
    folded(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );

  for (const group of TERM_GROUPS) {
    if (group.some((term) => result.has(term))) {
      for (const term of group) result.add(term);
    }
  }
  return result;
}

function basicTokens(value: string): Set<string> {
  return new Set(
    folded(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function placeDetails(extractedText: unknown) {
  if (typeof extractedText !== "string" || extractedText.length > 250_000) return null;
  try {
    const parsed = JSON.parse(extractedText) as { place?: unknown; topics?: unknown };
    if (!parsed.place || typeof parsed.place !== "object") return null;
    const place = parsed.place as Record<string, unknown>;
    const name = text(place.name);
    if (!name) return null;
    return { name, location: text(place.location), caption: text(place.caption) };
  } catch {
    return null;
  }
}

function itemTopics(extractedText: unknown): string[] {
  if (typeof extractedText !== "string" || extractedText.length > 250_000) return [];
  try {
    const parsed = JSON.parse(extractedText) as { topics?: unknown };
    if (!Array.isArray(parsed.topics)) return [];
    return parsed.topics.flatMap((topic) => (text(topic) ? [text(topic)!] : [])).slice(0, 12);
  } catch {
    return [];
  }
}

function actionFromRow(row: ContextActionRow): ContextAction | null {
  const actionId = text(row.id);
  const studentId = text(row.student_id);
  const description = text(row.description);
  const itemId = text(row.item_id);
  const status = text(row.status);
  const rawDue = text(row.due_date);
  if (!actionId || !studentId || !description || status !== "open") return null;
  if (rawDue !== null && !isIsoDate(rawDue)) return null;
  return {
    actionId,
    itemId,
    itemTitle: null,
    description,
    dueDate: rawDue,
    source: "actions",
  };
}

function itemFromRow(row: ContextItemRow): ContextItem | null {
  const itemId = text(row.id);
  const studentId = text(row.student_id);
  const summary = text(row.summary);
  if (!itemId || !studentId || !summary) return null;
  return {
    itemId,
    type: text(row.type),
    title: text(row.title),
    summary,
    category: text(row.category),
    createdAt: text(row.created_at),
    place: placeDetails(row.extracted_text),
    topics: itemTopics(row.extracted_text),
    actions: [],
    source: "items",
  };
}

function isPlace(item: ContextItem): boolean {
  const kind = folded(`${item.type ?? ""} ${item.category ?? ""}`);
  return item.place !== null || kind.includes("place") || kind.includes("study spot");
}

function commitmentCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.commitments)) return record.commitments.length;
    return Object.keys(record).length;
  }
  return null;
}

/** A lighter day is stated only when the stored schedule compares at least two
 * weekdays and has one unique minimum. Ties and opaque schedule shapes remain
 * unresolved rather than becoming invented availability. */
function lighterDay(profile: Record<string, unknown>): StudentContext["lighterDay"] {
  const schedule = profile.schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return null;
  const record = schedule as Record<string, unknown>;
  const counts = WEEKDAYS.flatMap((day) => {
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === day.toLowerCase());
    if (!key) return [];
    const count = commitmentCount(record[key]);
    return count === null ? [] : [{ day, count }];
  });
  if (counts.length < 2) return null;
  counts.sort((a, b) => a.count - b.count || WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
  if (counts[0]!.count === counts[1]!.count) return null;
  return { day: counts[0]!.day, storedCommitments: counts[0]!.count };
}

function searchable(item: ContextItem): string {
  return [
    item.title,
    item.summary,
    item.type,
    item.category,
    item.place?.name,
    item.place?.location,
    ...item.topics,
    ...item.actions.map((action) => action.description),
  ]
    .filter(Boolean)
    .join(" ");
}

function score(item: ContextItem, query: string): number {
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return 0;
  const title = folded(item.title ?? item.place?.name ?? "");
  const normalizedQuery = folded(query);
  let value = title && normalizedQuery.includes(title) ? 50 : 0;
  value += overlap(queryTokens, tokens(item.title ?? item.place?.name ?? "")) * 8;
  value += overlap(queryTokens, tokens(searchable(item))) * 2;
  return value;
}

function requestIntent(question: string): RequestGrounding["intent"] {
  if (PLAN_PATTERN.test(question) || (DAY_PATTERN.test(question) && /\b(work|do|study)\b/i.test(question))) {
    return "plan";
  }
  if (
    RETRIEVE_PATTERN.test(question) ||
    (REFERENCE_PATTERN.test(question) && /\b(what|when|where|which)\b/i.test(question))
  ) return "retrieve";
  return "chitchat";
}

function asksForCompleteTaskList(question: string): boolean {
  return TASK_PATTERN.test(question) && COMPLETE_LIST_PATTERN.test(question);
}

function analyzeRequest(
  question: string,
  items: ContextItem[],
  messages: ContextMessage[],
): { grounding: RequestGrounding; ranked: ContextItem[] } {
  const intent = requestIntent(question);
  if (intent === "chitchat" || intent === "plan") {
    return {
      grounding: {
        intent,
        candidateItemIds: [],
        matchStatus: "not_applicable",
        resolvedReferenceItemId: null,
      },
      ranked: items,
    };
  }

  if (
    /^\s*what (did|have) i save(?:d)?\s*[?!.]*\s*$/i.test(question) ||
    /^\s*(show me what|list (my )?saved)/i.test(question)
  ) {
    const chosen = items.slice(0, 3);
    return {
      grounding: {
        intent,
        candidateItemIds: chosen.map((item) => item.itemId),
        matchStatus: chosen.length ? "matched" : "not_found",
        resolvedReferenceItemId: null,
      },
      ranked: items,
    };
  }

  if (asksForCompleteTaskList(question)) {
    const chosen = items.filter((item) => item.actions.length > 0).slice(0, 10);
    return {
      grounding: {
        intent,
        candidateItemIds: chosen.map((item) => item.itemId),
        matchStatus: chosen.length ? "matched" : "not_found",
        resolvedReferenceItemId: null,
      },
      ranked: [...chosen, ...items.filter((item) => !chosen.includes(item))],
    };
  }

  const queryHasReference = REFERENCE_PATTERN.test(question);
  const prior = messages
    .filter((message) => folded(message.content) !== folded(question))
    .slice(-4)
    .map((message) => message.content)
    .join(" ");
  const scoringQuery = queryHasReference ? `${question} ${prior}` : question;
  const scored = items
    .map((item, index) => ({ item, score: score(item, scoringQuery), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  let candidates = scored.filter((entry) => entry.score > 0).slice(0, 3);
  const asksForPlace = PLACE_PATTERN.test(question);
  if (asksForPlace && candidates.length === 0) {
    candidates = scored.filter((entry) => isPlace(entry.item)).slice(0, 3);
  }

  const topScore = candidates[0]?.score ?? 0;
  const equalTop = candidates.filter((entry) => entry.score === topScore);
  const placeCandidates = asksForPlace ? items.filter(isPlace) : [];
  const genericPlaceTerms = new Set([
    "cafe", "coffee", "location", "place", "places", "remember", "save", "saved", "spot", "spots", "study",
  ]);
  const rawQueryTokens = basicTokens(question);
  const genericPlaceQuestion =
    asksForPlace && [...rawQueryTokens].every((token) => genericPlaceTerms.has(token));
  const broadListQuestion =
    /\b(assignments|deadlines|projects|tasks|to-?dos?|places|spots|anything|all|every|coming up|this week)\b/i.test(question);
  const ambiguous =
    !broadListQuestion && (
      (equalTop.length > 1 && topScore > 0) ||
      (genericPlaceQuestion && placeCandidates.length > 1)
    );
  const chosen = ambiguous && asksForPlace ? placeCandidates.slice(0, 3) : candidates.map((entry) => entry.item);
  const ids = chosen.map((item) => item.itemId);
  const resolvedReference = queryHasReference && ids.length === 1 ? ids[0]! : null;

  return {
    grounding: {
      intent,
      candidateItemIds: ids,
      matchStatus: ids.length === 0 ? "not_found" : ambiguous ? "ambiguous" : "matched",
      resolvedReferenceItemId: resolvedReference,
    },
    ranked: [...chosen, ...scored.map((entry) => entry.item).filter((item) => !ids.includes(item.itemId))],
  };
}

/**
 * Assemble the only evidence object the answering model receives.
 *
 * Rows are filtered by student id again even though every database query is
 * already scoped. This defense in depth makes cross-student leakage impossible
 * even if a future repository adapter accidentally returns a mixed batch.
 */
export function assembleContext(input: {
  student: ContextStudent;
  question: string;
  today: string;
  rows: ContextRows;
  options?: ContextOptions;
}): StudentContext {
  if (!isIsoDate(input.today)) throw new Error("context today must be an ISO date");
  const horizonEnd = addDays(input.today, input.options?.horizonDays ?? 14);
  let droppedMalformedRows = 0;

  const items = input.rows.items
    .filter((row) => text(row.student_id) === input.student.id)
    .map((row) => itemFromRow(row))
    .flatMap((item) => {
      if (item) return [item];
      droppedMalformedRows += 1;
      return [];
    });
  const itemById = new Map(items.map((item) => [item.itemId, item]));

  const actions = input.rows.actions
    .filter((row) => text(row.student_id) === input.student.id)
    .map((row) => actionFromRow(row))
    .flatMap((action) => {
      if (action) return [action];
      droppedMalformedRows += 1;
      return [];
    })
    // A linked action must point to an item owned by the same student. Null is
    // allowed for a standalone action; an unresolved non-null FK is excluded
    // conservatively instead of risking a cross-tenant association.
    .filter((action) => action.itemId === null || itemById.has(action.itemId))
    .filter((action) => action.dueDate === null || action.dueDate >= input.today)
    .map((action) => ({
      ...action,
      itemTitle: action.itemId ? itemById.get(action.itemId)?.title ?? null : null,
    }));

  for (const action of actions) {
    if (action.itemId) itemById.get(action.itemId)?.actions.push(action);
  }
  for (const item of items) {
    item.actions.sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99"));
  }

  const messages = input.rows.messages
    .filter((row) => text(row.student_id) === input.student.id)
    .map((row): ContextMessage | null => {
      const messageId = text(row.id);
      const content = text(row.content);
      const direction = text(row.direction);
      if (!messageId || !content || (direction !== "inbound" && direction !== "outbound")) return null;
      return { messageId, direction, content, source: "messages" };
    })
    .flatMap((message) => {
      if (message) return [message];
      droppedMalformedRows += 1;
      return [];
    })
    .slice(-(input.options?.maxMessages ?? 10));

  const { grounding, ranked } = analyzeRequest(input.question, items, messages);
  const maxItems = input.options?.maxItems ?? 10;
  const savedItems = ranked.slice(0, maxItems);
  const places = items.filter(isPlace).slice(0, input.options?.maxPlaces ?? 6);
  const upcomingDeadlines = actions
    .filter((action): action is ContextAction & { dueDate: string } =>
      action.dueDate !== null && action.dueDate <= horizonEnd,
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.description.localeCompare(b.description));
  const undatedOpenActions = actions.filter((action) => action.dueDate === null).slice(0, 10);

  return {
    student: input.student,
    question: input.question,
    today: input.today,
    horizonEnd,
    request: grounding,
    lighterDay: lighterDay(input.student.profile),
    upcomingDeadlines,
    undatedOpenActions,
    places,
    savedItems,
    messages,
    droppedMalformedRows,
  };
}

function clipped(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return clipped(value, 120);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 8).flatMap((entry) => {
      const compacted = compactValue(entry, depth + 1);
      return compacted === undefined ? [] : [compacted];
    });
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().slice(0, 12)) {
      const compacted = compactValue((value as Record<string, unknown>)[key], depth + 1);
      if (compacted !== undefined) result[key] = compacted;
    }
    return result;
  }
  return undefined;
}

function compactProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return (compactValue(profile, 0) as Record<string, unknown> | undefined) ?? {};
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function section(title: string, lines: string[], budget: number): string {
  const kept: string[] = [title];
  let used = title.length + 1;
  for (let index = 0; index < lines.length; index++) {
    const line = clipped(lines[index]!, 420);
    if (used + line.length + 1 > budget) {
      kept.push(`[${lines.length - index} more omitted to stay within the context budget]`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/**
 * Render an iMessage-sized answer context under a deliberate ~2,000-token
 * ceiling (8,000 characters). Raw attachment bytes and raw extracted documents
 * never enter this representation.
 */
export function renderContext(context: StudentContext, maxCharacters = 8_000): string {
  const current = section("CURRENT", [jsonLine({
    student_name: context.student.name,
    timezone: context.student.timezone,
    today: context.today,
    planning_horizon_end: context.horizonEnd,
    supported_lighter_day: context.lighterDay,
    profile: compactProfile(context.student.profile),
  })], 600);
  const request = section("REQUEST_GROUNDING", [jsonLine({
    ...context.request,
    rule: context.request.matchStatus === "not_found"
      ? "No evidence matched. Say so directly; do not infer one from conversation."
      : context.request.matchStatus === "ambiguous"
        ? "Several items are equally plausible. Name the options and ask one concise clarification."
        : "Use only the cited evidence and answer without narrating how it was found.",
  })], 700);
  const deadlines = section(
    "UPCOMING_DEADLINES_NEXT_14_DAYS (chronological; authoritative for plans)",
    context.upcomingDeadlines.length
      ? context.upcomingDeadlines.map((action) => jsonLine(action))
      : ["NONE"],
    2_400,
  );
  const undated = section(
    "UNDATED_OPEN_ACTIONS",
    context.undatedOpenActions.length ? context.undatedOpenActions.map((action) => jsonLine(action)) : ["NONE"],
    400,
  );
  const places = section(
    "RELEVANT_PLACES",
    context.places.length
      ? context.places.map((item) => jsonLine({
          item_id: item.itemId,
          name: item.place?.name ?? item.title,
          location: item.place?.location ?? null,
          summary: clipped(item.summary, 180),
          source: item.source,
        }))
      : ["NONE"],
    700,
  );
  const items = section(
    "RELEVANT_OR_RECENT_CONTEXT",
    context.savedItems.length
      ? context.savedItems.map((item) => jsonLine({
          item_id: item.itemId,
          type: item.type,
          title: item.title,
          summary: clipped(item.summary, 220),
          category: item.category,
          topics: item.topics.slice(0, 8),
          open_dates: item.actions.map((action) => ({
            action_id: action.actionId,
            description: action.description,
            due_date: action.dueDate,
          })),
          source: item.source,
        }))
      : ["NONE"],
    1_400,
  );
  const history = section(
    "RECENT_CONVERSATION (oldest first)",
    context.messages.length
      ? context.messages.map((message) => jsonLine({
          message_id: message.messageId,
          direction: message.direction,
          content: clipped(message.content, 240),
          source: message.source,
        }))
      : ["NONE"],
    1_200,
  );

  const rendered = [current, request, deadlines, undated, places, items, history].join("\n\n");
  if (rendered.length <= maxCharacters) return rendered;
  return `${rendered.slice(0, Math.max(0, maxCharacters - 42)).trimEnd()}\n[context clipped at ${maxCharacters} characters]`;
}

function answerKey(value: string): string {
  return folded(value).replace(/\s+/g, " ");
}

function containsAnswerKey(answer: string, value: string): boolean {
  const key = answerKey(value);
  return key.length > 0 && answerKey(answer).includes(key);
}

function actionName(action: ContextAction): string {
  const description = action.description.replace(/\s+(is\s+)?due\s*$/i, "").trim();
  return description || action.itemTitle || action.description;
}

function isCalendarCommitment(action: ContextAction): boolean {
  return /\b(?:meeting|appointment|office hours?|class|lecture|seminar|event)\b/i.test(actionName(action));
}

function requiredPlanActions(context: StudentContext): ContextAction[] {
  const first = context.upcomingDeadlines[0];
  if (!first) return [];
  const nextWork = context.upcomingDeadlines
    .slice(1)
    .find((action) => !isCalendarCommitment(action));
  return nextWork ? [first, nextWork] : [first];
}

function itemName(item: ContextItem): string {
  return item.place?.name ?? item.title ?? "an untitled saved item";
}

function sentenceCount(answer: string): number {
  return answer
    .split(/[.!?]+(?:\s|$)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length;
}

function recentAssistantText(context: StudentContext): string | null {
  return [...context.messages].reverse().find((message) => message.direction === "outbound")?.content ?? null;
}

const NEXT_FOLLOW_UP = /\b(?:after that|what else|anything else|next one|what(?:'s| is) next|then what)\b/i;

function uniqueActions(actions: ContextAction[]): ContextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.actionId)) return false;
    seen.add(action.actionId);
    return true;
  });
}

function retrievalActions(context: StudentContext, candidates: ContextItem[]): ContextAction[] {
  const taskList = asksForCompleteTaskList(context.question);
  let actions = uniqueActions([
    ...candidates.flatMap((item) => item.actions),
    ...(taskList ? [] : context.upcomingDeadlines),
  ]).filter((action) => taskList || action.dueDate !== null);

  if (NEXT_FOLLOW_UP.test(context.question)) {
    const prior = recentAssistantText(context) ?? "";
    const unseen = actions.filter((action) =>
      !containsAnswerKey(prior, actionName(action)) &&
      (!action.dueDate || !containsAnswerKey(prior, action.dueDate)),
    );
    if (unseen.length > 0) actions = unseen;
  }
  return actions;
}

function responseMode(context: StudentContext, attempt?: ReplyAttempt): ResponseMode {
  const mutations = mutationTools(attempt);
  if (needsClarification(attempt)) return "clarify";
  if (mutations.length > 0) {
    const result = parsedToolResult(mutations.at(-1)!.result);
    return result?.kind === "reminder" ? "reminder" : "mutation";
  }
  if (context.request.matchStatus === "ambiguous") return "clarify";
  if (context.request.intent === "plan") {
    return context.upcomingDeadlines.length || context.undatedOpenActions.length ? "plan" : "answer";
  }
  if (context.request.intent === "retrieve") return "answer";
  return "chat";
}

function mutationContract(answer: string, attempt?: ReplyAttempt): string | null {
  const last = mutationTools(attempt).at(-1);
  if (!last) return null;
  const result = parsedToolResult(last.result);
  if (result?.ok !== true) {
    if (/\b(?:done|added|saved|changed|moved|rescheduled|cancelled|tracking)\b/i.test(answer)) {
      return "The tool did not complete the change; do not claim success.";
    }
    const userMessage = typeof result?.user_message === "string" ? result.user_message : null;
    if (userMessage) {
      const keyTerms = userMessage
        .split(/\s+/)
        .map((word) => word.replace(/[^a-z0-9]/gi, ""))
        .filter((word) => word.length >= 6);
      if (keyTerms.length > 0 && !keyTerms.some((term) => containsAnswerKey(answer, term))) {
        return `Explain the failed change using the tool result: ${userMessage}`;
      }
    }
    return null;
  }
  const terms = Array.isArray(result.required_terms)
    ? result.required_terms.filter((term): term is string => typeof term === "string" && term.length > 0)
    : [];
  const missing = terms.find((term) => !containsAnswerKey(answer, term));
  return missing ? `The confirmation must preserve the completed change: ${missing}.` : null;
}

/**
 * Validate the model's prose against facts that cannot be optional. Prompting
 * alone is not a guarantee: this contract is the last gate before iMessage.
 */
export function validateReply(
  context: StudentContext,
  answer: string,
  attempt?: ReplyAttempt,
): string | null {
  const trimmed = answer.trim();
  if (!trimmed) return "The reply was empty.";
  if (/^\s*(#|\*|- )/m.test(trimmed)) return "Use plain iMessage text, not Markdown.";

  const clarificationRequired = needsClarification(attempt) ||
    (mutationTools(attempt).length === 0 && context.request.matchStatus === "ambiguous");
  const economyIssue = validateConversationalEconomy({
    text: trimmed,
    mode: responseMode(context, attempt),
    clarificationRequired,
    recentAssistantText: recentAssistantText(context),
  });
  if (economyIssue) return economyIssue;
  const mutationIssue = mutationContract(trimmed, attempt);
  if (mutationIssue) return mutationIssue;

  const internalIds = [
    ...context.savedItems.map((item) => item.itemId),
    ...context.upcomingDeadlines.map((action) => action.actionId),
  ].filter((id) => id.length >= 8);
  if (internalIds.some((id) => trimmed.includes(id))) return "Do not expose internal record ids.";

  if (context.request.intent === "plan") {
    const sentences = sentenceCount(trimmed);
    if (sentences > 4) return "A plan must be no more than four concise sentences.";

    const required = requiredPlanActions(context);
    for (const action of required) {
      if (!containsAnswerKey(trimmed, actionName(action))) {
        return `The plan must name the selected priority: ${actionName(action)}.`;
      }
      const dateForms = [
        action.dueDate,
        action.dueDate ? friendly(action.dueDate, context.student.timezone) : null,
        action.dueDate ? friendly(action.dueDate, context.student.timezone, { year: true }) : null,
      ].filter((value): value is string => value !== null);
      if (!dateForms.some((value) => containsAnswerKey(trimmed, value))) {
        return `The plan must preserve the date ${action.dueDate}.`;
      }
    }

    // A plan may selectively mention later work, but every selected deadline
    // must carry its own correct date. Validating only the first allowed a
    // fluent plan to attach Thursday to a Saturday meeting.
    for (const action of context.upcomingDeadlines.slice(1)) {
      if (!action.dueDate || !containsAnswerKey(trimmed, actionName(action))) continue;
      const dateForms = [
        action.dueDate,
        friendly(action.dueDate, context.student.timezone),
        friendly(action.dueDate, context.student.timezone, { year: true }),
      ];
      if (!dateForms.some((value) => containsAnswerKey(trimmed, value))) {
        return `The plan mentions ${actionName(action)}, so it must preserve the date ${action.dueDate}.`;
      }
    }

    if (context.lighterDay && !containsAnswerKey(trimmed, context.lighterDay.day)) {
      return `The schedule supports ${context.lighterDay.day} as the lighter day; use it in the recommendation.`;
    }
  }

  if (
    context.request.matchStatus === "not_found" &&
    context.upcomingDeadlines.length === 0 &&
    !/\b(couldn.t find|didn.t find|don.t have|do not have|nothing (?:relevant|saved|matching|due)|not saved)\b/i.test(trimmed)
  ) {
    return "Say plainly that no matching saved record was found.";
  }

  if (
    context.request.matchStatus === "ambiguous" &&
    mutationTools(attempt).length === 0 &&
    !trimmed.includes("?")
  ) {
    return "Ask one concise clarification question for the ambiguous match.";
  }

  if (context.request.intent === "retrieve" && context.request.matchStatus === "matched") {
    const candidates = context.request.candidateItemIds
      .map((id) => context.savedItems.find((item) => item.itemId === id))
      .filter((item): item is ContextItem => item !== undefined);
    const asksForDeadline = /\b(due|deadline|coming up|upcoming work|after that|what else|next)\b/i.test(context.question);
    const asksForEveryTask = asksForCompleteTaskList(context.question);

    if (asksForEveryTask) {
      const required = retrievalActions(context, candidates);
      for (const action of required) {
        if (!containsAnswerKey(trimmed, actionName(action))) {
          return `The complete task answer must include ${actionName(action)}.`;
        }
      }
      if (required.length === 0 && !/\b(no tasks?|nothing (?:saved|to do)|don.t have any tasks?)\b/i.test(trimmed)) {
        return "Say plainly that no tasks were found.";
      }
    } else if (asksForDeadline) {
      const target = retrievalActions(context, candidates)[0];
      if (!target?.dueDate) {
        if (!/\b(don.t have|do not have|doesn.t have|does not have|no open|no saved|nothing due|without a due date|has no .*due date)\b/i.test(trimmed)) {
          return "Say plainly that no supported open due date was found.";
        }
      } else {
        if (!containsAnswerKey(trimmed, actionName(target))) {
          return `The retrieval answer must name ${actionName(target)}.`;
        }
        const dateForms = [
          target.dueDate,
          friendly(target.dueDate, context.student.timezone),
          friendly(target.dueDate, context.student.timezone, { year: true }),
        ];
        if (!dateForms.some((value) => containsAnswerKey(trimmed, value))) {
          return `The retrieval answer must preserve the date ${target.dueDate}.`;
        }
      }
    } else if (candidates.length > 0 && !candidates.some((item) => containsAnswerKey(trimmed, itemName(item)))) {
      return `The retrieval answer must name a supported match: ${candidates.map(itemName).join(" or ")}.`;
    }
  }

  return null;
}

function planFallback(context: StudentContext): string {
  const first = context.upcomingDeadlines[0];
  const second = first
    ? context.upcomingDeadlines.slice(1).find((action) => !isCalendarCommitment(action))
      ?? context.upcomingDeadlines[1]
    : undefined;
  const place = context.places[0];

  let opening: string;
  if (first?.dueDate) {
    opening = `I’d start with ${actionName(first)}, due ${friendly(first.dueDate, context.student.timezone)}.`;
  } else if (context.undatedOpenActions[0]) {
    opening = `I’d start with ${actionName(context.undatedOpenActions[0])}; it has no date yet, so clear it before the dated work.`;
  } else {
    return "Nothing urgent in the next two weeks, so I wouldn’t force a plan.";
  }

  let closing: string | null = null;
  if (second?.dueDate) {
    closing = `Then move to ${actionName(second)}, due ${friendly(second.dueDate, context.student.timezone)}`;
    closing += place ? `; ${itemName(place)} fits the longer session.` : ".";
  } else if (place) {
    closing = `${itemName(place)} is a good fit for the longer work block.`;
  }

  const schedule = context.lighterDay
    ? `${context.lighterDay.day} is lighter, so use it for the focused block.`
    : null;
  return [opening, schedule, closing].filter(Boolean).join(" ");
}

function retrieveFallback(context: StudentContext): string {
  if (context.request.matchStatus === "not_found" && context.upcomingDeadlines.length === 0) {
    return /\b(due|deadline|coming up|upcoming work|what do i have)\b/i.test(context.question)
      ? "Nothing due in the next two weeks."
      : "Nothing matching that yet.";
  }

  const candidates = context.request.candidateItemIds
    .map((id) => context.savedItems.find((item) => item.itemId === id))
    .filter((item): item is ContextItem => item !== undefined);
  const asksForDeadline = /\b(due|deadline|coming up|upcoming work|after that|what else|next)\b/i.test(context.question);
  const asksForEveryTask = asksForCompleteTaskList(context.question);
  if (context.request.matchStatus === "ambiguous") {
    const names = candidates.map(itemName).join(" or ");
    return `${names || "More than one thing fits"} — which one do you mean?`;
  }

  const matchedActions = retrievalActions(context, candidates);
  if (asksForEveryTask && matchedActions.length > 0) {
    const selected = matchedActions.slice(0, 10);
    const facts = selected.map((action) => action.dueDate
      ? `${actionName(action)} (${friendly(action.dueDate, context.student.timezone)})`
      : actionName(action));
    const suffix = matchedActions.length > selected.length
      ? ` I’m showing the first ${selected.length} of ${matchedActions.length}.`
      : "";
    return `${matchedActions.length} ${matchedActions.length === 1 ? "task" : "tasks"}: ${facts.join(", ")}.${suffix}`;
  }
  if (matchedActions.length > 0) {
    const selected = matchedActions.slice(0, 3) as (ContextAction & { dueDate: string })[];
    if (selected.length === 1) {
      const action = selected[0]!;
      return `${actionName(action)} is due ${friendly(action.dueDate!, context.student.timezone)}.`;
    }
    const facts = selected.map((action) =>
      `${actionName(action)} ${friendly(action.dueDate!, context.student.timezone)}`,
    );
    const lead = `${selected.length} coming up`;
    return `${lead}: ${facts.slice(0, -1).join(", ")}, then ${facts.at(-1)}.`;
  }

  if (asksForDeadline && candidates.length > 0) {
    const names = candidates.map(itemName).join(" and ");
    return `${names} ${candidates.length === 1 ? "doesn’t" : "don’t"} have a due date yet.`;
  }

  if (candidates.length > 1) {
    return `${candidates.length} match: ${candidates.map(itemName).join(", ")}.`;
  }
  const item = candidates[0];
  if (item) return `${itemName(item)}: ${item.summary}`;

  if (context.upcomingDeadlines.length > 0) {
    const first = context.upcomingDeadlines[0]!;
    return `First up: ${actionName(first)}, due ${friendly(first.dueDate!, context.student.timezone)}.`;
  }
  return "Nothing due in the next two weeks.";
}

/** A grounded last resort if the model repeatedly violates the reply contract. */
export function fallbackReply(context: StudentContext): string {
  if (context.request.intent === "plan") return planFallback(context);
  if (context.request.intent === "retrieve") return retrieveFallback(context);
  return "I got tangled up on that one — mind saying it another way?";
}
