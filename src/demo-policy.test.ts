import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_LIMITS,
  DemoError,
  assertTurnInput,
  hashDemoClientKey,
  hashDemoToken,
  newDemoToken,
  safeDemoFilename,
  validTimezone,
} from "./demo-policy.ts";

test("anonymous session tokens contain 256 bits and only their SHA-256 hash is stable", () => {
  const token = newDemoToken();
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.match(hashDemoToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashDemoToken(token), token);
  assert.equal(hashDemoToken(token), hashDemoToken(token));
});

test("client keys are unlinkable across server secrets", () => {
  assert.notEqual(hashDemoClientKey("203.0.113.1", "a".repeat(32)), hashDemoClientKey("203.0.113.1", "b".repeat(32)));
});

test("timezone validation accepts IANA zones and falls back to UTC", () => {
  assert.equal(validTimezone("Asia/Manila"), "Asia/Manila");
  assert.equal(validTimezone("not/a-zone"), "UTC");
  assert.equal(validTimezone(null), "UTC");
});

test("browser filenames cannot escape the student's storage prefix", () => {
  assert.equal(safeDemoFilename("../../spring\\syllabus?.pdf", "application/pdf"), "syllabus_.pdf");
  assert.equal(safeDemoFilename("\u0000", "image/png"), "upload.png");
});

test("demo input policy enforces text, type, and per-file bounds before processing", () => {
  assert.doesNotThrow(() => assertTurnInput({ text: "remember this" }));
  assert.doesNotThrow(() => assertTurnInput({ text: "", file: { type: "image/png", size: DEMO_LIMITS.fileBytes } }));
  for (const [input, code] of [
    [{ text: "" }, "EMPTY_TURN"],
    [{ text: "x".repeat(DEMO_LIMITS.textCharacters + 1) }, "TEXT_TOO_LONG"],
    [{ text: "", file: { type: "image/gif", size: 2 } }, "INVALID_FILE_TYPE"],
    [{ text: "", file: { type: "image/png", size: 0 } }, "EMPTY_UPLOAD"],
    [{ text: "", file: { type: "application/pdf", size: DEMO_LIMITS.fileBytes + 1 } }, "FILE_TOO_LARGE"],
  ] as const) {
    assert.throws(() => assertTurnInput(input), (error: unknown) => error instanceof DemoError && error.code === code);
  }
});
