import { randomUUID } from "node:crypto";

import type { Message, Space } from "spectrum-ts";

import { attachmentsOf, parts, textOf } from "./content.ts";
import {
  attachSpaceToStudent,
  backfillMessageStudent,
  recordMessage,
  type Student,
} from "./db.ts";
import { safeDiagnostic } from "./diagnostics.ts";
import { env } from "./env.ts";
import { sendRecovery } from "./recovery.ts";
import { processTurn } from "./turn-core.ts";

const WELCOME =
  "Hey! I'm Sift. Send me anything you want to remember — a syllabus, a screenshot, a stray thought — " +
  "and I'll keep track of it and remind you when it matters. Ask me what's coming up any time.";

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

    const active = current;
    await processTurn({
      student: active,
      turn: { id: message.id, text, attachments: files },
      channel: {
        send: (reply) => say(space, active.id, reply),
        responding: (work) => space.responding(work),
      },
    });
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
