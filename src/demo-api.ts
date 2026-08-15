import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { handle } from "hono/vercel";

import {
  assertDemoEnabled,
  assertTurnInput,
  authenticateDemoSession,
  claimDemoTurn,
  cleanupExpiredDemoSessions,
  consumeDemoUpload,
  DemoError,
  readReservedDemoUpload,
  releaseDemoUpload,
  reserveDemoUpload,
  resetDemoSession,
  resumeOrCreateDemoSession,
  saveDemoTurn,
  type DemoEvent,
} from "./demo.ts";
import { demoScenario, isDemoScenarioId } from "./demo-fixtures.ts";
import { runWebDemoReminder } from "./demo-reminders.ts";
import { listPendingReminders, recordMessage } from "./db.ts";
import { InputDiagnosticError, safeDiagnostic } from "./diagnostics.ts";
import { getDemoEnv } from "./env.ts";
import { validateReadableBytes } from "./input.ts";
import { processTurn, type TurnAttachment } from "./turn-core.ts";
import { reminderPresentationDelta } from "./reminder-delta.ts";

export const config = { runtime: "nodejs", maxDuration: 300 };

export const demoApp = new Hono();
const app = demoApp;

app.use("/api/demo", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
});

function route(c: { req: { query(name: string): string | undefined } }) {
  return c.req.query("route") ?? "";
}

function bearer(value: string | undefined): string {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
}

function clientKey(c: { req: { header(name: string): string | undefined } }): string {
  const ip = c.req.header("x-vercel-forwarded-for") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const firstIp = ip.split(",")[0]?.trim() ?? "unknown";
  return firstIp;
}

function errorResponse(error: unknown) {
  if (error instanceof DemoError) {
    return { body: { error: { code: error.code, message: error.message } }, status: error.status };
  }
  if (error instanceof InputDiagnosticError) {
    return { body: { error: { code: "CORRUPT_UPLOAD", message: error.userMessage } }, status: 400 };
  }
  console.error("demo api failed", safeDiagnostic(error));
  return { body: { error: { code: "PROCESSING_FAILED", message: "sort couldn't finish that request. Try it once more." } }, status: 500 };
}

app.post("/api/demo", async (c) => {
  const endpoint = route(c);
  try {
    assertDemoEnabled();

    if (endpoint === "session") {
      const body: { token?: string; timezone?: unknown } = await c.req.json().catch(() => ({}));
      return c.json(await resumeOrCreateDemoSession({ token: body.token, timezone: body.timezone, clientKey: clientKey(c) }));
    }

    if (endpoint === "upload") {
      const token = bearer(c.req.header("authorization"));
      await authenticateDemoSession(token);
      const body: { clientMessageId?: string; filename?: string; mimeType?: string; size?: number } = await c.req.json().catch(() => ({}));
      if (!body.clientMessageId || !body.filename || !body.mimeType || typeof body.size !== "number") {
        throw new DemoError("INVALID_UPLOAD", "The upload metadata is incomplete.");
      }
      return c.json(await reserveDemoUpload({
        token,
        clientMessageId: body.clientMessageId,
        filename: body.filename,
        mimeType: body.mimeType,
        size: body.size,
      }));
    }

    if (endpoint === "upload/release") {
      const token = bearer(c.req.header("authorization"));
      const body: { uploadId?: string } = await c.req.json().catch(() => ({}));
      if (!body.uploadId) throw new DemoError("INVALID_UPLOAD", "The upload reservation is missing.");
      await releaseDemoUpload({ token, uploadId: body.uploadId });
      return c.json({ released: true });
    }

    if (endpoint === "turn") {
      const token = bearer(c.req.header("authorization"));
      const { student } = await authenticateDemoSession(token);
      const form = await c.req.formData();
      const text = String(form.get("text") ?? "").trim();
      const clientMessageId = String(form.get("clientMessageId") ?? "");
      const scenarioId = form.get("scenarioId");
      const rawFile = form.get("file");
      const uploadId = String(form.get("uploadId") ?? "");
      if (!clientMessageId || clientMessageId.length > 128) throw new DemoError("INVALID_MESSAGE_ID", "The message ID is missing or invalid.");
      if ([Boolean(scenarioId), Boolean(rawFile), Boolean(uploadId)].filter(Boolean).length > 1) throw new DemoError("TOO_MANY_ATTACHMENTS", "Choose a starter or one file, not both.");

      const reservedClaim = uploadId
        ? await claimDemoTurn({ token, clientMessageId, kind: "message", attachmentBytes: 0, uploadId })
        : undefined;
      if (reservedClaim?.duplicate) {
        c.header("Content-Type", "application/x-ndjson; charset=utf-8");
        return stream(c, async (writer) => {
          for (const event of reservedClaim.events) await writer.writeln(JSON.stringify(event));
          if (reservedClaim.status === "processing") {
            await writer.writeln(JSON.stringify({ type: "error", code: "TURN_IN_PROGRESS", message: "That message is still being processed. Try again in a moment." }));
          }
        });
      }

      let turnText = text;
      let attachment: TurnAttachment | undefined;
      let starterLabel: string | undefined;
      if (scenarioId) {
        if (!isDemoScenarioId(scenarioId)) throw new DemoError("INVALID_SCENARIO", "That starter is not available.");
        const scenario = await demoScenario(scenarioId, student.timezone);
        turnText = scenario.caption;
        attachment = scenario.attachment;
        starterLabel = scenario.label;
      } else if (rawFile instanceof File) {
        assertTurnInput({ text, file: rawFile });
        const bytes = Buffer.from(await rawFile.arrayBuffer());
        await validateReadableBytes(bytes, rawFile.type, rawFile.name);
        attachment = { id: `web-file-${clientMessageId}`, name: rawFile.name, mimeType: rawFile.type, size: bytes.length, read: async () => bytes };
      } else if (uploadId) {
        try {
          const reserved = await readReservedDemoUpload({ token, uploadId });
          attachment = reserved.attachment;
          await validateReadableBytes(await attachment.read(), attachment.mimeType, attachment.name);
        } catch (error) {
          await releaseDemoUpload({ token, uploadId }).catch((cleanupError) => {
            console.error("failed to release rejected demo upload", safeDiagnostic(cleanupError));
          });
          throw error;
        }
      }
      assertTurnInput({ text: turnText, file: attachment ? { size: attachment.size ?? 0, type: attachment.mimeType } : undefined });

      const claimed = reservedClaim ?? await claimDemoTurn({ token, clientMessageId, kind: scenarioId ? "starter" : "message", attachmentBytes: attachment?.size ?? 0 });
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (writer) => {
        if (claimed.duplicate) {
          for (const event of claimed.events) await writer.writeln(JSON.stringify(event));
          if (claimed.status === "processing") {
            await writer.writeln(JSON.stringify({ type: "error", code: "TURN_IN_PROGRESS", message: "That message is still being processed. Try again in a moment." }));
          }
          return;
        }

        const events: DemoEvent[] = [];
        let writerOpen = true;
        const writeEvent = async (event: DemoEvent) => {
          if (!writerOpen) return;
          try { await writer.writeln(JSON.stringify(event)); }
          catch { writerOpen = false; }
        };
        const emit = async (event: DemoEvent) => {
          events.push(event);
          await saveDemoTurn({ turnId: claimed.id, events, status: "processing" });
          await writeEvent(event);
        };

        try {
          await emit({ type: "accepted", clientMessageId });
          await emit({ type: "user", text: starterLabel ?? text, attachment: attachment ? { name: attachment.name, mimeType: attachment.mimeType } : undefined, scenarioId: typeof scenarioId === "string" ? scenarioId : undefined });
          await emit({ type: "quota", ...claimed.quota });
          await recordMessage({ studentId: student.id, photonMessageId: `web-${claimed.id}-in`, direction: "inbound", content: [turnText, attachment ? `[${attachment.name}]` : ""].filter(Boolean).join(" ") });
          const remindersBefore = await listPendingReminders(student.id);

          let outbound = 0;
          await processTurn({
            student,
            turn: { id: clientMessageId, text: turnText, attachments: attachment ? [attachment] : [] },
            channel: {
              send: async (reply, options) => {
                // Spectrum still sends the ingest acknowledgement. In the web
                // UI it is represented by the typing state, not a permanent
                // assistant bubble in the transcript.
                if (options?.transient) return;
                await recordMessage({ studentId: student.id, photonMessageId: `web-${claimed.id}-out-${outbound++}`, direction: "outbound", content: reply });
                await emit({ type: "assistant", text: reply });
              },
              responding: async (work) => {
                await emit({ type: "typing", active: true });
                try { return await work(); }
                finally { await emit({ type: "typing", active: false }); }
              },
            },
          });
          const reminderDelta = reminderPresentationDelta(
            remindersBefore,
            await listPendingReminders(student.id),
          );
          if (reminderDelta?.type === "show") {
            await emit({
              type: "presentation",
              presentation: { type: "reminder_jump", targetTime: reminderDelta.reminder.targetTime },
            });
          } else if (reminderDelta?.type === "clear") {
            await emit({ type: "presentation", presentation: { type: "reminder_cleared" } });
          }
          if (uploadId) await consumeDemoUpload(uploadId).catch((cleanupError) => {
            console.error("failed to finalize demo upload", safeDiagnostic(cleanupError));
          });
          await emit({ type: "done" });
          await saveDemoTurn({ turnId: claimed.id, events, status: "complete" });
        } catch (error) {
          const normalized = errorResponse(error);
          const event: DemoEvent = { type: "error", code: normalized.body.error.code, message: normalized.body.error.message };
          events.push(event);
          await saveDemoTurn({ turnId: claimed.id, events, status: "failed", failureCode: event.code });
          await writeEvent(event);
        }
      });
    }

    if (endpoint === "reminders/fast-forward") {
      const token = bearer(c.req.header("authorization"));
      const { student } = await authenticateDemoSession(token);
      const body: { clientMessageId?: string } = await c.req.json().catch(() => ({}));
      const clientMessageId = body.clientMessageId ?? randomUUID();
      const claimed = await claimDemoTurn({ token, clientMessageId, kind: "reminder", attachmentBytes: 0 });
      if (claimed.duplicate) return c.json({ events: claimed.events });
      const result = await runWebDemoReminder(student.id);
      const events: DemoEvent[] = [{ type: "accepted", clientMessageId }, { type: "quota", ...claimed.quota }];
      if (!result.text) {
        events.push({ type: "error", code: "NO_PENDING_REMINDER", message: "There isn't a pending reminder to jump to." });
        await saveDemoTurn({ turnId: claimed.id, events, status: "complete" });
        return c.json({ events });
      }
      events.push(
        { type: "assistant", text: result.text },
        { type: "presentation", presentation: { type: "reminder_cleared" } },
        { type: "done" },
      );
      await saveDemoTurn({ turnId: claimed.id, events, status: "complete" });
      return c.json({ events });
    }

    if (endpoint === "cleanup") {
      if (bearer(c.req.header("authorization")) !== getDemoEnv().CRON_SECRET) throw new DemoError("UNAUTHORIZED", "Not authorized.", 401);
      return c.json({ deleted: await cleanupExpiredDemoSessions() });
    }

    throw new DemoError("NOT_FOUND", "Demo endpoint not found.", 404);
  } catch (error) {
    const normalized = errorResponse(error);
    return c.json(normalized.body, normalized.status as 400);
  }
});

app.get("/api/demo", async (c) => {
  try {
    if (route(c) !== "cleanup") throw new DemoError("NOT_FOUND", "Demo endpoint not found.", 404);
    if (bearer(c.req.header("authorization")) !== getDemoEnv().CRON_SECRET) throw new DemoError("UNAUTHORIZED", "Not authorized.", 401);
    return c.json({ deleted: await cleanupExpiredDemoSessions() });
  } catch (error) {
    const normalized = errorResponse(error);
    return c.json(normalized.body, normalized.status as 400);
  }
});

app.delete("/api/demo", async (c) => {
  try {
    assertDemoEnabled();
    if (route(c) !== "session") throw new DemoError("NOT_FOUND", "Demo endpoint not found.", 404);
    const token = bearer(c.req.header("authorization"));
    await authenticateDemoSession(token);
    return c.json(await resetDemoSession(token));
  } catch (error) {
    const normalized = errorResponse(error);
    return c.json(normalized.body, normalized.status as 400);
  }
});

export default handle(app);
