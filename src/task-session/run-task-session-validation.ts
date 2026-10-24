import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  CommandTimeoutError,
} from "../process/command-runner.js";
import type { CommandRunOptions } from "../process/command-runner.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";

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
}

export interface RunTaskSessionValidationOptions {
  project: ProjectConfig;
  cardId: string;
  expectedBranch: string;
  operationKey: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  git: Pick<GitClient, "getCurrentBranch">;
  commands: CommandRunner;
  signal: AbortSignal;
  timeoutMilliseconds: number;
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
    sessionLabel: "Task-session repository validation",
    ...(options.sessionLogPath === undefined
      ? {}
      : { sessionLogPath: options.sessionLogPath }),
  };
}

export async function runTaskSessionValidation(
  options: RunTaskSessionValidationOptions,
): Promise<TaskSessionValidationResult> {
  const { project, cardId, expectedBranch, operationKey, worktreePath } =
    options;

  if (project.executionMode !== "task-session") {
    throw new Error("Task-session validation requires task-session mode");
  }

  const command = project.repository.validationCommand;

  if (command === undefined || command.trim().length === 0) {
    throw new Error(
      "Task-session validation requires a nonempty repository.validationCommand",
    );
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

  if (record.phase !== "validation") {
    throw new Error(
      `Task-session validation requires the validation phase, found ${record.phase}`,
    );
  }

  const actualBranch = await options.git.getCurrentBranch(worktreePath);

  if (actualBranch !== expectedBranch) {
    throw new Error(
      `Task-session validation branch mismatch for ${project.id}/${cardId}: expected ${expectedBranch}, found ${actualBranch}`,
    );
  }

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
    };
  }
}
