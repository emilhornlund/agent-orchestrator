import {
  getTrelloRequestOperation,
  isRetryableTrelloError,
  type TrelloRequestOperation,
} from "../trello/trello-client.js";

import { annotateFailure, annotateCardFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

export const MAX_TRELLO_RECONCILIATION_ATTEMPTS = 3;

export interface TrelloReconciliationErrorOptions {
  reconciliationListId?: string;
}

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
    options: TrelloReconciliationErrorOptions = {},
  ) {
    super("Workflow", message, { cause });
    this.name = "RetryableTrelloReconciliationError";
    this.projectId = projectId;
    this.cardId = cardId;
    this.operation = operation;
    this.reconciliationListId = options.reconciliationListId;
  }

  readonly reconciliationListId: string | undefined;
}

export function trelloReconciliationError(
  projectId: string,
  cardId: string | undefined,
  fallbackOperation: TrelloRequestOperation,
  error: unknown,
  message: string,
  options: TrelloReconciliationErrorOptions = {},
): Error {
  const operation = getTrelloRequestOperation(error) ?? fallbackOperation;
  const reconciliationError = isRetryableTrelloError(error)
    ? new RetryableTrelloReconciliationError(
        projectId,
        cardId,
        operation,
        error,
        message,
        options,
      )
    : new WorkflowError("Workflow", message, { cause: error });

  if (cardId === undefined) {
    annotateFailure(reconciliationError, { projectId });
  } else {
    annotateCardFailure(reconciliationError, projectId, cardId);
  }

  if (options.reconciliationListId !== undefined) {
    annotateFailure(reconciliationError, {
      projectId,
      ...(cardId === undefined ? {} : { cardId }),
      reconciliationListId: options.reconciliationListId,
    });
  }

  return reconciliationError;
}
