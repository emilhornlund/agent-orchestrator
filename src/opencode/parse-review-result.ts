export type ReviewResult = "pass" | "fail";

export function parseReviewResult(output: string): ReviewResult {
  const lines = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const finalLine = lines.at(-1);

  if (finalLine === "REVIEW_PASS") {
    return "pass";
  }

  if (finalLine === "REVIEW_FAIL") {
    return "fail";
  }

  throw new Error(
    "OpenCode review did not return REVIEW_PASS or REVIEW_FAIL as its final line",
  );
}
