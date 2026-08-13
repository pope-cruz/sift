import { randomUUID } from "node:crypto";

import { cleanupJobFailures, db, getStudentById, type Student } from "./db.ts";
import { safeDiagnostic } from "./diagnostics.ts";
import { getDemoEnv } from "./env.ts";
import {
  DEMO_LIMITS,
  DemoError,
  assertTurnInput,
  hashDemoClientKey,
  hashDemoToken,
  newDemoToken,
  safeDemoFilename,
  validTimezone,
} from "./demo-policy.ts";

export { DEMO_ALLOWED_MIME, DEMO_LIMITS, DEMO_TOKEN_STORAGE_KEY, DemoError, assertTurnInput, hashDemoToken, newDemoToken, validTimezone } from "./demo-policy.ts";

export type DemoEvent =
  | { type: "accepted"; clientMessageId: string }
  | { type: "user"; text: string; attachment?: { name: string; mimeType: string }; scenarioId?: string }
  | { type: "typing"; active: boolean }
  | { type: "assistant"; text: string }
  | { type: "presentation"; presentation: unknown }
  | { type: "quota"; turnsRemaining: number; attachmentTurnsRemaining: number; bytesRemaining: number }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export function hashClientKey(clientKey: string): string {
  return hashDemoClientKey(clientKey, getDemoEnv().DEMO_TOKEN_SECRET);
}

export function assertDemoEnabled(): void {
  if (getDemoEnv().DEMO_ENABLED !== "true") {
    throw new DemoError("DEMO_DISABLED", "The interactive demo is temporarily unavailable.", 503);
  }
}

type DemoSessionRow = {
  id: string;
  student_id: string;
  timezone: string;
  expires_at: string;
  turns_used: number;
  attachment_turns_used: number;
  attachment_bytes_used: number;
};

export type DemoSessionState = {
  token: string;
  expiresAt: string;
  quota: { turnsRemaining: number; attachmentTurnsRemaining: number; bytesRemaining: number };
  transcript: DemoEvent[];
};

function quota(row: DemoSessionRow) {
  return {
    turnsRemaining: Math.max(0, DEMO_LIMITS.turns - row.turns_used),
    attachmentTurnsRemaining: Math.max(0, DEMO_LIMITS.attachmentTurns - row.attachment_turns_used),
    bytesRemaining: Math.max(0, DEMO_LIMITS.totalBytes - Number(row.attachment_bytes_used)),
  };
}

async function transcript(sessionId: string): Promise<DemoEvent[]> {
  const result = await db
    .from("demo_turns")
    .select("events")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (result.error) throw result.error;
  return result.data.flatMap((row) => (Array.isArray(row.events) ? row.events : [])) as DemoEvent[];
}

async function findSession(token: string): Promise<DemoSessionRow | null> {
  if (!token || token.length > 128) return null;
  const result = await db
    .from("demo_sessions")
    .select("id, student_id, timezone, expires_at, turns_used, attachment_turns_used, attachment_bytes_used")
    .eq("token_hash", hashDemoToken(token))
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data || new Date(result.data.expires_at).getTime() <= Date.now()) return null;
  return result.data as DemoSessionRow;
}

export async function resumeOrCreateDemoSession(input: {
  token?: string;
  clientKey: string;
  timezone: unknown;
}): Promise<DemoSessionState> {
  if (input.token) {
    const existing = await findSession(input.token);
    if (existing) {
      return { token: input.token, expiresAt: existing.expires_at, quota: quota(existing), transcript: await transcript(existing.id) };
    }
  }

  // Keep physical cleanup moving between the daily cron runs without making
  // session creation depend on cleanup infrastructure being healthy.
  await cleanupExpiredDemoSessions(10).catch((error) => {
    console.error("opportunistic demo cleanup failed", safeDiagnostic(error));
  });

  const token = newDemoToken();
  const result = await db.rpc("create_demo_session", {
    p_token_hash: hashDemoToken(token),
    p_client_key_hash: hashClientKey(input.clientKey),
    p_timezone: validTimezone(input.timezone),
  });
  if (result.error) {
    if (result.error.message.includes("DEMO_SESSION_CAP")) {
      throw new DemoError("SESSION_CREATION_CAP", "This browser has created three demos in the last 24 hours.", 429);
    }
    throw result.error;
  }
  const created = result.data?.[0];
  if (!created) throw new Error("The demo session was not created.");
  return {
    token,
    expiresAt: created.expires_at,
    quota: { turnsRemaining: DEMO_LIMITS.turns, attachmentTurnsRemaining: DEMO_LIMITS.attachmentTurns, bytesRemaining: DEMO_LIMITS.totalBytes },
    transcript: [],
  };
}

export async function authenticateDemoSession(token: string): Promise<{ session: DemoSessionRow; student: Student }> {
  const session = await findSession(token);
  if (!session) throw new DemoError("SESSION_EXPIRED", "This demo has expired. Start a new one to keep going.", 401);
  const student = await getStudentById(session.student_id);
  if (!student || student.channel !== "web_demo") throw new DemoError("SESSION_EXPIRED", "This demo is no longer available.", 401);
  return { session, student };
}

export type ClaimedDemoTurn = {
  id: string;
  sessionId: string;
  studentId: string;
  timezone: string;
  duplicate: boolean;
  status: string;
  events: DemoEvent[];
  quota: ReturnType<typeof quota>;
};

export async function claimDemoTurn(input: {
  token: string;
  clientMessageId: string;
  kind: "message" | "starter" | "reminder";
  attachmentBytes: number;
  uploadId?: string;
}): Promise<ClaimedDemoTurn> {
  const result = await db.rpc("claim_demo_turn", {
    p_token_hash: hashDemoToken(input.token),
    p_client_message_id: input.clientMessageId,
    p_kind: input.kind,
    p_attachment_bytes: input.attachmentBytes,
    p_upload_id: input.uploadId ?? null,
  });
  if (result.error) {
    const known: Record<string, [string, string, number]> = {
      DEMO_SESSION_EXPIRED: ["SESSION_EXPIRED", "This demo has expired. Start a new one to keep going.", 401],
      DEMO_TURN_QUOTA: ["TURN_QUOTA_EXHAUSTED", "This demo has used all 12 turns.", 429],
      DEMO_ATTACHMENT_QUOTA: ["ATTACHMENT_QUOTA_EXHAUSTED", "This demo has used all four attachment turns.", 429],
      DEMO_BYTES_QUOTA: ["ATTACHMENT_BYTES_EXHAUSTED", "This demo has reached its 20 MB upload limit.", 429],
      DEMO_UPLOAD_NOT_READY: ["UPLOAD_NOT_READY", "That upload is no longer ready. Attach the file again.", 409],
    };
    const entry = Object.entries(known).find(([key]) => result.error.message.includes(key));
    if (entry) throw new DemoError(...entry[1]);
    throw result.error;
  }
  const row = result.data?.[0];
  if (!row) throw new Error("The demo turn was not claimed.");
  return {
    id: row.turn_id,
    sessionId: row.session_id,
    studentId: row.student_id,
    timezone: row.timezone,
    duplicate: row.duplicate,
    status: row.status,
    events: Array.isArray(row.events) ? row.events : [],
    quota: {
      turnsRemaining: row.turns_remaining,
      attachmentTurnsRemaining: row.attachment_turns_remaining,
      bytesRemaining: Number(row.attachment_bytes_remaining),
    },
  };
}

const uploadExtension: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function reserveDemoUpload(input: {
  token: string;
  clientMessageId: string;
  filename: string;
  mimeType: string;
  size: number;
}): Promise<{ uploadId: string; signedUrl: string | null; alreadyUploaded: boolean; quota: { attachmentTurnsRemaining: number; bytesRemaining: number } }> {
  assertTurnInput({ text: "", file: { type: input.mimeType, size: input.size } });
  if (!input.clientMessageId || input.clientMessageId.length > 128) throw new DemoError("INVALID_MESSAGE_ID", "The message ID is missing or invalid.");
  const uploadId = randomUUID();
  const storagePath = `demo/${randomUUID()}.${uploadExtension[input.mimeType]}`;
  const result = await db.rpc("reserve_demo_upload", {
    p_token_hash: hashDemoToken(input.token),
    p_upload_id: uploadId,
    p_client_message_id: input.clientMessageId,
    p_storage_path: storagePath,
    p_filename: safeDemoFilename(input.filename, input.mimeType),
    p_mime_type: input.mimeType,
    p_size_bytes: input.size,
  });
  if (result.error) {
    if (result.error.message.includes("DEMO_SESSION_EXPIRED")) throw new DemoError("SESSION_EXPIRED", "This demo has expired. Start a new one to keep going.", 401);
    if (result.error.message.includes("DEMO_TURN_QUOTA")) throw new DemoError("TURN_QUOTA_EXHAUSTED", "This demo has used all 12 turns.", 429);
    if (result.error.message.includes("DEMO_ATTACHMENT_QUOTA")) throw new DemoError("ATTACHMENT_QUOTA_EXHAUSTED", "This demo has used all four attachment turns.", 429);
    if (result.error.message.includes("DEMO_BYTES_QUOTA")) throw new DemoError("ATTACHMENT_BYTES_EXHAUSTED", "This demo has reached its 20 MB upload limit.", 429);
    throw result.error;
  }
  const row = result.data?.[0];
  if (!row) throw new Error("The upload was not reserved.");
  let alreadyUploaded = false;
  if (row.duplicate) {
    const turn = await db.from("demo_turns")
      .select("id")
      .eq("session_id", (await authenticateDemoSession(input.token)).session.id)
      .eq("client_message_id", input.clientMessageId)
      .maybeSingle();
    if (turn.error) throw turn.error;
    if (turn.data) {
      alreadyUploaded = true;
    } else {
      const exists = await db.storage.from("attachments").exists(row.storage_path);
      if (exists.error) throw exists.error;
      alreadyUploaded = exists.data;
    }
  }
  let signedUrl: string | null = null;
  if (!alreadyUploaded) {
    const signed = await db.storage.from("attachments").createSignedUploadUrl(row.storage_path);
    if (signed.error) throw signed.error;
    signedUrl = signed.data.signedUrl;
  }
  return {
    uploadId: row.upload_id,
    signedUrl,
    alreadyUploaded,
    quota: { attachmentTurnsRemaining: row.attachment_turns_remaining, bytesRemaining: Number(row.attachment_bytes_remaining) },
  };
}

export async function readReservedDemoUpload(input: { token: string; uploadId: string }): Promise<{ sessionId: string; attachment: { id: string; name: string; mimeType: string; size: number; read(): Promise<Buffer> } }> {
  const { session } = await authenticateDemoSession(input.token);
  const result = await db.from("demo_uploads")
    .select("id, storage_path, filename, mime_type, size_bytes")
    .eq("id", input.uploadId)
    .eq("session_id", session.id)
    .in("status", ["reserved", "processing"])
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new DemoError("UPLOAD_NOT_READY", "That upload is no longer ready. Attach the file again.", 409);
  const downloaded = await db.storage.from("attachments").download(result.data.storage_path);
  if (downloaded.error) throw new DemoError("UPLOAD_NOT_READY", "The upload did not finish. Try attaching it again.", 409);
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (bytes.length !== Number(result.data.size_bytes)) throw new DemoError("CORRUPT_UPLOAD", "The uploaded file was incomplete. Try attaching it again.");
  return {
    sessionId: session.id,
    attachment: {
      id: result.data.id,
      name: result.data.filename,
      mimeType: result.data.mime_type,
      size: bytes.length,
      read: async () => bytes,
    },
  };
}

export async function consumeDemoUpload(uploadId: string): Promise<void> {
  const result = await db.from("demo_uploads").select("storage_path").eq("id", uploadId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return;
  const removed = await db.storage.from("attachments").remove([result.data.storage_path]);
  if (removed.error) throw removed.error;
  const updated = await db.from("demo_uploads").update({ status: "consumed" }).eq("id", uploadId);
  if (updated.error) throw updated.error;
}

export async function releaseDemoUpload(input: { token: string; uploadId: string }): Promise<void> {
  const result = await db.rpc("release_demo_upload", {
    p_token_hash: hashDemoToken(input.token),
    p_upload_id: input.uploadId,
  });
  if (result.error) throw result.error;
  const storagePath = result.data?.[0]?.storage_path;
  if (!storagePath) return;
  const removed = await db.storage.from("attachments").remove([storagePath]);
  if (removed.error) {
    // The refunded row deliberately remains as a cleanup pointer. A transient
    // Storage failure must not take quota away from the browser again.
    console.error("failed to remove refunded demo upload", safeDiagnostic(removed.error));
  }
}

async function demoStoragePaths(studentId: string, sessionId: string): Promise<string[]> {
  const [attachments, uploads] = await Promise.all([
    db.from("attachments").select("storage_path").eq("student_id", studentId),
    db.from("demo_uploads").select("storage_path").eq("session_id", sessionId),
  ]);
  if (attachments.error) throw attachments.error;
  if (uploads.error) throw uploads.error;
  return [...attachments.data, ...uploads.data].map((row) => row.storage_path).filter((path): path is string => Boolean(path));
}

export async function saveDemoTurn(input: { turnId: string; events: DemoEvent[]; status: "processing" | "complete" | "failed"; failureCode?: string }): Promise<void> {
  const result = await db.from("demo_turns").update({
    events: input.events,
    status: input.status,
    failure_code: input.failureCode ?? null,
    lease_expires_at: input.status === "processing"
      ? new Date(Date.now() + 5 * 60_000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  }).eq("id", input.turnId);
  if (result.error) throw result.error;
}

export async function resetDemoSession(token: string): Promise<DemoSessionState> {
  const session = await findSession(token);
  if (!session) throw new DemoError("SESSION_EXPIRED", "This demo has expired. Start a new one to keep going.", 401);
  const paths = await demoStoragePaths(session.student_id, session.id);
  if (paths.length) {
    const removed = await db.storage.from("attachments").remove(paths);
    if (removed.error) throw removed.error;
  }

  const nextToken = newDemoToken();
  const result = await db.rpc("reset_demo_session", {
    p_token_hash: hashDemoToken(token),
    p_new_token_hash: hashDemoToken(nextToken),
  });
  if (result.error) throw result.error;
  const row = result.data?.[0];
  if (!row) throw new Error("The demo session was not reset.");
  return {
    token: nextToken,
    expiresAt: row.expires_at,
    quota: {
      turnsRemaining: DEMO_LIMITS.turns,
      attachmentTurnsRemaining: DEMO_LIMITS.attachmentTurns,
      bytesRemaining: DEMO_LIMITS.totalBytes,
    },
    transcript: [],
  };
}

export async function deleteDemoSession(token: string): Promise<void> {
  const session = await findSession(token);
  if (!session) return;
  const paths = await demoStoragePaths(session.student_id, session.id);
  if (paths.length) {
    const removed = await db.storage.from("attachments").remove(paths);
    if (removed.error) throw removed.error;
  }
  const deleted = await db.from("students").delete().eq("id", session.student_id).eq("channel", "web_demo");
  if (deleted.error) throw deleted.error;
}

export async function cleanupExpiredDemoSessions(limit = 500): Promise<number> {
  await cleanupJobFailures().catch((error) => {
    console.error("job failure retention cleanup failed", safeDiagnostic(error));
  });
  const oldIssuances = await db.from("demo_session_issuances").delete().lt("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString());
  if (oldIssuances.error) throw oldIssuances.error;
  const expired = await db.from("demo_sessions").select("id, student_id").lte("expires_at", new Date().toISOString()).limit(limit);
  if (expired.error) throw expired.error;
  let deletedCount = 0;
  for (let index = 0; index < expired.data.length; index += 10) {
    const batch = expired.data.slice(index, index + 10);
    const settled = await Promise.allSettled(batch.map(async (session) => {
      const paths = await demoStoragePaths(session.student_id, session.id);
      if (paths.length) {
        const removed = await db.storage.from("attachments").remove(paths);
        if (removed.error) throw removed.error;
      }
      const deleted = await db.from("students").delete().eq("id", session.student_id).eq("channel", "web_demo");
      if (deleted.error) throw deleted.error;
    }));
    settled.forEach((result, offset) => {
      if (result.status === "fulfilled") deletedCount += 1;
      else console.error("expired demo cleanup failed", {
        sessionId: batch[offset]?.id,
        error: safeDiagnostic(result.reason),
      });
    });
  }
  return deletedCount;
}
