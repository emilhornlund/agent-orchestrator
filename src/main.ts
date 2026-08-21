import "dotenv/config";

import { loadConfig } from "./config/config.js";
import { parseEnvironment } from "./config/environment.js";

function main(): void {
  const config = loadConfig();
  parseEnvironment(process.env);

  console.log("Agent Orchestrator");
  console.log(`Repository: ${config.repository.github}`);
  console.log(`Branch: ${config.repository.defaultBranch}`);
  console.log(`Model: ${config.opencode.model}`);
  console.log(`Variant: ${config.opencode.variant}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
