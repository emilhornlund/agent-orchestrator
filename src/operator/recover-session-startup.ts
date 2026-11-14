import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/config.js";
import { parseEnvironment } from "../config/environment.js";
import { GitClient } from "../git/git-client.js";
import { GitHubClient } from "../github/github-client.js";
import {
  inspectUnboundOpenCodeSessions,
  inspectPrimaryOpenCodeSession,
} from "../opencode/inspect-primary-session.js";
import { CommandRunner } from "../process/command-runner.js";
import { configureProcessRuntime } from "../process/process-runtime.js";
import { configureLoggerRuntime } from "../logging/logger.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { runTaskResources } from "../task-session/task-resources.js";
import { TrelloClient } from "../trello/trello-client.js";
import { acquireProjectRunOperatorContext } from "./project-run-operator-context.js";
import { hasPendingSessionCreation } from "../task-session/reconcile-session-creation.js";
import { recordStartupStopAttestation } from "../task-session/startup-stop-attestation.js";

/** Explicit recovery for older startup failures without stopped-process evidence.
 * The operator attests termination; absence of a PID is never used as proof. */
export async function recoverSessionStartup(args: readonly string[]): Promise<void> {
  if (
    (args.length !== 5 && args.length !== 7) ||
    args[0] !== "--project" ||
    args[2] !== "--card" ||
    args[4] !== "--confirm-stopped" ||
    (args.length === 7 &&
      (args[5] !== "--session" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(args[6] ?? "")))
  )
    throw new Error("Usage: yarn recover:session-startup --project ID --card ID --confirm-stopped");
  const config = loadConfig();
  const sessionId = args[6];
  const configured = config.projects.find((project) => project.id === args[1]);
  if (!configured) throw new Error("Unknown project");
  const project = { ...configured, contextRoot: config.workflow.contextRoot };
  const environment = parseEnvironment(process.env);
  const signal = new AbortController().signal;
  configureLoggerRuntime(config.workflow.contextRoot);
  configureProcessRuntime({
    runtimeRoot: config.workflow.contextRoot,
    signal,
    secretValues: [environment.TRELLO_API_KEY, environment.TRELLO_TOKEN],
  });
  const context = await acquireProjectRunOperatorContext(config, configured);
  try {
    await context.run(async () => {
      const run = context.authority.store.read();
      const store = new TaskExecutionStore(config.workflow.contextRoot, project);
      const task = store.read(args[3]!);
      if (
        !run ||
        run.cardId !== args[3] ||
        run.lifecycle !== "waiting" ||
        run.checkpoint !== "planning" ||
        run.publicationState !== "none" ||
        run.pendingOperations.some((operation) => operation.status !== "completed") ||
        !task ||
        !hasPendingSessionCreation(task) ||
        task.primarySessionId ||
        task.terminalFailure ||
        task.pullRequest ||
        task.planningAdvice ||
        Object.keys(task.primaryOperations ?? {}).length > 0
      )
        throw new Error("Attempt is not an isolated, unpublished initial-session startup blockage");
      const resources = runTaskResources(run);
      if (task.expectedBranch !== resources.branch)
        throw new Error("Task branch identity differs from the canonical attempt");
      const git = new GitClient();
      const github = new GitHubClient();
      const trello = new TrelloClient({
        apiKey: environment.TRELLO_API_KEY,
        token: environment.TRELLO_TOKEN,
        signal,
        timeoutMilliseconds: 30_000,
      });
      const card = await trello.getCard(run.cardId);
      if (
        card.idList !== project.trello.workingListId ||
        (await git.getCurrentBranch(resources.path)) !== resources.branch ||
        (await git.getStatus(resources.path)).trim() !== "" ||
        (await git.getCommitCountBetween(
          resources.path,
          `origin/${project.repository.defaultBranch}`,
          await git.getHeadSha(resources.path),
        )) !== 0 ||
        (await git.getRebaseState(resources.path)) !== null ||
        (await github.findPullRequestState({
          cwd: resources.path,
          repository: project.repository.github,
          headBranch: resources.branch,
          baseBranch: project.repository.defaultBranch,
          project,
        })) !== null
      )
        throw new Error(
          "Startup recovery requires verified Working membership, clean unchanged owned branch and no PR",
        );
      const inspection = {
        commands: new CommandRunner(),
        cwd: resources.path,
        signal,
        timeoutMilliseconds: 30_000,
      };
      if (sessionId === undefined) {
        if ((await inspectUnboundOpenCodeSessions(inspection)) !== "absent")
          throw new Error("An unbound session may exist; refusing duplicate creation");
      } else {
        if ((await inspectPrimaryOpenCodeSession({ ...inspection, sessionId })) !== "reachable")
          throw new Error(
            "Operator-confirmed stopped session binding requires exact worktree session identity",
          );
      }
      context.lease.assertHeld();
      recordStartupStopAttestation({
        authority: context.authority,
        task,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      store.compareAndSwap(task.cardId, task.revision, {
        ...task,
        phase: "planning",
        sessionCreationStatus: sessionId === undefined ? undefined : "bound",
        recoveryWait: undefined,
        ...(sessionId === undefined ? {} : { primarySessionId: sessionId }),
        revision: task.revision + 1,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString(),
      });
      process.stdout.write(
        `Operator-confirmed stopped startup recovered for ${task.cardId}; existing worktree and setup preserved.\n`,
      );
    });
  } finally {
    await context.release();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  recoverSessionStartup(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
