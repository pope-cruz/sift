// Read-only, marker-scoped audit for the Phase 3 live acceptance run. It
// prints no identity fields, raw messages, extracted documents, or storage
// paths and fails unless persistence and cleanup are exact.

import { createHash } from "node:crypto";

import { db, getStudentByPhone } from "../db.ts";
import { env } from "../env.ts";

const MARKER = "SIFT-PHASE3-20260811-A";
const CAFE_NAME = "Juniper Study Cafe";
const student = await getStudentByPhone(env.DEMO_PHONE);
if (!student) throw new Error("The demo student is not seeded.");

const itemsResult = await db
  .from("items")
  .select("id, type, title, category, extracted_text")
  .eq("student_id", student.id)
  .ilike("extracted_text", `%${MARKER}%`);
if (itemsResult.error) throw itemsResult.error;
const itemIds = itemsResult.data.map((item) => item.id);

const actionsResult = itemIds.length
  ? await db
      .from("actions")
      .select("item_id, description, due_date, status")
      .eq("student_id", student.id)
      .in("item_id", itemIds)
      .order("due_date", { ascending: true })
  : { data: [], error: null };
if (actionsResult.error) throw actionsResult.error;

const attachmentsResult = itemIds.length
  ? await db
      .from("attachments")
      .select("item_id, filename, storage_path")
      .eq("student_id", student.id)
      .in("item_id", itemIds)
  : { data: [], error: null };
if (attachmentsResult.error) throw attachmentsResult.error;

const callbackResult = await db
  .from("messages")
  .select("id", { count: "exact", head: true })
  .eq("student_id", student.id)
  .eq("direction", "outbound")
  .ilike("content", "%Project 1%")
  .ilike("content", `%${CAFE_NAME}%`);
if (callbackResult.error) throw callbackResult.error;

const storageResult = await db.storage.from("attachments").list(student.id, {
  limit: 1_000,
  sortBy: { column: "created_at", order: "asc" },
});
if (storageResult.error) throw storageResult.error;
const markerObjects = storageResult.data.filter((object) => object.name.includes(MARKER));
const referencedPaths = new Set(
  attachmentsResult.data
    .map((attachment) => attachment.storage_path)
    .filter((path): path is string => Boolean(path)),
);
const orphanMarkerObjects = markerObjects.filter(
  (object) => !referencedPaths.has(`${student.id}/${object.name}`),
);

const evidence = itemsResult.data.map((item) => {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = item.extracted_text ? JSON.parse(item.extracted_text) : null;
  } catch {
    parsed = null;
  }
  return {
    type: item.type,
    title: item.title,
    category: item.category,
    filename: typeof parsed?.filename === "string" ? parsed.filename : null,
    evidence_parseable: parsed !== null,
    date_candidates: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
    storage_ref: (() => {
      const path = attachmentsResult.data.find((attachment) => attachment.item_id === item.id)?.storage_path;
      return path ? createHash("sha256").update(path).digest("hex").slice(0, 12) : null;
    })(),
  };
});

const summary = {
  marker: MARKER,
  counts: {
    items: itemsResult.data.length,
    actions: actionsResult.data.length,
    attachments: attachmentsResult.data.length,
    storage_objects: markerObjects.length,
    orphan_storage_objects: orphanMarkerObjects.length,
    delivered_callbacks: callbackResult.count ?? 0,
  },
  items: evidence,
  actions: actionsResult.data.map(({ item_id: _itemId, ...action }) => action),
};

const failures: string[] = [];
if (summary.counts.items !== 2) failures.push(`expected 2 items, found ${summary.counts.items}`);
if (summary.counts.actions !== 2) failures.push(`expected 2 actions, found ${summary.counts.actions}`);
if (summary.counts.attachments !== 2) failures.push(`expected 2 attachments, found ${summary.counts.attachments}`);
if (summary.counts.storage_objects !== 2) failures.push(`expected 2 storage objects, found ${summary.counts.storage_objects}`);
if (summary.counts.orphan_storage_objects !== 0) failures.push("marker storage contains an orphan");
if (summary.counts.delivered_callbacks !== 1) {
  failures.push(`expected 1 delivered callback, found ${summary.counts.delivered_callbacks}`);
}
if (!summary.items.every((item) => item.evidence_parseable && item.storage_ref)) {
  failures.push("an item lacks parseable provenance or an attachment reference");
}
if (!summary.actions.every((action) => action.status === "open" && action.due_date)) {
  failures.push("an action is not an open dated action");
}
if (!summary.actions.some((action) => /Project 1/i.test(action.description ?? ""))) {
  failures.push("Project 1 action is missing");
}
if (!summary.items.some((item) => (item.title ?? "").toLowerCase() === CAFE_NAME.toLowerCase())) {
  failures.push(`${CAFE_NAME} item is missing`);
}

console.log(JSON.stringify({ phase3_audit: failures.length ? "failed" : "passed", ...summary }, null, 2));
if (failures.length) throw new Error(`Phase 3 audit failed: ${failures.join("; ")}`);
