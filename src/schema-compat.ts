const MISSING_SCHEMA_CODES = new Set(["PGRST202", "PGRST204", "42703", "42883"]);

/** Only downgrade when PostgREST/Postgres says a newly-added schema feature is absent. */
export function isMissingSchemaFeature(error: unknown, names: string[] = []): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = String(value.code ?? "");
  const detail = `${String(value.message ?? "")} ${String(value.details ?? "")}`;
  if (!MISSING_SCHEMA_CODES.has(code)) return false;
  return names.length === 0 || names.some((name) => detail.toLowerCase().includes(name.toLowerCase()));
}
