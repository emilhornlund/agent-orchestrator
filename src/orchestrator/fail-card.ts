import type { ProjectConfig } from "../config/config.js";
import type { TrelloClient } from "../trello/trello-client.js";

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

  throw originalError;
}
