export const RETRY_BACKOFF_BASE_MILLISECONDS = 1_000;
export const RETRY_BACKOFF_MAX_MILLISECONDS = 30_000;

const RETRY_BACKOFF_JITTER_RATIO = 0.1;

export function getRetryBackoffDelayMilliseconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Retry attempt must be a positive safe integer");
  }

  const exponentialDelay = Math.min(
    RETRY_BACKOFF_MAX_MILLISECONDS,
    RETRY_BACKOFF_BASE_MILLISECONDS * 2 ** (attempt - 1),
  );

  if (exponentialDelay === RETRY_BACKOFF_MAX_MILLISECONDS) {
    return exponentialDelay;
  }

  const jitter = Math.floor(
    exponentialDelay * RETRY_BACKOFF_JITTER_RATIO * Math.random(),
  );

  return Math.min(RETRY_BACKOFF_MAX_MILLISECONDS, exponentialDelay + jitter);
}
