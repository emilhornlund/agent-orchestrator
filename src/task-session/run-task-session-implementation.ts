import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import { inspectPrimaryOpenCodeSession } from "../opencode/inspect-primary-session.js";
import {
  OpenCodeRunAbortedError,
  type OpenCodeClient,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import { buildTaskSessionImplementationPrompt } from "../opencode/build-task-session-implementation-prompt.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import {
  transitionTaskExecutionRecord,
  type TaskExecutionEvent,
} from "./task-execution-transition.js";
import { TaskPlanStore } from "./task-plan-store.js";
import {
  PrimarySessionReconstructionRequiredError,
  runWithPrimaryTaskSession,
} from "./primary-task-session.js";
import { buildPrimarySessionContext } from "./build-primary-session-context.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { PrimaryOperationWaitingError } from "./run-primary-operation.js";
import { PrimaryOperationExhaustedError } from "./primary-operation-ledger.js";
import { inspectPrimaryOperationEvidence } from "./inspect-primary-operation.js";
import { getProcessRuntime } from "../process/process-runtime.js";

export type TaskSessionImplementationOutcome = "failed" | "aborted";

export class TaskSessionImplementationError extends Error {
  constructor(
    message: string,
    public readonly outcome: TaskSessionImplementationOutcome,
    public readonly runResult?: OpenCodeRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskSessionImplementationError";
  }
}

export class TaskSessionImplementationWaitingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskSessionImplementationWaitingError";
  }
}

export interface RunTaskSessionImplementationOptions {
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  git: Pick<GitClient, "getCurrentBranch">;
  recoveryGit: Pick<
    GitClient,
    | "getHeadSha"
    | "getDiff"
    | "getStatus"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getHeadTrackedFiles"
  >;
  commands: CommandRunner;
  recoveryContextRoot: string;
  recoveryAttemptId?: string;
  feedbackContent?: string;
  openCode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  expectedBranch: string;
  operationKey: string;
  retryIntervalMs?: number;
  resume?: boolean;
  worktreePath: string;
  attachmentContext?: CardAttachmentPromptContext;
  runOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId"
  >;
}

export interface TaskSessionImplementationResult {
  runResult: OpenCodeRunResult;
  record: TaskExecutionRecord;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertOwnedTaskWorktreePath(
  project: ProjectConfig,
  worktreePath: string,
): void {
  if (!path.isAbsolute(worktreePath)) {
    throw new Error("Task-session worktree path must be absolute");
  }

  const configuredRepository = path.resolve(project.repository.path);
  const configuredWorktreeRoot = path.resolve(project.repository.worktreeRoot);
  const candidateWorktree = path.resolve(worktreePath);

  if (
    !isWithin(configuredWorktreeRoot, candidateWorktree) ||
    path.relative(configuredWorktreeRoot, candidateWorktree) === "" ||
    candidateWorktree === configuredRepository ||
    isWithin(configuredRepository, candidateWorktree)
  ) {
    throw new Error(
      "Task-session implementation requires a worktree below the configured worktree root and outside the source checkout",
    );
  }

  const stat = fs.lstatSync(candidateWorktree);

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Task-session worktree must be a regular directory");
  }

  const realWorktreeRoot = fs.realpathSync(configuredWorktreeRoot);
  const realRepository = fs.realpathSync(configuredRepository);
  const realWorktree = fs.realpathSync(candidateWorktree);

  if (
    !isWithin(realWorktreeRoot, realWorktree) ||
    realWorktree === realRepository ||
    isWithin(realRepository, realWorktree)
  ) {
    throw new Error(
      "Task-session worktree resolves outside its configured owned location",
    );
  }
}

function nextEventTimestamp(record: TaskExecutionRecord): string {
  return new Date(
    Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
  ).toISOString();
}

function createEvent(
  record: TaskExecutionRecord,
  type: TaskExecutionEvent["type"],
  eventId: string,
): TaskExecutionEvent {
  return {
    type,
    eventId,
    projectId: record.projectId,
    cardId: record.cardId,
    operationKey: record.operationKey,
    occurredAt: nextEventTimestamp(record),
  } as TaskExecutionEvent;
}

function persistAttentionRequired(
  store: TaskExecutionStore,
  projectId: string,
  cardId: string,
  operationKey: string,
  eventId: string,
  terminalFailure?: string,
): void {
  const current = store.read(cardId);

  if (
    current === null ||
    current.projectId !== projectId ||
    current.cardId !== cardId ||
    current.operationKey !== operationKey ||
    current.phase !== "implementation"
  ) {
    throw new Error(
      `Task ownership or implementation phase changed while preserving failure for ${projectId}/${cardId}`,
    );
  }

  const nextRecord = transitionTaskExecutionRecord(
    current,
    createEvent(current, "attention-required", eventId),
  );
  store.compareAndSwap(cardId, current.revision, {
    ...nextRecord,
    ...(terminalFailure === undefined
      ? {}
      : {
          terminalFailure: {
            kind: "implementation" as const,
            reason: terminalFailure.slice(0, 4_000),
            outcome: "pending" as const,
          },
        }),
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof OpenCodeRunAbortedError;
}

export async function runTaskSessionImplementation(
  options: RunTaskSessionImplementationOptions,
): Promise<TaskSessionImplementationResult> {
  const {
    taskRecordStore,
    planStore,
    git,
    recoveryGit,
    commands,
    recoveryContextRoot,
    recoveryAttemptId,
    feedbackContent,
    openCode,
    project,
    card,
    expectedBranch,
    operationKey,
    retryIntervalMs,
    resume = false,
    worktreePath,
    attachmentContext,
    runOptions,
  } = options;
  const projectId = project.id;

  assertOwnedTaskWorktreePath(project, worktreePath);

  const record = loadOwnedTaskExecutionRecord(taskRecordStore, {
    projectId,
    cardId: card.id,
    expectedBranch,
    operationKey,
  });

  if (
    (record.phase !== "planning" &&
      !(resume && record.phase === "implementation")) ||
    record.sessionCreationStatus !== "bound"
  ) {
    throw new Error(
      `Task-session implementation requires a bound primary session in planning phase for ${projectId}/${card.id}`,
    );
  }

  const storedPlan = planStore.read(
    card.id,
    record.phase === "planning" ? record.revision : undefined,
  );

  if (storedPlan === null) {
    throw new Error(
      `Task-session implementation requires a persisted plan for ${projectId}/${card.id}`,
    );
  }

  if (storedPlan.verification?.verdict !== "pass") {
    throw new Error(
      `Task-session implementation requires passing independent plan verification for ${projectId}/${card.id}`,
    );
  }

  const actualBranch = await git.getCurrentBranch(worktreePath);

  if (actualBranch !== expectedBranch) {
    throw new Error(
      `Task-session worktree branch mismatch for ${projectId}/${card.id}: expected ${expectedBranch}, found ${actualBranch}`,
    );
  }

  const prompt = buildTaskSessionImplementationPrompt({
    projectId,
    card,
    approvedPlan: storedPlan.plan,
    ...(attachmentContext === undefined ? {} : { attachmentContext }),
  });

  if (record.phase === "planning") {
    const implementationRecord = transitionTaskExecutionRecord(
      record,
      createEvent(record, "plan-approved", `${operationKey}:plan-approved`),
    );
    taskRecordStore.compareAndSwap(
      card.id,
      record.revision,
      implementationRecord,
    );
  }

  let runResult: OpenCodeRunResult;

  try {
    const runAuthority = ProjectRunAuthority.current(projectId);
    runResult = await runWithPrimaryTaskSession(
      taskRecordStore,
      openCode,
      projectId,
      card.id,
      { ...runOptions, cwd: worktreePath, prompt },
      {
        inspect: async (sessionId) =>
          inspectPrimaryOpenCodeSession({
            commands,
            cwd: worktreePath,
            sessionId,
            signal: runOptions.signal,
            timeoutMilliseconds: Math.min(
              runOptions.timeoutMilliseconds,
              30_000,
            ),
          }),
        ...(recoveryAttemptId === undefined
          ? {}
          : { attemptId: recoveryAttemptId }),
        contextDirectory: path.join(
          recoveryContextRoot,
          "primary-session-context",
          project.id,
          card.id,
        ),
        forbiddenPaths: [
          project.repository.path,
          project.repository.worktreeRoot,
          worktreePath,
        ],
        ...(runAuthority === undefined
          ? {}
          : {
              persistArtifact: (content: Uint8Array) => {
                const artifact = runAuthority.store.writeArtifact(
                  content,
                  "application/json",
                );
                return { reference: artifact.id, path: artifact.path };
              },
            }),
        buildContext: () =>
          buildPrimarySessionContext({
            git: recoveryGit,
            projectId,
            card,
            attemptId: recoveryAttemptId ?? record.operationKey,
            worktreePath,
            record,
            plan: storedPlan.plan,
            ...(attachmentContext === undefined
              ? {}
              : { attachments: attachmentContext }),
            ...(feedbackContent === undefined ? {} : { feedbackContent }),
          }),
      },
      {
        role: "primary",
        operationId: `${operationKey}:implementation`,
        activity: "implementation",
        inspectPending: (entry) =>
          inspectPrimaryOperationEvidence(taskRecordStore, card.id, entry.id, {
            trustedRoot:
              ProjectRunAuthority.current(projectId)?.store.storageRoot ??
              getProcessRuntime().artifactRoot,
            cwd: worktreePath,
          }),
      },
    );

    if (runResult.exitCode !== 0) {
      const error = new Error(
        `OpenCode implementation exited with code ${runResult.exitCode}`,
      );
      persistAttentionRequired(
        taskRecordStore,
        projectId,
        card.id,
        operationKey,
        `${operationKey}:implementation-failed`,
        error.message,
      );
      throw new TaskSessionImplementationError(
        error.message,
        "failed",
        runResult,
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof TaskSessionImplementationError) {
      throw error;
    }

    if (error instanceof PrimarySessionReconstructionRequiredError) {
      throw new TaskSessionImplementationError(
        `Primary session reconstruction is required before implementation can resume for ${projectId}/${card.id}`,
        "failed",
        undefined,
        { cause: error },
      );
    }

    if (
      error instanceof PrimaryOperationWaitingError &&
      error.cause instanceof OpenCodeRunAbortedError
    ) {
      throw new TaskSessionImplementationError(
        `Task-session implementation aborted for ${projectId}/${card.id}; the bound session and worktree were preserved for restart recovery`,
        "aborted",
        undefined,
        { cause: error.cause },
      );
    }

    const outcome = isAbort(error) ? "aborted" : "failed";

    if (outcome === "aborted") {
      throw new TaskSessionImplementationError(
        `Task-session implementation ${outcome} for ${projectId}/${card.id}; the bound session and worktree were preserved for restart recovery`,
        outcome,
        undefined,
        { cause: error },
      );
    }

    if (error instanceof PrimaryOperationWaitingError) {
      persistImplementationWait(
        taskRecordStore,
        card.id,
        operationKey,
        retryIntervalMs,
        error.message,
      );
      throw new TaskSessionImplementationWaitingError(
        `Task-session implementation is waiting for recovery for ${projectId}/${card.id}`,
        { cause: error },
      );
    }

    if (error instanceof PrimaryOperationExhaustedError) {
      const current = taskRecordStore.read(card.id);
      if (
        current?.pullRequest !== undefined ||
        current?.externalRecovery !== undefined
      ) {
        persistImplementationWait(
          taskRecordStore,
          card.id,
          operationKey,
          retryIntervalMs,
          error.message,
        );
        throw new TaskSessionImplementationWaitingError(
          `Implementation execution budget exhausted after publication for ${projectId}/${card.id}`,
          { cause: error },
        );
      }
      const exhaustedOperation = current?.primaryOperations?.[operationKey];
      const failureCount =
        exhaustedOperation?.failureExecutions ??
        exhaustedOperation?.executions ??
        3;
      try {
        persistAttentionRequired(
          taskRecordStore,
          projectId,
          card.id,
          operationKey,
          `${operationKey}:implementation-exhausted`,
          `Primary implementation execution budget exhausted after ${failureCount} genuine failures: ${error.message}`,
        );
      } catch (stateError) {
        throw new TaskSessionImplementationError(
          "Could not persist exhausted implementation failure",
          "failed",
          undefined,
          { cause: stateError },
        );
      }
      throw new TaskSessionImplementationError(
        `Primary implementation execution budget exhausted for ${projectId}/${card.id}`,
        "failed",
        undefined,
        { cause: error },
      );
    }

    try {
      persistAttentionRequired(
        taskRecordStore,
        projectId,
        card.id,
        operationKey,
        `${operationKey}:implementation-${outcome}`,
      );
    } catch (stateError) {
      throw new TaskSessionImplementationError(
        `Implementation ${outcome} outcome could not be persisted for ${projectId}/${card.id}`,
        outcome,
        undefined,
        { cause: new AggregateError([error, stateError]) },
      );
    }

    throw new TaskSessionImplementationError(
      `Task-session implementation ${outcome} for ${projectId}/${card.id}`,
      outcome,
      undefined,
      { cause: error },
    );
  }

  const currentRecord = taskRecordStore.read(card.id);

  if (
    currentRecord === null ||
    currentRecord.projectId !== projectId ||
    currentRecord.cardId !== card.id ||
    currentRecord.operationKey !== operationKey ||
    currentRecord.phase !== "implementation"
  ) {
    throw new Error(
      `Task ownership or implementation phase changed before completion was persisted for ${projectId}/${card.id}`,
    );
  }

  const completedRecord = transitionTaskExecutionRecord(
    currentRecord,
    createEvent(
      currentRecord,
      "implementation-completed",
      `${operationKey}:implementation-completed`,
    ),
  );
  const persistedRecord = taskRecordStore.compareAndSwap(
    card.id,
    currentRecord.revision,
    completedRecord,
  );

  return { runResult, record: persistedRecord };
}

function persistImplementationWait(
  store: TaskExecutionStore,
  cardId: string,
  operationKey: string,
  retryIntervalMs: number | undefined,
  reason: string,
): void {
  if (
    retryIntervalMs === undefined ||
    !Number.isSafeInteger(retryIntervalMs) ||
    retryIntervalMs < 1
  )
    throw new Error(
      "Implementation recovery wait requires the configured retry interval",
    );
  const record = store.read(cardId);
  if (record === null || record.operationKey !== operationKey)
    throw new Error(
      "Implementation ownership changed while persisting recovery wait",
    );
  const now = Date.now();
  store.compareAndSwap(cardId, record.revision, {
    ...record,
    recoveryWait: {
      kind: "dependency",
      reason: reason.slice(0, 1_000),
      resumePhase: "implementation",
      since: record.recoveryWait?.since ?? new Date(now).toISOString(),
      retryAt: new Date(now + retryIntervalMs).toISOString(),
      attempts: (record.recoveryWait?.attempts ?? 0) + 1,
      notificationId: `${record.projectId}/${record.cardId}/${operationKey}/dependency`,
    },
    revision: record.revision + 1,
    updatedAt: new Date(now).toISOString(),
  });
}
