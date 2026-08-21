import type { TrelloCard } from "../trello/trello-client.js";

const maxSubjectLength = 72;

export function buildCommitMessage(card: TrelloCard): string {
  const title = card.name.replace(/\s+/g, " ").trim();

  if (title.length <= maxSubjectLength) {
    return title;
  }

  return title
    .slice(0, maxSubjectLength - 3)
    .trimEnd()
    .concat("...");
}
