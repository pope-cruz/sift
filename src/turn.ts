import type { Content, Message, Space } from "spectrum-ts";

import { attachSpaceToStudent, getRecentMessages, recordMessage, type Student } from "./db.ts";
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

const isStart = (text: string) => /^\s*start sift\s*$/i.test(text);

/**
 * Send and record in one step. Sift's own replies are half the conversation,
 * and without them every turn re-reads a one-sided transcript — which is what
 * made terse follow-ups like "make the 2025 into 2026" unreadable. The id is
 * ours rather than the provider's echo so ordering is deterministic; loop.ts
 * drops the echo when it arrives.
 */
async function say(space: Space, student: Student | null, text: string, tag: string) {
  await space.send(text);
  if (!student) return;
  await recordMessage({
    studentId: student.id,
    photonMessageId: `sift-out-${tag}`,
    direction: "outbound",
    content: text,
  }).catch((error) => console.error("failed to record reply", error));
}

export async function handleTurn(space: Space, message: Message, student: Student | null) {
  const contents = parts(message);
  const text = textOf(contents);
  const files = attachmentsOf(contents);

  try {
    if (!student) {
      if (isStart(text)) {
        const bound = await attachSpaceToStudent(env.DEMO_PHONE, space.id);
        // Text-only, no links — first-contact deliverability.
        await say(space, bound, WELCOME, message.id);
        return;
      }
      await space.send("Text me \u201CStart Sift\u201D to get going.");
      return;
    }

    if (!text && files.length === 0) return; // Nothing actionable (voice, contact card, etc.).

    // Files take the direct path. A PDF is a syllabus and a screenshot is a
    // place — there is nothing to decide, and this is the demo's latency-
    // critical beat, so it skips the model round trips entirely.
    if (files.length > 0) {
      // The literal pre-reply from the demo script, so the wait reads as work.
      await say(space, student, "Sifting...", `${message.id}-ack`);
      await space.responding(async () => {
        await say(space, student, await ingest({ student, text, files }), message.id);
      });
      return;
    }

    const [history, saved] = await Promise.all([
      getRecentMessages(student.id),
      describeSaved(student),
    ]);
    const reply = await space.responding(() =>
      respond({
        history,
        text,
        saved,
        timezone: student.timezone,
        tools: TOOLS,
        runTool: (name, args) => runTool(student, name, args),
      }),
    );
    await say(space, student, reply, message.id);
  } catch (error) {
    console.error("turn failed", { spaceId: space.id, messageId: message.id, error });
    await space.send(TROUBLE).catch(() => {});
  }
}
