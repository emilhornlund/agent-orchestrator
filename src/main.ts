import "dotenv/config";

import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";
import { GitClient } from "./git/git-client.js";
import { GitHubClient } from "./github/github-client.js";
import { GitHubCredentialProvider } from "./github/github-credential-provider.js";
import { logger, shouldWriteConsole } from "./logging/logger.js";
import { createEmailNotifier } from "./notifications/email-notifier.js";
import { OpenCodeClient } from "./opencode/opencode-client.js";
import { CommandRunner } from "./process/command-runner.js";
import {
  installProcessHandlers,
  type ProcessEventSource,
  RuntimeLifecycle,
} from "./runtime/runtime-lifecycle.js";
import { runStartup } from "./startup/run-startup.js";
import { TrelloClient } from "./trello/trello-client.js";

function addConfiguredSecretValues(
  lifecycle: RuntimeLifecycle,
  config: ReturnType<typeof loadConfig>,
  environment: ReturnType<typeof parseEnvironment>,
): void {
  const smtp = config.notifications?.email?.smtp;

  lifecycle.addSecretValues([
    environment.TRELLO_API_KEY,
    environment.TRELLO_TOKEN,
    ...(smtp === undefined
      ? []
      : [process.env[smtp.usernameEnv], process.env[smtp.passwordEnv]]),
  ]);
}

export async function main(
  lifecycle: RuntimeLifecycle = new RuntimeLifecycle(),
): Promise<void> {
  const config = loadConfig();
  const environment = parseEnvironment(process.env);
  addConfiguredSecretValues(lifecycle, config, environment);

  const emailNotifier = createEmailNotifier(
    config.notifications?.email,
    process.env,
    lifecycle.signal,
  );

  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
    signal: lifecycle.signal,
    timeoutMilliseconds: 30_000,
  });

  const githubCredentials = new GitHubCredentialProvider();
  const git = new GitClient(undefined, githubCredentials);
  const github = new GitHubClient(undefined, githubCredentials);

  const opencode = new OpenCodeClient();

  const commands = new CommandRunner();

  logger.event("Agent Orchestrator");
  logger.event(`Projects: ${config.projects.length}`);

  for (const project of config.projects) {
    if (shouldWriteConsole()) {
      console.log("");
    }

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
      githubCredentials,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
    },
    lifecycle.signal,
  );

  if (lifecycle.fatalFailure === undefined) {
    logger.event("Agent Orchestrator stopped");
  }
}

export async function bootstrap(
  lifecycle: RuntimeLifecycle = new RuntimeLifecycle(),
  processObject: ProcessEventSource = process,
): Promise<number> {
  const removeProcessHandlers = installProcessHandlers(
    lifecycle,
    processObject,
  );

  try {
    await main(lifecycle);
  } catch (error) {
    lifecycle.requestFatal("startup failure", error);
  } finally {
    removeProcessHandlers();
  }

  return lifecycle.exitCode;
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];

  return (
    entrypoint !== undefined &&
    pathToFileURL(path.resolve(entrypoint)).href === import.meta.url
  );
}

if (isEntrypoint()) {
  const lifecycle = new RuntimeLifecycle();

  void bootstrap(lifecycle).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      lifecycle.requestFatal("startup failure", error);
      process.exitCode = lifecycle.exitCode;
    },
  );
}
