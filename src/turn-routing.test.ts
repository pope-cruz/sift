import assert from "node:assert/strict";
import test from "node:test";

import { routeActiveTurn, siftingNotice, type RoutingChannel } from "./turn-routing.ts";

function fakeChannel(events: string[]): RoutingChannel {
  return {
    send: async (text, options) => { events.push(`send:${text}${options?.transient ? ":transient" : ""}`); },
    responding: async (work) => { events.push("typing:start"); try { return await work(); } finally { events.push("typing:stop"); } },
  };
}

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const IMAGE = { mimeType: "image/jpeg", size: 400_000 };
const PDF = { mimeType: "application/pdf", size: 120_000 };

/** Never elapses, so ingest always wins the race. */
const neverDelay = () => new Promise<void>(() => {});

for (const transport of ["Spectrum", "web"] as const) {
  test(`${transport} adapter sends no wait notice when ingest is fast`, async () => {
    const events: string[] = [];
    await routeActiveTurn({
      text: "save this",
      attachments: [IMAGE],
      channel: fakeChannel(events),
      ingest: async () => "Saved one deadline.",
      answer: async () => "unused",
      delay: neverDelay,
    });

    // The old routing opened every attachment turn with "Sifting...". A turn
    // that resolves quickly should cost the student exactly one bubble.
    assert.deepEqual(events, ["typing:start", "send:Saved one deadline.", "typing:stop"]);
  });

  test(`${transport} adapter receives identical text routing`, async () => {
    const events: string[] = [];
    await routeActiveTurn({
      text: "what is next?",
      attachments: [],
      channel: fakeChannel(events),
      ingest: async () => "unused",
      answer: async () => "Project 1 is next.",
    });
    assert.deepEqual(events, ["typing:start", "typing:stop", "send:Project 1 is next."]);
  });
}

test("slow ingest announces the wait, then still delivers the reply", async () => {
  const events: string[] = [];
  const ingest = deferred<string>();
  const timer = deferred<void>();

  const routed = routeActiveTurn({
    text: "save this",
    attachments: [IMAGE],
    channel: fakeChannel(events),
    ingest: () => ingest.promise,
    answer: async () => "unused",
    delay: () => timer.promise,
  });

  timer.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["typing:start", "send:Give me a minute to sift through this.:transient"]);

  ingest.resolve("Saved one deadline.");
  await routed;

  assert.deepEqual(events, [
    "typing:start",
    "send:Give me a minute to sift through this.:transient",
    "send:Saved one deadline.",
    "typing:stop",
  ]);
});

test("typing begins before the wait notice, not after it", async () => {
  const events: string[] = [];
  const timer = deferred<void>();

  const routed = routeActiveTurn({
    text: "save this",
    attachments: [IMAGE],
    channel: fakeChannel(events),
    ingest: async () => "Saved.",
    answer: async () => "unused",
    delay: () => timer.promise,
  });

  await routed;
  timer.resolve();

  // Routing used to await the announcement before starting the typing state, so
  // the thread sat dead for a full round trip at the start of every file turn.
  assert.equal(events[0], "typing:start");
});

test("a fast failure is not announced as a slow turn", async () => {
  const events: string[] = [];

  // The marker promise maps rejection to "settled": failing quickly is still
  // quick, and "give me a minute" about abandoned work is a lie.
  await assert.rejects(
    routeActiveTurn({
      text: "save this",
      attachments: [IMAGE],
      channel: fakeChannel(events),
      ingest: async () => { throw new Error("provider download failed"); },
      answer: async () => "unused",
      delay: neverDelay,
    }),
    /provider download failed/,
  );

  assert.deepEqual(events, ["typing:start", "typing:stop"]);
});

test("a slow failure still reaches the caller's recovery path", async () => {
  const events: string[] = [];
  const ingest = deferred<string>();
  const timer = deferred<void>();

  const routed = routeActiveTurn({
    text: "save this",
    attachments: [PDF],
    channel: fakeChannel(events),
    ingest: () => ingest.promise,
    answer: async () => "unused",
    delay: () => timer.promise,
  });

  timer.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  ingest.reject(new Error("reader timed out"));

  await assert.rejects(routed, /reader timed out/);
  assert.deepEqual(events, [
    "typing:start",
    "send:Give me a minute to sift through this.:transient",
    "typing:stop",
  ]);
});

test("an empty turn with no attachments is still refused", async () => {
  const events: string[] = [];
  await routeActiveTurn({
    text: "",
    attachments: [],
    channel: fakeChannel(events),
    ingest: async () => "unused",
    answer: async () => "unused",
  });
  assert.equal(events.length, 1);
  assert.match(events[0]!, /^send:I can't read that one yet/);
});

test("the notice counts the files instead of describing one of them", () => {
  assert.equal(siftingNotice([IMAGE, PDF, IMAGE]), "Give me a minute — I'm still reading through all 3.");
});

test("a dense PDF earns a stronger notice than a screenshot", () => {
  assert.equal(
    siftingNotice([{ mimeType: "application/pdf", size: 9 * 1024 * 1024 }]),
    "Give me a minute — there's a lot in this one. Still sifting through it.",
  );
  assert.equal(siftingNotice([PDF]), "Give me a minute to sift through this.");
  assert.equal(siftingNotice([IMAGE]), "Give me a minute to sift through this.");
});

test("a missing size never claims a document is dense", () => {
  // `size` is optional on the provider's attachment. Absent evidence of length
  // must not become a claim about it.
  assert.equal(
    siftingNotice([{ mimeType: "application/pdf" }]),
    "Give me a minute to sift through this.",
  );
});
