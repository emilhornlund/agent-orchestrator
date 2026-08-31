import type { ProjectConfig } from "../config/config.js";
import {
  TrelloRequestAbortedError,
  type TrelloCard,
  type TrelloClient,
} from "../trello/trello-client.js";

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
  signal?: AbortSignal,
): Promise<void> {
  const classificationLabelId = getClassificationLabelId(project, result.type);

  const classificationLabelIds = [
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ];

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  await trello.updateCardContent(card.id, result.title, result.description);

  for (const labelId of classificationLabelIds) {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    if (labelId !== classificationLabelId && card.idLabels.includes(labelId)) {
      await trello.removeLabel(card.id, labelId);
    }
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  if (!card.idLabels.includes(classificationLabelId)) {
    await trello.addLabel(card.id, classificationLabelId);
  }

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  await trello.removeLabel(card.id, project.trello.refinementLabelId);

  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }

  await trello.moveCard(card.id, project.trello.backlogListId);
}
