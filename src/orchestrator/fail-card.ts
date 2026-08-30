import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import { hasWorkflowOwnershipMarker } from "../trello/workflow-ownership.js";

import {
  annotateFailure,
  describeFailure,
  formatFailureDiagnostic,
  getExistingSessionLogPath,
  toFailureError,
  type FailureContext,
} from "./failure-diagnostic.js";

export async function failCard(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  workflowError: unknown,
  card?: TrelloCard,
): Promise<never> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId,
  });

  const originalError = toFailureError(workflowError);
  const failureDescription = describeFailure(originalError);
  const sessionLogPath = getExistingSessionLogPath(project.id, cardId);
  const failureContext: FailureContext = {
    projectId: project.id,
    cardId,
    ...(sessionLogPath === undefined ? {} : { sessionLogPath }),
  };

  annotateFailure(originalError, failureContext, failureDescription);

  cardLog.error(
    `${formatFailureDiagnostic(originalError, failureContext)}; attempting to move card to Failed`,
  );

  try {
    await trello.moveCard(cardId, project.trello.failedListId);
  } catch (failureMoveError) {
    const moveError = toFailureError(failureMoveError);
    const aggregateError = new AggregateError(
      [originalError, moveError],
      `Workflow failed: ${originalError.message}; additionally failed to move card to Failed: ${moveError.message}`,
      {
        cause: failureMoveError,
      },
    );

    annotateFailure(
      aggregateError,
      {
        ...failureContext,
        handlingOutcome: `could not move card to Failed: ${moveError.message}`,
      },
      {
        category: failureDescription.category,
        reason: aggregateError.message,
      },
    );

    cardLog.error(
      `Failure handling failed: could not move card to Failed: ${moveError.message}; preserving the primary failure and skipping the failure comment`,
    );

    throw aggregateError;
  }

  if (card !== undefined && hasWorkflowOwnershipMarker(card)) {
    try {
      await trello.clearWorkflowOwnership(
        cardId,
        project.trello.ownershipCustomFieldId,
      );
    } catch (ownershipError) {
      const clearError = toFailureError(ownershipError);

      try {
        await trello.moveCard(cardId, card.idList);
      } catch (rollbackError) {
        const restoreError = toFailureError(rollbackError);

        const aggregateError = new AggregateError(
          [originalError, clearError, restoreError],
          `Workflow failed: ${originalError.message}; additionally failed to clear Trello ownership after moving card to Failed: ${clearError.message}; additionally failed to restore card to its original list: ${restoreError.message}`,
          { cause: rollbackError },
        );

        annotateFailure(
          aggregateError,
          {
            ...failureContext,
            handlingOutcome: `card moved to Failed, ownership could not be cleared, and card could not be restored to its original list: ${restoreError.message}`,
          },
          {
            category: failureDescription.category,
            reason: aggregateError.message,
          },
        );

        cardLog.error(
          `Failure handling incomplete: card moved to Failed, ownership could not be cleared, and card could not be restored to its original list: ${restoreError.message}; preserving the primary failure`,
        );

        throw aggregateError;
      }

      const aggregateError = new AggregateError(
        [originalError, clearError],
        `Workflow failed: ${originalError.message}; additionally failed to clear Trello ownership after moving card to Failed: ${clearError.message}`,
        { cause: ownershipError },
      );

      annotateFailure(
        aggregateError,
        {
          ...failureContext,
          handlingOutcome: `card restored to ${card.idList} after ownership clearing failed: ${clearError.message}`,
        },
        {
          category: failureDescription.category,
          reason: aggregateError.message,
        },
      );

      cardLog.error(
        `Failure handling incomplete: ownership could not be cleared after moving card to Failed; restored card to ${card.idList}; preserving the primary failure`,
      );

      throw aggregateError;
    }
  }

  annotateFailure(originalError, {
    ...failureContext,
    handlingOutcome: "card moved to Failed",
  });
  cardLog.event(
    "Failure handling: card moved to Failed; adding failure comment",
  );

  try {
    await trello.addComment(
      cardId,
      [
        "Agent Orchestrator failed.",
        "",
        `Category: ${failureDescription.category}`,
        `Reason: ${failureDescription.reason}`,
        "",
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );

    annotateFailure(originalError, {
      ...failureContext,
      handlingOutcome: "card moved to Failed and failure comment added",
    });
    cardLog.event("Failure handling: failure comment added to Trello card");
  } catch (commentError) {
    const commentFailure = toFailureError(commentError);

    annotateFailure(originalError, {
      ...failureContext,
      handlingOutcome: `card moved to Failed, but adding the failure comment failed: ${commentFailure.message}`,
    });
    cardLog.error(
      `Failure handling incomplete: card moved to Failed, but adding the failure comment failed: ${commentFailure.message}; preserving the primary failure`,
    );
  }

  throw originalError;
}
