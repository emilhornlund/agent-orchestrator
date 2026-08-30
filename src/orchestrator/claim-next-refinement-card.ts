import type { Config } from "../config/config.js";
import { logger } from "../logging/logger.js";
import {
  createWorkflowOwnership,
  serializeWorkflowOwnership,
  validateWorkflowOwnership,
} from "../trello/workflow-ownership.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";

type Project = Config["projects"][number];

export async function claimNextRefinementCard(
  trello: TrelloClient,
  project: Project,
): Promise<TrelloCard | null> {
  const cards = await trello.getCards(project.trello.readyListId, {
    workflowOwnershipCustomFieldId: project.trello.ownershipCustomFieldId,
  });

  for (const candidate of cards) {
    if (!candidate.idLabels.includes(project.trello.refinementLabelId)) {
      continue;
    }

    const ownership = validateWorkflowOwnership(
      candidate,
      project,
      "refinement",
    );

    if (ownership.status === "missing" || ownership.status === "owned") {
      const marker = createWorkflowOwnership(project, candidate, "refinement");

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
