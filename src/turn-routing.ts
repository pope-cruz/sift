import { setTimeout as sleep } from "node:timers/promises";

export type RoutingChannel = {
  send(text: string, options?: { transient?: boolean }): Promise<void>;
  responding<T>(work: () => Promise<T>): Promise<T>;
};

/** Everything routing needs to describe a file without being able to read one. */
export type AttachmentSummary = {
  mimeType: string;
  size?: number;
};

const CANT_READ =
  "I can't read that one yet — send me a PDF, a screenshot, or just type it and I'll keep track of it.";

/**
 * How long ingest gets before sort says anything about waiting.
 *
 * This used to be unconditional: every attachment turn opened with "Sorting..."
 * whether the work took two seconds or forty, and the send was awaited *before*
 * the file was even read — so the announcement was on the critical path of the
 * thing it was announcing. Racing it instead means the fast path loses the
 * bubble entirely and the slow path gains a sentence that is actually true.
 */
const NOTICE_AFTER_MS = 2_500;

/** Past this, a PDF is dense enough that "a lot in here" is a claim we can make. */
const LONG_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * What to say when the work has outrun `NOTICE_AFTER_MS`.
 *
 * Only ever sent on the slow path, which is what lets every branch say "still" —
 * the reading is a fact by the time this is called, not a prediction. Nothing
 * here promises what was found; that sentence is built from persisted rows in
 * analysis.ts and cannot be anticipated.
 */
export function sortingNotice(attachments: readonly AttachmentSummary[]): string {
  if (attachments.length > 1) {
    return `Give me a minute — I'm still reading through all ${attachments.length}.`;
  }

  const only = attachments[0];
  if (only?.mimeType === "application/pdf" && (only.size ?? 0) > LONG_DOCUMENT_BYTES) {
    return "Give me a minute — there's a lot in this one. Still sorting through it.";
  }

  return "Give me a minute to sort through this.";
}

/**
 * Resolve `work`, announcing the wait only if it outlasts `afterMs`.
 *
 * The marker promise maps both settlement paths to `done` on purpose: a fast
 * *failure* is still a fast turn, and letting a rejection win the race here
 * would send a "give me a minute" for work that had already given up. The
 * original promise is returned rather than a copy, so the caller's await is what
 * observes the rejection and the existing recovery path still fires.
 */
async function announcingSlowWork<T>(
  work: Promise<T>,
  afterMs: number,
  announce: () => Promise<void>,
  delay: (ms: number) => Promise<void>,
): Promise<T> {
  const done = Symbol("done");
  const settled = work.then(() => done, () => done);

  if (await Promise.race([settled, delay(afterMs)]) !== done) await announce();

  return work;
}

/** A timer that cannot by itself hold the worker process open. */
const unrefDelay = (ms: number) => sleep(ms, undefined, { ref: false });

/** Dependency-free orchestration used by the real core and channel parity tests. */
export async function routeActiveTurn(input: {
  text: string;
  attachments: readonly AttachmentSummary[];
  channel: RoutingChannel;
  ingest(): Promise<string>;
  answer(): Promise<string>;
  /** Injected by tests so the race can be driven without real time. */
  noticeAfterMs?: number;
  delay?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (input.attachments.length > 0) {
    // The whole turn is inside `responding` now, including the wait notice.
    // Previously typing only began after the announcement had been sent, so the
    // student watched a dead thread for one full round trip first.
    await input.channel.responding(async () => {
      const reply = await announcingSlowWork(
        input.ingest(),
        input.noticeAfterMs ?? NOTICE_AFTER_MS,
        () => input.channel.send(sortingNotice(input.attachments), { transient: true }),
        input.delay ?? unrefDelay,
      );
      await input.channel.send(reply);
    });
    return;
  }
  if (!input.text) {
    await input.channel.send(CANT_READ);
    return;
  }
  await input.channel.send(await input.channel.responding(input.answer));
}
