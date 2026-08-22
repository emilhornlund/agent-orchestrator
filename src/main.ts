import "dotenv/config";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";
import { GitClient } from "./git/git-client.js";
import { GitHubClient } from "./github/github-client.js";
import { OpenCodeClient } from "./opencode/opencode-client.js";
import { runOrchestrator } from "./orchestrator/run-orchestrator.js";
import { CommandRunner } from "./process/command-runner.js";
import { TrelloClient } from "./trello/trello-client.js";
import { validateProjectTrello } from "./trello/validate-project-trello.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const environment = parseEnvironment(process.env);
  const shutdownController = new AbortController();

  function handleShutdown(signal: NodeJS.Signals): void {
    if (shutdownController.signal.aborted) {
      return;
    }

    console.log("");
    console.log(`Received ${signal}; shutting down...`);

    shutdownController.abort();
  }

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);

  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
  });

  const git = new GitClient();

  const github = new GitHubClient();

  const opencode = new OpenCodeClient();

  const commands = new CommandRunner();

  console.log("Agent Orchestrator");
  console.log(`Projects: ${config.projects.length}`);

  for (const project of config.projects) {
    console.log("");
    console.log(`Project: ${project.id}`);
    console.log(`Repository: ${project.repository.github}`);
    console.log(`Branch: ${project.repository.defaultBranch}`);
    console.log(`Trello board ID: ${project.trello.boardId}`);
    console.log(`Model: ${project.opencode.model}`);
    console.log(`Variant: ${project.opencode.variant}`);

    await validateProjectTrello(trello, project);

    console.log("Trello configuration: OK");
  }

  await runOrchestrator(
    trello,
    git,
    github,
    opencode,
    commands,
    config,
    shutdownController.signal,
  );

  console.log("Agent Orchestrator stopped");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
