import type { Config } from "../config/config.js";
import { ensureRepository } from "../git/ensure-repository.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { cleanupLogRetention } from "../logging/log-retention.js";
import { logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { validateProjectTrello } from "../trello/validate-project-trello.js";

import { runOrchestrator } from "../orchestrator/run-orchestrator.js";

export interface StartupDependencies {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  opencode: OpenCodeClient;
  commands: CommandRunner;
  emailNotifier?: EmailNotifier;
}

export interface StartupOperations {
  validateProjectTrello: typeof validateProjectTrello;
  runOrchestrator: typeof runOrchestrator;
}

const defaultStartupOperations: StartupOperations = {
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

  for (const project of config.projects) {
    await ensureRepository(dependencies.git, dependencies.commands, project);
  }

  for (const project of config.projects) {
    await operations.validateProjectTrello(dependencies.trello, project);

    logger.child({ projectId: project.id }).event("Trello configuration: OK");
  }

  if (dependencies.emailNotifier === undefined) {
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
      dependencies.emailNotifier,
    );
  }
}
