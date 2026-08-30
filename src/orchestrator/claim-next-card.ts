import type { Config } from "../config/config.js";
import { logger } from "../logging/logger.js";
import {
  createWorkflowOwnership,
  serializeWorkflowOwnership,
  validateWorkflowOwnership,
} from "../trello/workflow-ownership.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

type Project = Config["projects"][number];

export async function claimNextCard(
  trello: TrelloClient,
  project: Project,
): Promise<TrelloCard | null> {
  const cards = await trello.getCards(project.trello.readyListId, {
    workflowOwnershipCustomFieldId: project.trello.ownershipCustomFieldId,
  });

  const implementationLabelIds = new Set([
    project.trello.featureLabelId,
    project.trello.improvementLabelId,
    project.trello.bugLabelId,
  ]);

  for (const candidate of cards) {
    if (
      candidate.idLabels.includes(project.trello.refinementLabelId) ||
      !candidate.idLabels.some((labelId) => implementationLabelIds.has(labelId))
    ) {
      continue;
    }

    const ownership = validateWorkflowOwnership(
      candidate,
      project,
      "implementation",
    );

    if (ownership.status === "missing" || ownership.status === "owned") {
      const marker = createWorkflowOwnership(
        project,
        candidate,
        "implementation",
      );

      await trello.setWorkflowOwnership(
        candidate.id,
        project.trello.ownershipCustomFieldId,
        marker,
      );

      const claimedCard = await trello.moveCard(
        candidate.id,
        project.trello.workingListId,
      );

      return {
        ...claimedCard,
        workflowOwnership: serializeWorkflowOwnership(marker),
      };
    }

    logger
      .child({ projectId: project.id, cardId: candidate.id })
      .warn(`Skipping Ready for Agent card: ${ownership.reason}`);
  }

  return null;
}
