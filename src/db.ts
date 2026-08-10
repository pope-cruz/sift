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
 * A question Sift asked and is waiting on an answer to. Lives in the student's
 * existing `profile` jsonb — this is one open question per student, not a work
 * queue, so it needs no table of its own.
 */
export type Pending = {
  kind: "stale_syllabus";
  question: string;
  itemId: string;
};

export function pendingOf(student: Student): Pending | null {
  const pending = student.profile?.pending;
  return pending && typeof pending === "object" ? (pending as Pending) : null;
}

export async function setPending(studentId: string, pending: Pending | null): Promise<void> {
  const { data, error } = await db
    .from("students")
    .select("profile")
    .eq("id", studentId)
    .single();

  if (error) throw error;

  const profile = { ...(data.profile ?? {}) } as Record<string, unknown>;
  if (pending) profile.pending = pending;
  else delete profile.pending;

  const update = await db.from("students").update({ profile }).eq("id", studentId);
  if (update.error) throw update.error;
}

/**
 * Store the raw file in the private bucket and record it. Keyed by student so a
 * second student's upload can never collide with the demo student's; the row is
 * what ties the bytes back to the item they produced.
 */
export async function saveAttachment(input: {
  studentId: string;
  itemId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<string> {
  const storagePath = `${input.studentId}/${Date.now()}-${input.filename}`;

  const upload = await db.storage
    .from(BUCKET)
    .upload(storagePath, input.bytes, { contentType: input.mimeType, upsert: false });

  if (upload.error) throw upload.error;

  const { error } = await db.from("attachments").insert({
    student_id: input.studentId,
    item_id: input.itemId,
    filename: input.filename,
    mime_type: input.mimeType,
    storage_path: storagePath,
  });

  if (error) throw error;
  return storagePath;
}
