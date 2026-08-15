import { createHash, createHmac, randomBytes } from "node:crypto";

export const DEMO_LIMITS = {
  turns: 12,
  attachmentTurns: 4,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  textCharacters: 2_000,
  sessionsPerClient: 3,
} as const;

export const DEMO_TOKEN_STORAGE_KEY = "sort.demo.session.v1";
export const DEMO_ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export class DemoError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function newDemoToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDemoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashDemoClientKey(clientKey: string, secret: string): string {
  return createHmac("sha256", secret).update(clientKey).digest("hex");
}

export function safeDemoFilename(value: string, mimeType: string): string {
  const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mimeType] ?? "bin";
  const leaf = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  const compact = leaf.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 220);
  return compact || `upload.${extension}`;
}

export function validTimezone(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return "UTC";
  }
}

export function assertTurnInput(input: { text: string; file?: { size: number; type: string } }): void {
  if (input.text.length > DEMO_LIMITS.textCharacters) {
    throw new DemoError("TEXT_TOO_LONG", `Keep messages under ${DEMO_LIMITS.textCharacters.toLocaleString()} characters.`);
  }
  if (!input.text.trim() && !input.file) throw new DemoError("EMPTY_TURN", "Write a message or attach a file first.");
  if (input.file && !DEMO_ALLOWED_MIME.has(input.file.type)) throw new DemoError("INVALID_FILE_TYPE", "Use a PDF, JPEG, PNG, or WebP file.");
  if (input.file && input.file.size < 1) throw new DemoError("EMPTY_UPLOAD", "That file is empty. Choose the original file and try again.");
  if (input.file && input.file.size > DEMO_LIMITS.fileBytes) throw new DemoError("FILE_TOO_LARGE", "Files in the demo must be 8 MB or smaller.");
}
