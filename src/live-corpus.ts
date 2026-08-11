import { createHash } from "node:crypto";

export type LiveCorpusCase = {
  id: "L1" | "L2" | "L3";
  filename: string;
  sha256: string;
  size: number;
  caption: string;
};

export const LIVE_CORPUS: readonly LiveCorpusCase[] = [
  {
    id: "L1",
    filename: "2018 Sample Midterm.pdf",
    sha256: "956e3171e459e407983a7bbbd134c4d848c889c570ae9e24a4ff54583ce8b6ac",
    size: 2421,
    caption: "",
  },
  {
    id: "L2",
    filename: "Fall 2018 Project Brief.pdf",
    sha256: "0538be7a26c855de62f0b35ccaa981e0ac023c077ffd862b53b0be6c287ae6f1",
    size: 2322,
    caption: "Save this current project brief.",
  },
  {
    id: "L3",
    filename: "old-final-packet-2019.pdf",
    sha256: "ccc35f9413bacd0b8a4903d3aef9bb6e00158fb2eb46add0f310e5a26ac79153",
    size: 3358,
    caption: "",
  },
] as const;

const normalizedCaption = (caption: string) => caption.trim().replace(/\s+/g, " ");

export const findLiveCorpusCase = (filename: string) =>
  LIVE_CORPUS.find((candidate) => candidate.filename === filename);

export function matchLiveCorpusCase(input: {
  filename: string;
  bytes: Buffer;
  caption: string;
}): { matched: true; corpusCase: LiveCorpusCase } | { matched: false; reason: string } {
  const corpusCase = findLiveCorpusCase(input.filename);
  if (!corpusCase) return { matched: false, reason: "filename is not in the controlled corpus" };
  if (input.bytes.length !== corpusCase.size) {
    return { matched: false, reason: "attachment size does not match the controlled corpus" };
  }

  const digest = createHash("sha256").update(input.bytes).digest("hex");
  if (digest !== corpusCase.sha256) {
    return { matched: false, reason: "attachment digest does not match the controlled corpus" };
  }
  if (normalizedCaption(input.caption) !== corpusCase.caption) {
    return { matched: false, reason: "caption does not match the controlled corpus" };
  }

  return { matched: true, corpusCase };
}
