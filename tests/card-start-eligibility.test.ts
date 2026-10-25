import { describe, expect, it } from "vitest";

import { isCardStartDateReached } from "../src/orchestrator/card-start-eligibility.js";

describe("isCardStartDateReached", () => {
  const now = Date.parse("2026-10-25T12:00:00.000Z");

  it("considers a card without a start date eligible", () => {
    expect(isCardStartDateReached({}, now)).toBe(true);
  });

  it("considers a card with a start date in the past eligible", () => {
    expect(
      isCardStartDateReached({ start: "2026-10-24T12:00:00.000Z" }, now),
    ).toBe(true);
  });

  it("does not consider a card with a start date in the future eligible", () => {
    expect(
      isCardStartDateReached({ start: "2026-10-26T12:00:00.000Z" }, now),
    ).toBe(false);
  });

  it("considers a card eligible at its exact start instant", () => {
    expect(
      isCardStartDateReached({ start: "2026-10-25T12:00:00.000Z" }, now),
    ).toBe(true);
  });
});
