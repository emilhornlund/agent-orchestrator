import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

import { WorkflowError } from "./workflow-error.js";

export async function correctCardToBacklog(
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  const cardLog = logger.child({
    projectId: project.id,
    cardId: card.id,
  });

  try {
    await trello.moveCard(card.id, project.trello.backlogListId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    cardLog.error(
      `Could not correct card "${card.name}" to Backlog: ${message}`,
    );

    throw new WorkflowError(
      "Workflow",
      `Could not move card to Backlog while correcting its Trello state: ${message}`,
      { cause: error },
    );
  }

  if (signal?.aborted) {
    return;
  }

  cardLog.event(`Corrected card to Backlog: ${reason}`);

  if (signal?.aborted) {
    return;
  }

  try {
    await trello.addComment(
      card.id,
      [
        "Agent Orchestrator corrected this card's Trello state.",
        "",
        `Reason: ${reason}`,
        "The card was moved to Backlog without starting or resuming agent work.",
        "To deliberately retry it, move the card to Ready for Agent.",
      ].join("\n"),
    );
  } catch (error) {
    cardLog.error(
      `Card was corrected to Backlog, but the explanatory Trello comment failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
