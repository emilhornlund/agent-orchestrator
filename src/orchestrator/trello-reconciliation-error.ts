import {
  getTrelloRequestOperation,
  isRetryableTrelloError,
  type TrelloRequestOperation,
} from "../trello/trello-client.js";

import { annotateFailure, annotateCardFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

export const MAX_TRELLO_RECONCILIATION_ATTEMPTS = 3;

export class RetryableTrelloReconciliationError extends WorkflowError {
  readonly operation: TrelloRequestOperation;
  readonly projectId: string;
  readonly cardId: string | undefined;

  constructor(
    projectId: string,
    cardId: string | undefined,
    operation: TrelloRequestOperation,
    cause: unknown,
    message: string,
  ) {
    super("Workflow", message, { cause });
    this.name = "RetryableTrelloReconciliationError";
    this.projectId = projectId;
    this.cardId = cardId;
    this.operation = operation;
  }
}

export function trelloReconciliationError(
  projectId: string,
  cardId: string | undefined,
  fallbackOperation: TrelloRequestOperation,
  error: unknown,
  message: string,
): Error {
  const operation = getTrelloRequestOperation(error) ?? fallbackOperation;
  const reconciliationError = isRetryableTrelloError(error)
    ? new RetryableTrelloReconciliationError(
        projectId,
        cardId,
        operation,
        error,
        message,
      )
    : new WorkflowError("Workflow", message, { cause: error });

  if (cardId === undefined) {
    annotateFailure(reconciliationError, { projectId });
  } else {
    annotateCardFailure(reconciliationError, projectId, cardId);
  }

  return reconciliationError;
}
