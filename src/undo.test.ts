import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const toolsSource = await readFile(new URL("./tools.ts", import.meta.url), "utf8");
const ingestSource = await readFile(new URL("./ingest.ts", import.meta.url), "utf8");

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("undo has no model-selected deletion target", () => {
  const tool = block(toolsSource, 'name: "undo_last_save"', 'name: "reschedule_reminder"');
  assert.match(tool, /properties: \{\}/);
  assert.match(tool, /additionalProperties: false/);
  assert.doesNotMatch(tool, /item_id|action_id|student_id|title:/);
  assert.match(tool, /never deletes profile\/personal context or conversation/);
});

test("undo is student-scoped and cannot delete profile or conversation history", () => {
  const rpc = block(schema, "create or replace function undo_latest_save", "end $$;");
  assert.match(rpc, /where i\.student_id = p_student_id/);
  assert.match(rpc, /source_turn_id/);
  assert.match(rpc, /interval '2 hours'/);
  assert.match(rpc, /delete from actions/);
  assert.match(rpc, /delete from attachments/);
  assert.match(rpc, /delete from items/);
  assert.doesNotMatch(rpc, /delete from students|delete from messages|update students|update messages/i);
});

test("one save turn groups multi-item files and preserves shared storage references", () => {
  assert.match(schema, /items add column if not exists source_turn_id text/);
  assert.match(schema, /p_source_message_id, p_source_message_id/);
  assert.match(schema, /p_source_message_id, p_source_turn_id/);
  assert.match(ingestSource, /sourceTurnId/);

  const rpc = block(schema, "create or replace function undo_latest_save", "end $$;");
  assert.match(rpc, /not exists \(select 1 from attachments a where a\.storage_path = candidate\.path\)/);
  assert.match(rpc, /return query select cardinality\(v_item_ids\)/);
});

test("undo RPC is private to the service role", () => {
  assert.match(schema, /revoke all on function undo_latest_save\(uuid\) from public, anon, authenticated/);
  assert.match(schema, /grant execute on function undo_latest_save\(uuid\) to service_role/);
});
