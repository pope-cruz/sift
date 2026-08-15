# Phase 3 — Retrieve & Plan

Phase 3 turns persisted sort data into grounded retrieval answers and concise weekly plans. Phase 2 ingest remains frozen: this phase reads its `students`, `items`, `actions`, and `messages` rows but does not reinterpret attachment bytes or extracted documents.

## Context architecture

Every text turn crosses one boundary:

1. `getContextRows(studentId)` runs three explicit `student_id`-filtered queries for recent items, open actions, and recent messages.
2. `assembleContext(...)` filters every returned row by the same student ID again, rejects malformed rows, resolves compact place/topic fields from ingest evidence, drops completed and past actions, and orders the 14-day deadline window chronologically.
3. A deterministic lexical ranker places exact or paraphrased matches before recent items. It marks equally plausible singular matches as ambiguous, treats plural/list requests as multi-result retrieval, and uses recent messages to ground representative references such as “it.”
4. `renderContext(...)` emits provenance-bearing sections under an 8,000-character budget (approximately 2,000 tokens): current date/timezone/profile, a uniquely supported lighter day, request grounding, upcoming deadlines, undated open actions, saved places, relevant/recent items, and the last ten messages.
5. Haiku synthesizes the reply from that evidence. It may communicate and prioritize; it may not manufacture database results, availability, preferences, dates, titles, or places.
6. `validateReply(...)` is the final send gate. It rejects missing/changed deadline facts, substituted places, dishonest empty states, internal IDs, or iMessage-hostile formatting. Haiku gets a bounded repair attempt; a deterministic grounded fallback remains if it repeatedly violates the contract.

Raw attachment bytes never enter the boundary. Dense `extracted_text` is parsed only to recover the compact `place` and `topics` fields already persisted by ingest; the raw JSON is never sent to the answering model.

## Retrieval behavior

- Exact titles and reasonable paraphrases are ranked deterministically.
- Upcoming deadlines come only from `status = open` actions owned by the active student.
- Plans use only today through the inclusive 14-day horizon plus explicitly undated open work.
- Dates beyond the horizon can answer an exact item question but cannot distort the weekly plan.
- Saved places are represented separately so a useful one can appear naturally in a plan.
- Singular ties are reported as ambiguous; plural requests return the supported set.
- An absent match produces an explicit `not_found` grounding instruction.
- Completed, past, malformed, foreign-student, and mismatched cross-tenant rows are excluded conservatively.
- Chitchat is marked `not_applicable` and does not trigger a saved-state recap.

## Planning behavior

The answer prompt requires plain text in two to five sentences. It preserves exact titles and dates, prioritizes the chronological deadline evidence, and names a saved study place when useful. Context assembly compares weekday commitment counts only when `students.profile.schedule` contains at least two comparable days; it names a lighter day only for one unique minimum. Ties and opaque schedule shapes remain unresolved rather than becoming invented availability.

The required callback fixture contains:

- `Project 1`, with a due date six days after the live run date.
- `Juniper Study Cafe`, saved as a study place.

The live answer is rejected before delivery unless it contains the first chronological deadline and exact date, the selected saved place, two to five sentences, and no Markdown-style header or list prefix. The live acceptance harness additionally requires both `Project 1` and `Juniper Study Cafe`.

## Failure behavior

- Database/model failures inside a turn produce: `Hmm, I had trouble sorting that — mind sending it again?`
- A database failure before turn routing attempts the same useful reply without trying to persist it.
- A provider outage cannot receive a reply, but the recovery send is swallowed so the long-running worker continues.
- Raw provider/database errors are redacted before logging and are never passed into the answering model.
- A schema-invalid reader response gets exactly one retry with a closed-enum correction. Authentication, quota, network, and other provider failures are never retried or mislabelled; a second schema failure becomes one safe stable diagnostic.

## Verification

```sh
npm run verify
npm run phase3:preflight
npm run phase3:audit
```

`phase3:preflight` is read-only. It inspects only the configured demo student and prints no identity fields, raw messages, extracted documents, or credentials.

Focused coverage lives in `src/planner.test.ts`, `src/recovery.test.ts`, and `src/structured-output.test.ts`. It covers exact and paraphrased retrieval, chronological and empty deadlines, multiple places, absent items, plural results, chitchat separation, multi-deadline planning, retrieval/planning send contracts and fallbacks, the Project 1 + café callback, horizon/status filtering, student isolation, mismatched links, follow-up references, malformed rows, profile schedules, context pressure, bounded schema retries, and failure recovery. The full suite also runs all frozen Phase 2 ingest regressions.

Final result: 82/82 tests pass. `typecheck`, `lint`, and `build` pass. `phase3:audit` passes with exactly two marker items, two open actions, two attachment rows, two referenced storage objects, zero marker orphans, and one delivered callback.

## One-shot live acceptance

The live harness is intentionally stateful and therefore requires explicit authorization:

```sh
npm run phase3:live -- --execute --send
```

It is bounded to the configured, already-bound demo student and marker `SIFT-PHASE3-20260811-A`. It generates exactly two in-memory PNG fixtures, passes both through the real ingest/Anthropic/Supabase path, persists one fixed plan question, assembles context through the production boundary, generates the real Haiku plan, asserts the callback, and sends exactly that plan to the existing iMessage space. It does not reseed, delete, or alter pre-existing rows. Artifact filename checks make ingestion idempotent, and duplicate message delivery is refused unless `--resend` is explicitly supplied.

The approved live run completed on 2026-08-11. Exact delivered result:

> You've got two deadlines coming up: Reading quiz due Fri, Aug 14 for CS 4414, and Project 1 due Mon, Aug 17. Both are in the next few days, so those should be your focus this week. You've also got Juniper Study Cafe saved if you need a good spot to work.

The first syllabus attempt exposed a schema-invalid metadata field. It stopped before delivery, its concurrent upload was cleaned up, and the smallest general repair was a single bounded structured-output retry plus a closed-enum reminder. The next syllabus ingest produced two supported open actions. A resume-guard defect then stopped before delivery because the controlled inbound question already existed; the guard was narrowed to actual outbound callback evidence. The final run reused both marker artifacts, passed the reply contract, and delivered exactly once.

## Acceptance matrix

| Requirement | Authoritative evidence |
|---|---|
| Exact and paraphrased item retrieval | `planner.test.ts`: exact title, coffee-shop paraphrase, operating-item ranking primitives, and send-time title/date contracts |
| Upcoming/empty/missing/ambiguous/plural cases | Deterministic context tests plus grounded retrieval fallbacks |
| Multiple-deadline weekly plan | Chronological plan fixture, Thursday routing, unique lighter-day derivation, and first-deadline send contract |
| Project 1 + saved café callback | Unit contract/fallback tests and the exact delivered iMessage above |
| Completed/out-of-range exclusion | Status/past/horizon regression |
| Student/session isolation | Student-filtered Supabase reads plus mixed-tenant and mismatched-link regressions |
| Follow-up references | “When is it due?” recent-conversation regression |
| Malformed stored data | Conservative row rejection and parse-pressure regressions |
| Provider/database failure | Useful recovery reply and provider-outage no-crash regressions |
| Ingest preservation | All original 51 ingest/rollback/live-corpus regressions remain green |
| Live persistence integrity | `phase3:audit`: 2 items, 2 actions, 2 attachments, 2 objects, 0 marker orphans, 1 callback |

## Current limitations

- Retrieval uses deterministic lexical ranking over the latest 50 items rather than vector search; vector search remains deliberately out of scope.
- The schema has no soft-delete or expiry columns. The boundary filters the available lifecycle field (`actions.status`) and cannot apply item lifecycle states that do not exist.
- A lighter-day recommendation requires schedule evidence in `students.profile`; sort does not infer a calendar.

## Freeze decision and Phase 4

Phase 3 is ready to freeze. Its deterministic context, retrieval/planning contracts, regressions, live delivery, and storage integrity are all verified; the limitations above are deliberate scope boundaries rather than incomplete acceptance work.

Exact recommended Phase 4 objective: **Implement proactive reminders that atomically claim each due open action once, assemble the same grounded student context, deliver one concise iMessage reminder to the stored Spectrum space, survive retries/provider failures without duplicate sends, and provide a deterministic `remind:now` acceptance path.**
