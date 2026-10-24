import { redactSecrets } from "./redact-secrets.js";

export const MAX_EXTERNAL_DIAGNOSTIC_LENGTH = 2_000;
export const EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER = "... [truncated]";

/** Redacts external text before applying the shared concise-diagnostic bound. */
export function presentExternalDiagnostic(
  value: string,
  secretValues: readonly (string | undefined)[] = [],
  maximumLength = MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    throw new Error("External diagnostic maximum length must be positive");
  }
  const redacted = redactSecrets(value, secretValues);

  if (redacted.length <= maximumLength) {
    return redacted;
  }

  const contentLength = Math.max(
    0,
    maximumLength - EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER.length,
  );

  return `${redacted.slice(0, contentLength)}${EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER}`.slice(
    0,
    maximumLength,
  );
}
