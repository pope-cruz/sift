import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "spectrum-ts";

import { aggregate, effectivePurpose, type AdmissionContext } from "./analysis.ts";
import { attachmentsOf, parts, summarize, textOf } from "./content.ts";
import { uniqueAttachments } from "./input.ts";
import { reconcileMetadata } from "./metadata.ts";
import {
  ArtifactAnalysisBatch,
  type ArtifactAnalysis,
  type DateCandidate,
  type MetadataCandidate,
  type MetadataField,
} from "./schemas.ts";

const CONTEXT: AdmissionContext = {
  today: "2026-08-11",
  timezone: "America/New_York",
  filename: "artifact.pdf",
  caption: "",
  captionScope: "single_artifact",
};

function metadata(
  field: MetadataField,
  value: string,
  overrides: Partial<MetadataCandidate> = {},
): MetadataCandidate {
  return {
    field,
    value,
    source: "document_body",
    evidence_excerpt: value,
    explicit: true,
    confidence: 0.9,
    reason: "explicit visible statement",
    ...overrides,
  };
}

function date(overrides: Partial<DateCandidate> = {}): DateCandidate {
  return {
    label: "Project due",
    original_text: "September 18, 2026",
    normalized_date: "2026-09-18",
    normalized_time: null,
    role: "deadline",
    source: "document_body",
    evidence_excerpt: "Project due September 18, 2026",
    explicit: true,
    confidence: 0.95,
    recommended_actionable: true,
    reason: "explicit due date",
    ...overrides,
  };
}

function artifact(
  overrides: Partial<ArtifactAnalysis> & { title?: string | null } = {},
): ArtifactAnalysis {
  const { title = "Course handout", ...analysisOverrides } = overrides;
  const subject: ArtifactAnalysis = {
    item_key: "item-1",
    summary: "A course handout.",
    purpose: "reference_material",
    secondary_tags: [],
    user_intent: "save_for_later",
    topics: [],
    place: null,
    metadata_candidates: [],
    date_candidates: [],
    ...analysisOverrides,
  };
  if (overrides.metadata_candidates === undefined && title?.trim()) {
    subject.metadata_candidates = [metadata("title", title)];
  }
  return subject;
}

test("filename year contradicting an explicit body year cannot override the body", () => {
  const result = aggregate(
    artifact({
      date_candidates: [
        date({
          original_text: "2018",
          normalized_date: "2018-01-01",
          role: "title_or_filename_year",
          source: "filename",
          evidence_excerpt: "2018 Sample Midterm.pdf",
          explicit: false,
        }),
        date({ original_text: "September 18, 2026", normalized_date: "2026-09-18" }),
      ],
    }),
    { ...CONTEXT, filename: "2018 Sample Midterm.pdf" },
  );

  assert.deepEqual(result.actions.map((action) => action.dueDate), ["2026-09-18"]);
  assert.equal(result.decisions[0]!.outcome, "evidence_only");
});

test("several years retain distinct roles and only an explicit event becomes live", () => {
  const result = aggregate(
    artifact({
      date_candidates: [
        date({
          label: "article publication",
          original_text: "2019",
          normalized_date: null,
          role: "publication_date",
          explicit: false,
        }),
        date({
          label: "course term",
          original_text: "Fall 2024",
          normalized_date: null,
          role: "academic_term",
          explicit: false,
        }),
        date({ label: "Symposium", role: "scheduled_event" }),
        date({
          label: "archive reference",
          original_text: "2008",
          normalized_date: null,
          role: "historical_date",
          explicit: false,
        }),
      ],
    }),
    CONTEXT,
  );

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]!.description, "Symposium");
  assert.equal(JSON.parse(result.item.extractedText).candidates.length, 4);
});

test("year-like IDs, course numbers, prices, and page references are never calendar facts", () => {
  const roles = ["identifier", "course_number", "price", "page_reference"] as const;
  const result = aggregate(
    artifact({
      date_candidates: roles.map((role, index) =>
        date({
          label: `${role} value`,
          original_text: ["ID 2024", "CS 2018", "$19.99", "page 2020"][index]!,
          normalized_date: null,
          role,
          explicit: false,
        }),
      ),
    }),
    CONTEXT,
  );

  assert.equal(result.actions.length, 0);
  assert.ok(result.decisions.every((decision) => decision.outcome === "evidence_only"));
  assert.doesNotMatch(result.confirmation, /couldn't work out|Tell me the date/);
});

test("an archive reference identifier never triggers a date clarification", () => {
  const result = aggregate(
    artifact({
      title: "North Library Renovation Notice",
      purpose: "reference_material",
      date_candidates: [
        date({
          label: "library notice publication",
          original_text: "July 14, 2025",
          normalized_date: "2025-07-14",
          role: "publication_date",
          recommended_actionable: false,
        }),
        date({
          label: "archive reference number",
          original_text: "NL-2025-0714",
          normalized_date: null,
          role: "identifier",
          explicit: false,
          recommended_actionable: false,
        }),
        date({
          label: "project page reference",
          original_text: "2019",
          normalized_date: null,
          role: "page_reference",
          explicit: false,
          recommended_actionable: false,
        }),
      ],
    }),
    { ...CONTEXT, filename: "old-final-packet-2019.pdf" },
  );

  assert.equal(result.actions.length, 0);
  assert.ok(result.decisions.every((decision) => decision.outcome === "evidence_only"));
  assert.doesNotMatch(result.confirmation, /NL-2025-0714|couldn't work out|Tell me the date/);
});

test("missing title, author, category, date, and source remain omitted", () => {
  const result = aggregate(
    artifact({ title: null, metadata_candidates: [], date_candidates: [] }),
    CONTEXT,
  );
  const stored = JSON.parse(result.item.extractedText);

  assert.equal(result.item.title, null);
  assert.equal(result.item.category, null);
  assert.equal(result.actions.length, 0);
  assert.deepEqual(stored.metadata.values, {
    title: null,
    author: null,
    category: null,
    publication_date: null,
    source: null,
  });
});

test("ambiguous sample/practice/draft/final/old filename words stay weak context", () => {
  for (const adjective of ["sample", "practice", "draft", "final", "old"]) {
    const subject = artifact({ purpose: "exam_information" });
    assert.equal(
      effectivePurpose(subject, `${adjective} midterm.pdf`),
      "exam_information",
      adjective,
    );
  }
});

test("an explicit user statement outranks conflicting forwarded embedded metadata", () => {
  const reconciled = reconcileMetadata([
    metadata("title", "Current Housing Guide", {
      source: "user_message",
      evidence_excerpt: "This is the Current Housing Guide",
    }),
    metadata("title", "Old Housing Guide", {
      source: "embedded_content",
      evidence_excerpt: "Fwd: Old Housing Guide",
      confidence: 0.99,
    }),
  ]);

  assert.equal(reconciled.values.title, "Current Housing Guide");
  assert.equal(reconciled.decisions[1]!.outcome, "rejected");
});

test("visible page metadata outranks a conflicting URL slug", () => {
  const reconciled = reconcileMetadata([
    metadata("title", "Archived 2018 Schedule", {
      source: "url_slug",
      evidence_excerpt: "/archived-2018-schedule",
      confidence: 1,
    }),
    metadata("title", "Fall 2026 Schedule", {
      source: "visible_page",
      evidence_excerpt: "Fall 2026 Schedule",
    }),
  ]);

  assert.equal(reconciled.values.title, "Fall 2026 Schedule");
  assert.equal(reconciled.decisions[0]!.outcome, "rejected");
});

test("equally strong contradictory metadata is omitted, not guessed", () => {
  const reconciled = reconcileMetadata([
    metadata("author", "A. Rivera"),
    metadata("author", "B. Rivera"),
  ]);

  assert.equal(reconciled.values.author, null);
  assert.ok(reconciled.decisions.every((decision) => decision.outcome === "unresolved"));
});

test("contradictory dates for one obligation do not create competing actions", () => {
  const result = aggregate(
    artifact({
      date_candidates: [
        date({ normalized_date: "2026-09-18" }),
        date({ normalized_date: "2027-09-18", original_text: "September 18, 2027" }),
      ],
    }),
    CONTEXT,
  );

  assert.equal(result.actions.length, 0);
  assert.ok(result.decisions.every((decision) => decision.outcome === "evidence_only"));
  assert.match(result.decisions[0]!.reason, /contradictory dates/);
});

test("several distinct items in one attachment remain isolated", () => {
  const batch = ArtifactAnalysisBatch.parse({
    items: [
      artifact({
        item_key: "flyer-1",
        metadata_candidates: [metadata("title", "Robotics Talk")],
        date_candidates: [date({ label: "Robotics Talk" })],
      }),
      artifact({
        item_key: "article-2",
        metadata_candidates: [metadata("title", "Library Renovation")],
        date_candidates: [],
      }),
    ],
  });

  const results = batch.items.map((item) => aggregate(item, CONTEXT));
  assert.deepEqual(results.map((result) => result.item.title), ["Robotics Talk", "Library Renovation"]);
  assert.deepEqual(results.map((result) => result.actions.length), [1, 0]);
});

test("a Spectrum group boundary deduplicates files and does not scope one caption to every item", () => {
  const attachment = {
    type: "attachment",
    id: "file-1",
    name: "packet.pdf",
    mimeType: "application/pdf",
    size: 123,
    read: async () => Buffer.from("unused"),
    stream: () => { throw new Error("unused"); },
  } as const;
  const message = {
    content: {
      type: "group",
      items: [
        { content: attachment },
        { content: attachment },
        { content: { type: "text", text: "Remind me on September 20" } },
      ],
    },
  } as unknown as Message;

  const contents = parts(message);
  const files = uniqueAttachments(attachmentsOf(contents));
  assert.equal(files.length, 1);
  assert.equal(textOf(contents), "Remind me on September 20");
  assert.equal(summarize(contents), "Remind me on September 20 [packet.pdf, packet.pdf]");

  const result = aggregate(
    artifact({
      date_candidates: [
        date({
          role: "reminder_request",
          source: "user_caption",
          original_text: "September 20",
          normalized_date: "2026-09-20",
          evidence_excerpt: "Remind me on September 20",
        }),
      ],
    }),
    {
      ...CONTEXT,
      caption: textOf(contents),
      captionScope: "multi_artifact_turn",
    },
  );
  assert.equal(result.actions.length, 0);
  assert.match(result.decisions[0]!.reason, /not scoped to this item/);

  // Representative boundary-to-persistence-plan flow: the real Spectrum group
  // shape is flattened above, the reader batch is validated, and each isolated
  // result becomes exactly the item/action payload production persists.
  const batch = ArtifactAnalysisBatch.parse({
    items: [
      artifact({
        item_key: "project",
        metadata_candidates: [metadata("title", "Project Brief")],
        date_candidates: [date({ label: "Project due" })],
      }),
      artifact({
        item_key: "reference",
        metadata_candidates: [metadata("title", "Reference Sheet")],
        date_candidates: [],
      }),
    ],
  });
  const persistencePlans = batch.items.map((item) =>
    aggregate(item, {
      ...CONTEXT,
      filename: files[0]!.name,
      caption: textOf(contents),
      captionScope: "single_artifact",
    }),
  );
  assert.deepEqual(
    persistencePlans.map((plan) => ({ title: plan.item.title, actions: plan.actions.length })),
    [
      { title: "Project Brief", actions: 1 },
      { title: "Reference Sheet", actions: 0 },
    ],
  );
});
