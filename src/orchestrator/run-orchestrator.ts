import type { Config } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { pollProject } from "./poll-project.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function runOrchestrator(
  trello: TrelloClient,
  git: GitClient,
  config: Config,
): Promise<void> {
  const pollIntervalMilliseconds = config.workflow.pollIntervalSeconds * 1000;

  console.log("");
  console.log(
    `Polling every ${config.workflow.pollIntervalSeconds} seconds...`,
  );

  while (true) {
    for (const project of config.projects) {
      try {
        await pollProject(trello, git, project);
      } catch (error) {
        console.error(
          `[${project.id}] ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await sleep(pollIntervalMilliseconds);
  }
}
