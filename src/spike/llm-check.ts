// Confirms ANTHROPIC_API_KEY works and that structured outputs behave on the
// extraction model, without needing the line or a database.
//
//   npm run llm:check
//
// Optionally pass a PDF or image path to exercise the document/image path too:
//   npm run llm:check -- tmp/attachments/some-syllabus.pdf
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { extractPlace, extractSyllabus } from "../llm.ts";

const path = process.argv[2];

if (!path) {
  console.log("no file given — skipping the document/image check");
} else {
  const bytes = await readFile(path);
  const today = new Date().toISOString().slice(0, 10);

  if (extname(path).toLowerCase() === ".pdf") {
    const extracted = await extractSyllabus(bytes, { today, timezone: "America/New_York" });
    console.log({
      title: extracted.title,
      topics: extracted.topics.length,
      events: extracted.events.slice(0, 5),
    });
  } else {
    const mimeType = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
    console.log({ place: await extractPlace(bytes, { mimeType }) });
  }
}
