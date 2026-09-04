import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRetryBackoffDelayMilliseconds,
  RETRY_BACKOFF_BASE_MILLISECONDS,
  RETRY_BACKOFF_MAX_MILLISECONDS,
} from "../src/orchestrator/retry-backoff.js";

describe("retry backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increases exponentially for successive retries", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const delays = [1, 2, 3].map(getRetryBackoffDelayMilliseconds);

    expect(delays).toEqual([
      RETRY_BACKOFF_BASE_MILLISECONDS + 50,
      RETRY_BACKOFF_BASE_MILLISECONDS * 2 + 100,
      RETRY_BACKOFF_BASE_MILLISECONDS * 4 + 200,
    ]);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
  });

  it("keeps jittered delays at or below the maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);

    const delays = [1, 2, 3, 4, 5, 6, 20].map(getRetryBackoffDelayMilliseconds);

    expect(
      delays.every((delay) => delay <= RETRY_BACKOFF_MAX_MILLISECONDS),
    ).toBe(true);
    expect(delays.at(-1)).toBe(RETRY_BACKOFF_MAX_MILLISECONDS);
  });

  it("rejects invalid retry attempts", () => {
    expect(() => getRetryBackoffDelayMilliseconds(0)).toThrow(RangeError);
    expect(() => getRetryBackoffDelayMilliseconds(1.5)).toThrow(RangeError);
  });
});
