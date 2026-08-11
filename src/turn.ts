import { randomUUID } from "node:crypto";

import type { Content, Message, Space } from "spectrum-ts";

import {
  attachSpaceToStudent,
  backfillMessageStudent,
  getRecentMessages,
  recordMessage,
  type Student,
} from "./db.ts";
import { env } from "./env.ts";
import { ingest } from "./ingest.ts";
import { respond } from "./llm.ts";
import { describeSaved, runTool, TOOLS } from "./tools.ts";

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

    // Files take the direct path. A PDF is a syllabus and a screenshot is a
    // place — there is nothing to decide, and this is the demo's latency-
    // critical beat, so it skips the conversational round trips entirely.
    if (files.length > 0) {
      // The literal pre-reply from the demo script, so the wait reads as work.
      await say(space, current.id, "Sifting...");
      await space.responding(async () => {
        await say(space, current.id, await ingest({ student: current, text, files }));
      });
      return;
    }

    if (!text) return; // Nothing actionable (voice, contact card, etc.).

    // A text turn gets the real conversation plus tools and decides for itself.
    // `saved` is state the model always needs, so it goes in the prompt rather
    // than behind a tool call it might not make.
    const [history, saved] = await Promise.all([
      getRecentMessages(current.id),
      describeSaved(current),
    ]);

    const reply = await space.responding(() =>
      respond({
        history,
        text,
        saved,
        timezone: current.timezone,
        tools: TOOLS,
        runTool: (name, args) => runTool(current, name, args),
      }),
    );

    await say(space, current.id, reply);
  } catch (error) {
    console.error("turn failed", { spaceId: space.id, messageId: message.id, error });
    await space.send(TROUBLE).catch(() => {});
  }
}
