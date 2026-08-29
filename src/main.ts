import "dotenv/config";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";
import { GitClient } from "./git/git-client.js";
import { GitHubClient } from "./github/github-client.js";
import { logger } from "./logging/logger.js";
import { OpenCodeClient } from "./opencode/opencode-client.js";
import { CommandRunner } from "./process/command-runner.js";
import { runStartup } from "./startup/run-startup.js";
import { TrelloClient } from "./trello/trello-client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const environment = parseEnvironment(process.env);
  const shutdownController = new AbortController();

  function handleShutdown(signal: NodeJS.Signals): void {
    if (shutdownController.signal.aborted) {
      return;
    }

    console.log("");
    logger.event(`Received ${signal}; shutting down...`);

    shutdownController.abort();
  }

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);

  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
    signal: shutdownController.signal,
    timeoutMilliseconds: 30_000,
  });

  const git = new GitClient();

  const github = new GitHubClient();

  const opencode = new OpenCodeClient();

  const commands = new CommandRunner();

  logger.event("Agent Orchestrator");
  logger.event(`Projects: ${config.projects.length}`);

  for (const project of config.projects) {
    console.log("");

    const projectLog = logger.child({
      projectId: project.id,
    });

    projectLog.event(`Project: ${project.id}`);
    projectLog.info(`Repository: ${project.repository.github}`);
    projectLog.info(`Branch: ${project.repository.defaultBranch}`);
    projectLog.info(`Trello board ID: ${project.trello.boardId}`);
    projectLog.info(
      `Implementation: ${project.opencode.implementation.model} (${project.opencode.implementation.variant})`,
    );
    projectLog.info(
      `Review: ${project.opencode.review.model} (${project.opencode.review.variant})`,
    );
    projectLog.info(
      `Remediation: ${project.opencode.remediation.model} (${project.opencode.remediation.variant})`,
    );
    projectLog.info(
      `Commit: ${project.opencode.commit.model} (${project.opencode.commit.variant})`,
    );
    projectLog.info(
      `OpenCode timeout: ${project.opencode.timeoutMinutes} minutes`,
    );
  }

  await runStartup(
    config,
    {
      trello,
      git,
      github,
      opencode,
      commands,
    },
    shutdownController.signal,
  );

  logger.event("Agent Orchestrator stopped");
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
