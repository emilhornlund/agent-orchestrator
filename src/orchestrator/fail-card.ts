import type { ProjectConfig } from "../config/config.js";
import { OpenCodeTimeoutError } from "../opencode/opencode-client.js";
import type { TrelloClient } from "../trello/trello-client.js";

function describeFailureCategory(error: Error): string {
  if (error instanceof OpenCodeTimeoutError) {
    return "OpenCode timeout";
  }

  if (error.message.startsWith("OpenCode ")) {
    return "OpenCode";
  }

  if (error.message.startsWith("Repository validation")) {
    return "Validation";
  }

  if (
    error.message.includes("GitHub") ||
    error.message.includes("pull request") ||
    error.message.includes("push")
  ) {
    return "Git/GitHub";
  }

  return "Workflow";
}

export async function failCard(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  workflowError: unknown,
): Promise<never> {
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
    console.error(
      `[${project.id}] Failed to add failure reason to Trello card: ${
        commentError instanceof Error
          ? commentError.message
          : String(commentError)
      }`,
    );
  }

  throw originalError;
}
