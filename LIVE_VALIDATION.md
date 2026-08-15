# sort live production validation

Run marker: `SIFT-LIVE-20260811-A`

Safety constraints: do not reseed or delete production rows; do not delete storage objects; do not print credentials or phone numbers. All assertions are read-only except for rows and objects created naturally by the controlled inbound messages.

## Controlled corpus

| Case | Input | Expected result |
|---|---|---|
| L1 | `2018 Sample Midterm.pdf`, no caption | One saved practice/reference item. No action. The filename year is retained only as weak evidence. Course number, ID, price, and page reference do not normalize into dates. |
| L2 | `Fall 2018 Project Brief.pdf`, caption `Save this current project brief.` | One saved project/assignment item titled `DATA 310 Project Brief`. One open action due `2026-09-18`. Publication date remains metadata. Filename year `2018` does not override visible content. |
| L3 | `old-final-packet-2019.pdf`, no caption | Two isolated saved items: `Robotics Society Open Lab` with one event action due `2026-09-22`, and `North Library Renovation Notice` with no action. No metadata/date crosses item boundaries. |

## Evidence to capture per case

- Spectrum message shape and one reply per inbound message.
- Stage latency from `[ingest] read`, `validate`, `analyze`, `upload`, and `TOTAL` logs. Each
  stage line carries its filename (`[ingest] analyze syllabus.pdf 8123ms`) because attachments
  are read up to three at a time, so a multi-file turn interleaves these lines. `TOTAL` remains
  per turn, and on a multi-file turn is now the slowest file rather than the sum of all of them.
- Item, action, attachment, and message rows created after the case.
- Parsed `extracted_text`: item key, resolved metadata, every candidate source/outcome/reason, and date decisions.
- Storage object path is referenced by every attachment row and there are no unreferenced objects created during the run.
- No partial rows or object remain when a controlled preparation/persistence failure is injected locally.

## Execution log

- Baseline production snapshot at `2026-08-11T12:23:44.634Z` (read-only): demo student exists and is bound; 3 items, 11 actions, 2 attachment rows, 11 messages, 4 storage objects. Two storage objects were already unattached. Controlled corpus rows/objects: zero. Pass criterion for this run is zero *new* unattached objects; pre-existing objects will not be deleted.
- L1 reader preflight (real Anthropic, no persistence): schema passed; one isolated practice item; five non-date numeric candidates were correctly role-tagged; filename `2018` stayed evidence-only; zero actions. Found confirmation bug: an unresolved page/filename year triggered a date clarification. Reduced to the year-like-number regression, repaired the confirmation filter, and reran live. Final reply: saved as practice material with no upcoming exam date.
- L2 reader preflight (real Anthropic, no persistence): schema passed; one isolated assignment item titled `DATA 310 Project Brief`; publication date, course number, portal ID, run marker, and filename `Fall 2018` stayed evidence-only; exactly one open action due `2026-09-18`.
- L3 reader preflight (real Anthropic, no persistence): schema passed; two isolated items. `Robotics Society Open Lab` produced exactly one event action due `2026-09-22`; `North Library Renovation Notice` produced none. The filename year appeared independently on each item as weak evidence and no content crossed item boundaries.
- Cleanup repair: concurrent analysis/upload now waits for both branches. A successful upload is removed if analysis fails; database failure compensates every partial item and the uploaded object. Five deterministic rollback tests pass, including cleanup-error reporting.
- The user explicitly approved the bounded credentialed run, Anthropic usage, Supabase writes, storage uploads, and automated replies. The three corpus PDFs were sent through the existing iMessage conversation.
- Post-preflight snapshot at `2026-08-11T12:34:02.520Z` (read-only, since baseline): 0 new items, actions, attachments, messages, storage objects, or unattached objects. This proves the reader preflights and local repairs did not mutate production.
- The live runner is now bounded rather than open-ended: it accepts only inbound iMessage from the already-bound demo space, requires one attachment matching an exact filename/byte-size/SHA-256/caption manifest, ignores all other traffic before persistence or model work, and exits after L1/L2/L3 or ten minutes.
- Bounded-run verification: exact generated corpus files pass the manifest; unknown, modified, and mis-captioned inputs are rejected. The runner also rejects wrong platform, direction, space, MIME, attachment count, and declared size before persistence/model work.
- L1 live: completed on the current bounded worker in `21,915 ms` end to end (`read 0 ms`, `validate 0 ms`, `upload 1,153 ms`, `analyze 14,623 ms`, ingest total `16,111 ms`). It persisted one `CHEM 204 Midterm Practice Questions` practice item, no action, one attachment row/object, and the reply stated that no upcoming exam date was found. Filename year, identifiers, price, page reference, and course number were all evidence-only.
- L2 live: an earlier local `npm run start` listener claimed the message before the bounded worker, whose unique-message claim correctly returned `duplicate message id`. The persisted result still passed every assertion: one `DATA 310 Project Brief` assignment item, one open action due `2026-09-18`, one referenced object, publication date as metadata, filename `2018` rejected as a title and retained only as date evidence. The visible reply matched the stored action. Exact stage timing was unavailable from the stale listener; the visible send/reply interval was under one minute.
- L3 first live pass: the same stale listener claimed the message. Persistence was correct (two isolated items sharing one storage object; only the Robotics event created an action due `2026-09-22`; zero orphan objects), but its old in-memory confirmation code asked the user to clarify the archive identifier `NL-2025-0714`.
- The competing process was identified as the earlier local worker, stopped cleanly, and not restarted. The exact `NL-2025-0714` shape was added as a deterministic regression: identifiers and page references remain evidence-only and cannot trigger date clarification. The live harness now accepts `--cases=L3` for a bounded affected-case rerun.
- L3 fixed rerun: completed exclusively on the current worker in `37,450 ms` end to end (`read 0 ms`, `validate 0 ms`, `upload 1,043 ms`, `analyze 31,028 ms`, ingest total `32,934 ms`). It again persisted exactly two isolated items sharing one new storage object and one event action due `2026-09-22`. The final reply saved the North Library notice as reference material and did not mention the identifier or ask for a date.
- Final production snapshot at `2026-08-11T12:59:54.832Z` (since baseline): 6 item rows, 3 action rows, 6 attachment rows, 12 message rows, and 4 storage objects. These totals include the required L3 affected-case rerun: each L3 upload produced two isolated items/attachment rows referencing the same object. New unattached storage objects: `0`; controlled orphan objects: `0`. The two unattached objects present before the run remain untouched and are excluded from the delta.

## Judge-ready demo

1. Run `npm run live:run -- --cases=L3` and wait for `expected_cases: [ 'L3' ]`.
2. Send the manifest-matched `output/pdf/old-final-packet-2019.pdf` with no caption in the bound iMessage conversation.
3. Expect one progress reply followed by a response that tracks the Robotics Open Lab date and saves the North Library notice without asking about `NL-2025-0714`.
4. Run `npm run live:snapshot -- --since=<ISO timestamp captured before the send>` and assert: 2 items, 1 action, 2 attachment rows, 3 message rows, 1 storage object, 0 unattached objects; both attachment rows share the same `storage_ref`.
