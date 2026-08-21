import { describe, expect, it } from "vitest";

import { parseReviewResult } from "../src/opencode/parse-review-result.js";

describe("parseReviewResult", () => {
  it("parses a passing review", () => {
    expect(parseReviewResult("Everything looks correct.\nREVIEW_PASS\n")).toBe(
      "pass",
    );
  });

  it("parses a failing review", () => {
    expect(parseReviewResult("A regression was found.\nREVIEW_FAIL\n")).toBe(
      "fail",
    );
  });

  it("rejects output without a review result", () => {
    expect(() => parseReviewResult("Looks good to me.")).toThrow(
      "OpenCode review did not return REVIEW_PASS or REVIEW_FAIL",
    );
  });
});
