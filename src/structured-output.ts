/** A bounded retry for the one failure class that a fresh structured-output
 * sample can repair. Authentication, quota, network, and provider errors are
 * never retried or relabelled. */
export class StructuredOutputValidationError extends Error {
  override readonly name = "StructuredOutputValidationError";
  readonly code = "STRUCTURED_OUTPUT_INVALID";
}

function isSchemaFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /failed to parse structured output|failed schema validation/i.test(error.message);
}

export async function withStructuredOutputRetry<T>(
  run: (attempt: 0 | 1) => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await run(0);
  } catch (error) {
    if (!isSchemaFailure(error)) throw error;
  }

  try {
    return await run(1);
  } catch (error) {
    if (!isSchemaFailure(error)) throw error;
    throw new StructuredOutputValidationError(
      `${label}: structured output was invalid after one bounded retry`,
    );
  }
}
