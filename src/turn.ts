import { createHash, randomUUID } from "node:crypto";

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
 *
 * `transient` sends without recording. A progress notice is real in iMessage but
 * is not part of the conversation: assembleContext carries only the last ten
 * messages to the model, so every recorded "give me a minute" evicts a turn that
 * carried meaning — and the system prompt asks the model to resolve "it" and
 * "that" against its own previous message, which a progress ping cannot answer.
 * The web demo already dropped these; Spectrum ignored the flag and stored them.
 */
export async function say(
  space: Space,
  studentId: string | null,
  text: string,
  options?: { transient?: boolean },
) {
  const sent = await space.send(text);

  if (options?.transient) return;

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

export async function handleTurnBatch(
  space: Space,
  messages: Message[],
  student: Student | null,
  isSuperseded: () => boolean = () => false,
): Promise<boolean> {
  if (messages.length === 0) return true;
  const messageIds = messages.map((message) => message.id);
  const turnId = messages.length === 1
    ? messageIds[0]!
    : `batch-${createHash("sha256").update(messageIds.join("\u0000")).digest("hex")}`;

  // Hoisted so the catch can attribute the failure reply to the student the
  // turn was for, including the turn that just onboarded them.
  let current = student;

  try {
    if (!current) {
      const startIndex = messages.findIndex((message) => isStart(textOf(parts(message))));
      if (startIndex < 0) {
        await say(space, null, "Text me “Start Sift” to get going.");
        return true;
      }

      current = await attachSpaceToStudent(env.DEMO_PHONE, space.id);
      await Promise.all(messageIds.map((messageId) => backfillMessageStudent(messageId, current!.id)));
      await say(space, current.id, WELCOME); // Text-only, no links — first-contact deliverability.
      messages = messages.filter((_, index) => index !== startIndex);
      if (messages.length === 0) return true;
    }

    const contents = messages.flatMap((message) => parts(message));
    const text = messages
      .map((message) => textOf(parts(message)).trim())
      .filter(Boolean)
      .join("\n");
    const files = attachmentsOf(contents);
    const active = current;
    await processTurn({
      student: active,
      turn: { id: turnId, text, attachments: files },
      channel: {
        send: async (reply, options) => {
          if (isSuperseded()) return;
          await say(space, active.id, reply, options);
        },
        responding: (work) => space.responding(work),
      },
    });
    return true;
  } catch (error) {
    console.error("turn failed", {
      spaceId: space.id,
      messageIds,
      error: safeDiagnostic(error),
    });
    // Through say(), so the failure is in the transcript. Sent bare, the next
    // turn's context has a gap where the apology was, and Sift answers "what
    // happened?" as though the turn never occurred.
    await sendRecovery((text) => say(space, current?.id ?? null, text));
    return false;
  }
}
