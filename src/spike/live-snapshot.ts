// Read-only production assertions for the controlled live ingest run.
// Never prints phone numbers, credentials, message bodies, or unrelated filenames.
import { createHash } from "node:crypto";

import { db } from "../db.ts";
import { env } from "../env.ts";

const sinceArg = process.argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
const since = sinceArg ? new Date(sinceArg) : null;
if (since && Number.isNaN(since.getTime())) throw new Error("--since must be an ISO timestamp");

const CONTROLLED_FILENAMES = new Set([
  "2018 Sample Midterm.pdf",
  "Fall 2018 Project Brief.pdf",
  "old-final-packet-2019.pdf",
]);

const { data: student, error: studentError } = await db
  .from("students")
  .select("id, photon_space_id")
  .eq("phone", env.DEMO_PHONE)
  .maybeSingle();
if (studentError) throw studentError;
if (!student) {
  console.log(JSON.stringify({ student_exists: false }, null, 2));
  process.exit(0);
}

async function count(table: "items" | "actions" | "attachments" | "messages") {
  let query = db.from(table).select("id", { count: "exact", head: true }).eq("student_id", student!.id);
  if (since) query = query.gte("created_at", since.toISOString());
  const { count: value, error } = await query;
  if (error) throw error;
  return value ?? 0;
}

const [itemsCount, actionsCount, attachmentsCount, messagesCount] = await Promise.all([
  count("items"),
  count("actions"),
  count("attachments"),
  count("messages"),
]);

let attachmentQuery = db
  .from("attachments")
  .select("id, item_id, filename, storage_path, created_at")
  .eq("student_id", student.id);
if (since) attachmentQuery = attachmentQuery.gte("created_at", since.toISOString());
const { data: attachmentRows, error: attachmentError } = await attachmentQuery;
if (attachmentError) throw attachmentError;

let itemQuery = db
  .from("items")
  .select("id, type, title, category, extracted_text, created_at")
  .eq("student_id", student.id);
if (since) itemQuery = itemQuery.gte("created_at", since.toISOString());
const { data: itemRows, error: itemError } = await itemQuery;
if (itemError) throw itemError;

let actionQuery = db
  .from("actions")
  .select("id, item_id, description, due_date, status, remind_at, created_at")
  .eq("student_id", student.id);
if (since) actionQuery = actionQuery.gte("created_at", since.toISOString());
const { data: actionRows, error: actionError } = await actionQuery;
if (actionError) throw actionError;

const referencedPaths = new Set(
  attachmentRows.map((row) => row.storage_path).filter((path): path is string => Boolean(path)),
);
const storage = await db.storage.from("attachments").list(student.id, {
  limit: 1000,
  sortBy: { column: "created_at", order: "asc" },
});
if (storage.error) throw storage.error;

const newStorage = storage.data.filter((object) => {
  if (!since) return true;
  return object.created_at !== null && new Date(object.created_at) >= since;
});
const orphanNames = newStorage
  .filter((object) => !referencedPaths.has(`${student.id}/${object.name}`))
  .map((object) => object.name)
  .filter((name) => CONTROLLED_FILENAMES.has(name.replace(/^\d+-/, "")));
const allOrphanCount = newStorage.filter(
  (object) => !referencedPaths.has(`${student.id}/${object.name}`),
).length;

const controlledAttachments = attachmentRows
  .filter((row) => row.filename && CONTROLLED_FILENAMES.has(row.filename))
  .map((row) => ({
    filename: row.filename,
    item_id: row.item_id,
    storage_ref: row.storage_path
      ? createHash("sha256").update(row.storage_path).digest("hex").slice(0, 12)
      : null,
  }));

const controlledItemIds = new Set(controlledAttachments.map((row) => row.item_id).filter(Boolean));
const controlledItems = itemRows
  .filter((row) => controlledItemIds.has(row.id))
  .map((row) => {
    let evidence: Record<string, unknown> | null = null;
    try {
      evidence = row.extracted_text ? JSON.parse(row.extracted_text) : null;
    } catch {
      evidence = { parse_error: true };
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      category: row.category,
      evidence,
    };
  });

const controlledActions = actionRows
  .filter((row) => row.item_id && controlledItemIds.has(row.item_id))
  .map(({ id, created_at, ...row }) => row);

console.log(
  JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      since: since?.toISOString() ?? null,
      student_exists: true,
      space_bound: Boolean(student.photon_space_id),
      counts: {
        items: itemsCount,
        actions: actionsCount,
        attachments: attachmentsCount,
        messages: messagesCount,
        storage_objects: newStorage.length,
        unattached_storage_objects: allOrphanCount,
      },
      controlled: {
        attachments: controlledAttachments,
        items: controlledItems,
        actions: controlledActions,
        orphan_storage_objects: orphanNames,
      },
    },
    null,
    2,
  ),
);
