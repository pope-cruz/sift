import sharp from "sharp";

import { InputDiagnosticError } from "./diagnostics.ts";

const PDF_HEADER = Buffer.from("%PDF-");
const PDF_EOF = Buffer.from("%%EOF");
const VISION_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type InputKind = "pdf" | "image" | "unsupported_image" | "unsupported";

export function classifyInputMime(mimeType: string): InputKind {
  if (mimeType === "application/pdf") return "pdf";
  if (VISION_MIME.has(mimeType)) return "image";
  if (mimeType.startsWith("image/")) return "unsupported_image";
  return "unsupported";
}

/** Reject empty/corrupt/truncated inputs before upload or model work. */
export async function validateReadableBytes(
  bytes: Buffer,
  mimeType: string,
  displayName = "That file",
): Promise<void> {
  if (bytes.length === 0) {
    throw new InputDiagnosticError(
      "EMPTY_INPUT",
      `${displayName} is empty. Try sending the original file again.`,
      "attachment contained zero bytes",
    );
  }

  if (mimeType === "application/pdf") {
    if (!bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
      throw new InputDiagnosticError(
        "MALFORMED_PDF",
        `${displayName} doesn't appear to be a readable PDF. Try exporting it again.`,
        "PDF signature was missing",
      );
    }

    const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
    if (!tail.includes(PDF_EOF)) {
      throw new InputDiagnosticError(
        "TRUNCATED_PDF",
        `${displayName} looks incomplete. Try sending or exporting it again.`,
        "PDF end marker was missing",
      );
    }
    return;
  }

  if (mimeType.startsWith("image/")) {
    try {
      const metadata = await sharp(bytes, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("image dimensions were missing");
    } catch {
      throw new InputDiagnosticError(
        "MALFORMED_IMAGE",
        `${displayName} isn't a readable image. A fresh screenshot should work.`,
        "image decoder rejected the attachment",
      );
    }
  }
}

export type AttachmentIdentity = { id: string; name: string; mimeType: string; size?: number };

/** Collapse provider duplicates within one group without conflating distinct files. */
export function uniqueAttachments<T extends AttachmentIdentity>(files: T[]): T[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.id || `${file.name}\u0000${file.mimeType}\u0000${file.size ?? "unknown"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
