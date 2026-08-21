import "dotenv/config";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";
import { runOrchestrator } from "./orchestrator/run-orchestrator.js";
import { TrelloClient } from "./trello/trello-client.js";
import { validateProjectTrello } from "./trello/validate-project-trello.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const environment = parseEnvironment(process.env);

  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
  });

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

  await runOrchestrator(trello, config);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
