// Confirms ANTHROPIC_API_KEY works and that structured outputs behave on the
// reader model, without needing the line or a database.
//
//   npm run llm:check
//
// Pass a PDF or image to run the real ingestion pipeline over it — the reader
// call plus the deterministic ruling, printed side by side, with nothing
// persisted. This is the fastest way to see why a given file did or didn't
// produce a deadline:
//
//   npm run llm:check -- "tmp/attachments/Sample Midterm 2018.pdf"
//   npm run llm:check -- tmp/attachments/cafe.png "remind me about this friday"
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { aggregate } from "../analysis.ts";
import { today } from "../dates.ts";
import { analyzeArtifact } from "../llm.ts";

const path = process.argv[2];
const caption = process.argv[3] ?? "";
const timezone = "America/New_York";

if (!path) {
  console.log("no file given — skipping the document/image check");
} else {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  const mimeType =
    extension === ".pdf"
      ? "application/pdf"
      : extension === ".png"
        ? "image/png"
        : extension === ".webp"
          ? "image/webp"
          : "image/jpeg";

  const filename = basename(path);
  const analyses = await analyzeArtifact({ bytes, mimeType, filename, caption, timezone });

  console.log("\n=== analysis ===");
  for (const analysis of analyses) {
    console.log({
      item_key: analysis.item_key,
      purpose: analysis.purpose,
      secondary_tags: analysis.secondary_tags,
      user_intent: analysis.user_intent,
      place: analysis.place,
      topics: analysis.topics.length,
      metadata_candidates: analysis.metadata_candidates.length,
      date_candidates: analysis.date_candidates.length,
    });

    const result = aggregate(analysis, {
      today: today(timezone),
      timezone,
      filename,
      caption,
    });

    console.log("\n=== date rulings ===");
    for (const decision of result.decisions) {
      console.log(
        `  ${decision.outcome.padEnd(13)} "${decision.candidate.original_text}" ` +
          `(${decision.candidate.role} / ${decision.candidate.source}) — ${decision.reason}`,
      );
    }
    if (result.decisions.length === 0) console.log("  (no dates found)");

    console.log("\n=== would persist ===");
    console.log({ item: { ...result.item, extractedText: "[…]" }, actions: result.actions });

    console.log("\n=== would reply ===");
    console.log(result.confirmation);
  }
}
