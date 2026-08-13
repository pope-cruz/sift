import { createClient } from "@supabase/supabase-js";

import { safeDiagnostic } from "./diagnostics.ts";
import { sharedEnv } from "./env.ts";
import { localInstant } from "./dates.ts";
import type {
  ContextActionRow,
  ContextItemRow,
  ContextMessageRow,
  ContextRows,
} from "./planner.ts";
import { REMINDER_CLAIMED_STATUS, type ReminderClaim } from "./reminders.ts";
import { storedDueTime } from "./stored-deadlines.ts";
import type { PendingReminderState } from "./reminder-delta.ts";
import { isMissingSchemaFeature } from "./schema-compat.ts";

export const db = createClient(sharedEnv.SUPABASE_URL, sharedEnv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function recordJobFailure(input: {
  stage: string;
  resourceId?: string;
  error: unknown;
}): Promise<void> {
  const diagnostic = safeDiagnostic(input.error);
  try {
    const { error } = await db.from("job_failures").insert({
      stage: input.stage.slice(0, 120),
      resource_id: input.resourceId?.slice(0, 240) ?? null,
      error_code: diagnostic.code,
      detail: diagnostic,
    });
    if (error) throw error;
  } catch (error) {
    console.error("failed to persist job failure", { stage: input.stage, error: safeDiagnostic(error) });
  }
}

export async function cleanupJobFailures(retentionDays = 30): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
  const { error } = await db.from("job_failures").delete().lt("created_at", cutoff);
  if (error) throw error;
}

export type Student = {
  id: string;
  name: string | null;
  phone: string | null;
  photon_space_id: string | null;
  timezone: string;
  profile: Record<string, unknown>;
  channel: "imessage" | "web_demo";
};

const STUDENT_COLUMNS = "id, name, phone, photon_space_id, timezone, profile, channel";

export async function getStudentBySpaceId(spaceId: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select(STUDENT_COLUMNS)
    .eq("photon_space_id", spaceId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Identity lookup for bounded validation scripts; never log the phone. */
export async function getStudentByPhone(phone: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select(STUDENT_COLUMNS)
    .eq("phone", phone)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getStudentById(studentId: string): Promise<Student | null> {
  const { data, error } = await db
    .from("students")
    .select(STUDENT_COLUMNS)
    .eq("id", studentId)
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
  const row = {
    student_id: input.studentId,
    photon_message_id: input.photonMessageId,
    direction: input.direction,
    content: input.content,
  };
  let result = await db
    .from("messages")
    .upsert(
      {
        ...row,
        processing_status: input.direction === "inbound" ? "pending" : "complete",
      },
      { onConflict: "photon_message_id", ignoreDuplicates: true },
    )
    .select("id");

  // Keep the worker usable while the additive migration is being rolled out.
  // Missing-column errors reject before the insert, so this retry cannot write
  // the same message twice.
  if (result.error && isMissingSchemaFeature(result.error, ["processing_status"])) {
    result = await db
      .from("messages")
      .upsert(row, { onConflict: "photon_message_id", ignoreDuplicates: true })
      .select("id");
  }
  if (result.error) throw result.error;
  return (result.data?.length ?? 0) > 0;
}

export async function claimInboundMessage(photonMessageId: string, legacyClaim = true): Promise<boolean> {
  const { data, error } = await db.rpc("claim_inbound_message", { p_message_id: photonMessageId });
  if (error && isMissingSchemaFeature(error, ["claim_inbound_message"])) return legacyClaim;
  if (error) throw error;
  return data === true;
}

export async function finishInboundMessage(photonMessageId: string, succeeded: boolean): Promise<void> {
  const { error } = await db.rpc("finish_inbound_message", {
    p_message_id: photonMessageId,
    p_succeeded: succeeded,
  });
  if (error && isMissingSchemaFeature(error, ["finish_inbound_message"])) return;
  if (error) throw error;
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
    .select(STUDENT_COLUMNS)
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

export async function saveNoteAtomic(input: {
  studentId: string;
  sourceMessageId: string;
  title: string;
  summary: string;
  extractedText: string;
  actions: ActionInput[];
}): Promise<{ itemId: string; duplicate: boolean }> {
  const { data, error } = await db.rpc("save_note_with_actions", {
    p_student_id: input.studentId,
    p_source_message_id: input.sourceMessageId,
    p_title: input.title,
    p_summary: input.summary,
    p_extracted_text: input.extractedText,
    p_actions: input.actions.map((action) => ({
      description: action.description,
      due_date: action.dueDate,
      remind_at: action.remindAt,
      status: action.status ?? "open",
    })),
  });
  if (error && isMissingSchemaFeature(error, ["save_note_with_actions", "source_message_id"])) {
    const itemId = await insertItem({
      studentId: input.studentId,
      type: "note",
      title: input.title,
      summary: input.summary,
      extractedText: input.extractedText,
      category: "note",
    });
    try {
      await insertActions(input.studentId, itemId, input.actions);
      return { itemId, duplicate: false };
    } catch (fallbackError) {
      await deleteItemCascade(input.studentId, itemId).catch((cleanupError) => {
        console.error("failed to compensate legacy note write", safeDiagnostic(cleanupError));
      });
      throw fallbackError;
    }
  }
  if (error) throw error;
  const row = data?.[0];
  if (!row?.item_id) throw new Error("The note transaction returned no item.");
  return { itemId: row.item_id, duplicate: row.duplicate === true };
}

export async function saveIngestItemAtomic(input: {
  studentId: string;
  sourceMessageId: string;
  sourceTurnId: string;
  type: string;
  title: string | null;
  summary: string;
  extractedText: string | null;
  category: string | null;
  filename: string;
  mimeType: string;
  storagePath: string;
  actions: ActionInput[];
}): Promise<{ itemId: string; duplicate: boolean }> {
  const { data, error } = await db.rpc("save_ingest_item", {
    p_student_id: input.studentId,
    p_source_message_id: input.sourceMessageId,
    p_source_turn_id: input.sourceTurnId,
    p_type: input.type,
    p_title: input.title,
    p_summary: input.summary,
    p_extracted_text: input.extractedText,
    p_category: input.category,
    p_filename: input.filename,
    p_mime_type: input.mimeType,
    p_storage_path: input.storagePath,
    p_actions: input.actions.map((action) => ({
      description: action.description,
      due_date: action.dueDate,
      remind_at: action.remindAt,
      status: action.status ?? "open",
    })),
  });
  if (error && isMissingSchemaFeature(error, ["save_ingest_item", "source_message_id"])) {
    const itemId = await insertItem({
      studentId: input.studentId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      extractedText: input.extractedText,
      category: input.category,
    });
    try {
      await recordAttachment({
        studentId: input.studentId,
        itemId,
        filename: input.filename,
        mimeType: input.mimeType,
        storagePath: input.storagePath,
      });
      await insertActions(input.studentId, itemId, input.actions);
      return { itemId, duplicate: false };
    } catch (fallbackError) {
      await deleteItemCascade(input.studentId, itemId).catch((cleanupError) => {
        console.error("failed to compensate legacy ingest write", safeDiagnostic(cleanupError));
      });
      throw fallbackError;
    }
  }
  if (error) throw error;
  const row = data?.[0];
  if (!row?.item_id) throw new Error("The ingest transaction returned no item.");
  return { itemId: row.item_id, duplicate: row.duplicate === true };
}

export type UndoLatestSaveResult = {
  itemCount: number;
  titles: string[];
};

/**
 * Remove only the newest recent save-turn owned by this student. The database
 * transaction deletes derived items/actions/attachment rows and returns only
 * storage objects that no surviving attachment references. Student profile and
 * conversation messages are outside the function's write set.
 */
export async function undoLatestSave(studentId: string): Promise<UndoLatestSaveResult | null> {
  const { data, error } = await db.rpc("undo_latest_save", { p_student_id: studentId });
  if (error) throw error;
  const row = data?.[0];
  if (!row || Number(row.item_count) < 1) return null;

  const storagePaths = Array.isArray(row.storage_paths)
    ? row.storage_paths.filter((path: unknown): path is string => typeof path === "string" && path.length > 0)
    : [];
  if (storagePaths.length > 0) {
    const removed = await db.storage.from(BUCKET).remove(storagePaths);
    if (removed.error) {
      await recordJobFailure({
        stage: "undo.storage_cleanup",
        resourceId: studentId,
        error: removed.error,
      });
    }
  }

  return {
    itemCount: Number(row.item_count),
    titles: Array.isArray(row.titles)
      ? row.titles.filter((title: unknown): title is string =>
          typeof title === "string" && title.trim().length > 0)
      : [],
  };
}

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
      .update({
        status: row.status,
        due_date: row.dueDate,
        remind_at: row.remindAt,
        // A moved/re-enabled deadline is a new pending delivery decision.
        reminder_sent: false,
      })
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
  actions: {
    id: string;
    description: string;
    due_date: string | null;
    due_time: string | null;
    remind_at: string | null;
    status: string;
  }[];
};

/** Everything this student has saved, newest first, with dates attached. */
export async function listSavedItems(studentId: string, limit = 20): Promise<SavedItem[]> {
  const { data, error } = await db
    .from("items")
    .select("id, type, title, summary, extracted_text")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  if (data.length === 0) return [];

  const actions = await db
    .from("actions")
    .select("id, item_id, description, due_date, remind_at, status")
    .eq("student_id", studentId)
    .in(
      "item_id",
      data.map((item) => item.id),
    )
    .order("due_date");

  if (actions.error) throw actions.error;

  return data.map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    summary: item.summary,
    actions: actions.data
      .filter((action) => action.item_id === item.id)
      .map(({ item_id: _ignored, ...action }) => ({
        ...action,
        due_time: action.due_date
          ? storedDueTime(item.extracted_text, action.description, action.due_date)
          : null,
      })),
  }));
}

type ReminderActionRow = {
  id: string;
  student_id: string;
  item_id: string | null;
  description: string | null;
  due_date: string | null;
  remind_at: string | null;
};

/**
 * Claim due reminders with one conditional UPDATE per candidate. PostgreSQL
 * rechecks the status/remind_at predicate after a concurrent updater releases
 * its row lock, so only one worker receives each action. `reminder_sent` stays
 * false until the provider callback succeeds; the temporary action status is
 * the claim token.
 */
async function claimDueRemindersFor(
  now: Date,
  limit: number,
  scope: { channel: Student["channel"]; studentId?: string },
): Promise<ReminderClaim[]> {
  let candidateQuery = db
    .from("actions")
    .select("id, student_id, item_id, description, due_date, remind_at, students!inner(channel)")
    .eq("students.channel", scope.channel)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .not("remind_at", "is", null)
    .not("due_date", "is", null)
    .lte("remind_at", now.toISOString())
    .order("remind_at", { ascending: true })
    .limit(Math.max(limit * 2, limit));
  if (scope.studentId) candidateQuery = candidateQuery.eq("student_id", scope.studentId);
  const candidates = await candidateQuery;
  if (candidates.error) throw candidates.error;

  const claimed: ReminderActionRow[] = [];
  for (const candidate of candidates.data as ReminderActionRow[]) {
    if (claimed.length >= limit) break;
    const result = await db
      .from("actions")
      .update({ status: REMINDER_CLAIMED_STATUS })
      .eq("id", candidate.id)
      .eq("student_id", candidate.student_id)
      .eq("status", "open")
      .eq("reminder_sent", false)
      .eq("remind_at", candidate.remind_at)
      .select("id, student_id, item_id, description, due_date, remind_at")
      .maybeSingle();
    if (result.error) throw result.error;
    if (result.data) claimed.push(result.data as ReminderActionRow);
  }

  const hydrated: ReminderClaim[] = [];
  for (const action of claimed) {
    const [student, item] = await Promise.all([
      getStudentById(action.student_id),
      action.item_id
        ? db
            .from("items")
            .select("title, summary, extracted_text")
            .eq("id", action.item_id)
            .eq("student_id", action.student_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (item.error) throw item.error;
    const dueTime = action.due_date && action.description
      ? storedDueTime(item.data?.extracted_text, action.description, action.due_date)
      : null;
    const due = action.due_date && student
      ? localInstant(action.due_date, dueTime ?? "20:00", student.timezone)
      : null;
    if (
      !student ||
      student.channel !== scope.channel ||
      (scope.channel === "imessage" && !student.photon_space_id) ||
      !action.description ||
      !action.due_date ||
      !action.remind_at ||
      !due ||
      due.getTime() <= now.getTime()
    ) {
      // A reminder with no destination or grounded deadline cannot be sent.
      // Cancel the reminder without deleting the underlying saved action.
      const { error } = await db
        .from("actions")
        .update({
          status: due && due.getTime() <= now.getTime() ? "reference" : "open",
          remind_at: null,
        })
        .eq("id", action.id)
        .eq("status", REMINDER_CLAIMED_STATUS);
      if (error) throw error;
      continue;
    }

    hydrated.push({
      actionId: action.id,
      studentId: action.student_id,
      itemId: action.item_id,
      spaceId: student.photon_space_id ?? `web:${student.id}`,
      timezone: student.timezone,
      description: action.description,
      dueDate: action.due_date,
      dueTime,
      plannedSendAt: action.remind_at,
      itemTitle: item.data?.title ?? null,
      itemSummary: item.data?.summary ?? null,
    });
  }

  return hydrated;
}

/** Production workers can only claim iMessage students. */
export function claimDueReminders(now: Date, limit: number): Promise<ReminderClaim[]> {
  return claimDueRemindersFor(now, limit, { channel: "imessage" });
}

/** The web path is additionally scoped to the authenticated anonymous student. */
export function claimWebDemoReminders(studentId: string, now: Date, limit = 1): Promise<ReminderClaim[]> {
  return claimDueRemindersFor(now, limit, { channel: "web_demo", studentId });
}

export async function nextPendingReminder(studentId: string): Promise<{ actionId: string; targetTime: string } | null> {
  const result = await db
    .from("actions")
    .select("id, remind_at")
    .eq("student_id", studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .not("remind_at", "is", null)
    .not("due_date", "is", null)
    .order("remind_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data?.remind_at ? { actionId: result.data.id, targetTime: result.data.remind_at } : null;
}

export async function listPendingReminders(studentId: string): Promise<PendingReminderState[]> {
  const result = await db
    .from("actions")
    .select("id, remind_at")
    .eq("student_id", studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .not("remind_at", "is", null)
    .not("due_date", "is", null)
    .order("remind_at", { ascending: true });
  if (result.error) throw result.error;
  return result.data.flatMap((row) => row.remind_at
    ? [{ actionId: row.id, targetTime: row.remind_at }]
    : []);
}

export async function markReminderDelivered(claim: ReminderClaim): Promise<void> {
  const { data, error } = await db
    .from("actions")
    .update({ status: "open", reminder_sent: true })
    .eq("id", claim.actionId)
    .eq("student_id", claim.studentId)
    .eq("status", REMINDER_CLAIMED_STATUS)
    .eq("reminder_sent", false)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Reminder claim was no longer owned at delivery completion.");
}

export async function releaseReminderForRetry(
  claim: ReminderClaim,
  retryAt: Date,
): Promise<void> {
  const { data, error } = await db
    .from("actions")
    .update({ status: "open", remind_at: retryAt.toISOString() })
    .eq("id", claim.actionId)
    .eq("student_id", claim.studentId)
    .eq("status", REMINDER_CLAIMED_STATUS)
    .eq("reminder_sent", false)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Reminder claim was no longer owned when retry was scheduled.");
}

export async function cancelActionReminder(studentId: string, actionId: string): Promise<boolean> {
  const { data, error } = await db
    .from("actions")
    .update({ remind_at: null })
    .eq("id", actionId)
    .eq("student_id", studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .not("remind_at", "is", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) === 1;
}

export async function rescheduleActionReminder(input: {
  studentId: string;
  actionId: string;
  plannedSendAt: string;
}): Promise<boolean> {
  const { data, error } = await db
    .from("actions")
    .update({ remind_at: input.plannedSendAt })
    .eq("id", input.actionId)
    .eq("student_id", input.studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) === 1;
}

/** Move exactly one pending reminder to now for the bounded acceptance path. */
export async function forceNextReminderNow(
  studentId: string,
  now: Date,
  actionId?: string,
): Promise<string | null> {
  let query = db
    .from("actions")
    .select("id")
    .eq("student_id", studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .not("remind_at", "is", null)
    .not("due_date", "is", null)
    .order("remind_at", { ascending: true })
    .limit(1);
  if (actionId) query = query.eq("id", actionId);

  const pending = await query.maybeSingle();
  if (pending.error) throw pending.error;
  if (!pending.data) return null;

  const updated = await db
    .from("actions")
    .update({ remind_at: now.toISOString() })
    .eq("id", pending.data.id)
    .eq("student_id", studentId)
    .eq("status", "open")
    .eq("reminder_sent", false)
    .select("id")
    .maybeSingle();
  if (updated.error) throw updated.error;
  return updated.data?.id ?? null;
}
