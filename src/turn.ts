import type { Content, Message, Space } from "spectrum-ts";

import { attachSpaceToStudent, pendingOf, type Student } from "./db.ts";
import { env } from "./env.ts";
import { ingest, resolvePending } from "./ingest.ts";
import { classify } from "./llm.ts";
import type { Intent } from "./schemas.ts";

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
 * Non-ingest intents. `retrieve` and `plan` are Phase 3 — they need the context
 * assembly (open actions, recent items, recent messages) that doesn't exist
 * yet, so they hold rather than guess.
 */
function reply(intent: Exclude<Intent, "ingest">, text: string) {
  switch (intent) {
    case "retrieve":
    case "plan":
      return "I've got that saved — pulling it back out is what I'm learning next. Keep sending me things in the meantime.";
    case "clarify":
      return text
        ? "I'm not sure what to do with that one — can you give me a bit more?"
        : "Didn't quite catch that — what would you like me to remember?";
    case "chitchat":
      return "Hey! Send me a syllabus, a screenshot, or anything you want to remember and I'll keep track of it.";
  }
}

export async function handleTurn(space: Space, message: Message, student: Student | null) {
  const contents = parts(message);
  const text = textOf(contents);
  const files = attachmentsOf(contents);

  try {
    if (!student) {
      if (isStart(text)) {
        await attachSpaceToStudent(env.DEMO_PHONE, space.id);
        await space.send(WELCOME); // Text-only, no links — first-contact deliverability.
        return;
      }
      await space.send("Text me “Start Sift” to get going.");
      return;
    }

    if (!text && files.length === 0) return; // Nothing actionable (voice, contact card, etc.).

    // A question Sift asked last turn gets first refusal on a text-only reply.
    // Sending a new file instead is itself an answer — they've moved on — so
    // files skip this and the pending question is dropped by the next resolve.
    const pending = files.length === 0 ? pendingOf(student) : null;
    if (pending) {
      const resolved = await space.responding(() =>
        resolvePending({ student, pending, text }),
      );
      if (resolved) {
        await space.send(resolved);
        return;
      }
      // They ignored the question — fall through and route the turn normally.
    }

    // A turn carrying a file is unambiguously ingest, so skip the classifier
    // call and its latency — the caption rides along as extraction context.
    const intent = files.length > 0 ? "ingest" : await classify({ text, files });

    if (intent === "ingest") {
      // The literal pre-reply from the demo script, sent before the extraction
      // call so the wait reads as work rather than silence.
      await space.send("Sifting...");
      await space.responding(async () => {
        await space.send(await ingest({ student, text, files }));
      });
      return;
    }

    await space.responding(async () => {
      await space.send(reply(intent, text));
    });
  } catch (error) {
    console.error("turn failed", { spaceId: space.id, messageId: message.id, error });
    await space.send(TROUBLE).catch(() => {});
  }
}
