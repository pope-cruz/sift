# Metadata robustness notes

## Architecture

Sift now separates observation from selection:

1. The reader returns one or more isolated `item_key` records for an attachment.
2. Scalar metadata and dates are candidate sets carrying source, excerpt, explicitness, confidence, and rationale.
3. Deterministic reconciliation ranks direct user statements and visible content above embedded or transport metadata. Filenames, attachment labels, and URL slugs are retained as context but cannot establish a fact alone.
4. Equal-strength contradictions remain unresolved. Missing values remain `null`; confirmations use neutral wording rather than manufacturing a title.
5. Every candidate and ruling is persisted in `items.extracted_text`. Actions are written only from admitted date decisions.

The Spectrum boundary, reader schema, deterministic reconciler, persistence payloads, and confirmation text are independently testable. A reader batch can produce several item rows without sharing candidate state between them.

## Remaining limitations

- The automated boundary test uses a realistic Spectrum group message and production reconciliation to produce persistence payloads, but it does not call Anthropic or mutate Supabase. The real Spectrum worker was booted successfully; no live message was sent during this run.
- URL slugs and visible-page evidence are modeled and reconciled, but Sift still has no URL fetcher. A standalone rich link remains unsupported by the current turn router.
- Multi-item segmentation inside one PDF/image depends on the structured reader model. There is no deterministic OCR/layout splitter to independently verify item boundaries.
- Author, publication date, and source provenance live in `items.extracted_text`; the current SQL schema has no dedicated searchable columns for those fields.
- A caption shared across multiple attachments is conservatively prevented from creating per-item actions. Users must send files separately or clarify the target in a later text turn.
- Upload and analysis still run concurrently for latency, but both branches are now settled: a successful upload is removed when analysis fails, and database rollback removes partial rows plus the object. Cleanup failures are surfaced as redacted target diagnostics.
- `lint` and `build` are static TypeScript verification because this app executes TypeScript through `tsx`; there is no stylistic linter or emitted distribution bundle yet.
