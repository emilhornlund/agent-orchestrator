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
