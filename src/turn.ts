import { randomUUID } from "node:crypto";

import type { Message, Space } from "spectrum-ts";

import { attachmentsOf, parts, textOf } from "./content.ts";
import {
  attachSpaceToStudent,
  backfillMessageStudent,
  getContextRows,
  recordMessage,
  type Student,
} from "./db.ts";
import { safeDiagnostic } from "./diagnostics.ts";
import { env } from "./env.ts";
import { ingest } from "./ingest.ts";
import { respond } from "./llm.ts";
import { today } from "./dates.ts";
import { assembleContext, fallbackReply, renderContext, validateReply } from "./planner.ts";
import { sendRecovery } from "./recovery.ts";
import { runTool, TOOLS } from "./tools.ts";

const WELCOME =
  "Hey! I'm Sift. Send me anything you want to remember — a syllabus, a screenshot, a stray thought — " +
  "and I'll keep track of it and remind you when it matters. Ask me what's coming up any time.";

const CANT_READ =
  "I can't read that one yet — send me a PDF, a screenshot, or just type it and I'll keep track of it.";

/**
 * Send and persist. This line does not echo outbound messages back into the
 * stream, so a reply is only ever recorded here — and Phase 3's context needs
 * both sides of the conversation to read coherently.
 *
 * Persistence failures are logged, never thrown: the message has already gone
 * out, and surfacing an error would make the caller apologize for a reply the
 * student can see.
 */
export async function say(space: Space, studentId: string | null, text: string) {
  const sent = await space.send(text);

  try {
    await recordMessage({
      studentId,
      // Providers may not hand back the outbound message; a synthetic id still
      // satisfies the UNIQUE column and keeps the transcript complete.
      photonMessageId: sent?.id ?? `local-${randomUUID()}`,
      direction: "outbound",
      content: text,
    });
  } catch (error) {
    console.error("failed to persist outbound message", {
      spaceId: space.id,
      error: safeDiagnostic(error),
    });
  }
}

const isStart = (text: string) => /^\s*start sift\s*$/i.test(text);

export async function handleTurn(space: Space, message: Message, student: Student | null) {
  const contents = parts(message);
  const text = textOf(contents);
  const files = attachmentsOf(contents);

  // Hoisted so the catch can attribute the failure reply to the student the
  // turn was for, including the turn that just onboarded them.
  let current = student;

  try {
    if (!current) {
      if (!isStart(text)) {
        await say(space, null, "Text me “Start Sift” to get going.");
        return;
      }

      current = await attachSpaceToStudent(env.DEMO_PHONE, space.id);
      await backfillMessageStudent(message.id, current.id);
      await say(space, current.id, WELCOME); // Text-only, no links — first-contact deliverability.
      return;
    }

    // `current` is a mutable outer binding so the catch can see it, which
    // means its narrowing doesn't survive into the closures below. Rebind.
    const active = current;

    // Files take the direct path — the turn's latency-critical beat. What the
    // artifact IS gets decided inside ingest, not here.
    if (files.length > 0) {
      // The literal pre-reply from the demo script, so the wait reads as work.
      await say(space, active.id, "Sifting...");
      await space.responding(async () => {
        await say(space, active.id, await ingest({ student: active, text, files }));
      });
      return;
    }

    // Voice notes, contact cards and the like. Silence reads as a dropped
    // message, so say what happened rather than returning without a word.
    if (!text) {
      await say(space, active.id, CANT_READ);
      return;
    }

    // Every retrieve/plan answer crosses the same deterministic boundary.
    // Queries are identity-scoped in db.ts and filtered by student id again in
    // assembly; only compact evidence reaches the answering model.
    const context = assembleContext({
      student: active,
      question: text,
      today: today(active.timezone),
      rows: await getContextRows(active.id),
    });

    const reply = await space.responding(() =>
      respond({
        history: context.messages.map(({ direction, content }) => ({ direction, content })),
        text,
        context: renderContext(context),
        timezone: active.timezone,
        tools: TOOLS,
        runTool: (name, args) => runTool(active, name, args),
        validateReply: (text, attempt) => validateReply(context, text, attempt),
        fallbackReply: fallbackReply(context),
      }),
    );

    await say(space, active.id, reply);
  } catch (error) {
    console.error("turn failed", {
      spaceId: space.id,
      messageId: message.id,
      error: safeDiagnostic(error),
    });
    // Through say(), so the failure is in the transcript. Sent bare, the next
    // turn's context has a gap where the apology was, and Sift answers "what
    // happened?" as though the turn never occurred.
    await sendRecovery((text) => say(space, current?.id ?? null, text));
  }
}
