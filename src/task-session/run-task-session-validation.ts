import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  CommandTimeoutError,
} from "../process/command-runner.js";
import type { CommandRunOptions } from "../process/command-runner.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { getSessionLogPath } from "../logging/session-log.js";

export type TaskSessionValidationStatus =
  "passed" | "failed" | "timed-out" | "aborted";

export interface TaskSessionValidationResult {
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  status: TaskSessionValidationStatus;
  timedOut: boolean;
  aborted: boolean;
  diagnostic: string;
  contentIdentity: string;
}

export interface RunTaskSessionValidationOptions {
  project: ProjectConfig;
  cardId: string;
  expectedBranch: string;
  operationKey: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  git: Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
  >;
  commands: CommandRunner;
  signal: AbortSignal;
  timeoutMilliseconds: number;
  /** Only for a verified, failed requested-changes review checkpoint. */
  feedbackReviewRecovery?: boolean;
  commandOverride?: string;
  commandLabel?: string;
  secretValues?: readonly string[];
  sessionLogPath?: string;
}

function buildCommandOptions(
  options: RunTaskSessionValidationOptions,
  command: string,
): CommandRunOptions {
  return {
    cwd: options.worktreePath,
    command,
    signal: options.signal,
    timeoutMilliseconds: options.timeoutMilliseconds,
    captureOutput: true,
    ...(options.secretValues === undefined
      ? {}
      : { secretValues: options.secretValues }),
    sessionLabel: options.commandLabel ?? "Task-session repository validation",
    sessionLogPath:
      options.sessionLogPath ??
      getSessionLogPath(options.project.id, options.cardId),
  };
}

export async function runTaskSessionValidation(
  options: RunTaskSessionValidationOptions,
): Promise<TaskSessionValidationResult> {
  const { project, cardId, expectedBranch, operationKey, worktreePath } =
    options;

  const validationCommand = project.repository.validationCommand;

  if (
    validationCommand === undefined ||
    validationCommand.trim().length === 0
  ) {
    throw new Error(
      "Task-session validation requires a nonempty repository.validationCommand",
    );
  }

  const command = options.commandOverride ?? validationCommand;

  if (command.trim().length === 0) {
    throw new Error("Task-session command must not be blank");
  }

  if (
    !Number.isSafeInteger(options.timeoutMilliseconds) ||
    options.timeoutMilliseconds < 1
  ) {
    throw new Error("Task-session validation timeout must be positive");
  }

  assertOwnedTaskWorktreePath(project, worktreePath);
  const record = loadOwnedTaskExecutionRecord(options.taskRecordStore, {
    projectId: project.id,
    cardId,
    expectedBranch,
    operationKey,
  });

  if (
    record.phase !== "validation" &&
    record.phase !== "publication" &&
    !(
      options.feedbackReviewRecovery === true &&
      record.phase === "review" &&
      record.reviewRepair?.status === "exhausted" &&
      record.feedbackRemediation?.status === "changed"
    )
  ) {
    throw new Error(
      `Task-session validation requires validation or publication preparation, found ${record.phase}`,
    );
  }

  const actualBranch = await options.git.getCurrentBranch(worktreePath);

  if (actualBranch !== expectedBranch) {
    throw new Error(
      `Task-session validation branch mismatch for ${project.id}/${cardId}: expected ${expectedBranch}, found ${actualBranch}`,
    );
  }

  const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    worktreePath,
  );
  const startedAt = new Date().toISOString();

  try {
    const result = await options.commands.run(
      buildCommandOptions(options, command),
    );
    const diagnostic = presentExternalDiagnostic(
      [result.output, result.errorOutput].filter(Boolean).join("\n"),
      options.secretValues,
    );
    const passed = result.exitCode === 0;

    return {
      command,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      status: passed ? "passed" : "failed",
      timedOut: false,
      aborted: false,
      diagnostic,
      contentIdentity,
    };
  } catch (error) {
    const timedOut = error instanceof CommandTimeoutError;
    const aborted = error instanceof CommandRunAbortedError;

    return {
      command,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: null,
      status: timedOut ? "timed-out" : aborted ? "aborted" : "failed",
      timedOut,
      aborted,
      diagnostic: presentExternalDiagnostic(
        error instanceof Error ? error.message : String(error),
        options.secretValues,
      ),
      contentIdentity,
    };
  }
}
