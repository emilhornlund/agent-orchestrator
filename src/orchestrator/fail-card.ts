import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { OpenCodeTimeoutError } from "../opencode/opencode-client.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { WorkflowError } from "./workflow-error.js";

function describeFailureCategory(error: Error): string {
  if (error instanceof OpenCodeTimeoutError) {
    return "OpenCode timeout";
  }

  if (error instanceof WorkflowError) {
    return error.category;
  }

  return "Workflow";
}

export async function failCard(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  workflowError: unknown,
): Promise<never> {
  const cardLog = logger.child({
    projectId: project.id,
    cardId,
  });

  const originalError =
    workflowError instanceof Error
      ? workflowError
      : new Error(String(workflowError));

  try {
    await trello.moveCard(cardId, project.trello.failedListId);
  } catch (failureMoveError) {
    const moveError =
      failureMoveError instanceof Error
        ? failureMoveError
        : new Error(String(failureMoveError));

    throw new AggregateError(
      [originalError, moveError],
      `Workflow failed: ${originalError.message}; additionally failed to move card to Failed: ${moveError.message}`,
      {
        cause: failureMoveError,
      },
    );
  }

  try {
    await trello.addComment(
      cardId,
      [
        "Agent Orchestrator failed.",
        "",
        `Category: ${describeFailureCategory(originalError)}`,
        `Reason: ${originalError.message}`,
      ].join("\n"),
    );
  } catch (commentError) {
    cardLog.error(
      `Failed to add failure reason to Trello card: ${
        commentError instanceof Error
          ? commentError.message
          : String(commentError)
      }`,
    );
  }

  throw originalError;
}
