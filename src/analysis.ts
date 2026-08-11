// The deterministic half of ingestion.
//
// The model classifies; this file decides. Everything here is pure — no
// database, no API key, no clock of its own — because these are the rules that
// must hold regardless of what the model said, and rules you cannot test are
// rules you do not have.
//
// The invariant that motivates the whole file: a date the model noticed is a
// *candidate*, not a deadline. It becomes an action only by passing the checks
// in `decide()`, and the model's own `recommended_actionable` is an opinion
// that carries no weight on its own.
import { count, friendly, isIsoDate, remindAtFor } from "./dates.ts";
import { evidenceStrength, reconcileMetadata } from "./metadata.ts";
import type { ArtifactAnalysis, ArtifactPurpose, DateCandidate } from "./schemas.ts";

/** Roles that could ever describe something the student has to show up for. */
const ACTIONABLE_ROLES = new Set(["deadline", "scheduled_event", "reminder_request"]);

/** "2018", "(2018)", "Fall 2018" — a year with no day is never an event date. */
const YEAR_ONLY_RE = /^[^0-9]*(?:19|20)\d{2}[^0-9]*$/;

/**
 * Below this the model is guessing. Not sufficient on its own to admit an
 * action — source and role still have to pass — but enough to veto one.
 */
const MIN_CONFIDENCE = 0.6;
/** Practice material has to clear a higher bar to produce a live deadline. */
const PRACTICE_MIN_CONFIDENCE = 0.8;

export type AdmissionContext = {
  /** ISO yyyy-mm-dd in the student's timezone. Injected, never read from the clock. */
  today: string;
  timezone: string;
  filename: string;
  caption: string;
  /** A shared caption cannot safely be assigned to every file in a multi-file turn. */
  captionScope?: "single_artifact" | "multi_artifact_turn";
};

export type Decision = {
  candidate: DateCandidate;
  /** `open` becomes a live deadline, `reference` is remembered but never reminded on. */
  outcome: "open" | "reference" | "evidence_only";
  reason: string;
};

/** True when content classification identifies study-from material. */
export function looksLikePractice(analysis: ArtifactAnalysis, _filename: string): boolean {
  return (
    analysis.purpose === "practice_material" ||
    analysis.secondary_tags.includes("practice_material")
  );
}

/**
 * The purpose we actually record, after code has reconciled the reader's
 * primary and secondary content classifications. Filenames do not participate.
 */
export function effectivePurpose(
  analysis: ArtifactAnalysis,
  filename: string,
): ArtifactPurpose {
  if (analysis.purpose === "exam_information" && looksLikePractice(analysis, filename)) {
    return "practice_material";
  }
  return analysis.purpose;
}

/**
 * Should this candidate become an action, a reference row, or stay as evidence?
 *
 * Ordered most-structural first so the `reason` names the real disqualifier: a
 * filename date is rejected for being a filename date, not for being in the past.
 */
export function decide(
  candidate: DateCandidate,
  context: AdmissionContext,
  practice: boolean,
): Decision {
  const at = (outcome: Decision["outcome"], reason: string): Decision => ({
    candidate,
    outcome,
    reason,
  });

  // 1. Role. Publication dates, term labels and title years describe the
  //    artifact; they are not things that happen to the student.
  if (!ACTIONABLE_ROLES.has(candidate.role)) {
    return at("evidence_only", `role "${candidate.role}" is not an actionable role`);
  }

  // 2. Provenance. A filename is metadata a human typed once; it never gets to
  //    put a deadline on anyone's calendar, whatever role the model assigned.
  if (candidate.source === "filename") {
    return at("evidence_only", "a filename alone can never create an action");
  }
  if (
    candidate.source === "attachment_name" ||
    candidate.source === "url_slug" ||
    candidate.source === "transport_metadata"
  ) {
    return at("evidence_only", `${candidate.source} alone can never create an action`);
  }

  // A caption sent alongside several attachments is surrounding transport
  // context. Without an explicit per-item link, applying it to every artifact
  // duplicates one requested date/reminder across unrelated items.
  if (
    context.captionScope === "multi_artifact_turn" &&
    (candidate.source === "user_caption" || candidate.source === "user_message")
  ) {
    return at("evidence_only", "a shared multi-attachment caption is not scoped to this item");
  }

  if (candidate.source === "user_caption" || candidate.source === "user_message") {
    const excerpt = candidate.evidence_excerpt.trim().toLocaleLowerCase("en-US");
    const caption = context.caption.trim().toLocaleLowerCase("en-US");
    if (!excerpt || !caption.includes(excerpt)) {
      return at("evidence_only", "the claimed caption evidence is not present in the message");
    }
  }

  // 3. Resolution. An unresolved date stays unresolved — inventing a year to
  //    make it storable is the failure this pipeline exists to prevent.
  if (candidate.normalized_date === null) {
    return at("evidence_only", "the date could not be resolved to a calendar day");
  }
  if (!isIsoDate(candidate.normalized_date)) {
    return at("evidence_only", `"${candidate.normalized_date}" is not a valid calendar date`);
  }

  // 4. A bare four-digit year is a label, even when it normalized cleanly.
  if (YEAR_ONLY_RE.test(candidate.original_text)) {
    return at("evidence_only", "a bare four-digit year is not an event date");
  }

  // 5. Future-facing language. This is the "due / submit by / exam on / remind
  //    me" test, reported by the model but enforced here.
  if (!candidate.explicit) {
    return at("evidence_only", "no explicit language ties an obligation to this date");
  }

  // 6. A reminder is something the student asks for, in their own words.
  if (candidate.role === "reminder_request" && candidate.source !== "user_caption") {
    return at("evidence_only", "a reminder request has to come from the student");
  }

  const floor = practice ? PRACTICE_MIN_CONFIDENCE : MIN_CONFIDENCE;
  if (candidate.confidence < floor) {
    return at("evidence_only", `confidence ${candidate.confidence} is below ${floor}`);
  }

  // 7. Practice material defaults to reference. Only the student's own caption
  //    or explicit body language promotes it, and step 5 already required
  //    explicit — so this narrows the sources that count.
  if (practice && candidate.source !== "user_caption" && candidate.source !== "document_body") {
    return at("evidence_only", "practice material needs the body or the student to set a date");
  }

  // 8. Past dates are real and worth keeping, but they are not live work. This
  //    is what stops the reminder cron firing a backlog on its first tick.
  if (candidate.normalized_date < context.today) {
    return at("reference", "the date has already passed");
  }

  return at("open", "supported by explicit future-facing evidence");
}

export type AggregateResult = {
  item: {
    type: string;
    title: string | null;
    summary: string;
    category: string | null;
    /** Full provenance, so Sift can later say where a deadline came from. */
    extractedText: string;
  };
  actions: {
    description: string;
    dueDate: string | null;
    remindAt: string | null;
    status: "open" | "reference";
  }[];
  decisions: Decision[];
  confirmation: string;
};

/**
 * What the student is told this date is. The label, never the evidence excerpt —
 * the excerpt is provenance and reads as a fragment of someone else's document
 * ("Due September 18, 2026 at 11:59pm on Gradescope.") in the middle of a
 * sentence Sift is speaking.
 */
function describe(candidate: DateCandidate): string {
  const label = candidate.label.trim().replace(/[.\s]+$/, "");
  return label || candidate.original_text.trim();
}

/**
 * The model can report one real deadline twice — a syllabus that lists the same
 * due date in a table and again in an announcements feed reads as two
 * candidates. Two identical rows means two reminders and a reply that claims
 * "2 supported dates" for one, so collapse them on what the student would see:
 * the same day and the same label is the same obligation.
 *
 * Keeps the first, which is also the highest-confidence one after the sort.
 */
function dedupe(decisions: Decision[]): Decision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const key = `${decision.candidate.normalized_date}|${describe(decision.candidate).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reconcile multiple claims about the same obligation before writing actions.
 * Stronger evidence wins over surrounding metadata; equally strong conflicting
 * calendar dates remain unresolved instead of creating two reminders.
 */
function reconcileDateConflicts(decisions: Decision[]): Decision[] {
  const bySubject = new Map<string, Decision[]>();
  for (const decision of decisions) {
    if (decision.outcome === "evidence_only") continue;
    const key = describe(decision.candidate).toLocaleLowerCase("en-US");
    bySubject.set(key, [...(bySubject.get(key) ?? []), decision]);
  }

  const replacements = new Map<Decision, Decision>();
  for (const group of bySubject.values()) {
    const dates = new Set(group.map((decision) => decision.candidate.normalized_date));
    if (dates.size < 2) continue;

    const strongest = Math.max(
      ...group.map((decision) => evidenceStrength(decision.candidate.source)),
    );
    const leading = group.filter(
      (decision) => evidenceStrength(decision.candidate.source) === strongest,
    );
    const leadingDates = new Set(leading.map((decision) => decision.candidate.normalized_date));

    for (const decision of group) {
      const isLeading = leading.includes(decision);
      const unresolved = leadingDates.size > 1 || !isLeading;
      if (unresolved) {
        replacements.set(decision, {
          ...decision,
          outcome: "evidence_only",
          reason:
            leadingDates.size > 1
              ? "equally strong evidence gives contradictory dates for the same obligation"
              : "a stronger source gives a different date for the same obligation",
        });
      }
    }
  }

  return decisions.map((decision) => replacements.get(decision) ?? decision);
}

/**
 * Fold one analysis into exactly what gets written and exactly what Sift says.
 *
 * The confirmation is built from the persisted rows rather than from the
 * analysis, so it is structurally incapable of claiming a deadline that no
 * action backs.
 */
export function aggregate(
  analysis: ArtifactAnalysis,
  context: AdmissionContext,
): AggregateResult {
  const practice = looksLikePractice(analysis, context.filename);
  const purpose = effectivePurpose(analysis, context.filename);
  const metadata = reconcileMetadata(analysis.metadata_candidates);

  const decisions = reconcileDateConflicts(
    analysis.date_candidates.map((candidate) => decide(candidate, context, practice)),
  );

  const byDate = (a: Decision, b: Decision) =>
    (a.candidate.normalized_date ?? "").localeCompare(b.candidate.normalized_date ?? "") ||
    b.candidate.confidence - a.candidate.confidence;

  const open = dedupe(decisions.filter((d) => d.outcome === "open").sort(byDate));
  const reference = dedupe(decisions.filter((d) => d.outcome === "reference").sort(byDate));

  const title = metadata.values.title;

  const actions: AggregateResult["actions"] = [
    ...open.map((decision) => ({
      description: describe(decision.candidate),
      dueDate: decision.candidate.normalized_date,
      remindAt: decision.candidate.normalized_date
        ? remindAtFor(decision.candidate.normalized_date, context.timezone)
        : null,
      status: "open" as const,
    })),
    ...reference.map((decision) => ({
      description: describe(decision.candidate),
      dueDate: decision.candidate.normalized_date,
      remindAt: null,
      status: "reference" as const,
    })),
  ];

  // Everything the model saw plus every ruling made on it. This is what lets a
  // later turn answer "where did that deadline come from?" without re-reading
  // the file, and it keeps unresolved dates recoverable instead of discarded.
  const extractedText = JSON.stringify({
    purpose,
    model_purpose: analysis.purpose,
    secondary_tags: analysis.secondary_tags,
    user_intent: analysis.user_intent,
    topics: analysis.topics,
    place: analysis.place,
    item_key: analysis.item_key,
    filename: context.filename,
    caption: context.caption,
    caption_scope: context.captionScope ?? "single_artifact",
    evaluated_at: context.today,
    metadata: {
      values: metadata.values,
      candidates: metadata.decisions.map((decision) => ({
        ...decision.candidate,
        outcome: decision.outcome,
        decision_reason: decision.reason,
      })),
    },
    candidates: decisions.map((decision) => ({
      ...decision.candidate,
      outcome: decision.outcome,
      decision_reason: decision.reason,
    })),
  });

  return {
    item: {
      type: itemType(purpose, analysis),
      title,
      summary: analysis.summary,
      category: itemCategory(purpose, analysis, metadata.values.category),
      extractedText,
    },
    actions,
    decisions,
    confirmation: confirm({ analysis, title, purpose, open, reference, decisions, context }),
  };
}

/**
 * `items.type` stays in the vocabulary the rest of the app already reads —
 * `place` and `syllabus` in particular are load-bearing for retrieval — with
 * the newer purposes passed through as themselves.
 */
function itemType(purpose: ArtifactPurpose, analysis: ArtifactAnalysis): string {
  // A place is only a place if we actually got its details. Typing an item
  // `place` on the model's say-so alone produced a study_spot with no name and
  // no location — retrievable as a café recommendation, useless as one.
  if (analysis.place !== null && (purpose === "place" || purpose === "other")) return "place";
  if (purpose === "place") return "other";
  return purpose;
}

function itemCategory(
  purpose: ArtifactPurpose,
  analysis: ArtifactAnalysis,
  reconciled: string | null,
): string | null {
  if (reconciled) return reconciled;
  return null;
}

/**
 * How each purpose reads in "Saved X as ___". `other` is null on purpose:
 * there is no honest noun phrase for an artifact we couldn't categorize, and
 * "Saved X as this" is worse than saying nothing.
 */
const PURPOSE_LABEL: Record<ArtifactPurpose, string | null> = {
  syllabus: "your syllabus",
  assignment_instructions: "the assignment",
  exam_information: "the exam info",
  practice_material: "practice material",
  reference_material: "reference material",
  event_flyer: "an event",
  place: "a place",
  article: "an article",
  receipt: "a receipt",
  personal_note: "a note",
  other: null,
};

/**
 * Say what actually happened, and nothing more.
 *
 * Every branch reads off `open` / `reference` / `decisions`, which are the same
 * arrays that get written. There is no path through this function that mentions
 * a deadline without an open action behind it.
 */
function confirm(input: {
  analysis: ArtifactAnalysis;
  title: string | null;
  purpose: ArtifactPurpose;
  open: Decision[];
  reference: Decision[];
  decisions: Decision[];
  context: AdmissionContext;
}): string {
  const { analysis, title, purpose, open, reference, decisions, context } = input;
  const { timezone } = context;
  const displayTitle = title ?? "the attachment";

  if (itemType(purpose, analysis) === "place" && analysis.place) {
    const where = analysis.place.location
      ? `${analysis.place.name} (${analysis.place.location})`
      : analysis.place.name;
    return (
      `Saved ${where} as a study spot. ${analysis.place.caption} ` +
      `I'll bring it up when you're deciding where to work.`
    );
  }

  if (open.length > 0) {
    const first = open[0]!;
    const when = friendly(first.candidate.normalized_date!, timezone);
    const lead =
      purpose === "event_flyer"
        ? `Saved this event — ${displayTitle}.`
        : `Saved ${displayTitle}.`;

    const found =
      open.length === 1
        ? `I'm tracking ${describe(first.candidate)} on ${when}.`
        : `I found ${count(open.length, "supported date", "supported dates")}; the first is ` +
          `${describe(first.candidate)} on ${when}.`;

    const parked =
      reference.length > 0
        ? ` ${count(reference.length, "other date has", "other dates have")} already passed, ` +
          `so I've kept ${reference.length === 1 ? "it" : "those"} as reference.`
        : "";

    const nudge = open.length === 1 ? "I'll nudge you beforehand." : "I'll nudge you before each one.";

    return `${lead} ${found}${parked} ${nudge}`;
  }

  // Nothing live. Say which kind of nothing — these want different follow-ups,
  // and the old pipeline collapsed them all into a stale-date question.
  if (reference.length > 0) {
    const withYear = { year: true };
    const first = reference[0]!.candidate.normalized_date!;
    const last = reference[reference.length - 1]!.candidate.normalized_date!;
    const span =
      reference.length === 1
        ? `on ${friendly(first, timezone, withYear)}`
        : `between ${friendly(first, timezone, withYear)} and ${friendly(last, timezone, withYear)}`;

    return (
      `Saved ${displayTitle}. Every date I found lands ${span}, which has already passed. ` +
      `Want me to keep this as reference only, or are those dates supposed to be current?`
    );
  }

  const unresolved = decisions.filter(
    (decision) =>
      decision.candidate.normalized_date === null &&
      (decision.candidate.role === "deadline" ||
        decision.candidate.role === "scheduled_event" ||
        decision.candidate.role === "reminder_request" ||
        decision.candidate.role === "ambiguous"),
  );
  if (unresolved.length > 0) {
    return (
      `Saved ${displayTitle} for later, but I couldn't work out what ` +
      `"${unresolved[0]!.candidate.original_text}" refers to — no year I could pin it to. ` +
      `Tell me the date and I'll track it.`
    );
  }

  if (purpose === "practice_material") {
    return `Saved ${displayTitle} as practice material. I didn't find an upcoming exam date.`;
  }

  const label = PURPOSE_LABEL[purpose];
  const topics =
    analysis.topics.length > 0
      ? ` I pulled ${count(analysis.topics.length, "topic", "topics")}.`
      : "";
  const saved = label ? `Saved ${displayTitle} as ${label}.` : `Saved ${displayTitle}.`;
  return `${saved}${topics} I didn't find any dates to track.`;
}
