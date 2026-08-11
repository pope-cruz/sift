import { createClient } from "@supabase/supabase-js";

import { env } from "./env.ts";

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
  title: string;
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
 * The conversation, both directions, oldest first. Sift's own replies are
 * recorded by `say()` in turn.ts rather than from the provider's echo, so
 * ordering is deterministic and every turn sees what it actually said.
 */
export async function getRecentMessages(
  studentId: string,
  limit = 12,
): Promise<{ direction: string; content: string }[]> {
  const { data, error } = await db
    .from("messages")
    .select("direction, content, created_at")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data
    .reverse()
    .filter((row) => row.content)
    .map((row) => ({ direction: row.direction ?? "inbound", content: row.content as string }));
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
