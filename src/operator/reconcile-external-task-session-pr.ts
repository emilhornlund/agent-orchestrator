import "dotenv/config";

import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/config.js";
import { parseEnvironment } from "../config/environment.js";
import { GitClient } from "../git/git-client.js";
import { GitHubClient } from "../github/github-client.js";
import { GitHubCredentialProvider } from "../github/github-credential-provider.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { TrelloClient } from "../trello/trello-client.js";
import { reconcileExternalTaskSessionPullRequest } from "../orchestrator/reconcile-external-task-session-pr.js";

const usage =
  "Usage: yarn reconcile:external-pr --project ID --card ID --commit SHA --branch BRANCH --pr NUMBER";

function parseArguments(args: readonly string[]): {
  projectId: string;
  cardId: string;
  implementationCommit: string;
  recoveryBranch: string;
  pullRequestNumber: number;
} {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--project", "--card", "--commit", "--branch", "--pr"].includes(key) ||
      parsed.has(key)
    ) {
      throw new Error(usage);
    }
    parsed.set(key, value);
  }
  const projectId = parsed.get("--project");
  const cardId = parsed.get("--card");
  const implementationCommit = parsed.get("--commit");
  const recoveryBranch = parsed.get("--branch");
  const pullRequest = parsed.get("--pr");
  if (
    projectId === undefined ||
    cardId === undefined ||
    implementationCommit === undefined ||
    recoveryBranch === undefined ||
    pullRequest === undefined ||
    !/^\d+$/u.test(pullRequest)
  ) {
    throw new Error(usage);
  }
  const pullRequestNumber = Number(pullRequest);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    throw new Error(usage);
  return {
    projectId,
    cardId,
    implementationCommit,
    recoveryBranch,
    pullRequestNumber,
  };
}

export async function runExternalTaskSessionRecovery(
  args: readonly string[],
): Promise<void> {
  const association = parseArguments(args);
  const config = loadConfig();
  const projectConfig = config.projects.find(
    (project) => project.id === association.projectId,
  );
  if (projectConfig === undefined)
    throw new Error(`Unknown project: ${association.projectId}`);
  const project = {
    ...projectConfig,
    contextRoot: config.workflow.contextRoot,
  };
  const environment = parseEnvironment(process.env);
  const controller = new AbortController();
  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
    signal: controller.signal,
    timeoutMilliseconds: 30_000,
  });
  const githubCredentials = new GitHubCredentialProvider();
  const github = new GitHubClient(undefined, githubCredentials);
  const git = new GitClient(undefined, githubCredentials);
  const taskStore = new TaskExecutionStore(
    config.workflow.contextRoot,
    project,
  );
  const queue = new TaskMutationQueue(config.workflow.contextRoot, project);
  const relevantListIds = [
    project.trello.workingListId,
    project.trello.reviewListId,
    project.trello.failedListId,
    project.trello.doneListId,
  ];

  await reconcileExternalTaskSessionPullRequest({
    project,
    association: { ...association, projectId: project.id },
    github,
    git,
    taskStore,
    queue,
    trello,
    doneListId: project.trello.doneListId,
    readTrelloListId: async () => {
      const lists = await Promise.all(
        relevantListIds.map(async (listId) => ({
          listId,
          cards: await trello.getCards(listId),
        })),
      );
      const locations = lists.flatMap(({ listId, cards }) =>
        cards
          .filter((card) => card.id === association.cardId)
          .map(() => listId),
      );
      if (locations.length !== 1)
        throw new Error(
          `Expected exactly one authoritative Trello location for ${association.cardId}; found ${locations.length}`,
        );
      return locations[0]!;
    },
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runExternalTaskSessionRecovery(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
