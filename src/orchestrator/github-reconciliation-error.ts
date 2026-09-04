import { isRetryableGitHubError } from "../github/github-client.js";

import { annotateCardFailure, annotateFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

export const MAX_GITHUB_RECONCILIATION_ATTEMPTS = 3;

export interface GitHubReconciliationErrorOptions {
  reconciliationListId?: string;
}

export type GitHubReconciliationOperation =
  | "pull request"
  | "pull request state"
  | "requested changes"
  | "maintenance state"
  | "prepared conflict handoff";

export class RetryableGitHubReconciliationError extends WorkflowError {
  readonly operation: GitHubReconciliationOperation;
  readonly projectId: string;
  readonly cardId: string;

  constructor(
    projectId: string,
    cardId: string,
    operation: GitHubReconciliationOperation,
    cause: unknown,
    message: string,
    options: GitHubReconciliationErrorOptions = {},
  ) {
    super("Git/GitHub", message, { cause });

    this.name = "RetryableGitHubReconciliationError";
    this.operation = operation;
    this.projectId = projectId;
    this.cardId = cardId;
    this.reconciliationListId = options.reconciliationListId;
  }

  readonly reconciliationListId: string | undefined;
}

export function githubReconciliationError(
  projectId: string,
  cardId: string,
  operation: GitHubReconciliationOperation,
  error: unknown,
  terminalMessage: string,
  options: GitHubReconciliationErrorOptions = {},
): WorkflowError {
  const reconciliationError = isRetryableGitHubError(error)
    ? new RetryableGitHubReconciliationError(
        projectId,
        cardId,
        operation,
        error,
        terminalMessage,
        options,
      )
    : new WorkflowError("Git/GitHub", terminalMessage, { cause: error });

  annotateCardFailure(reconciliationError, projectId, cardId);
  if (options.reconciliationListId !== undefined) {
    annotateFailure(reconciliationError, {
      projectId,
      cardId,
      reconciliationListId: options.reconciliationListId,
    });
  }
  return reconciliationError;
}
