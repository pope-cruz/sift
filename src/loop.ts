import type { Message, Space, SpectrumInstance } from "spectrum-ts";

import { parts, summarize } from "./content.ts";
import {
  claimInboundMessage,
  finishInboundMessage,
  getStudentBySpaceId,
  recordJobFailure,
  recordMessage,
} from "./db.ts";
import { safeDiagnostic } from "./diagnostics.ts";
import { sendRecovery } from "./recovery.ts";
import { handleTurnBatch } from "./turn.ts";

const IGNORED = new Set(["read", "typing", "reaction", "unsend", "edit"]);
const BURST_WINDOW_MS = 700;

type PendingMessage = { space: Space; message: Message; fresh: boolean };
type SpaceBucket = {
  space: Space;
  pending: PendingMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
};

async function finishBatch(messages: Message[], succeeded: boolean): Promise<void> {
  const results = await Promise.allSettled(
    messages.map((message) => finishInboundMessage(message.id, succeeded)),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("failed to finish inbound message", {
        messageId: messages[index]?.id,
        error: safeDiagnostic(result.reason),
      });
    }
  });
}

async function processBatch(batch: PendingMessage[], isSuperseded: () => boolean): Promise<void> {
  if (batch.length === 0) return;
  const claimed: PendingMessage[] = [];
  for (const entry of batch) {
    try {
      if (await claimInboundMessage(entry.message.id, entry.fresh)) claimed.push(entry);
      else console.log({ duplicate: entry.message.id, spaceId: entry.space.id });
    } catch (error) {
      console.error("inbound claim failed", {
        messageId: entry.message.id,
        spaceId: entry.space.id,
        error: safeDiagnostic(error),
      });
      await recordJobFailure({ stage: "spectrum.claim", resourceId: entry.space.id, error });
    }
  }
  if (claimed.length === 0) return;

  const { space } = claimed[0]!;
  const messages = claimed.map((entry) => entry.message);
  try {
    const student = await getStudentBySpaceId(space.id);
    const succeeded = await handleTurnBatch(space, messages, student, isSuperseded);
    await finishBatch(messages, succeeded);
  } catch (error) {
    console.error("batch processing failed", {
      spaceId: space.id,
      messageIds: messages.map((message) => message.id),
      error: safeDiagnostic(error),
    });
    await recordJobFailure({ stage: "spectrum.batch", resourceId: space.id, error });
    await finishBatch(messages, false);
    await sendRecovery((text) => space.send(text));
  }
}

/**
 * Receive globally, process per conversation. A slow attachment no longer
 * blocks another student, while messages from one iMessage thread remain
 * ordered and short human typing bursts become one coherent model turn.
 */
export async function runLoop(app: SpectrumInstance) {
  const buckets = new Map<string, SpaceBucket>();

  const start = (bucket: SpaceBucket) => {
    if (bucket.running || bucket.pending.length === 0) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = null;
    const batch = bucket.pending.splice(0);
    bucket.running = processBatch(batch, () => bucket.pending.length > 0).finally(() => {
      bucket.running = null;
      if (bucket.pending.length > 0) schedule(bucket);
    });
  };

  const schedule = (bucket: SpaceBucket) => {
    if (bucket.running) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => start(bucket), BURST_WINDOW_MS);
  };

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound" || IGNORED.has(message.content.type)) continue;

    try {
      const fresh = await recordMessage({
        studentId: (await getStudentBySpaceId(space.id))?.id ?? null,
        photonMessageId: message.id,
        direction: message.direction,
        content: summarize(parts(message)),
      });

      let bucket = buckets.get(space.id);
      if (!bucket) {
        bucket = { space, pending: [], timer: null, running: null };
        buckets.set(space.id, bucket);
      }
      bucket.pending.push({ space, message, fresh });
      schedule(bucket);
    } catch (error) {
      console.error("loop intake error", {
        spaceId: space.id,
        messageId: message.id,
        error: safeDiagnostic(error),
      });
      await recordJobFailure({ stage: "spectrum.intake", resourceId: space.id, error });
      await sendRecovery((text) => space.send(text));
    }
  }

  // Spectrum's stream can close during a graceful shutdown. Drain everything
  // already accepted before app.stop() tears down provider connections.
  for (const bucket of buckets.values()) start(bucket);
  while ([...buckets.values()].some((bucket) => bucket.running || bucket.pending.length)) {
    const running = [...buckets.values()].flatMap((bucket) => bucket.running ? [bucket.running] : []);
    if (running.length === 0) break;
    await Promise.allSettled(running);
    for (const bucket of buckets.values()) start(bucket);
  }
}
