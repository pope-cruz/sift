import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const dbSource = await readFile(new URL("./db.ts", import.meta.url), "utf8");

test("demo persistence declares fixed caps, expiry indexes, and idempotent turn identity", () => {
  assert.match(schema, /turns_used integer[^\n]+between 0 and 12/);
  assert.match(schema, /attachment_turns_used integer[^\n]+between 0 and 4/);
  assert.match(schema, /attachment_bytes_used bigint[^\n]+20971520/);
  assert.match(schema, /unique \(session_id, client_message_id\)/);
  assert.match(schema, /demo_sessions_expiry_idx/);
  assert.match(schema, /demo_session_issuances[\s\S]+created_at > now\(\) - interval '24 hours'/);
});

test("session and quota mutations lock rows and are unavailable to browser roles", () => {
  assert.match(schema, /create or replace function create_demo_session[\s\S]+pg_advisory_xact_lock/);
  assert.match(schema, /create or replace function reserve_demo_upload[\s\S]+for update/);
  assert.match(schema, /create or replace function claim_demo_turn[\s\S]+for update/);
  assert.match(schema, /revoke all on function create_demo_session[^\n]+public, anon, authenticated/);
  assert.match(schema, /revoke all on function claim_demo_turn[^\n]+public, anon, authenticated/);
});

test("failed turns, uploads, resets, and mutations have durable recovery boundaries", () => {
  assert.match(schema, /lease_expires_at timestamptz/);
  assert.match(schema, /t\.status = 'failed'[\s\S]+attempt_count = attempt_count \+ 1/);
  assert.match(schema, /create or replace function release_demo_upload[\s\S]+attachment_turns_used = greatest/);
  assert.match(schema, /create or replace function reset_demo_session[\s\S]+turns_used = 0/);
  assert.match(schema, /create or replace function save_note_with_actions[\s\S]+pg_advisory_xact_lock/);
  assert.match(schema, /create or replace function save_ingest_item[\s\S]+insert into attachments[\s\S]+insert into actions/);
});

test("Spectrum inbound messages have reclaimable processing state", () => {
  assert.match(schema, /processing_status text not null default 'complete'/);
  assert.match(schema, /create or replace function claim_inbound_message[\s\S]+processing_status in \('pending', 'failed'\)/);
  assert.match(schema, /create or replace function finish_inbound_message/);
});

test("worker failures have a private retained audit trail", () => {
  assert.match(schema, /create table if not exists job_failures/);
  assert.match(schema, /alter table job_failures enable row level security/);
  assert.match(dbSource, /recordJobFailure/);
  assert.match(dbSource, /cleanupJobFailures/);
});

test("reminder claims retain explicit production and authenticated web scopes", () => {
  assert.match(dbSource, /scope: \{ channel: Student\["channel"\]; studentId\?: string \}/);
  assert.match(dbSource, /channel: "imessage"/);
  assert.match(dbSource, /channel: "web_demo", studentId/);
  assert.match(dbSource, /eq\("students\.channel", scope\.channel\)/);
});
