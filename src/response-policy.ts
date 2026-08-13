export const RESPONSE_POLICY = `Voice and economy:
- Text like a sharp friend with perfect memory: quiet, observant, concise, and confident.
- Stay understated. No emojis, hype, punchy coaching, or performative sign-offs.
- Lead with the answer, decision, or completed outcome. Selection matters more than proving what you remember.
- Never narrate storage or retrieval. Do not say "stored item", "record", "database", "retrieved context", "open action", or similar system language.
- Do not repeat the user's wording or a fact from your previous message unless confirmation or disambiguation requires it.
- Do not append an offer of more help. No "Would you like me to...", "Let me know...", or "anything else?"
- Ask only when an answer is required to proceed or would materially change the result.

Choose one conversational job:
- Save/ingest: confirm what you understood and saved; surface only the nearest or most important consequence.
- Answer: answer directly. For several results, quantify and select the few that matter; omit unrelated context.
- Plan/recommend: make a judgment. Name what comes first, what follows, and optionally one useful time/place supported by evidence. Never return an inventory.
- Create/update: one natural sentence when possible. Confirm only the change and any important date/state.
- Reminder: state exactly when it will happen. Explain why only when personal context changed the timing.
- Clarify: isolate the one missing decision and ask one concise question.

Length follows the job: one sentence is normal for a simple answer or completed action; factual answers use one to three; plans use two to four; clarification is one question.`;

export type CompletedTool = { name: string; result: string };

export type ReplyAttempt = {
  completedTools: CompletedTool[];
};

export type ResponseMode = "answer" | "plan" | "mutation" | "reminder" | "clarify" | "chat";

const INTERNAL_NARRATION =
  /\b(?:database|retrieved context|stored (?:item|items|record|records|data)|saved records?|open saved actions?|record ids?|persistence)\b/i;
const GENERIC_CLOSER =
  /\b(?:would you like me to|do you want me to|let me know if|anything else|happy to help|need anything else|want help (?:planning|with))\b/i;
const PLAN_JUDGMENT =
  /\b(?:i['’]?d|prioriti[sz]e|start with|first(?: up)?|focus on|finish|handle|tackle|before|then|follow (?:that|it) with|give .+ the (?:day|weekend|afternoon|evening))\b/i;
const FORMAL_OPENING = /^(?:based on|according to|from (?:your|the)|i (?:found|retrieved|reviewed|checked)|here(?:'s| is) (?:a|the) (?:summary|recap|list))/i;
const ENERGETIC_TONE = /(?:[!😀-🙏]|\b(?:crush it|you['’]?ve got this|hit .+ if you|push straight into|that['’]?s your week|let['’]?s go|knock (?:it|this) out)\b)/iu;
const UNSUPPORTED_COUNTDOWN = /\b\d+\s+days?\s+away\b/i;

export const MUTATION_TOOLS = new Set([
  "update_dates",
  "set_tracking",
  "save_note",
  "undo_last_save",
  "reschedule_reminder",
  "cancel_reminder",
]);

export function parsedToolResult(result: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function mutationTools(attempt?: ReplyAttempt): CompletedTool[] {
  return (attempt?.completedTools ?? []).filter((tool) => MUTATION_TOOLS.has(tool.name));
}

export function needsClarification(attempt?: ReplyAttempt): boolean {
  return mutationTools(attempt).some((tool) => parsedToolResult(tool.result)?.needs_clarification === true);
}

export function confirmationFallback(attempt?: ReplyAttempt): string | null {
  const last = mutationTools(attempt).at(-1);
  if (!last) return null;
  const result = parsedToolResult(last.result);
  const confirmation = result?.confirmation;
  if (typeof confirmation === "string" && confirmation.trim()) return confirmation.trim();
  const userMessage = result?.user_message;
  if (typeof userMessage === "string" && userMessage.trim()) return userMessage.trim();
  return "I couldn’t finish that change. Try it once more.";
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function repeatsRecentAnswer(text: string, recentAssistantText: string | null): boolean {
  if (!recentAssistantText) return false;
  const prior = new Set(sentences(recentAssistantText).map(normalized).filter((line) => line.length >= 16));
  return sentences(text).map(normalized).some((line) => prior.has(line));
}

export function validateConversationalEconomy(input: {
  text: string;
  mode: ResponseMode;
  clarificationRequired?: boolean;
  recentAssistantText?: string | null;
}): string | null {
  const text = input.text.trim();
  if (INTERNAL_NARRATION.test(text)) return "Answer without narrating storage, records, or retrieval.";
  if (GENERIC_CLOSER.test(text)) return "Remove the generic offer or closing question.";
  if (FORMAL_OPENING.test(text)) {
    return "Lead with the answer, decision, or outcome instead of a formal preamble.";
  }
  if (ENERGETIC_TONE.test(text)) return "Keep the tone quiet and understated; remove hype or coaching language.";
  if (UNSUPPORTED_COUNTDOWN.test(text)) return "Use the supported date directly; do not calculate a days-away countdown.";
  if (["answer", "plan"].includes(input.mode) && /\b(?:is|was|are|were) saved\b|\byou saved\b|\bi saved\b/i.test(text)) {
    return "Use remembered context directly; do not announce that it was saved.";
  }
  if (["answer", "plan"].includes(input.mode) && /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(text)) {
    return "Express the date naturally for iMessage instead of showing an ISO date.";
  }

  const count = sentences(text).length;
  const limits: Record<ResponseMode, number> = {
    answer: 3,
    plan: 4,
    mutation: 2,
    reminder: 2,
    clarify: 1,
    chat: 3,
  };
  if (count > limits[input.mode]) return `This ${input.mode} reply is too long; keep only what changes the answer.`;

  const questions = (text.match(/\?/g) ?? []).length;
  if (input.clarificationRequired) {
    if (questions !== 1 || count !== 1) return "Ask exactly one concise clarification question.";
  } else if (["answer", "plan", "mutation", "reminder"].includes(input.mode) && questions > 0) {
    return "No question is needed after this answer or completed action.";
  }

  if (input.mode === "plan" && !PLAN_JUDGMENT.test(text)) {
    return "Make an actual recommendation: choose what comes first and what follows.";
  }
  if (
    (input.mode === "answer" || input.mode === "plan") &&
    repeatsRecentAnswer(text, input.recentAssistantText ?? null)
  ) {
    return "Do not repeat a sentence the student just saw; answer only the new part.";
  }

  return null;
}
