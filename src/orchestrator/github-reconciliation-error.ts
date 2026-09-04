import { isRetryableGitHubError } from "../github/github-client.js";

import { annotateCardFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";

export const MAX_GITHUB_RECONCILIATION_ATTEMPTS = 3;

export type GitHubReconciliationOperation =
  | "pull request"
  | "pull request state"
  | "requested changes"
  | "maintenance state";

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
  ) {
    super("Git/GitHub", message, { cause });

    this.name = "RetryableGitHubReconciliationError";
    this.operation = operation;
    this.projectId = projectId;
    this.cardId = cardId;
  }
}

export function githubReconciliationError(
  projectId: string,
  cardId: string,
  operation: GitHubReconciliationOperation,
  error: unknown,
  terminalMessage: string,
): WorkflowError {
  const reconciliationError = isRetryableGitHubError(error)
    ? new RetryableGitHubReconciliationError(
        projectId,
        cardId,
        operation,
        error,
        terminalMessage,
      )
    : new WorkflowError("Git/GitHub", terminalMessage, { cause: error });

  annotateCardFailure(reconciliationError, projectId, cardId);
  return reconciliationError;
}
