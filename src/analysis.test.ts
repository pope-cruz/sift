// Tests for the deterministic half of ingestion.
//
//   npm test
//
// These run on synthetic ArtifactAnalysis values — no Anthropic call, no
// database, no clock. That is the point: the model's output is the untrusted
// input here, so every case below is "the model said X, what does the code do
// about it?". `today` is injected, so these do not rot with the calendar.
import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate, decide, effectivePurpose } from "./analysis.ts";
import type { AdmissionContext } from "./analysis.ts";
import type { ArtifactAnalysis, DateCandidate } from "./schemas.ts";

const TODAY = "2026-08-11";

function context(overrides: Partial<AdmissionContext> = {}): AdmissionContext {
  return {
    today: TODAY,
    timezone: "America/New_York",
    filename: "file.pdf",
    caption: "",
    ...overrides,
  };
}

function candidate(overrides: Partial<DateCandidate> = {}): DateCandidate {
  return {
    label: "Problem Set 1 due",
    original_text: "September 18, 2026",
    normalized_date: "2026-09-18",
    role: "deadline",
    source: "document_body",
    evidence_excerpt: "Problem Set 1 is due September 18, 2026",
    explicit: true,
    confidence: 0.95,
    recommended_actionable: true,
    reason: "stated as a due date in the body",
    ...overrides,
  };
}

function analysis(overrides: Partial<ArtifactAnalysis> = {}): ArtifactAnalysis {
  return {
    title: "Untitled",
    summary: "An artifact.",
    purpose: "other",
    secondary_tags: [],
    user_intent: "save_for_later",
    topics: [],
    place: null,
    date_candidates: [],
    ...overrides,
  };
}

const openActions = (result: ReturnType<typeof aggregate>) =>
  result.actions.filter((action) => action.status === "open");

// ---------------------------------------------------------------------------
// Case 1 — Sample Midterm 2018.pdf, no date in the body.
// ---------------------------------------------------------------------------

test("a sample exam with only a title year is practice material and creates no actions", () => {
  const subject = analysis({
    title: "Sample Midterm 2018",
    // The model reasonably reads exam-shaped content as exam information; code
    // has to override that on the strength of the name.
    purpose: "exam_information",
    date_candidates: [
      candidate({
        original_text: "2018",
        normalized_date: "2018-01-01",
        role: "title_or_filename_year",
        source: "filename",
        evidence_excerpt: "Sample Midterm 2018.pdf",
        explicit: false,
        confidence: 0.9,
        recommended_actionable: false,
        reason: "the year is part of the title",
      }),
    ],
  });

  const result = aggregate(subject, context({ filename: "Sample Midterm 2018.pdf" }));

  assert.equal(result.item.type, "practice_material");
  assert.equal(result.actions.length, 0);
  assert.equal(result.decisions[0]!.outcome, "evidence_only");
  // The 2018 survives as descriptive metadata even though it produced nothing.
  assert.match(result.item.extractedText, /2018/);
  assert.match(result.confirmation, /practice material/);
  assert.match(result.confirmation, /didn't find an upcoming exam date/);
});

test("a model recommending an action cannot override the filename rule", () => {
  // The most dangerous shape: model is confident, explicit, and says yes.
  const decision = decide(
    candidate({
      original_text: "Midterm 2018",
      normalized_date: "2018-10-14",
      role: "scheduled_event",
      source: "filename",
      explicit: true,
      confidence: 1,
      recommended_actionable: true,
    }),
    context(),
    false,
  );

  assert.equal(decision.outcome, "evidence_only");
  assert.match(decision.reason, /filename alone/);
});

// ---------------------------------------------------------------------------
// Case 2 — a current assignment with a real due date in the body.
// ---------------------------------------------------------------------------

test("an explicit due date in the body creates one supported action with provenance", () => {
  const subject = analysis({
    title: "PS1 — Problem Set 1",
    purpose: "assignment_instructions",
    user_intent: "extract_deadlines",
    date_candidates: [candidate()],
  });

  const result = aggregate(subject, context({ filename: "ps1.pdf" }));
  const live = openActions(result);

  assert.equal(live.length, 1);
  assert.equal(live[0]!.dueDate, "2026-09-18");
  assert.ok(live[0]!.remindAt, "a live deadline gets a reminder instant");

  const evidence = JSON.parse(result.item.extractedText);
  assert.equal(evidence.candidates[0].source, "document_body");
  assert.equal(evidence.candidates[0].outcome, "open");
  assert.equal(evidence.candidates[0].evidence_excerpt, "Problem Set 1 is due September 18, 2026");
  assert.match(result.confirmation, /Sep 18/);

  // The row and the reply use the short label; the excerpt stays provenance, or
  // the student gets a sentence of someone else's document mid-sentence.
  assert.equal(live[0]!.description, "Problem Set 1 due");
  assert.match(result.confirmation, /tracking Problem Set 1 due on Fri, Sep 18\./);
});

// ---------------------------------------------------------------------------
// Case 3 — a date in the filename, nothing in the body.
// ---------------------------------------------------------------------------

test("a resolvable date read off the filename creates zero actions", () => {
  const subject = analysis({
    title: "Reading",
    purpose: "reference_material",
    date_candidates: [
      candidate({
        original_text: "2026-09-18",
        normalized_date: "2026-09-18",
        role: "deadline",
        source: "filename",
        evidence_excerpt: "notes-2026-09-18.pdf",
        explicit: false,
        confidence: 0.85,
      }),
    ],
  });

  const result = aggregate(subject, context({ filename: "notes-2026-09-18.pdf" }));

  assert.equal(result.actions.length, 0);
  assert.match(result.confirmation, /didn't find any dates to track/);
});

// ---------------------------------------------------------------------------
// Case 4 — a historical syllabus.
// ---------------------------------------------------------------------------

test("a past syllabus is saved with its dates as reference, never as open work", () => {
  const subject = analysis({
    title: "CHEM 121 — Fall 2025",
    purpose: "syllabus",
    topics: ["stoichiometry", "thermodynamics"],
    date_candidates: [
      candidate({
        original_text: "September 12, 2025",
        normalized_date: "2025-09-12",
        evidence_excerpt: "Problem Set 1 due September 12, 2025",
      }),
      candidate({
        original_text: "December 11, 2025",
        normalized_date: "2025-12-11",
        evidence_excerpt: "Final Exam on December 11, 2025",
        role: "scheduled_event",
      }),
    ],
  });

  const result = aggregate(subject, context({ filename: "chem121-fall2025.pdf" }));

  assert.equal(openActions(result).length, 0);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every((action) => action.status === "reference"));
  // Reference rows carry no reminder instant — this is what keeps the cron quiet.
  assert.ok(result.actions.every((action) => action.remindAt === null));
  assert.match(result.confirmation, /already passed/);
});

// ---------------------------------------------------------------------------
// Case 5 — an ambiguous date the model could not resolve.
// ---------------------------------------------------------------------------

test("an unresolved date is kept as evidence and never invented into an action", () => {
  const subject = analysis({
    title: "Lab handout",
    purpose: "assignment_instructions",
    date_candidates: [
      candidate({
        original_text: "March 30",
        normalized_date: null,
        evidence_excerpt: "Lab report due March 30",
        confidence: 0.5,
      }),
    ],
  });

  const result = aggregate(subject, context());

  assert.equal(result.actions.length, 0);

  const evidence = JSON.parse(result.item.extractedText);
  assert.equal(evidence.candidates[0].normalized_date, null);
  assert.equal(evidence.candidates[0].original_text, "March 30");
  assert.match(result.confirmation, /couldn't work out what "March 30" refers to/);
});

// ---------------------------------------------------------------------------
// Case 6 — a café screenshot.
// ---------------------------------------------------------------------------

test("a cafe screenshot is still saved as a retrievable place", () => {
  const subject = analysis({
    title: "Blue Bottle Coffee",
    purpose: "place",
    user_intent: "remember_place",
    place: {
      name: "Blue Bottle Coffee",
      location: "1 Rockefeller Plaza",
      caption: "Quiet upstairs seating and plenty of outlets.",
    },
  });

  const result = aggregate(subject, context({ filename: "IMG_0421.png" }));

  assert.equal(result.item.type, "place");
  assert.equal(result.item.category, "study_spot");
  assert.equal(result.actions.length, 0);
  assert.match(result.confirmation, /Blue Bottle Coffee \(1 Rockefeller Plaza\)/);
  assert.match(result.confirmation, /study spot/);
});

// ---------------------------------------------------------------------------
// Case 7 — an event flyer, which must not be forced into the place schema.
// ---------------------------------------------------------------------------

test("a place with no place details is not typed as a study spot", () => {
  const result = aggregate(
    analysis({ title: "Somewhere", purpose: "place", place: null }),
    context(),
  );

  assert.notEqual(result.item.type, "place");
  assert.equal(result.item.category, null);
  assert.doesNotMatch(result.confirmation, /study spot/);
});

test("an event flyer stays an event and creates a dated action when the image says so", () => {
  const subject = analysis({
    title: "Grad Research Symposium",
    purpose: "event_flyer",
    place: null,
    date_candidates: [
      candidate({
        original_text: "September 22",
        normalized_date: "2026-09-22",
        role: "scheduled_event",
        source: "image_text",
        evidence_excerpt: "Join us on September 22 at 6pm",
      }),
    ],
  });

  const result = aggregate(subject, context({ filename: "flyer.png" }));

  assert.equal(result.item.type, "event_flyer");
  assert.notEqual(result.item.type, "place");
  assert.equal(openActions(result).length, 1);
  assert.equal(openActions(result)[0]!.dueDate, "2026-09-22");
  assert.match(result.confirmation, /Saved this event/);
});

test("an event flyer with no visible date is saved with no action", () => {
  const subject = analysis({
    title: "Poetry Night",
    purpose: "event_flyer",
    date_candidates: [
      candidate({
        original_text: "Thursdays",
        normalized_date: null,
        role: "recurring_schedule",
        source: "image_text",
        evidence_excerpt: "Every Thursday",
        explicit: false,
        confidence: 0.7,
      }),
    ],
  });

  const result = aggregate(subject, context({ filename: "poetry.png" }));

  assert.equal(result.actions.length, 0);
  assert.doesNotMatch(result.confirmation, /I'll nudge you/);
});

// ---------------------------------------------------------------------------
// Case 8 — the caption authorizes an action the artifact cannot.
// ---------------------------------------------------------------------------

test("an explicit caption reminder creates an action even when the artifact has none", () => {
  const subject = analysis({
    title: "Housing form",
    purpose: "reference_material",
    user_intent: "create_reminder",
    date_candidates: [
      candidate({
        original_text: "September 20",
        normalized_date: "2026-09-20",
        role: "reminder_request",
        source: "user_caption",
        evidence_excerpt: "Remind me about this on September 20",
      }),
    ],
  });

  const result = aggregate(
    subject,
    context({ filename: "housing.pdf", caption: "Remind me about this on September 20" }),
  );

  assert.equal(openActions(result).length, 1);
  assert.equal(openActions(result)[0]!.dueDate, "2026-09-20");
});

test("a reminder request the student did not make is rejected", () => {
  const decision = decide(
    candidate({ role: "reminder_request", source: "document_body" }),
    context(),
    false,
  );

  assert.equal(decision.outcome, "evidence_only");
  assert.match(decision.reason, /come from the student/);
});

test("a caption can set a date on practice material, the body's own dates cannot", () => {
  const fromCaption = decide(
    candidate({
      original_text: "September 20",
      normalized_date: "2026-09-20",
      role: "reminder_request",
      source: "user_caption",
    }),
    context(),
    true,
  );
  assert.equal(fromCaption.outcome, "open");

  const fromImage = decide(
    candidate({
      original_text: "September 20",
      normalized_date: "2026-09-20",
      role: "scheduled_event",
      source: "image_text",
    }),
    context(),
    true,
  );
  assert.equal(fromImage.outcome, "evidence_only");
  assert.match(fromImage.reason, /practice material/);
});

// ---------------------------------------------------------------------------
// The individual admission rules.
// ---------------------------------------------------------------------------

test("non-actionable roles never become actions", () => {
  for (const role of [
    "publication_date",
    "historical_date",
    "academic_term",
    "title_or_filename_year",
    "recurring_schedule",
    "ambiguous",
  ] as const) {
    const decision = decide(candidate({ role }), context(), false);
    assert.equal(decision.outcome, "evidence_only", `role ${role} should not be actionable`);
    assert.match(decision.reason, /not an actionable role/);
  }
});

test("a date with no future-facing language is not actionable", () => {
  const decision = decide(candidate({ explicit: false }), context(), false);
  assert.equal(decision.outcome, "evidence_only");
  assert.match(decision.reason, /no explicit language/);
});

test("a bare four-digit year is rejected even when it normalizes and is called a deadline", () => {
  const decision = decide(
    candidate({
      original_text: "2018",
      normalized_date: "2018-05-01",
      role: "deadline",
      source: "document_body",
      explicit: true,
    }),
    context(),
    false,
  );

  assert.equal(decision.outcome, "evidence_only");
  assert.match(decision.reason, /bare four-digit year/);
});

test("confidence alone cannot admit an action, and low confidence vetoes one", () => {
  // High confidence, wrong source — still rejected.
  assert.equal(
    decide(candidate({ source: "filename", confidence: 1 }), context(), false).outcome,
    "evidence_only",
  );
  // Right source, confidence below the floor — rejected.
  const weak = decide(candidate({ confidence: 0.4 }), context(), false);
  assert.equal(weak.outcome, "evidence_only");
  assert.match(weak.reason, /below/);
});

test("a malformed normalized date is rejected rather than written", () => {
  for (const bad of ["2026-13-01", "2026-02-30", "next friday", "09/18/2026"]) {
    const decision = decide(candidate({ normalized_date: bad }), context(), false);
    assert.equal(decision.outcome, "evidence_only", `${bad} should not be admitted`);
  }
});

test("a past date becomes reference, not an open action", () => {
  const decision = decide(
    candidate({ original_text: "March 3, 2026", normalized_date: "2026-03-03" }),
    context(),
    false,
  );
  assert.equal(decision.outcome, "reference");
  assert.match(decision.reason, /already passed/);
});

test("a date landing on today is still live", () => {
  const decision = decide(
    candidate({ original_text: "August 11, 2026", normalized_date: TODAY }),
    context(),
    false,
  );
  assert.equal(decision.outcome, "open");
});

// ---------------------------------------------------------------------------
// Invariants that hold across every case above.
// ---------------------------------------------------------------------------

test("an artifact is always saved, even when it yields nothing actionable", () => {
  const result = aggregate(analysis({ title: "Mystery" }), context());

  assert.ok(result.item.title);
  assert.ok(result.item.type);
  assert.equal(result.actions.length, 0);
  assert.ok(result.confirmation.startsWith("Saved"));
  // An uncategorized artifact gets no "as ___" clause rather than "as this".
  assert.equal(result.confirmation, "Saved Mystery. I didn't find any dates to track.");
});

test("no confirmation promises a reminder unless an open action backs it", () => {
  const cases: ArtifactAnalysis[] = [
    analysis({ title: "Sample Midterm 2018", purpose: "practice_material" }),
    analysis({
      title: "Old syllabus",
      purpose: "syllabus",
      date_candidates: [candidate({ normalized_date: "2025-01-05" })],
    }),
    analysis({
      title: "Handout",
      date_candidates: [candidate({ normalized_date: null })],
    }),
    analysis({
      title: "Notes",
      date_candidates: [candidate({ source: "filename", explicit: false })],
    }),
  ];

  for (const subject of cases) {
    const result = aggregate(subject, context());
    const promises = /I'll nudge you|supported date|tracking/.test(result.confirmation);
    assert.equal(
      promises,
      openActions(result).length > 0,
      `"${result.confirmation}" promises tracking with ${openActions(result).length} open actions`,
    );
  }
});

test("every candidate is accounted for in the persisted evidence", () => {
  const subject = analysis({
    title: "Mixed bag",
    date_candidates: [
      candidate(),
      candidate({ source: "filename", role: "title_or_filename_year", original_text: "2019" }),
      candidate({ normalized_date: null, original_text: "sometime in spring" }),
    ],
  });

  const result = aggregate(subject, context());
  const evidence = JSON.parse(result.item.extractedText);

  assert.equal(evidence.candidates.length, 3);
  for (const entry of evidence.candidates) {
    assert.ok(entry.outcome, "each candidate records an outcome");
    assert.ok(entry.decision_reason, "each candidate records why");
  }
});

test("the same deadline reported twice produces one action, not two", () => {
  // A syllabus that lists a due date in a table and again in an announcements
  // feed comes back as two candidates for one obligation.
  const subject = analysis({
    title: "PS1",
    date_candidates: [candidate(), candidate({ evidence_excerpt: "HW1: due 9/18", confidence: 0.8 })],
  });

  const result = aggregate(subject, context());

  assert.equal(openActions(result).length, 1);
  assert.doesNotMatch(result.confirmation, /2 supported dates/);
  // Both candidates are still recorded as evidence — dedup is a write-time
  // decision, not a reason to lose what the model saw.
  assert.equal(JSON.parse(result.item.extractedText).candidates.length, 2);
});

test("two genuinely different deadlines on the same day both survive", () => {
  const subject = analysis({
    title: "Busy Friday",
    date_candidates: [
      candidate({ label: "PS1 due" }),
      candidate({ label: "Lab 3 due" }),
    ],
  });

  assert.equal(openActions(aggregate(subject, context())).length, 2);
});

test("a blank model title falls back to the filename instead of 'Saved .'", () => {
  const result = aggregate(
    analysis({ title: "   " }),
    context({ filename: "housing-form.pdf" }),
  );

  assert.equal(result.item.title, "housing-form");
  assert.match(result.confirmation, /Saved housing-form\./);
});

test("effectivePurpose downgrades exam information named as practice", () => {
  const exam = analysis({ title: "Midterm 2", purpose: "exam_information" });
  assert.equal(effectivePurpose(exam, "midterm2.pdf"), "exam_information");
  assert.equal(effectivePurpose(exam, "Sample Midterm 2.pdf"), "practice_material");
  assert.equal(effectivePurpose(exam, "past-midterm2.pdf"), "practice_material");
  assert.equal(effectivePurpose(exam, "mock exam.pdf"), "practice_material");

  // A real syllabus is not reclassified just because it mentions nothing special.
  const syllabus = analysis({ title: "CS 4414 Syllabus", purpose: "syllabus" });
  assert.equal(effectivePurpose(syllabus, "syllabus.pdf"), "syllabus");
});
