import type { Config } from "../config/config.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

type Project = Config["projects"][number];

export async function claimNextCard(
  trello: TrelloClient,
  project: Project,
): Promise<TrelloCard | null> {
  const cards = await trello.getCards(project.trello.readyListId);

  const implementationLabelIds = new Set([
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ]);

  const card = cards.find(
    (candidate) =>
      !candidate.idLabels.includes(project.trello.refinementLabelId) &&
      candidate.idLabels.some((labelId) => implementationLabelIds.has(labelId)),
  );

  if (!card) {
    return null;
  }

  return trello.moveCard(card.id, project.trello.workingListId);
}
