import { redactSecrets } from "./redact-secrets.js";

export const MAX_EXTERNAL_DIAGNOSTIC_LENGTH = 2_000;
export const EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER = "... [truncated]";

/** A fresh execution artifact is evidence of the same unresolved failure, not
 * a new notification event. Keep semantic text/head identities intact. */
export function diagnosticEventIdentityText(value: string): string {
  return value
    .replace(
      /process-executions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//giu,
      "process-executions/<execution>/",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

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

  const contentLength = Math.max(0, maximumLength - EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER.length);

  return `${redacted.slice(0, contentLength)}${EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER}`.slice(
    0,
    maximumLength,
  );
}
