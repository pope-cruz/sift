// Bounded, production-path live validation. Unlike the normal worker, this:
// - accepts only the already-bound demo conversation;
// - reads only iMessage attachments matching the exact corpus name/size/hash/caption;
// - ignores all other inbound traffic without persisting, analyzing, or replying;
// - exits after the selected cases (L1/L2/L3 by default) or ten minutes.
import { Spectrum, type Attachment, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import { attachmentsOf, parts, summarize, textOf } from "../content.ts";
import { db, recordMessage, type Student } from "../db.ts";
import { safeDiagnostic } from "../diagnostics.ts";
import { env } from "../env.ts";
import { ingest } from "../ingest.ts";
import { findLiveCorpusCase, LIVE_CORPUS, matchLiveCorpusCase } from "../live-corpus.ts";
import { say } from "../turn.ts";

const MAX_RUNTIME_MS = 10 * 60_000;

const casesArgument = process.argv.find((argument) => argument.startsWith("--cases="));
const requestedCaseIds = casesArgument
  ? casesArgument
      .slice("--cases=".length)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : LIVE_CORPUS.map((corpusCase) => corpusCase.id);
const expectedCorpus = LIVE_CORPUS.filter((corpusCase) =>
  requestedCaseIds.includes(corpusCase.id),
);
const unknownCaseIds = requestedCaseIds.filter(
  (id) => !LIVE_CORPUS.some((corpusCase) => corpusCase.id === id),
);
if (expectedCorpus.length === 0 || unknownCaseIds.length > 0) {
  throw new Error(
    `invalid live corpus selection: ${unknownCaseIds.length > 0 ? unknownCaseIds.join(", ") : "empty"}`,
  );
}

const studentResult = await db
  .from("students")
  .select("id, name, phone, photon_space_id, timezone, profile")
  .eq("phone", env.DEMO_PHONE)
  .maybeSingle();
if (studentResult.error) throw studentResult.error;
if (!studentResult.data?.photon_space_id) {
  throw new Error("demo student is missing or is not bound to a Spectrum space");
}
const student = studentResult.data as Student;

const app = await Spectrum({
  projectId: env.PROJECT_ID,
  projectSecret: env.PROJECT_SECRET,
  providers: [imessage.config()],
});

async function nextBeforeDeadline(
  iterator: AsyncIterator<[Space, Message]>,
  deadline: number,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remaining);
  });
  const next = iterator.next();
  const result = await Promise.race([next, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

const completed = new Set<string>();
const deadline = Date.now() + MAX_RUNTIME_MS;

console.log({
  live_validation: "ready",
  expected_cases: expectedCorpus.map((corpusCase) => corpusCase.id),
  max_runtime_seconds: MAX_RUNTIME_MS / 1000,
});

try {
  const iterator = app.messages[Symbol.asyncIterator]();
  while (completed.size < expectedCorpus.length) {
    const next = await nextBeforeDeadline(iterator, deadline);
    if (next === null || next.done) break;
    const [space, message] = next.value;

    if (
      message.direction !== "inbound" ||
      message.platform !== "imessage" ||
      space.id !== student.photon_space_id
    ) {
      console.log({ live_validation: "ignored", reason: "outside bounded conversation" });
      continue;
    }

    const contents = parts(message);
    const files = attachmentsOf(contents);
    if (files.length !== 1) {
      console.log({ live_validation: "ignored", reason: "expected exactly one attachment" });
      continue;
    }

    const file = files[0]!;
    const expected = findLiveCorpusCase(file.name);
    if (
      !expected ||
      !expectedCorpus.some((corpusCase) => corpusCase.id === expected.id) ||
      file.mimeType !== "application/pdf"
    ) {
      console.log({ live_validation: "ignored", reason: "attachment is not in the PDF corpus" });
      continue;
    }
    if (file.size !== undefined && file.size !== expected.size) {
      console.log({ live_validation: "ignored", reason: "attachment size does not match" });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await file.read();
    } catch (error) {
      console.error("[live-validation] controlled attachment read failed", {
        case: expected.id,
        error: safeDiagnostic(error),
      });
      continue;
    }
    const match = matchLiveCorpusCase({
      filename: file.name,
      bytes,
      caption: textOf(contents),
    });
    if (!match.matched) {
      console.log({ live_validation: "ignored", reason: match.reason });
      continue;
    }
    if (completed.has(match.corpusCase.id)) {
      console.log({ live_validation: "ignored", reason: "controlled case already completed" });
      continue;
    }

    const fresh = await recordMessage({
      studentId: student.id,
      photonMessageId: message.id,
      direction: message.direction,
      content: summarize(contents),
    });
    if (!fresh) {
      console.log({ live_validation: "ignored", reason: "duplicate message id" });
      continue;
    }

    const cachedFile = {
      ...file,
      size: bytes.length,
      read: async () => bytes,
    } as Attachment;

    const started = Date.now();
    try {
      await say(space, student.id, "Sifting...");
      await space.responding(async () => {
        const reply = await ingest({
          student,
          text: textOf(contents),
          files: [cachedFile],
        });
        await say(space, student.id, reply);
      });
      completed.add(match.corpusCase.id);
      console.log({
        live_validation: "completed",
        case: match.corpusCase.id,
        elapsed_ms: Date.now() - started,
      });
    } catch (error) {
      console.error("[live-validation] controlled case failed", {
        case: match.corpusCase.id,
        error: safeDiagnostic(error),
      });
      await say(
        space,
        student.id,
        "Hmm, I had trouble sifting that controlled test file — please wait for the validation result.",
      ).catch(() => {});
    }
  }
} finally {
  await app.stop();
}

console.log({
  live_validation: completed.size === expectedCorpus.length ? "complete" : "incomplete",
  completed: [...completed],
  missing: expectedCorpus.filter((corpusCase) => !completed.has(corpusCase.id)).map(
    (corpusCase) => corpusCase.id,
  ),
});
