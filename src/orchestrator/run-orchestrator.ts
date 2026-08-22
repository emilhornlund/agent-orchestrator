import type { Config } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { pollProject } from "./poll-project.js";

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);

    function handleAbort(): void {
      clearTimeout(timeout);
      resolve();
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function runOrchestrator(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  config: Config,
  signal: AbortSignal,
): Promise<void> {
  const pollIntervalMilliseconds = config.workflow.pollIntervalSeconds * 1000;

  console.log("");
  console.log(
    `Polling every ${config.workflow.pollIntervalSeconds} seconds...`,
  );

  while (!signal.aborted) {
    for (const project of config.projects) {
      try {
        await pollProject(
          trello,
          git,
          github,
          opencode,
          commands,
          project,
          signal,
        );
      } catch (error) {
        console.error(
          `[${project.id}] ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await sleep(pollIntervalMilliseconds, signal);
  }
}
