# Sift — Implementation Plan

**Written:** Aug 10, 2026 (rev 2, after repo scaffold) · **Deadline:** Aug 21, 2026 (11 days) · **Companion docs:** `Sift_Fable_Architecture_Brief.md`, `Sift_Brief_Audit.md`

All Photon claims below were verified against photon.codes docs on Aug 10, then re-checked against the vendored SDK docs in the repo (`.agents/skills/spectrum/`, authoritative for the pinned `spectrum-ts@12.7.0`). **Repo state:** `~/code/sift` is a scaffolded Spectrum starter — `spectrum-ts` installed, credentials in `.env` (`PROJECT_ID`/`PROJECT_SECRET`), and a working echo loop in `src/index.ts`. Day one starts from a running transport, not from npm init.

---

## Architecture decision: Option A, one worker

**A single always-on Node.js + TypeScript worker** (Railway) running the `spectrum-ts` message loop, plus a static landing page on Vercel. No webhooks, no separate outbound service.

Why the docs settle this:

- **Everything goes through the SDK anyway.** Attachments are fetched only via `im.getAttachment(id)` (`@spectrum-ts/imessage`) — webhooks carry metadata but no bytes and no download URLs. So even webhook ingestion would need the SDK in the handler. Option B buys nothing.
- **Proactive sends work outside the loop.** `im.space.get(spaceId)` returns a full `Space` for an existing conversation, and `.send()` works on it — so the reminder cron can live *in the same process* as the message loop. No "minimal outbound Spectrum service" needed.
- **One process = no signature verification, no retry-delivery handling, no cold starts.** The webhook path's serverless advantages don't matter for one demo user.

```
iMessage ⇄ Photon line
              ⇅ spectrum-ts (message loop + space.get/send + getAttachment)
       ┌────────────────────────────┐
       │  Sift worker (Railway)     │
       │  Node 22 + TypeScript      │
       │  • inbound loop            │──── Claude API (claude-haiku-4-5)
       │  • reminder cron (in-proc) │──── Supabase (Postgres + Storage)
       └────────────────────────────┘
Landing page: static Next.js on Vercel (separate, no backend coupling)
```

### Verified Photon facts the design relies on

| Fact | Source |
|---|---|
| Loop is `for await (const [space, message] of app.messages)`; auth via `PROJECT_ID` / `PROJECT_SECRET` passed to `Spectrum()` (as the starter's `src/index.ts` already does) | repo + getting-started |
| **Filter own messages:** every message has `direction` — `if (message.direction === "outbound") continue;` must be the first line of the loop (the starter's echo loop is missing this) | vendored messages.md |
| `message.id` is stable across every delivery/retry — "the right dedup key" | webhooks/events |
| **Inbound attachments carry their own bytes accessor:** `message.content.type === "attachment"` → `{id, name, mimeType, size?, read(), stream()}` — call `content.read()` right in the loop; no separate `getAttachment` GUID round-trip needed for ingest | vendored messages.md |
| **A captioned attachment is ONE message, not two:** `content.type === "group"` with `items` = `[attachment, text]` in that order. Verified on the real line (Phase 0) for `image/jpeg` and `application/pdf` — this replaces the burst batcher Phase 2 originally called for | Phase 0 spike + vendored messages.md (`"group"` → `items: Message[]`) |
| `im.space.get(space.id)` → sendable Space for proactive messages (store `space.id` from the loop); `space.responding(fn)` wraps work in a typing indicator | vendored spaces-and-users.md |
| **Shared-pool allowlist (Free/Pro plans):** proactive outreach requires the recipient to be registered as a project user in the Photon Dashboard, else sends fail with `Target not allowed for this project`; dedicated Business lines are exempt. On shared pools the line number can differ per recipient and per-phone routing is ignored | vendored providers/imessage.md |
| Deliverability: **inbound-first is critical** (user texts Sift first — which is exactly our onboarding); 5,000 msgs/server/day, 50 *new* conversations/line/day (replies in existing conversations don't count); first message should be **text-only, no links** | imessage-deliverability |
| Recommended inbound shape: debounce bursts, split read → generate → send, idempotent sends via stable client GUIDs | vendored best-practices.md |

The repo also ships a `photon` CLI skill (`photon projects show`, `photon spectrum lines list`) for checking the plan tier and line — used in Phase 0.

Deliverability implications for the demo: the student always texts first (`Start Sift`), so the proactive reminder goes to an **existing** conversation — safe. Keep the welcome message link-free. Aim for ≥3 user messages in the conversation before the proactive send (the demo script naturally does this).

## LLM: Claude Haiku 4.5 (free credits)

- **Model ID:** `claude-haiku-4-5` · $1/M input, $5/M output · 200K context, 64K max output.
- Supports everything Sift needs: **structured outputs** (use `client.messages.parse()` with `zodOutputFormat(schema)` — this satisfies the brief's "validate with Zod before database writes" requirement natively), **vision** (café screenshot), and **PDF input** (base64 `document` block; the 200K-context page cap of 100 pages is far above any syllabus).
- One SDK: `@anthropic-ai/sdk`. Three call shapes: classify intent (structured output, tiny), extract from PDF/image (document/image block + structured output), and answer/plan (plain text generation with retrieved context in the prompt).
- Budget sanity: a full demo run is well under $0.05 at Haiku pricing; free credits are a non-issue.

## Data model (Supabase)

Per the brief, with the audit's fixes applied:

```sql
create table students (
  id uuid primary key default gen_random_uuid(),
  name text, phone text unique, photon_space_id text unique,  -- space id from the loop; needed for space.get()
  timezone text not null default 'America/New_York',           -- seeded for the demo user
  profile jsonb default '{}'
);
create table items (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students not null,
  type text, title text, summary text, extracted_text text,
  source_url text, category text, created_at timestamptz default now()
);
create table actions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students not null,
  item_id uuid references items,
  description text, due_date date, status text default 'open',
  remind_at timestamptz, reminder_sent boolean default false
);
create table attachments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students not null, item_id uuid references items,
  filename text, mime_type text, storage_path text
);
create table messages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students,
  photon_message_id text unique not null,   -- UNIQUE = the dedup mechanism
  direction text, content text, created_at timestamptz default now()
);
```

Dedup is one insert: `insert ... on conflict (photon_message_id) do nothing` — if 0 rows inserted, drop the event. Isolation: every query filters by `student_id` (single-tenant demo, but keep the discipline so the write-up's scalability claim is honest).

---

## Phases

### Phase 0 — Finish the end-to-end spike (Day 1, Aug 10–11)
The scaffold covers half of this already. Remaining, against the real line:

- Run the existing echo loop (`npm run start`); text the line, get the echo.
- `photon projects show` / `photon spectrum lines list` — confirm the plan tier (shared pool vs dedicated) and the line number. **If shared pool: register the demo phone number as a project user in the Photon Dashboard now** — the proactive reminder in Phase 4 fails with `Target not allowed for this project` otherwise.
- Extend the loop one step: on `content.type === "attachment"`, `await message.content.read()` → write bytes to disk. Send a PDF and a photo from your phone to verify.
- From a separate script (not the loop): `imessage(app).space.get(<space.id logged by the loop>)` + `.send()` — proves the proactive path.
- Add remaining deps: `@anthropic-ai/sdk`, `zod`, `@supabase/supabase-js`, `node-cron`.

**Exit test:** echo, attachment bytes, and out-of-loop send all work against the real line. If any fails, this is the day to discover it.

### Phase 1 — Foundations (Days 1–2)
- Fix the echo loop's missing self-message filter: `if (message.direction === "outbound") continue;` first thing in the loop.
- Supabase project + schema above; storage bucket for attachments.
- Worker skeleton deployed to Railway (loop + graceful shutdown via `app.stop()` + env config).
- Message persistence with the dedup insert; `Start Sift` → seeded demo student (store `space.id` on the student row as `photon_space_id`) + text-only welcome.
- Wrap LLM turns in `space.responding(...)` so the typing indicator shows while Sift thinks; send the literal `Sifting...` message for ingest turns per the demo script.

**Exit test:** brief's acceptance test 1 (messaging), plus: redeliver/resend the same message id → exactly one row, one reply.

### Phase 2 — Ingest (Days 2–4)
- **Group unwrap (replaces the planned burst batcher).** Phase 0 disproved the premise this section was built on. A caption typed alongside an attachment does **not** arrive as two messages — the provider delivers **one message with `content.type === "group"`**, whose `items` carry both parts, ordered **attachment first, then text**. Verified on the real line for both `image/jpeg` and `application/pdf`. So a turn's unit of work is *the content parts of one message*, not *a batch of messages*: flatten `group.items` into parts, then route by the part types present. Collect parts by type — never assume caption-before-file ordering. This is the `parts()` helper already in `src/index.ts` from Phase 0.
- **No `batch_queue` table, no debounce, for the demo.** Both demo ingest steps are single captioned sends, which the group unwrap handles completely. Skip the queue table, the per-space timers, and their crash-recovery semantics. If genuine multi-*message* bursts show up in rehearsal (two separate sends in quick succession), revisit the vendored best-practices debounce then — it is no longer on the critical path.
- Intent classifier: one Haiku structured-output call over the batched turn → `ingest | retrieve | plan | clarify | chitchat` (the audit's "none of the above" default: chitchat gets a short friendly reply).
- PDF ingest: syllabus → `document` block → Zod-validated extraction `{title, topics[], events[{name, date, kind}]}` → rows in `items` + `actions`. Send the "Sifting..." pre-reply before the LLM call for the demo feel.
- Screenshot ingest: café post → `image` block → `{name, location?, caption, category: "study_spot"}`.
- Tune against the **one known syllabus PDF and one known screenshot** — per the locked scope, generality is not the goal.

**Exit test:** acceptance test 2 (syllabus → topics/dates → verified rows) + café save.

### Phase 3 — Retrieve & plan (Days 4–6)
- Context assembly: compact profile + open actions (next 14 days) + recent items + last ~10 messages → one Haiku call for `retrieve`/`plan` answers.
- Weekly-plan prompt: prioritize deadlines, identify the light day, and *always consider saved places when suggesting where to work* — this is the callback that makes the demo.

**Exit test:** acceptance test 3 — the plan mentions both the project deadline and the café by name.

### Phase 4 — Proactive reminder (Days 6–7)
- In-process cron (e.g. `node-cron`, every minute): `select ... where remind_at <= now() and reminder_sent = false` → claim the row with a conditional update (`set reminder_sent = true where id = ? and reminder_sent = false`, proceed only if 1 row updated) → `space.get(photon_space_id).send(...)`.
- Reminder copy generated from the same context assembly so it can reference Thursday and the café.
- **Manual trigger:** `npm run remind:now` — a script that sets the demo action's `remind_at` to now and runs one cron tick. The demo video and acceptance test 4 both use this; never wait for wall-clock time during a recording.

**Exit test:** acceptance test 4 — trigger the job, exactly one reminder arrives; run the job again, nothing sends.

### Phase 5 — Landing page & fallback (Days 7–9)
- Static Next.js page on Vercel: cream background `#FFF8F0`-ish, persimmon accent, near-black text; tagline, the Send → Understand → Remember → Ask loop, embedded demo video slot, clearly-labeled interactive simulation replaying the seeded demo script.
- Fallback package per the brief: page + video + simulation + GitHub link. The simulation reuses the real reply copy from Phases 2–4 so it's faithful.

**Exit test:** acceptance test 5 — a first-time viewer understands Sift in under 30 seconds.

### Phase 6 — Submission assets (Days 9–11, protected)
- Run the full demo script on the real line; screen-record the two-minute video; host on **YouTube/Vimeo/Loom** (a submission requirement).
- 500-word write-up. Address the actual judging criteria — including **potential scalability** (one line number today, any student can text it; per-student isolation already in the schema; Photon lines scale horizontally).
- Tool list (Photon/Spectrum, Claude Haiku 4.5, Supabase, Railway, Vercel, Next.js), title/category, working link. Submit **by Aug 20**, keeping the 21st as buffer.

### Deliberately cut (from the brief's defer list — do not build)
Multi-user onboarding/auth, web dashboard, universal PDF/social handling, LMS/calendar integrations, vector search.

---

## Execution guide (for the implementing agent)

Concrete contracts so implementation doesn't require re-deriving decisions. Respect the repo's `AGENTS.md` — in particular, **never read, write, or echo `.env`**.

### File map

```
src/
  index.ts      — entry: boot Spectrum app, start loop + cron, graceful shutdown (app.stop())
  loop.ts       — inbound loop: direction filter → dedup insert → hand the message to turn.ts
  turn.ts       — one message = one turn: flatten group.items into parts, classify intent, route
  llm.ts        — Anthropic client; classify(), extract(), answer() wrappers (all Haiku)
  schemas.ts    — every Zod schema (single source of truth for LLM output shapes)
  ingest.ts     — PDF + image ingest → items/actions/attachments rows
  planner.ts    — context assembly + retrieve/plan answers
  remind.ts     — cron tick + remind:now entry
  db.ts         — Supabase client (service-role key) + typed query helpers
  seed.ts       — creates/reset the demo student (npm run seed)
web/            — Next.js landing page, deployed to Vercel separately (own package.json)
```

Scripts: `start`, `dev`, `seed`, `remind:now`.

### Env (server worker)

`PROJECT_ID`, `PROJECT_SECRET` (already present) + `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_PHONE` (the demo student's number). Mirror new names into `.env.example` (values blank).

### Zod schemas (schemas.ts)

```ts
export const Intent = z.object({
  intent: z.enum(["ingest", "retrieve", "plan", "clarify", "chitchat"]),
});

export const SyllabusExtraction = z.object({
  title: z.string(),                     // e.g. "CS 4414: Operating Systems"
  topics: z.array(z.string()),
  events: z.array(z.object({
    name: z.string(),
    date: z.string(),                    // ISO yyyy-mm-dd; model instructed to normalize
    kind: z.enum(["assignment", "exam", "project", "reading", "other"]),
  })),
});

export const PlaceExtraction = z.object({
  name: z.string(),
  location: z.string().nullable(),
  caption: z.string(),
  category: z.literal("study_spot"),
});
```

Use `client.messages.parse()` with `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod`; `parsed_output` is null on parse failure — treat that as an extraction error (below), never write unvalidated data.

### LLM call shapes (all `claude-haiku-4-5`)

| Call | Input | Output | Notes |
|---|---|---|---|
| classify | batched turn text (+ attachment names/types) | `Intent` schema | `max_tokens` small (~200) |
| extract (PDF) | `document` block (base64) + instruction | `SyllabusExtraction` | instruct ISO dates + current year; pass today's date in the prompt |
| extract (image) | `image` block + caption text | `PlaceExtraction` | |
| answer/plan | assembled context + question | plain text | keep replies iMessage-length (2–5 sentences); no markdown headers — iMessage renders plain text |

Context assembly for answer/plan: student profile JSON + open `actions` within 14 days + `items` summaries (most recent 10) + last 10 `messages` + today's date and timezone. All filtered by `student_id`.

### Failure behavior (the audit's open item)

- Any LLM/extraction/DB error inside a turn → reply `"Hmm, I had trouble sifting that — mind sending it again?"` and log the error. Never crash the loop; wrap each turn in try/catch.
- A turn is processed in one pass from the live message, so there is no queue to drain and nothing to clean up on crash. A message lost to a crash mid-turn is re-sent by the user; the dedup insert keeps a retry from double-writing.
- Unknown content types (voice, reactions, etc.): ignore silently except reactions, which never warrant a reply. `read` receipts arrive as their own messages on this line and must be skipped before any turn work.

### Demo choreography (do this before recording, not after)

The demo's dates are load-bearing: the proactive reminder says *"Project 1 is due in six days"* and the plan says *"Thursday is your lightest day."* Neither can come from a stale syllabus.

1. Pick the recording day R (target: Aug 18–19).
2. Generate the demo syllabus PDF **with dates derived from R**: Project 1 due R+6 (and R+6 should make Thursday genuinely the light day of R's week), plus 2–3 other assignments/readings spread across the week. A small script or hand-made Google Doc → PDF is fine; keep it in `demo/` in the repo.
3. Demo script beats = brief's four steps, sent from `DEMO_PHONE`; run `npm run seed` first for a clean slate.
4. Reminder is fired with `npm run remind:now` between step 3 and the "next day" cut in the video (a caption like "The next morning…" covers the time jump honestly).
5. Rehearse the full script once off-camera on the real line; only then record.

### Guardrails for the executor

- Do **not** build anything on the brief's defer list (multi-user onboarding, dashboards, vector search, integrations) even where it seems easy.
- Prefer boring choices: no job-queue library and no queue table for the demo (one message = one turn); no ORM (supabase-js is enough); no monorepo tooling for `web/`.
- Definition of done per phase = its exit test passing **against the real line**, not unit tests. Unit tests are optional; the five acceptance tests + dedup test are not.
- Delete the stray empty `sift/` directory at the repo root before the first real commit.

---

## Risks that remain

1. **Phase 0 failure** is the only schedule-breaking risk left (provisioning is done). If attachment fetch or proactive send doesn't work as documented, the fallback demo package (Phase 5) becomes the primary submission — decide by end of Day 2, not Day 9.
2. **Shared-pool allowlist** — on Free/Pro plans the proactive send fails unless the demo number is registered as a project user, and the line number shown to a new recipient can vary. Both are handled in Phase 0 (register the number, note the assigned line). If the demo needs a stable, single number for the video, consider whether the plan tier needs a bump — decide on Day 1.
3. **Apple filtering** — mitigated by inbound-first flow, text-only welcome, low volume, ≥3 user messages before the proactive send. Don't demo-spam the line with bursts while testing.
4. **Demo-day flakiness** — the video is the submission artifact; record it early (end of Phase 4 is the first possible moment) and re-record polished later.

## Verification (whole-project)

The brief's five acceptance tests map to phase exit tests 1–5 above, plus the added dedup test (audit fix #4). Final check before submitting: run the complete demo script start-to-finish on the real line, then verify Supabase contains exactly one row per message, item, and reminder.
