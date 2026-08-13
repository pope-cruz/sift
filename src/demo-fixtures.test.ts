import assert from "node:assert/strict";
import test from "node:test";

import { demoScenario } from "./demo-fixtures.ts";
import { validateReadableBytes } from "./input.ts";

test("all starter shortcuts generate valid PNGs and route as real attachments", async () => {
  for (const id of ["deadlines", "cafe", "application"] as const) {
    const scenario = await demoScenario(id, "Asia/Manila", new Date("2026-08-13T04:00:00Z"));
    const bytes = await scenario.attachment.read();
    assert.equal(scenario.attachment.mimeType, "image/png");
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.doesNotReject(() => validateReadableBytes(bytes, "image/png", scenario.attachment.name));
    assert.ok(scenario.caption.length > 10);
  }
});

test("deadline starter dates are relative to the session date", async () => {
  const scenario = await demoScenario("deadlines", "UTC", new Date("2026-08-13T12:00:00Z"));
  assert.equal(scenario.presentation.type, "deadline_list");
  if (scenario.presentation.type === "deadline_list") {
    assert.deepEqual(scenario.presentation.items.map((item) => item.date), ["2026-08-16", "2026-08-20"]);
  }
});
