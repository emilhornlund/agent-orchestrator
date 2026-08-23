import type { TrelloCard } from "../trello/trello-client.js";

export function buildReviewPrompt(
  card: TrelloCard,
  previousFindings?: string,
): string {
  const description = card.desc.trim();

  const previousFindingsSection =
    previousFindings === undefined
      ? []
      : [
          "",
          "A previous review reported the following blocking findings:",
          "",
          previousFindings.trim(),
          "",
          "First verify whether each previous finding has been resolved.",
          "If any previous finding remains unresolved, return REVIEW_FAIL.",
          "Then perform a fresh independent review of the complete current changes.",
          "You may report new blocking findings that were not identified previously.",
        ];

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
    ...previousFindingsSection,
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
