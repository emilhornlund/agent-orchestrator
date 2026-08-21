import "dotenv/config";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";

function main(): void {
  const config = loadConfig();
  parseEnvironment(process.env);

  console.log("Agent Orchestrator");
  console.log(`Projects: ${config.projects.length}`);

  for (const project of config.projects) {
    console.log("");
    console.log(`Project: ${project.id}`);
    console.log(`Repository: ${project.repository.github}`);
    console.log(`Branch: ${project.repository.defaultBranch}`);
    console.log(`Trello board: ${project.trello.boardId}`);
    console.log(`Model: ${project.opencode.model}`);
    console.log(`Variant: ${project.opencode.variant}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
