import type { TrelloCard } from "../trello/trello-client.js";

export function buildRemediationPrompt(
  card: TrelloCard,
  reviewOutput: string,
): string {
  return [
    "Fix the issues found by the review of the current uncommitted changes.",
    "",
    `Task: ${card.name}`,
    "",
    "Review findings:",
    reviewOutput.trim(),
    "",
    "Inspect the repository and current changes before editing.",
    "Address the review findings completely.",
    "Run the repository's appropriate validation checks.",
    "Do not create commits.",
    "Do not push anything.",
  ].join("\n");
}
