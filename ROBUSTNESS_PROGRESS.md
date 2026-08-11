# Sift robustness progress

Updated: 2026-08-11 (Asia/Manila)

## Discoveries and decisions

- Goal objective and repository `AGENTS.md` read; `.env` is strictly out of scope.
- Worktree started clean on `main`; preserve current behavior and avoid unrelated changes.
- Spectrum message streams are the real application boundary. Incoming content must be narrowed by type, and failures must remain useful without exposing credentials or raw secret-bearing payloads.
- Baseline: 27/27 tests pass and `tsc --noEmit` passes. `npm run lint` and `npm run build` fail because those scripts do not exist.
- Audit: dates already had provenance, but title/category/author/source did not; equal-strength date contradictions could create competing actions; one shared caption was applied to every file; the reader returned only one item; corrupt files reached model/storage work.
- Decision: scalar metadata is a candidate set with source, excerpt, explicitness, and confidence. Weak transport/filename/URL evidence is preserved but cannot establish a value alone. Equal-strength contradictions are omitted.
- Decision: each reader result has an `item_key`, and one attachment returns an item batch. Persistence remains per item and rolls the batch back together on failure.
- Decision: a caption attached to multiple files is turn-level context and cannot create a per-item action without explicit scoping.
- Decision: diagnostics log only a redacted name/code/message triple; raw errors, headers, payloads, stacks, and quoted date text are excluded.
- Full verification now passes with 51/51 tests plus typecheck, lint, and build. The real Spectrum worker completed the controlled live corpus and the repaired L3 rerun.

## Checkpoints

- [x] Read goal objective and primary repository/Spectrum instructions.
- [x] Establish tests, typecheck, lint, and build baseline.
- [x] Trace ingestion, extraction, classification, storage, and retrieval.
- [x] Implement conservative provenance-aware metadata reconciliation.
- [x] Add every mandatory adversarial regression fixture.
- [x] Verify focused tests, full suite, and a representative real-boundary flow.
- [x] Run the three controlled PDFs through iMessage → Spectrum → Anthropic → Supabase.
- [x] Assert persisted provenance, multi-item isolation, actions, attachment references, and zero new storage orphans.
- [x] Reduce the stale L3 identifier prompt to an exact regression and rerun the affected live case on current code.

## Failures / blockers

- Baseline `lint` and `build` scripts were missing. Added project-appropriate static verification scripts; this runtime executes TypeScript through `tsx`, so build validation is typecheck-only and produces no distribution artifact.
- A first focused run failed because Node's strip-only TypeScript test runner rejects constructor parameter properties. Reduced fixture: `InputDiagnosticError` alone. Architectural cause: test/runtime syntax contract. General fix: explicit class fields. Regression suite then passed 43/43.
- Live L1 reader preflight exposed a confirmation-layer bug: non-date numbers with `normalized_date: null` were treated as ambiguous dates. Reduced to the year-like-number fixture, restricted clarification to actionable/ambiguous date roles, and verified the corrected live reply.
- Production already contained two unattached storage objects before the controlled run. They were counted read-only and left untouched.
- Live inbound worker launch was initially approval-gated. The user later approved the bounded paid/state-mutating run, and it completed.
- Replaced the proposed open listener with `live:run`, a ten-minute validation harness limited to the bound demo space and the exact three filename/size/SHA-256/caption tuples. All unrelated traffic is ignored before persistence or paid model work; local manifest tests pass.
- An earlier local `npm run start` process competed with the bounded harness and claimed L2/L3. Its old in-memory confirmation code asked about an identifier even though persistence correctly marked it evidence-only. The exact process was stopped, the regression was pinned, and an exclusive L3 rerun proved the corrected reply.
- Production began with two unattached storage objects. The controlled run and rerun added zero new unattached objects; pre-existing data was not deleted.

## Exact next task

Freeze the supported ingest surface for the demo. Use the L3-only judge script in `LIVE_VALIDATION.md`; do not start another unbounded listener alongside it. Standalone URL ingestion remains explicitly out of scope for this run.
