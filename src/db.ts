import { createClient } from "@supabase/supabase-js";

import { env } from "./env.ts";
import type {
  ContextActionRow,
  ContextItemRow,
  ContextMessageRow,
  ContextRows,
} from "./planner.ts";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Student = {
  id: string;
  name: string | null;
  phone: string | null;
  photon_space_id: string | null;
  timezone: string;
  profile: Record<string, unknown>;
};

export async function getStudentBySpaceId(spaceId: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select("id, name, phone, photon_space_id, timezone, profile")
    .eq("photon_space_id", spaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Identity lookup for bounded validation scripts; never log the phone. */
export async function getStudentByPhone(phone: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select("id, name, phone, photon_space_id, timezone, profile")
    .eq("phone", phone)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Claim a message id. Returns false when this id has already been recorded —
 * the caller must then drop the event. `photon_message_id` is UNIQUE, so the
 * conflict is resolved by the database, not by a read-then-write race.
 */
export async function recordMessage(input: {
  studentId: string | null;
  photonMessageId: string;
  direction: string;
  content: string | null;
}): Promise<boolean> {
  const { data, error } = await db
    .from("messages")
    .upsert(
      {
        student_id: input.studentId,
        photon_message_id: input.photonMessageId,
        direction: input.direction,
        content: input.content,
      },
      { onConflict: "photon_message_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Onboarding writes its message row before the student is bound to the space,
 * so that row lands with a null student_id. Attribute it after the fact —
 * Phase 3 assembles context by student_id and would otherwise miss the first
 * thing they ever said.
 */
export async function backfillMessageStudent(photonMessageId: string, studentId: string) {
  const { error } = await db
    .from("messages")
    .update({ student_id: studentId })
    .eq("photon_message_id", photonMessageId)
    .is("student_id", null);

  if (error) throw error;
}

/**
 * Bind the demo student to the space they texted from. The student row is
 * created by `npm run seed`; onboarding only attaches the space id.
 */
export async function attachSpaceToStudent(phone: string, spaceId: string): Promise<Student> {
  const { data, error } = await db
    .from("students")
    .update({ photon_space_id: spaceId })
    .eq("phone", phone)
    .select("id, name, phone, photon_space_id, timezone, profile")
    .single();

  if (error) throw error;
  return data;
}

const BUCKET = "attachments";

export async function insertItem(input: {
  studentId: string;
  type: string;
  title: string | null;
  summary: string;
  extractedText?: string | null;
  category?: string | null;
}): Promise<string> {
  const { data, error } = await db
    .from("items")
    .insert({
      student_id: input.studentId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      extracted_text: input.extractedText ?? null,
      category: input.category ?? null,
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

/**
 * Undo a partially-written ingest. Supabase JS has no transactions, so when a
 * write after insertItem fails, the compensating move is to remove the item
 * and anything already hung off it. The FKs are `on delete set null`, not
 * cascade — dependents are deleted explicitly so no orphan rows survive.
 */
export async function deleteItemCascade(studentId: string, itemId: string): Promise<void> {
  for (const table of ["actions", "attachments"] as const) {
    const { error } = await db
      .from(table)
      .delete()
      .eq("item_id", itemId)
      .eq("student_id", studentId);
    if (error) throw error;
  }

  const { error } = await db.from("items").delete().eq("id", itemId).eq("student_id", studentId);
  if (error) throw error;
}

export type ActionInput = {
  description: string;
  dueDate: string | null;
  remindAt: string | null;
  /** `open` is trackable work; `reference` is remembered but never reminded on. */
  status?: "open" | "reference";
};

/** Returns the new row ids, in the order given. */
export async function insertActions(
  studentId: string,
  itemId: string,
  actions: ActionInput[],
): Promise<string[]> {
  if (actions.length === 0) return [];

  const { data, error } = await db
    .from("actions")
    .insert(
      actions.map((action) => ({
        student_id: studentId,
        item_id: itemId,
        description: action.description,
        due_date: action.dueDate,
        remind_at: action.remindAt,
        status: action.status ?? "open",
      })),
    )
    .select("id");

  if (error) throw error;
  return data.map((row) => row.id);
}

/**
 * Rewrite reference rows once the student has told Sift what the dates really
 * are. Each row gets its own values, so this is a loop rather than one
 * statement — a syllabus is a handful of rows, not a bulk job.
 */
export async function rescheduleActions(
  studentId: string,
  rows: { id: string; dueDate: string; remindAt: string | null; status: "open" | "reference" }[],
): Promise<void> {
  for (const row of rows) {
    const { error } = await db
      .from("actions")
      .update({ status: row.status, due_date: row.dueDate, remind_at: row.remindAt })
      .eq("id", row.id)
      .eq("student_id", studentId);

    if (error) throw error;
  }
}

/**
 * Push the raw bytes into the private bucket. Split from the row insert because
 * this is the slow half — a megabyte over the wire — and it depends on nothing
 * the extraction produces, so ingest runs the two concurrently rather than
 * making the student wait for the upload before Sift can reply.
 *
 * Keyed by student, so one student's upload can never collide with another's.
 */
export async function uploadAttachmentBytes(input: {
  studentId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<string> {
  const storagePath = `${input.studentId}/${Date.now()}-${input.filename}`;

  const { error } = await db.storage
    .from(BUCKET)
    .upload(storagePath, input.bytes, { contentType: input.mimeType, upsert: false });

  if (error) throw error;
  return storagePath;
}

/** Remove an uploaded object when analysis or persistence cannot finish. */
export async function deleteAttachmentBytes(storagePath: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
}

/** Ties stored bytes back to the item they produced. */
export async function recordAttachment(input: {
  studentId: string;
  itemId: string;
  filename: string;
  mimeType: string;
  storagePath: string;
}): Promise<void> {
  const { error } = await db.from("attachments").insert({
    student_id: input.studentId,
    item_id: input.itemId,
    filename: input.filename,
    mime_type: input.mimeType,
    storage_path: input.storagePath,
  });

  if (error) throw error;
}

/**
 * One identity-scoped read boundary for retrieval and planning. The relatively
 * generous row limits are reduced deterministically in planner.ts after
 * relevance ranking; raw attachment bytes are never queried, and
 * `extracted_text` is parsed only for compact place/topic fields.
 */
export async function getContextRows(
  studentId: string,
  options?: { itemLimit?: number; actionLimit?: number; messageLimit?: number },
): Promise<ContextRows> {
  const [items, actions, messages] = await Promise.all([
    db
      .from("items")
      .select("id, student_id, type, title, summary, category, extracted_text, created_at")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false })
      .limit(options?.itemLimit ?? 50),
    db
      .from("actions")
      .select("id, student_id, item_id, description, due_date, status, created_at")
      .eq("student_id", studentId)
      .eq("status", "open")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(options?.actionLimit ?? 100),
    db
      .from("messages")
      .select("id, student_id, direction, content, created_at")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false })
      .limit(options?.messageLimit ?? 20),
  ]);

  if (items.error) throw items.error;
  if (actions.error) throw actions.error;
  if (messages.error) throw messages.error;

  return {
    items: items.data as ContextItemRow[],
    actions: actions.data as ContextActionRow[],
    // The query is newest-first; assembly expects conversation order.
    messages: [...(messages.data as ContextMessageRow[])].reverse(),
  };
}

/**
 * The reasoning behind one saved item, as written at ingest.
 *
 * `extracted_text` already holds every date the reader saw and the ruling
 * analysis.ts made on it — so "why isn't the final on my list?" is answerable
 * from what we stored, not from the model's memory of saying something. It is
 * read on demand rather than carried in every prompt because a dense syllabus
 * is ~28 candidates, and most turns never ask.
 */
export async function getItemEvidence(
  studentId: string,
  itemId: string,
): Promise<{ title: string | null; extractedText: string | null } | null> {
  const { data, error } = await db
    .from("items")
    .select("title, extracted_text")
    .eq("id", itemId)
    .eq("student_id", studentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { title: data.title, extractedText: data.extracted_text };
}

export type SavedItem = {
  id: string;
  type: string | null;
  title: string | null;
  summary: string | null;
  actions: { id: string; description: string; due_date: string | null; status: string }[];
};

/** Everything this student has saved, newest first, with dates attached. */
export async function listSavedItems(studentId: string, limit = 20): Promise<SavedItem[]> {
  const { data, error } = await db
    .from("items")
    .select("id, type, title, summary")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  if (data.length === 0) return [];

  const actions = await db
    .from("actions")
    .select("id, item_id, description, due_date, status")
    .eq("student_id", studentId)
    .in(
      "item_id",
      data.map((item) => item.id),
    )
    .order("due_date");

  if (actions.error) throw actions.error;

  return data.map((item) => ({
    ...item,
    actions: actions.data
      .filter((action) => action.item_id === item.id)
      .map(({ item_id: _ignored, ...action }) => action),
  }));
}
