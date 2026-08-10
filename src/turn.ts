import { randomUUID } from "node:crypto";

import type { Content, Message, Space } from "spectrum-ts";

import { attachSpaceToStudent, backfillMessageStudent, recordMessage, type Student } from "./db.ts";
import { env } from "./env.ts";

const WELCOME =
  "Hey! I'm Sift. Send me anything you want to remember — a syllabus, a screenshot, a stray thought — " +
  "and I'll keep track of it and remind you when it matters. Ask me what's coming up any time.";

const TROUBLE = "Hmm, I had trouble sifting that — mind sending it again?";

/**
 * A captioned attachment arrives as ONE message with `content.type === "group"`,
 * whose items hold the parts (attachment first, then text). Verified on the real
 * line in Phase 0 for image/jpeg and application/pdf. So the unit of work is the
 * parts of one message — collect by type, never rely on ordering.
 */
export function parts(message: Message): Content[] {
  if (message.content.type === "group") {
    return message.content.items.map((item) => item.content);
  }
  return [message.content];
}

export function textOf(contents: Content[]): string {
  return contents
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

export function attachmentsOf(contents: Content[]) {
  return contents.filter((part) => part.type === "attachment");
}

/** What lands in messages.content — a turn can carry both text and files. */
export function summarize(contents: Content[]): string {
  const text = textOf(contents);
  const files = attachmentsOf(contents).map((part) => part.name);
  return [text, files.length ? `[${files.join(", ")}]` : ""].filter(Boolean).join(" ").trim();
}

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
    console.error("failed to persist outbound message", { spaceId: space.id, error });
  }
}

const isStart = (text: string) => /^\s*start sift\s*$/i.test(text);

export async function handleTurn(space: Space, message: Message, student: Student | null) {
  const contents = parts(message);
  const text = textOf(contents);
  const files = attachmentsOf(contents);

  try {
    let current = student;

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

    // Ingest turns get the literal pre-reply from the demo script before the
    // (Phase 2) extraction call, so the wait reads as work rather than silence.
    if (files.length > 0) {
      await say(space, current.id, "Sifting...");
      await space.responding(async () => {
        // Phase 2 replaces this with classify → extract → rows.
        const names = files.map((file) => file.name).join(", ");
        await say(space, current.id, `Got ${names}. I can't read these yet — that lands next.`);
      });
      return;
    }

    if (!text) return; // Nothing actionable (voice, contact card, etc.).

    await space.responding(async () => {
      // Phase 2 replaces this with the intent classifier.
      await say(space, current.id, `echo: ${text}`);
    });
  } catch (error) {
    console.error("turn failed", { spaceId: space.id, messageId: message.id, error });
    await space.send(TROUBLE).catch(() => {});
  }
}
