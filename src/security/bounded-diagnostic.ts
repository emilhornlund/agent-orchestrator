import { redactSecrets } from "./redact-secrets.js";

export const MAX_EXTERNAL_DIAGNOSTIC_LENGTH = 2_000;
export const EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER = "... [truncated]";

/** Redacts external text before applying the shared concise-diagnostic bound. */
export function presentExternalDiagnostic(
  value: string,
  secretValues: readonly (string | undefined)[] = [],
): string {
  const redacted = redactSecrets(value, secretValues);

  if (redacted.length <= MAX_EXTERNAL_DIAGNOSTIC_LENGTH) {
    return redacted;
  }

  const contentLength =
    MAX_EXTERNAL_DIAGNOSTIC_LENGTH -
    EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER.length;

  return `${redacted.slice(0, contentLength)}${EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER}`;
}
