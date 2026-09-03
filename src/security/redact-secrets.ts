export function redactSecrets(
  text: string,
  secretValues: readonly (string | undefined)[] = [],
): string {
  let redacted = text;
  const secrets = secretValues
    .filter((value): value is string => value !== undefined && value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  redacted = redacted.replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(
    /([?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(
    /(\b["']?(?:api[_-]?key|token|password|secret|authorization|credential|username)["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi,
    "$1[REDACTED]",
  );

  return redacted;
}

export interface SecretRedactor {
  push(text: string): string;
  flush(): string;
}

/** Buffers stream output until it can be redacted without chunk-boundary leaks. */
export function createSecretRedactor(
  secretValues: readonly (string | undefined)[] = [],
): SecretRedactor {
  const secrets = secretValues.filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  let pending = "";

  return {
    push(text) {
      pending += text;
      return "";
    },
    flush() {
      const output = pending;
      pending = "";

      return redactSecrets(output, secrets);
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

    return (
      visit(candidate.message) ||
      visit(candidate.stack) ||
      visit(candidate.cause)
    );
  }

  return visit(value);
}
