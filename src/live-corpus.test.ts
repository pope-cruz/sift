import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { LIVE_CORPUS, matchLiveCorpusCase } from "./live-corpus.ts";

test("generated corpus files match the bounded live-run manifest exactly", async () => {
  for (const corpusCase of LIVE_CORPUS) {
    const bytes = await readFile(new URL(`../output/pdf/${corpusCase.filename}`, import.meta.url));
    const match = matchLiveCorpusCase({
      filename: corpusCase.filename,
      bytes,
      caption: corpusCase.caption,
    });
    assert.equal(match.matched, true, corpusCase.id);
  }
});

test("bounded live matching rejects unknown, modified, and mis-captioned inputs", async () => {
  const corpusCase = LIVE_CORPUS[0]!;
  const bytes = await readFile(new URL(`../output/pdf/${corpusCase.filename}`, import.meta.url));

  assert.equal(
    matchLiveCorpusCase({ filename: "unrelated.pdf", bytes, caption: "" }).matched,
    false,
  );
  assert.equal(
    matchLiveCorpusCase({
      filename: corpusCase.filename,
      bytes: Buffer.concat([bytes, Buffer.from("changed")]),
      caption: "",
    }).matched,
    false,
  );
  assert.equal(
    matchLiveCorpusCase({ filename: corpusCase.filename, bytes, caption: "remind me" }).matched,
    false,
  );
});
