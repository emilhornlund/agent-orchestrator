import type { ProjectConfig } from "../config/config.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import type { RefinementResult } from "./refinement-result.js";

function getClassificationLabelId(
  project: ProjectConfig,
  type: RefinementResult["type"],
): string {
  switch (type) {
    case "feature":
      return project.trello.featureLabelId;

    case "improvement":
      return project.trello.improvementLabelId;

    case "bug":
      return project.trello.bugLabelId;
  }
}

export async function finalizeRefinement(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  result: RefinementResult,
): Promise<void> {
  const classificationLabelId = getClassificationLabelId(project, result.type);

  const classificationLabelIds = [
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ];

  await trello.updateCardContent(card.id, result.title, result.description);

  for (const labelId of classificationLabelIds) {
    if (labelId !== classificationLabelId && card.idLabels.includes(labelId)) {
      await trello.removeLabel(card.id, labelId);
    }
  }

  if (!card.idLabels.includes(classificationLabelId)) {
    await trello.addLabel(card.id, classificationLabelId);
  }

  await trello.removeLabel(card.id, project.trello.refinementLabelId);

  await trello.moveCard(card.id, project.trello.backlogListId);

  try {
    await trello.clearWorkflowOwnership(
      card.id,
      project.trello.ownershipCustomFieldId,
    );
  } catch (error) {
    try {
      await trello.moveCard(card.id, card.idList);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Could not clear refinement ownership after moving card to Backlog; additionally could not restore card to its original list`,
        { cause: rollbackError },
      );
    }

    throw error;
  }
}
