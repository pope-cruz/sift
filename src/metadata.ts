import type {
  EvidenceSource,
  MetadataCandidate,
  MetadataField,
} from "./schemas.ts";

/**
 * Evidence strength is architectural, not field-specific. Transport labels and
 * URL/filename fragments are useful context to preserve, but cannot establish
 * metadata by themselves. Visible content and direct user statements can.
 */
const SOURCE_STRENGTH: Record<EvidenceSource, number> = {
  user_caption: 4,
  user_message: 4,
  document_body: 3,
  image_text: 3,
  visible_page: 3,
  embedded_content: 2,
  transport_metadata: 1,
  filename: 0,
  attachment_name: 0,
  url_slug: 0,
};

export const evidenceStrength = (source: EvidenceSource): number => SOURCE_STRENGTH[source];

const MIN_CONFIDENCE = 0.6;

export type MetadataDecision = {
  candidate: MetadataCandidate;
  outcome: "selected" | "corroborating" | "rejected" | "unresolved";
  reason: string;
};

export type ReconciledMetadata = {
  values: Record<MetadataField, string | null>;
  decisions: MetadataDecision[];
};

const FIELDS: MetadataField[] = [
  "title",
  "author",
  "category",
  "publication_date",
  "source",
];

function normalized(field: MetadataField, value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return field === "publication_date" ? compact : compact.toLocaleLowerCase("en-US");
}

/**
 * Choose scalar metadata conservatively while retaining every candidate and
 * ruling. Equal-strength contradictions are omitted; a stronger explicit
 * statement may override weak surrounding metadata, but weak metadata never
 * becomes a fact merely because it is the only value available.
 */
export function reconcileMetadata(candidates: MetadataCandidate[]): ReconciledMetadata {
  const values = Object.fromEntries(FIELDS.map((field) => [field, null])) as Record<
    MetadataField,
    string | null
  >;
  const decisions: MetadataDecision[] = [];

  for (const field of FIELDS) {
    const fieldCandidates = candidates.filter((candidate) => candidate.field === field);
    const eligible = fieldCandidates.filter(
      (candidate) =>
        candidate.value.trim().length > 0 &&
        candidate.explicit &&
        candidate.confidence >= MIN_CONFIDENCE &&
        SOURCE_STRENGTH[candidate.source] >= 2,
    );

    if (eligible.length === 0) {
      for (const candidate of fieldCandidates) {
        const weak = SOURCE_STRENGTH[candidate.source] < 2;
        decisions.push({
          candidate,
          outcome: "unresolved",
          reason: weak
            ? `${candidate.source} is contextual evidence, not an authoritative assertion`
            : !candidate.explicit
              ? "the source does not explicitly assert this metadata"
              : `confidence ${candidate.confidence} is below ${MIN_CONFIDENCE}`,
        });
      }
      continue;
    }

    const strongest = Math.max(...eligible.map((candidate) => SOURCE_STRENGTH[candidate.source]));
    const contenders = eligible.filter(
      (candidate) => SOURCE_STRENGTH[candidate.source] === strongest,
    );
    const distinct = new Set(contenders.map((candidate) => normalized(field, candidate.value)));

    if (distinct.size > 1) {
      for (const candidate of fieldCandidates) {
        decisions.push({
          candidate,
          outcome: "unresolved",
          reason: `equally strong ${field} evidence contradicts another candidate`,
        });
      }
      continue;
    }

    const selected = [...contenders].sort((a, b) => b.confidence - a.confidence)[0]!;
    const selectedValue = normalized(field, selected.value);
    values[field] = selected.value.trim();

    for (const candidate of fieldCandidates) {
      const agrees = normalized(field, candidate.value) === selectedValue;
      decisions.push({
        candidate,
        outcome:
          candidate === selected ? "selected" : agrees ? "corroborating" : "rejected",
        reason:
          candidate === selected
            ? `strongest explicit ${field} evidence`
            : agrees
              ? `agrees with the selected ${field}`
              : `contradicted by stronger explicit ${field} evidence`,
      });
    }
  }

  return { values, decisions };
}
