import type { ProjectConfig } from "../config/config.js";
import type {
  GitHubClient,
  PullRequestDescriptionStatusOptions,
} from "../github/github-client.js";
import { type ManagedPullRequestStatus } from "../github/pull-request-status.js";
import { annotateCardFailure } from "./failure-diagnostic.js";
import { WorkflowError } from "./workflow-error.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { Logger } from "../logging/logger.js";

export class PullRequestStatusPresentationError extends WorkflowError {
  constructor(message: string, options?: ErrorOptions) {
    super("Git/GitHub", message, options);
    this.name = "PullRequestStatusPresentationError";
  }
}

export async function updateMaintenanceStatus(
  github: GitHubClient | undefined,
  project: ProjectConfig,
  card: TrelloCard,
  pullRequestUrl: string,
  status: ManagedPullRequestStatus | null,
  phase: string,
  cardLog: Logger,
  bestEffortOptions: { bestEffort?: boolean } = {},
): Promise<void> {
  if (typeof github?.updatePullRequestDescriptionStatus !== "function") {
    return;
  }

  const presentationOptions: PullRequestDescriptionStatusOptions = {
    cwd: project.repository.path,
    repository: project.repository.github,
    pullRequestUrl,
    status,
    project,
  };

  try {
    await github.updatePullRequestDescriptionStatus(presentationOptions);
  } catch (error) {
    const presentationError = new PullRequestStatusPresentationError(
      `Could not update managed status for pull request ${pullRequestUrl} and card "${card.name}" during ${phase}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );

    annotateCardFailure(presentationError, project.id, card.id);
    if (bestEffortOptions.bestEffort !== true) {
      cardLog.error(presentationError.message);
    }

    throw presentationError;
  }
}
