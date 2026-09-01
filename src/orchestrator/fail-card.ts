import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import {
  notifyFailed,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";

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
  emailNotifier?: EmailNotifier,
  card?: Pick<TrelloCard, "name" | "url">,
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
    cardFailureHandled: false,
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

  annotateFailure(originalError, {
    ...failureContext,
    cardFailureHandled: true,
    handlingOutcome: "card moved to Failed",
  });
  cardLog.event(
    "Failure handling: card moved to Failed; adding failure comment",
  );

  if (card !== undefined) {
    await notifyFailed(
      emailNotifier,
      {
        project,
        card: {
          name: card.name,
          url: card.url,
        },
        category: failureDescription.category,
        reason: failureDescription.reason,
      },
      cardLog,
    );
  } else if (emailNotifier !== undefined) {
    cardLog.warn(
      "Failed email notification omitted because the failure handler did not receive card details",
    );
  }

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
      cardFailureHandled: true,
      handlingOutcome: "card moved to Failed and failure comment added",
    });
    cardLog.event("Failure handling: failure comment added to Trello card");
  } catch (commentError) {
    const commentFailure = toFailureError(commentError);

    annotateFailure(originalError, {
      ...failureContext,
      cardFailureHandled: true,
      handlingOutcome: `card moved to Failed, but adding the failure comment failed: ${commentFailure.message}`,
    });
    cardLog.error(
      `Failure handling incomplete: card moved to Failed, but adding the failure comment failed: ${commentFailure.message}; preserving the primary failure`,
    );
  }

  throw originalError;
}
