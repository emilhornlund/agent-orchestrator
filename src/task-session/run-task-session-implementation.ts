import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
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
import { runWithPrimaryTaskSession } from "./primary-task-session.js";

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

export interface RunTaskSessionImplementationOptions {
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  git: Pick<GitClient, "getCurrentBranch">;
  openCode: OpenCodeClient;
  project: ProjectConfig;
  card: TrelloCard;
  expectedBranch: string;
  operationKey: string;
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
  store.compareAndSwap(cardId, current.revision, nextRecord);
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
    openCode,
    project,
    card,
    expectedBranch,
    operationKey,
    resume = false,
    worktreePath,
    attachmentContext,
    runOptions,
  } = options;
  const projectId = project.id;

  if (project.executionMode !== "task-session") {
    throw new Error("Task-session implementation requires task-session mode");
  }

  if (
    project.repository.validationCommand === undefined ||
    project.repository.validationCommand.trim().length === 0
  ) {
    throw new Error(
      "Task-session implementation requires a nonempty repository.validationCommand",
    );
  }

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
    runResult = await runWithPrimaryTaskSession(
      taskRecordStore,
      openCode,
      projectId,
      card.id,
      { ...runOptions, cwd: worktreePath, prompt },
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

    const outcome = isAbort(error) ? "aborted" : "failed";

    if (outcome === "aborted") {
      throw new TaskSessionImplementationError(
        `Task-session implementation ${outcome} for ${projectId}/${card.id}; the bound session and worktree were preserved for restart recovery`,
        outcome,
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
