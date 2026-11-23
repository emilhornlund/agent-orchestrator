import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/config.js";
import { parseEnvironment } from "../config/environment.js";
import { GitClient } from "../git/git-client.js";
import { GitHubClient } from "../github/github-client.js";
import { withGitHubOperationProject } from "../github/github-operation-context.js";
import {
  inspectPublishedFeedbackRecovery,
  restorePublishedFeedbackCheckpoint,
} from "../orchestrator/published-feedback-recovery.js";
import { CommandRunner } from "../process/command-runner.js";
import { configureProcessRuntime } from "../process/process-runtime.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TrelloClient } from "../trello/trello-client.js";
import { acquireProjectRunOperatorContext } from "./project-run-operator-context.js";

export async function recoverPublishedFeedback(args: readonly string[]): Promise<void> {
  if (
    args.length !== 7 ||
    args[0] !== "--project" ||
    args[2] !== "--card" ||
    args[4] !== "--attempt" ||
    !["--inspect", "--resume"].includes(args[6]!)
  )
    throw new Error(
      "Usage: yarn recover:published-feedback --project ID --card ID --attempt ID --inspect|--resume",
    );
  const config = loadConfig();
  const project = config.projects.find((item) => item.id === args[1]);
  if (!project) throw new Error("Unknown project");
  const env = parseEnvironment(process.env);
  const signal = new AbortController().signal;
  const context = await acquireProjectRunOperatorContext(config, project, args[6] === "--inspect");
  configureProcessRuntime({
    runtimeRoot: config.workflow.contextRoot,
    signal,
    secretValues: [env.TRELLO_API_KEY, env.TRELLO_TOKEN],
  });
  try {
    await context.run(() =>
      withGitHubOperationProject(project, async () => {
        if (context.authority.store.attemptId !== args[5] || context.authority.cardId !== args[3])
          throw new Error("Selected card and attempt do not match canonical ownership");
        const store = new TaskExecutionStore(
          context.authority.store.storageRoot,
          project,
          context.authority,
        );
        const task = store.read(args[3]!);
        if (!task) throw new Error("Cannot inspect missing task state");
        const trello = new TrelloClient({
          apiKey: env.TRELLO_API_KEY,
          token: env.TRELLO_TOKEN,
          signal,
          timeoutMilliseconds: 30_000,
        });
        const result = await inspectPublishedFeedbackRecovery({
          project,
          authority: context.authority,
          task,
          card: await trello.getCard(task.cardId),
          git: new GitClient(),
          github: new GitHubClient(),
          commands: new CommandRunner(),
          signal,
        });
        if (args[6] === "--resume") restorePublishedFeedbackCheckpoint(store, task);
        process.stdout.write(
          `${JSON.stringify({ ...result, status: args[6] === "--resume" ? "feedback-checkpoint-restored" : "verified-eligible" })}\n`,
        );
      }),
    );
  } finally {
    await context.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  recoverPublishedFeedback(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${sanitizeControlledText(error instanceof Error ? error.message : "Published feedback recovery refused").slice(0, 2000)}\n`,
    );
    process.exitCode = 1;
  });
