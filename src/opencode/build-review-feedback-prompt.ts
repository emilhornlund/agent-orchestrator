import type { TrelloCard } from "../trello/trello-client.js";

export function buildReviewFeedbackPrompt(
  card: TrelloCard,
  pullRequestUrl: string,
  feedback: string,
): string {
  return [
    "Apply the human review feedback for the existing pull request.",
    "",
    `Task: ${card.name}`,
    `Pull request: ${pullRequestUrl}`,
    "",
    "Human review feedback:",
    feedback.trim(),
    "",
    "Inspect the current repository and existing implementation before editing.",
    "Address all still-applicable requested changes completely.",
    "Some feedback may refer to code that has already changed, so verify the current state before modifying it.",
    "Keep the existing task scope unless the review feedback explicitly requires otherwise.",
    "Run the repository's appropriate validation checks.",
    "Do not create commits.",
    "Do not push anything.",
  ].join("\n");
}
