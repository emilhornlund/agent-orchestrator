import type { TrelloCard } from "../trello/trello-client.js";

export function isCardStartDateReached(
  card: Pick<TrelloCard, "start">,
  now = Date.now(),
): boolean {
  return card.start === undefined || Date.parse(card.start) <= now;
}
