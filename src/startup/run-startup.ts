import type { Config } from "../config/config.js";
import { ensureRepository } from "../git/ensure-repository.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { GitHubCredentialProvider } from "../github/github-credential-provider.js";
import { withGitHubOperationProject } from "../github/github-operation-context.js";
import { cleanupCardContextRetention } from "../context/card-context-retention.js";
import { cleanupLogRetention } from "../logging/log-retention.js";
import { logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  getTrelloRequestOperation,
  isRetryableTrelloError,
  type TrelloClient,
} from "../trello/trello-client.js";
import { validateProjectTrello } from "../trello/validate-project-trello.js";

import { runOrchestrator } from "../orchestrator/run-orchestrator.js";

type DeferredTrelloValidation = (
  trello: TrelloClient,
  project: Config["projects"][number],
) => Promise<void>;

export interface StartupDependencies {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  opencode: OpenCodeClient;
  commands: CommandRunner;
  githubCredentials?: GitHubCredentialProvider;
  emailNotifier?: EmailNotifier;
}

export interface StartupOperations {
  validateGitHubCli: (
    github: GitHubClient,
    projects: Config["projects"],
  ) => Promise<void>;
  validateProjectTrello: typeof validateProjectTrello;
  runOrchestrator: typeof runOrchestrator;
}

const defaultStartupOperations: StartupOperations = {
  validateGitHubCli: (github, projects) =>
    github.validateCliCompatibility(projects),
  validateProjectTrello,
  runOrchestrator,
};

export async function runStartup(
  config: Config,
  dependencies: StartupDependencies,
  signal: AbortSignal,
  operations: StartupOperations = defaultStartupOperations,
): Promise<void> {
  cleanupLogRetention(config.workflow.logRetentionDays);
  cleanupCardContextRetention(
    config.workflow.contextRoot,
    config.workflow.contextRetentionDays,
    new Date(),
    config.projects.map((project) => project.id),
  );

  const githubCredentials =
    dependencies.githubCredentials ?? new GitHubCredentialProvider();

  await operations.validateGitHubCli(dependencies.github, config.projects);

  for (const project of config.projects) {
    if (signal.aborted) {
      return;
    }

    await withGitHubOperationProject(project, () =>
      ensureRepository(
        dependencies.git,
        dependencies.commands,
        project,
        githubCredentials,
      ),
    );
  }

  const pendingTrelloValidations = new Set<string>();

  for (const project of config.projects) {
    if (signal.aborted) {
      return;
    }

    try {
      await operations.validateProjectTrello(dependencies.trello, project);
    } catch (error) {
      if (!isRetryableTrelloError(error)) {
        throw error;
      }

      pendingTrelloValidations.add(project.id);

      logger
        .child({ projectId: project.id })
        .warn(
          `Startup Trello validation temporarily failed for ${getTrelloRequestOperation(error) ?? "project configuration"}; polling will retry it: ${error instanceof Error ? error.message : String(error)}`,
        );

      continue;
    }

    logger.child({ projectId: project.id }).event("Trello configuration: OK");
  }

  if (signal.aborted) {
    return;
  }

  const deferredTrelloValidation: DeferredTrelloValidation | undefined =
    pendingTrelloValidations.size === 0
      ? undefined
      : async (trello, project) => {
          if (!pendingTrelloValidations.has(project.id)) {
            return;
          }

          await operations.validateProjectTrello(trello, project);
          pendingTrelloValidations.delete(project.id);
          logger
            .child({ projectId: project.id })
            .event("Trello configuration: OK");
        };

  if (dependencies.emailNotifier === undefined) {
    if (deferredTrelloValidation === undefined) {
      await operations.runOrchestrator(
        dependencies.trello,
        dependencies.git,
        dependencies.github,
        dependencies.opencode,
        dependencies.commands,
        config,
        signal,
      );
    } else {
      await operations.runOrchestrator(
        dependencies.trello,
        dependencies.git,
        dependencies.github,
        dependencies.opencode,
        dependencies.commands,
        config,
        signal,
        undefined,
        deferredTrelloValidation,
      );
    }
  } else {
    if (deferredTrelloValidation === undefined) {
      await operations.runOrchestrator(
        dependencies.trello,
        dependencies.git,
        dependencies.github,
        dependencies.opencode,
        dependencies.commands,
        config,
        signal,
        dependencies.emailNotifier,
      );
    } else {
      await operations.runOrchestrator(
        dependencies.trello,
        dependencies.git,
        dependencies.github,
        dependencies.opencode,
        dependencies.commands,
        config,
        signal,
        dependencies.emailNotifier,
        deferredTrelloValidation,
      );
    }
  }
}
