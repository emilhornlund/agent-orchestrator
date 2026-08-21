import type { TrelloCard } from "../trello/trello-client.js";

export function buildReviewPrompt(card: TrelloCard): string {
  const description = card.desc.trim();

  return [
    "Review the uncommitted changes in this repository for the following task.",
    "",
    `Task: ${card.name}`,
    "",
    description.length > 0
      ? `Description:\n${description}`
      : "No additional task description was provided.",
    "",
    "Inspect the repository instructions and the complete Git diff/status.",
    "Review correctness, completeness, regressions, tests, validation, and adherence to repository conventions.",
    "Do not modify any files.",
    "Do not create commits.",
    "",
    "Your final line must be exactly one of:",
    "REVIEW_PASS",
    "REVIEW_FAIL",
    "",
    "Use REVIEW_PASS only if the changes are ready to proceed.",
    "Use REVIEW_FAIL if anything must be corrected.",
    "You may explain findings before the final line.",
  ].join("\n");
}
