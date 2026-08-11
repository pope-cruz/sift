import assert from "node:assert/strict";
import { test } from "node:test";

import {
  StructuredOutputValidationError,
  withStructuredOutputRetry,
} from "./structured-output.ts";

test("structured output validation gets one bounded retry", async () => {
  const attempts: number[] = [];
  const result = await withStructuredOutputRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt === 0) throw new Error("Failed to parse structured output: bad enum");
    return "valid";
  }, "reader");
  assert.equal(result, "valid");
  assert.deepEqual(attempts, [0, 1]);
});

test("authentication and provider failures are not retried", async () => {
  let attempts = 0;
  const failure = new Error("authentication failed");
  await assert.rejects(
    withStructuredOutputRetry(async () => {
      attempts += 1;
      throw failure;
    }, "reader"),
    failure,
  );
  assert.equal(attempts, 1);
});

test("a second schema failure is reduced to a safe stable diagnostic", async () => {
  await assert.rejects(
    withStructuredOutputRetry(async () => {
      throw new Error("Failed to parse structured output: private raw response");
    }, "reader"),
    (error: unknown) =>
      error instanceof StructuredOutputValidationError &&
      error.code === "STRUCTURED_OUTPUT_INVALID" &&
      !error.message.includes("private raw response"),
  );
});
