import assert from "node:assert/strict";
import { test } from "node:test";

import { rollbackArtifact, settleArtifactPreparation } from "./rollback.ts";

test("analysis failure waits for and removes a successful concurrent upload", async () => {
  const removed: string[] = [];
  const failure = new Error("reader failed");

  await assert.rejects(
    settleArtifactPreparation({
      analysis: Promise.reject(failure),
      upload: Promise.resolve("student/object.pdf"),
      deleteUpload: async (path) => { removed.push(path); },
    }),
    failure,
  );
  assert.deepEqual(removed, ["student/object.pdf"]);
});

test("upload failure creates no cleanup request and preserves the upload error", async () => {
  let cleanupCalls = 0;
  const failure = new Error("upload failed");

  await assert.rejects(
    settleArtifactPreparation({
      analysis: Promise.resolve(["analysis"]),
      upload: Promise.reject(failure),
      deleteUpload: async () => { cleanupCalls += 1; },
    }),
    failure,
  );
  assert.equal(cleanupCalls, 0);
});

test("successful preparation returns both results without cleanup", async () => {
  let cleanupCalls = 0;
  const result = await settleArtifactPreparation({
    analysis: Promise.resolve(["analysis"]),
    upload: Promise.resolve("student/object.pdf"),
    deleteUpload: async () => { cleanupCalls += 1; },
  });

  assert.deepEqual(result, {
    analysis: ["analysis"],
    storagePath: "student/object.pdf",
  });
  assert.equal(cleanupCalls, 0);
});

test("persistence rollback removes all partial rows and the uploaded object", async () => {
  const deleted: string[] = [];
  const failures = await rollbackArtifact({
    itemIds: ["one", "two"],
    storagePath: "student/object.pdf",
    deleteItem: async (id) => { deleted.push(`item:${id}`); },
    deleteUpload: async (path) => { deleted.push(`storage:${path}`); },
  });

  assert.deepEqual(deleted, ["item:one", "item:two", "storage:student/object.pdf"]);
  assert.deepEqual(failures, []);
});

test("persistence rollback attempts every target and reports cleanup failures", async () => {
  const attempted: string[] = [];
  const failures = await rollbackArtifact({
    itemIds: ["one", "two"],
    storagePath: "student/object.pdf",
    deleteItem: async (id) => {
      attempted.push(`item:${id}`);
      if (id === "one") throw new Error("row cleanup failed");
    },
    deleteUpload: async (path) => {
      attempted.push(`storage:${path}`);
      throw new Error("object cleanup failed");
    },
  });

  assert.deepEqual(attempted, ["item:one", "item:two", "storage:student/object.pdf"]);
  assert.deepEqual(failures.map((failure) => failure.target), [
    "item:one",
    "storage:student/object.pdf",
  ]);
});
