import assert from "node:assert/strict";
import test from "node:test";

import { mapWithLimit } from "./concurrency.ts";

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("an empty list never invokes the mapper", async () => {
  let calls = 0;
  assert.deepEqual(await mapWithLimit([], 3, async () => { calls++; return 1; }), []);
  assert.equal(calls, 0);
});

test("results keep input order even when later items finish first", async () => {
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  const work = mapWithLimit([0, 1, 2], 3, (index) => gates[index]!.promise);

  // Settle backwards; the joined reply must still read in attachment order.
  gates[2]!.resolve("third");
  gates[1]!.resolve("second");
  gates[0]!.resolve("first");

  assert.deepEqual(await work, ["first", "second", "third"]);
});

test("no more than `limit` run at once", async () => {
  let active = 0;
  let peak = 0;

  await mapWithLimit(Array.from({ length: 9 }, (_, index) => index), 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return null;
  });

  assert.equal(peak, 3);
});

test("a slow item does not idle the other slots", async () => {
  const slow = deferred<string>();
  const order: number[] = [];

  const work = mapWithLimit([0, 1, 2, 3], 2, async (index) => {
    order.push(index);
    if (index === 0) return slow.promise;
    return `fast-${index}`;
  });

  // With a batch-shaped implementation, items 2 and 3 would be stuck behind
  // item 0's batch. Pulling from a shared cursor lets them start immediately.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [0, 1, 2, 3]);

  slow.resolve("slow-0");
  assert.deepEqual(await work, ["slow-0", "fast-1", "fast-2", "fast-3"]);
});

test("a limit above the item count does not over-allocate workers", async () => {
  let peak = 0;
  let active = 0;

  const results = await mapWithLimit([1, 2], 100, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4]);
  assert.equal(peak, 2);
});

test("a rejection propagates to the caller", async () => {
  await assert.rejects(
    mapWithLimit([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("boom");
      return value;
    }),
    /boom/,
  );
});
