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
  deleteDemoSession,
  DemoError,
  readReservedDemoUpload,
  reserveDemoUpload,
  resumeOrCreateDemoSession,
  saveDemoTurn,
  type DemoEvent,
} from "../src/demo.ts";
import { demoScenario, isDemoScenarioId } from "../src/demo-fixtures.ts";
import { runWebDemoReminder } from "../src/demo-reminders.ts";
import { nextPendingReminder, recordMessage } from "../src/db.ts";
import { InputDiagnosticError, safeDiagnostic } from "../src/diagnostics.ts";
import { getDemoEnv } from "../src/env.ts";
import { validateReadableBytes } from "../src/input.ts";
import { processTurn, type TurnAttachment } from "../src/turn-core.ts";

export const config = { runtime: "nodejs", maxDuration: 300 };

const app = new Hono();

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
  return `${firstIp}\u0000${c.req.header("user-agent") ?? "unknown"}`;
}

function errorResponse(error: unknown) {
  if (error instanceof DemoError) {
    return { body: { error: { code: error.code, message: error.message } }, status: error.status };
  }
  if (error instanceof InputDiagnosticError) {
    return { body: { error: { code: "CORRUPT_UPLOAD", message: error.userMessage } }, status: 400 };
  }
  console.error("demo api failed", safeDiagnostic(error));
  return { body: { error: { code: "PROCESSING_FAILED", message: "Sift couldn't finish that request. Try it once more." } }, status: 500 };
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
            await writer.writeln(JSON.stringify({ type: "error", code: "PROCESSING_INTERRUPTED", message: "That turn was interrupted before it finished. Send it again to retry." }));
          }
        });
      }

      let turnText = text;
      let attachment: TurnAttachment | undefined;
      let starterPresentation: unknown;
      let starterLabel: string | undefined;
      if (scenarioId) {
        if (!isDemoScenarioId(scenarioId)) throw new DemoError("INVALID_SCENARIO", "That starter is not available.");
        const scenario = await demoScenario(scenarioId, student.timezone);
        turnText = scenario.caption;
        attachment = scenario.attachment;
        starterPresentation = scenario.presentation;
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
          await consumeDemoUpload(uploadId).catch((cleanupError) => {
            console.error("failed to remove rejected demo upload", safeDiagnostic(cleanupError));
          });
          if (reservedClaim) {
            const normalized = errorResponse(error);
            await saveDemoTurn({
              turnId: reservedClaim.id,
              events: [{ type: "error", code: normalized.body.error.code, message: normalized.body.error.message }],
              status: "failed",
              failureCode: normalized.body.error.code,
            });
          }
          throw error;
        }
      }
      assertTurnInput({ text: turnText, file: attachment ? { size: attachment.size ?? 0, type: attachment.mimeType } : undefined });

      const claimed = reservedClaim ?? await claimDemoTurn({ token, clientMessageId, kind: scenarioId ? "starter" : "message", attachmentBytes: attachment?.size ?? 0 });
      if (uploadId && !claimed.duplicate) await consumeDemoUpload(uploadId);
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (writer) => {
        if (claimed.duplicate) {
          for (const event of claimed.events) await writer.writeln(JSON.stringify(event));
          if (claimed.status === "processing") {
            await writer.writeln(JSON.stringify({ type: "error", code: "PROCESSING_INTERRUPTED", message: "That turn was interrupted before it finished. Send it again to retry." }));
          }
          return;
        }

        const events: DemoEvent[] = [];
        const emit = async (event: DemoEvent) => {
          events.push(event);
          await saveDemoTurn({ turnId: claimed.id, events, status: "processing" });
          await writer.writeln(JSON.stringify(event));
        };

        try {
          await emit({ type: "accepted", clientMessageId });
          await emit({ type: "user", text: starterLabel ?? text, attachment: attachment ? { name: attachment.name, mimeType: attachment.mimeType } : undefined, scenarioId: typeof scenarioId === "string" ? scenarioId : undefined });
          if (starterPresentation) await emit({ type: "presentation", presentation: starterPresentation });
          await emit({ type: "quota", ...claimed.quota });
          await recordMessage({ studentId: student.id, photonMessageId: `web-${claimed.id}-in`, direction: "inbound", content: [turnText, attachment ? `[${attachment.name}]` : ""].filter(Boolean).join(" ") });

          let outbound = 0;
          await processTurn({
            student,
            turn: { id: clientMessageId, text: turnText, attachments: attachment ? [attachment] : [] },
            channel: {
              send: async (reply) => {
                await recordMessage({ studentId: student.id, photonMessageId: `web-${claimed.id}-out-${outbound++}`, direction: "outbound", content: reply });
                await emit({ type: "assistant", text: reply });
              },
              responding: async (work) => {
                await emit({ type: "typing", active: true });
                try { return await work(); }
                finally { await emit({ type: "typing", active: false }); }
              },
              present: (presentation) => emit({ type: "presentation", presentation }),
            },
          });
          const pending = await nextPendingReminder(student.id);
          if (pending) await emit({ type: "presentation", presentation: { type: "reminder_jump", targetTime: pending.targetTime } });
          await emit({ type: "done" });
          await saveDemoTurn({ turnId: claimed.id, events, status: "complete" });
        } catch (error) {
          const normalized = errorResponse(error);
          const event: DemoEvent = { type: "error", code: normalized.body.error.code, message: normalized.body.error.message };
          events.push(event);
          await writer.writeln(JSON.stringify(event));
          await saveDemoTurn({ turnId: claimed.id, events, status: "failed", failureCode: event.code });
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
      events.push({ type: "assistant", text: result.text }, { type: "done" });
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
    const { student } = await authenticateDemoSession(token);
    await deleteDemoSession(token);
    return c.json(await resumeOrCreateDemoSession({ clientKey: clientKey(c), timezone: student.timezone }));
  } catch (error) {
    const normalized = errorResponse(error);
    return c.json(normalized.body, normalized.status as 400);
  }
});

export default handle(app);
