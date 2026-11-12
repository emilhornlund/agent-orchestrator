function secretForms(secretValues: readonly (string | undefined)[]): string[] {
  return secretValues
    .filter((value): value is string => value !== undefined && value.length > 0)
    .flatMap((value) => {
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const escaped = JSON.stringify(value).slice(1, -1);
      return [
        value,
        encodeURIComponent(value),
        encodeURIComponent(value).replaceAll("%20", "+"),
        encoded,
        encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
        escaped,
      ];
    })
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
}

export function redactRegisteredSecrets(
  text: string,
  secretValues: readonly (string | undefined)[] = [],
): string {
  let redacted = text;
  const secrets = secretForms(secretValues);
  const marker = "\u0000REDACTED-SECRET-MARKER\u0000";
  redacted = redacted.replaceAll("[REDACTED]", marker);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, marker);
  return redacted
    .replace(new RegExp(`(?:${marker}){2,}`, "gu"), marker)
    .replaceAll(marker, "[REDACTED]");
}

export function redactSecrets(
  text: string,
  secretValues: readonly (string | undefined)[] = [],
): string {
  let redacted = text;
  const secrets = secretForms(secretValues);

  // Keep existing markers opaque when a configured secret is short (for
  // example, "a"). This prevents subsequent redaction passes from expanding
  // a single marker into many overlapping markers.
  const marker = "\u0000REDACTED-SECRET-MARKER\u0000";
  redacted = redacted.replaceAll("[REDACTED]", marker);

  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, marker);
  }

  redacted = redacted.replace(
    /(\b["']?(?:api[_-]?key|token|password|secret|authorization|credential|username)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'};]+/gi,
    `$1${marker}`,
  );
  redacted = redacted.replace(
    /([?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=)[^&#\s]+/gi,
    `$1${marker}`,
  );
  redacted = redacted.replace(/(\bBearer\s+)[^\s,;]+/gi, `$1${marker}`);

  const duplicatedMarkers = new RegExp(`(?:${marker}){2,}`, "gu");
  return redacted.replace(duplicatedMarkers, marker).replaceAll(marker, "[REDACTED]");
}

export interface SecretRedactor {
  push(text: string): string;
  flush(): string;
}

/** Redacts incrementally while retaining only a bounded boundary window. */
export function createSecretRedactor(
  secretValues: readonly (string | undefined)[] = [],
): SecretRedactor {
  const optionalBase64PaddingForms = secretValues
    .filter((value): value is string => value !== undefined && value.length > 0)
    .map((value) => {
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const form = encoded.replace(/=+$/u, "");
      return { form, padding: encoded.length - form.length };
    })
    .filter(({ form, padding }) => form.length > 0 && padding > 0);
  const secrets = secretForms(secretValues);
  const maxSecretLength = secrets.reduce((maximum, secret) => Math.max(maximum, secret.length), 0);
  const sensitivePrefixes = [
    "bearer ",
    ...[
      "key",
      "token",
      "api_key",
      "api-key",
      "access_token",
      "access-token",
      "password",
      "secret",
      "authorization",
      "credential",
      "username",
    ].flatMap((key) => [`${key}:`, `${key}=`, `"${key}":`, `"${key}"=`]),
  ];
  let pending = "";
  let skippedValueDelimiter: RegExp | undefined;

  function boundaryOverlap(text: string): number {
    const maximum = Math.min(text.length, Math.max(maxSecretLength - 1, 20));
    const lower = text.toLowerCase();
    for (let length = maximum; length > 0; length -= 1) {
      const suffix = lower.slice(-length);
      if (
        secrets.some((secret) => secret.toLowerCase().startsWith(suffix)) ||
        sensitivePrefixes.some((prefix) => prefix.startsWith(suffix))
      ) {
        return length;
      }
    }
    return 0;
  }

  function takeStablePrefix(final: boolean): string {
    if (final) {
      const output = pending;
      pending = "";
      return output;
    }

    // Keep only a suffix whose unpadded base64url spelling could still receive
    // its optional '=' padding. Stable text before that suffix remains streamable.
    let paddingTailLength = 0;
    for (const { form, padding } of optionalBase64PaddingForms) {
      if (pending.endsWith(form)) {
        paddingTailLength = Math.max(paddingTailLength, form.length);
      }
      for (let count = 1; count < padding; count += 1) {
        const partialForm = `${form}${"=".repeat(count)}`;
        if (pending.endsWith(partialForm)) {
          paddingTailLength = Math.max(paddingTailLength, partialForm.length);
        }
      }
    }

    const stableInputLength = pending.length - paddingTailLength;
    const stableInput = redactRegisteredSecrets(pending.slice(0, stableInputLength), secrets);
    pending = stableInput + pending.slice(stableInputLength);
    const stableRegionLength = stableInput.length;
    const safeLength = Math.max(
      0,
      stableRegionLength - boundaryOverlap(pending.slice(0, stableRegionLength)),
    );
    if (safeLength === 0) return "";

    const credentialPrefixes = [
      { expression: /\bBearer\s+/gi, delimiter: /[\s,;]/u },
      {
        expression: /[?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=/gi,
        delimiter: /[&#\s]/u,
      },
      {
        expression:
          /\b["']?(?:api[_-]?key|token|password|secret|authorization|credential|username)["']?\s*[:=]\s*["']?(?:Bearer\s+)?/gi,
        delimiter: /[\s,"'};]/u,
      },
    ];
    for (const { expression, delimiter } of credentialPrefixes) {
      for (const match of pending.matchAll(expression)) {
        const valueStart = (match.index ?? 0) + match[0].length;
        const delimiterIndex = pending.slice(valueStart).search(delimiter);
        const valueEnd = delimiterIndex === -1 ? pending.length : valueStart + delimiterIndex;
        if (valueStart < safeLength && valueEnd >= safeLength) {
          const output = `${pending.slice(0, match.index ?? 0)}${match[0]}[REDACTED]`;
          const valueAndRemainder = pending.slice(valueStart);
          const nextDelimiter = valueAndRemainder.search(delimiter);
          if (nextDelimiter === -1) {
            pending = "";
            skippedValueDelimiter = delimiter;
          } else {
            pending = valueAndRemainder.slice(nextDelimiter);
          }
          return redactSecrets(output, secrets);
        }
      }
    }

    if (safeLength === 0) return "";
    const output = pending.slice(0, safeLength);
    pending = pending.slice(safeLength);
    return output;
  }

  return {
    push(text) {
      if (skippedValueDelimiter !== undefined) {
        const delimiterIndex = text.search(skippedValueDelimiter);
        if (delimiterIndex === -1) return "";
        text = text.slice(delimiterIndex);
        skippedValueDelimiter = undefined;
      }
      pending += text;
      return redactSecrets(takeStablePrefix(false), secrets);
    },
    flush() {
      if (skippedValueDelimiter !== undefined) {
        skippedValueDelimiter = undefined;
        pending = "";
      }
      return redactSecrets(takeStablePrefix(true), secrets);
    },
  };
}

export function redactError(
  error: unknown,
  secretValues: readonly (string | undefined)[] = [],
): Error {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
    secretValues,
  );

  if (!(error instanceof Error)) {
    return new Error(message);
  }

  const redacted = new Error(message);
  redacted.name = error.name;

  return redacted;
}

export function containsSecret(
  value: unknown,
  secretValues: readonly (string | undefined)[] = [],
): boolean {
  const secrets = secretValues.filter(
    (secret): secret is string => secret !== undefined && secret.length > 0,
  );
  const seen = new Set<unknown>();

  function visit(candidate: unknown): boolean {
    if (seen.has(candidate)) {
      return false;
    }

    seen.add(candidate);

    if (typeof candidate === "string") {
      return secrets.some((secret) => candidate.includes(secret));
    }

    if (!(candidate instanceof Error)) {
      return false;
    }

    return visit(candidate.message) || visit(candidate.stack) || visit(candidate.cause);
  }

  return visit(value);
}

/** Sanitizer for text crossing an orchestrator-controlled output boundary. */
export function sanitizeControlledText(text: string): string {
  return redactRegisteredSecrets(text, getProcessRuntime().secretValues);
}
import { getProcessRuntime } from "../process/process-runtime.js";
