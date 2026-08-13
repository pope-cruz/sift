import assert from "node:assert/strict";
import { test } from "node:test";

import { InputDiagnosticError, safeDiagnostic } from "./diagnostics.ts";
import {
  classifyInputMime,
  shouldPersistArtifact,
  uniqueAttachments,
  validateReadableBytes,
} from "./input.ts";

async function expectInputError(
  bytes: Buffer,
  mimeType: string,
  code: string,
): Promise<void> {
  await assert.rejects(
    () => validateReadableBytes(bytes, mimeType),
    (error: unknown) => error instanceof InputDiagnosticError && error.code === code,
  );
}

test("empty, malformed, and truncated PDFs fail with distinct diagnostics", async () => {
  await expectInputError(Buffer.alloc(0), "application/pdf", "EMPTY_INPUT");
  await expectInputError(Buffer.from("not a pdf"), "application/pdf", "MALFORMED_PDF");
  await expectInputError(Buffer.from("%PDF-1.7 incomplete"), "application/pdf", "TRUNCATED_PDF");
});

test("malformed image bytes fail before model or storage work", async () => {
  await expectInputError(Buffer.from("not an image"), "image/png", "MALFORMED_IMAGE");
});

test("unsupported inputs are classified without inspecting their payload", () => {
  assert.equal(classifyInputMime("text/plain"), "unsupported");
  assert.equal(classifyInputMime("application/zip"), "unsupported");
  assert.equal(classifyInputMime("image/heic"), "unsupported_image");
  assert.equal(classifyInputMime("application/pdf"), "pdf");
});

test("duplicated attachment identities collapse but distinct items survive", () => {
  const files = [
    { id: "a", name: "one.pdf", mimeType: "application/pdf", size: 10 },
    { id: "a", name: "one-copy.pdf", mimeType: "application/pdf", size: 10 },
    { id: "b", name: "two.pdf", mimeType: "application/pdf", size: 10 },
  ];
  assert.deepEqual(uniqueAttachments(files).map((file) => file.id), ["a", "b"]);
});

test("an immediate retraction in the same burst prevents attachment persistence", () => {
  assert.equal(shouldPersistArtifact("actually don't save that"), false);
  assert.equal(shouldPersistArtifact("do not save this PDF"), false);
  assert.equal(shouldPersistArtifact("just summarize this"), false);
  assert.equal(shouldPersistArtifact("save this for my exam"), true);
});

test("diagnostics redact common credential shapes and omit stacks", () => {
  const diagnostic = safeDiagnostic(
    new Error("ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop and Bearer abc.def.ghi"),
  );
  assert.doesNotMatch(JSON.stringify(diagnostic), /abcdefghijklmnop|abc\.def\.ghi/);
  assert.equal("stack" in diagnostic, false);
});
