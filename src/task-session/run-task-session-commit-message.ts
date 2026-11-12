import { createHash } from "node:crypto";
import fs from "node:fs";

import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import { buildCommitPrompt } from "../opencode/build-commit-prompt.js";
import type { OpenCodeClient, OpenCodeRunOptions } from "../opencode/opencode-client.js";
import {
  captureRepositorySnapshot,
  clearCommitResult,
  getCommitResultPath,
  getCommitResultRelativePath,
  InvalidCommitResultError,
  readCommitResult,
  repositorySnapshotsEqual,
} from "../opencode/commit-result.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { inspectPrimaryOperationEvidence } from "./inspect-primary-operation.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { runWithPrimaryTaskSession } from "./primary-task-session.js";
import { PrimaryOperationWaitingError } from "./run-primary-operation.js";
import { TaskExecutionStore } from "./task-execution-store.js";

export interface RunTaskSessionCommitMessageOptions {
  project: ProjectConfig;
  card: TrelloCard;
  operationKey: string;
  /** Stable semantic identity of the initial, CI-pass, or feedback commit intent. */
  commitIntentId: string;
  /** Primary-ledger key for this exact intent; reused without a nonce on replay. */
  operationId: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  git: GitClient;
  openCode: OpenCodeClient;
  runOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId" | "readOnly" | "onExecutionPrepared"
  >;
}

export class CommitMessageRecoveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitMessageRecoveryBlockedError";
  }
}

export class CommitMessageAdviceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommitMessageAdviceUnavailableError";
  }
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export async function runTaskSessionCommitMessage(
  options: RunTaskSessionCommitMessageOptions,
): Promise<string> {
  const { project, card, operationKey, commitIntentId, operationId } = options;
  let record = options.taskRecordStore.read(card.id);
  if (record === null || record.projectId !== project.id || record.operationKey !== operationKey)
    throw new CommitMessageRecoveryBlockedError(
      "Commit-message generation does not match the owned task operation",
    );

  const unresolvedWriter = Object.values(record.primaryOperations ?? {}).find(
    (operation) =>
      operation !== undefined &&
      operation.id !== operationId &&
      (["intent", "dispatched", "ambiguous"].includes(operation.status) ||
        (operation.status === "failed" && operation.retrySafe !== true)),
  );
  if (unresolvedWriter !== undefined) throw new PrimaryOperationWaitingError(unresolvedWriter.id);

  const legacyOperationId = `${operationKey}:commit-message`;
  const legacyOperation = record.primaryOperations?.[legacyOperationId];
  if (
    legacyOperation !== undefined &&
    (legacyOperation.status === "intent" ||
      legacyOperation.status === "dispatched" ||
      legacyOperation.status === "ambiguous" ||
      (legacyOperation.status === "failed" && legacyOperation.retrySafe !== true))
  )
    throw new PrimaryOperationWaitingError(legacyOperationId);
  if (legacyOperation !== undefined) clearCommitResult(options.worktreePath);
  else if (fs.existsSync(getCommitResultPath(options.worktreePath)))
    throw new CommitMessageRecoveryBlockedError(
      "Unassociated legacy commit-result artifact prevents safe commit-message generation",
    );

  const resultArtifactHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        operationKey,
        commitIntentId,
        operationId,
      }),
    )
    .digest("hex");
  const resultPath = getCommitResultRelativePath(resultArtifactHash);
  const before = await captureRepositorySnapshot(options.git, options.worktreePath, [resultPath]);
  const intentIdentity = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        operationKey,
        commitIntentId,
        operationId,
        snapshot: before,
      }),
    )
    .digest("hex")}` as const;

  const savedOperation = record.primaryOperations?.[operationId];
  if (savedOperation?.commitMessageResult !== undefined) {
    if (
      savedOperation.status !== "completed" ||
      savedOperation.commitMessageResult.intentIdentity !== intentIdentity
    )
      throw new CommitMessageRecoveryBlockedError(
        "Persisted commit message does not match its completed commit intent",
      );
    clearCommitResult(options.worktreePath, resultArtifactHash);
    if (operationId === legacyOperationId) clearCommitResult(options.worktreePath);
    return savedOperation.commitMessageResult.message;
  }

  if (
    legacyOperationId === operationId &&
    legacyOperation?.status === "completed" &&
    !fs.existsSync(getCommitResultPath(options.worktreePath, resultArtifactHash))
  ) {
    // Older completed message operations have no source-bound ledger result.
    // Their message is optional metadata, so retain the operation and let the
    // caller use its deterministic fallback rather than dispatching it again.
    clearCommitResult(options.worktreePath);
    throw new CommitMessageAdviceUnavailableError(
      "Completed legacy commit-message advice lacks a replayable result; use the deterministic fallback",
    );
  }

  if (
    savedOperation === undefined &&
    fs.existsSync(getCommitResultPath(options.worktreePath, resultArtifactHash))
  )
    throw new CommitMessageRecoveryBlockedError(
      "Unassociated commit-result artifact prevents safe commit-message generation",
    );

  const runResult = await runWithPrimaryTaskSession(
    options.taskRecordStore,
    options.openCode,
    project.id,
    card.id,
    {
      ...options.runOptions,
      cwd: options.worktreePath,
      sessionLogPath: options.runOptions.sessionLogPath ?? getSessionLogPath(project.id, card.id),
      sessionLabel: options.runOptions.sessionLabel ?? "Task-session commit message",
      prompt: buildCommitPrompt(card, resultPath),
    },
    {},
    {
      role: "advisory",
      operationId,
      // Retain the established advisory activity for replay of older task
      // records; the operation ID binds this message to its commit intent.
      activity: "advisory",
      inspectPending: (entry) =>
        inspectPrimaryOperationEvidence(options.taskRecordStore, card.id, entry.id, {
          trustedRoot:
            ProjectRunAuthority.current(project.id)?.store.storageRoot ??
            getProcessRuntime().artifactRoot,
          cwd: options.worktreePath,
        }),
    },
  );
  if (runResult.exitCode !== 0) {
    const afterFailure = await captureRepositorySnapshot(options.git, options.worktreePath, [
      resultPath,
    ]);
    if (!repositorySnapshotsEqual(before, afterFailure))
      throw new CommitMessageRecoveryBlockedError(
        "Commit-message generation changed source files outside its owned result artifact",
      );
    clearCommitResult(options.worktreePath, resultArtifactHash);
    throw new CommitMessageAdviceUnavailableError(
      `Commit message session exited with code ${runResult.exitCode}`,
    );
  }

  let message: string;
  let invalidResult: InvalidCommitResultError | undefined;
  try {
    message = readCommitResult(options.worktreePath, resultArtifactHash).message;
  } catch (error) {
    if (
      legacyOperationId === operationId &&
      legacyOperation?.status === "completed" &&
      fs.existsSync(getCommitResultPath(options.worktreePath))
    ) {
      message = readCommitResult(options.worktreePath).message;
    } else if (error instanceof InvalidCommitResultError) {
      invalidResult = error;
      message = "";
    } else {
      throw error;
    }
  }
  const after = await captureRepositorySnapshot(options.git, options.worktreePath, [resultPath]);
  if (!repositorySnapshotsEqual(before, after)) {
    throw new CommitMessageRecoveryBlockedError(
      "Commit-message generation changed source files outside its owned result artifact",
    );
  }
  if (invalidResult !== undefined) {
    // This path is derived from this exact operation's stable identity. Remove
    // only that owned malformed result after confirming source scope is intact.
    clearCommitResult(options.worktreePath, resultArtifactHash);
    throw new CommitMessageAdviceUnavailableError(
      "Commit-message advice returned a malformed result; use the deterministic fallback",
      { cause: invalidResult },
    );
  }

  record = options.taskRecordStore.read(card.id);
  if (record === null || record.projectId !== project.id || record.operationKey !== operationKey)
    throw new Error("Task ownership changed before the commit message could be persisted");
  const completedOperation = record.primaryOperations?.[operationId];
  if (completedOperation?.status !== "completed")
    throw new Error(
      "Commit-message execution is not durably completed; preserving its result artifact",
    );
  if (
    completedOperation.commitMessageResult !== undefined &&
    (completedOperation.commitMessageResult.intentIdentity !== intentIdentity ||
      completedOperation.commitMessageResult.message !== message)
  )
    throw new Error("Commit-message replay result conflicts with its persisted intent result");

  if (completedOperation.commitMessageResult === undefined)
    options.taskRecordStore.compareAndSwap(card.id, record.revision, {
      ...record,
      primaryOperations: {
        ...record.primaryOperations,
        [operationId]: {
          ...completedOperation,
          commitMessageResult: { intentIdentity, message },
        },
      },
      revision: record.revision + 1,
      updatedAt: nextTimestamp(record.updatedAt),
    });
  clearCommitResult(options.worktreePath, resultArtifactHash);
  if (legacyOperationId === operationId) clearCommitResult(options.worktreePath);
  return message;
}
