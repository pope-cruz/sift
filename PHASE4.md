# Phase 4 — proactive reminders

Phase 4 is the smallest complete reminder loop. It reuses the existing `actions`
row as the one reminder record for that action:

- `student_id` links identity and, through `students.photon_space_id`, the Spectrum space.
- `item_id` links the grounded saved item.
- `due_date` and exact source-stated times in item evidence preserve the deadline.
- `remind_at` is the one planned send time.
- `status = reminder_claimed` is the atomic in-flight claim.
- `reminder_sent` becomes true only after `space.send(...)` resolves.

There is no second reminder table or queue, so one action cannot accumulate
multiple pending reminders.

## Timing rule

All wall-clock choices use the student's IANA timezone. Exact due times are
kept when the source gives one; otherwise the consistent due-time default is
8:00 PM local.

- Within 24 hours: two hours from now (or the midpoint for an imminent deadline).
- Within 2–3 days: 6:00 PM the evening before.
- Later: 6:00 PM two days before.

Vague, undated, past, reference, completed, cancelled, and already-delivered
actions never enter the worker.

## Delivery and control

The in-process minute worker conditionally changes `open` to
`reminder_claimed`. PostgreSQL rechecks that predicate under a concurrent
update, so only one worker receives the row. The worker builds one plain-text
message from the claimed action/item/date and sends it through
`imessage(app).space.get(...).send(...)`.

Provider callback failures restore `open`, move `remind_at` five minutes out,
and retry. A failure after a successful provider callback deliberately leaves
the action claimed rather than risking a duplicate; it is logged for explicit
reconciliation.

Conversation tools provide:

- `reschedule_reminder` — moves one pending reminder to 6:00 PM on the requested local day, only before its deadline.
- `cancel_reminder` — clears only the reminder, leaving the saved action intact.

## Verification

```sh
npm run verify
npm run remind:now
npm run phase4:audit -- --action <action-id-from-remind-now>
npm run phase4:controls -- --execute
```

`remind:now` advances one real pending demo reminder and invokes the same
production batch function as the cron worker. It does not use a mock send path.

On 2026-08-11, the bounded live acceptance produced:

- one claimed action;
- one successful Spectrum iMessage callback;
- `reminder_sent = true` after the callback;
- one exact outbound transcript row;
- zero retries and zero completion failures;
- successful live reschedule and cancellation checks, with the tested reminder restored afterward.

Phase 4 is frozen here. Calendar UI, recurrence, notification preferences,
queues, configurable rules, and schedule optimization remain out of scope; the
next product work is the judge-facing sandbox.
