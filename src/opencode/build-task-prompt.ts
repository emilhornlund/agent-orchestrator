import type { TrelloCard } from "../trello/trello-client.js";

export function buildTaskPrompt(card: TrelloCard): string {
  const description = card.desc.trim();

  return [
    "Implement the following task in this repository.",
    "",
    `Task: ${card.name}`,
    "",
    description.length > 0
      ? `Description:\n${description}`
      : "No additional task description was provided.",
    "",
    "Work directly in the current repository.",
    "Inspect the existing code before making changes.",
    "Follow the repository's existing conventions and instructions.",
    "Do not create commits, push branches, or open pull requests.",
  ].join("\n");
}
