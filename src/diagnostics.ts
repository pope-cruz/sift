const SECRET_PATTERNS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(PROJECT_SECRET|SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|DEMO_TOKEN_SECRET|CRON_SECRET)\s*[=:]\s*\S+/gi,
];

export type SafeDiagnostic = {
  name: string;
  code: string;
  message: string;
};

function redact(value: string): string {
  let safe = value;
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, "[REDACTED]");
  return safe.replace(/[\r\n\t]+/g, " ").slice(0, 320);
}

/** Loggable error facts only: no headers, request bodies, byte payloads, or stacks. */
export function safeDiagnostic(error: unknown): SafeDiagnostic {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string" ? error.code : "UNEXPECTED_ERROR";
    return { name: error.name || "Error", code, message: redact(error.message) };
  }
  // PostgREST and other clients reject with plain objects rather than Errors.
  // String() turns those into "[object Object]", which hides the one useful
  // fact — a failed RPC once reported nothing but that, while the database was
  // naming the exact missing function signature.
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = ["message", "details", "hint"]
      .map((key) => record[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const code = typeof record.code === "string" ? record.code : "UNEXPECTED_ERROR";
    if (parts.length) return { name: "UnknownError", code, message: redact(parts.join(" | ")) };
    return { name: "UnknownError", code, message: redact(safeStringify(error)) };
  }
  return { name: "UnknownError", code: "UNEXPECTED_ERROR", message: redact(String(error)) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class InputDiagnosticError extends Error {
  override readonly name = "InputDiagnosticError";
  readonly code: string;
  readonly userMessage: string;

  constructor(
    code: string,
    userMessage: string,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.userMessage = userMessage;
  }
}
