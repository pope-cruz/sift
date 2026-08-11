import assert from "node:assert/strict";
import { test } from "node:test";

import { sendRecovery, TROUBLE } from "./recovery.ts";

test("a database-style failure can produce a useful recovery reply", async () => {
  const sent: string[] = [];
  const recovered = await sendRecovery(async (text) => { sent.push(text); });
  assert.equal(recovered, true);
  assert.deepEqual(sent, [TROUBLE]);
});

test("a provider failure does not crash the worker recovery path", async () => {
  const recovered = await sendRecovery(async () => { throw new Error("provider unavailable"); });
  assert.equal(recovered, false);
});

