import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import {
  PrMaintenanceConflictError,
  PrMaintenanceStore,
} from "./pr-maintenance-store.js";
import type {
  LocalPreparationProgress,
  PrMaintenanceOperation,
} from "./pr-maintenance-operation.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";

type GitPreparationClient = Pick<
  GitClient,
  | "fetch"
  | "getCommonGitDirectory"
  | "getCurrentBranch"
  | "getHeadSha"
  | "getRefSha"
  | "createRefIfAbsent"
  | "getStatus"
  | "getRebaseState"
  | "getConflictedPaths"
  | "isAncestor"
  | "resolveCommitSha"
  | "rebase"
>;

type PullRequestLookup = Pick<GitHubClient, "findPullRequestState">;

export interface PreparePublishedPrRebaseOptions {
  project: ProjectConfig;
  cardId: string;
  operationId: string;
  worktreePath: string;
  maintenanceStore: PrMaintenanceStore;
  taskExecutionStore: Pick<TaskExecutionStore, "read">;
  git: GitPreparationClient;
  github: PullRequestLookup;
  remote?: string;
}

export type PublishedPrRebasePreparationResult =
  | {
      status: "prepared" | "already-current";
      operation: PrMaintenanceOperation;
      originalHead: string;
      baseHead: string;
      resultingHead: string;
      backupRef?: string;
    }
  | {
      status: "conflicted";
      operation: PrMaintenanceOperation;
      originalHead: string;
      baseHead: string;
      conflictedPaths: string[];
      backupRef: string;
    };

function assertPublishedTaskIdentity(
  project: ProjectConfig,
  cardId: string,
  branch: string,
  operation: PrMaintenanceOperation,
  task: TaskExecutionRecord | null,
): asserts task is TaskExecutionRecord {
  if (operation.projectId !== project.id || operation.cardId !== cardId) {
    throw new PrMaintenanceConflictError(
      "Maintenance operation project or card does not match the requested task",
    );
  }
  if (branch !== `agent/${cardId}`) {
    throw new PrMaintenanceConflictError(
      `Maintenance requires the owned task branch agent/${cardId}, found ${branch}`,
    );
  }
  if (
    task === null ||
    task.projectId !== project.id ||
    task.cardId !== cardId ||
    task.expectedBranch !== branch ||
    task.pullRequest === undefined ||
    task.pullRequest.headSha === undefined ||
    !["ci", "human-feedback", "done"].includes(task.phase)
  ) {
    throw new PrMaintenanceConflictError(
      "Task record does not identify an already-published owned pull request",
    );
  }
  if (
    task.pullRequest.number !== operation.pullRequest.number ||
    task.pullRequest.url !== operation.pullRequest.url ||
    task.pullRequest.headSha !== operation.expectedRemoteHead
  ) {
    throw new PrMaintenanceConflictError(
      "Task record PR identity or persisted published head does not match maintenance operation",
    );
  }
}

function assertAuthoritativePullRequest(
  project: ProjectConfig,
  cardId: string,
  operation: PrMaintenanceOperation,
  pullRequest: PullRequestState | null,
): asserts pullRequest is PullRequestState {
  const [owner, repository] = project.repository.github.split("/");
  const expectedUrlNumber = Number(
    new URL(operation.pullRequest.url).pathname.split("/").at(-1),
  );
  if (
    pullRequest === null ||
    pullRequest.url !== operation.pullRequest.url ||
    expectedUrlNumber !== operation.pullRequest.number ||
    pullRequest.state !== "OPEN" ||
    pullRequest.headRefName !== `agent/${cardId}` ||
    pullRequest.baseRefName !== project.repository.defaultBranch ||
    pullRequest.headRefOid !== operation.expectedRemoteHead ||
    pullRequest.headRepository?.name !== repository ||
    pullRequest.headRepositoryOwner?.login !== owner
  ) {
    throw new PrMaintenanceConflictError(
      "Authoritative GitHub pull request ownership, base, or published head is ambiguous",
    );
  }
}

function backupRefFor(operationId: string): string {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return `refs/orchestrator/pr-maintenance/${digest}/original`;
}

function progress(
  status: LocalPreparationProgress["status"],
  originalHead: string,
  additions: Omit<
    LocalPreparationProgress,
    "status" | "originalHead" | "updatedAt"
  > = {},
): LocalPreparationProgress {
  return {
    status,
    originalHead,
    ...additions,
    updatedAt: new Date().toISOString(),
  };
}

async function assertCleanWorktree(
  git: GitPreparationClient,
  worktreePath: string,
): Promise<void> {
  const [status, rebaseState, conflicts] = await Promise.all([
    git.getStatus(worktreePath),
    git.getRebaseState(worktreePath),
    git.getConflictedPaths(worktreePath),
  ]);
  if (status.length > 0 || rebaseState !== null || conflicts.length > 0) {
    throw new PrMaintenanceConflictError(
      "Refusing maintenance rebase with dirty, conflicted, or in-progress worktree state",
    );
  }
}

/** Prepare an already-published owned task branch for a local rebase; this never pushes or edits remote state. */
export async function preparePublishedPrRebase(
  options: PreparePublishedPrRebaseOptions,
): Promise<PublishedPrRebasePreparationResult> {
  const {
    project,
    cardId,
    operationId,
    worktreePath,
    maintenanceStore,
    taskExecutionStore,
    git,
    github,
  } = options;
  const remote = options.remote ?? "origin";
  assertOwnedTaskWorktreePath(project, worktreePath);
  let operation = maintenanceStore.inspect(operationId);
  if (operation === null)
    throw new PrMaintenanceConflictError(
      `Unknown maintenance operation: ${operationId}`,
    );
  if (operation.projectId !== project.id || operation.cardId !== cardId) {
    throw new PrMaintenanceConflictError(
      "Maintenance operation does not own the requested project/card",
    );
  }
  const identity = {
    projectId: operation.projectId,
    cardId: operation.cardId,
    pullRequest: operation.pullRequest,
    expectedRemoteHead: operation.expectedRemoteHead,
    targetBaseHead: operation.targetBaseHead,
  };
  if (operation.status === "uncertain")
    operation = maintenanceStore.claimForRecovery(operationId, identity);
  else {
    try {
      maintenanceStore.requireOwnedActive(operationId, identity);
    } catch (error) {
      if (
        !(error instanceof PrMaintenanceConflictError) ||
        operation.status !== "active"
      )
        throw error;
      operation = maintenanceStore.claimForRecovery(operationId, identity);
    }
  }
  const currentBranch = await git.getCurrentBranch(worktreePath);
  const existingRebaseState = await git.getRebaseState(worktreePath);
  const branch =
    currentBranch ||
    (existingRebaseState?.headName.startsWith("refs/heads/")
      ? existingRebaseState.headName.slice("refs/heads/".length)
      : "");
  const task = taskExecutionStore.read(cardId);
  assertPublishedTaskIdentity(project, cardId, branch, operation, task);
  const [sourceCommonDirectory, worktreeCommonDirectory] = await Promise.all([
    git.getCommonGitDirectory(project.repository.path),
    git.getCommonGitDirectory(worktreePath),
  ]);
  if (
    path.resolve(sourceCommonDirectory) !==
    path.resolve(worktreeCommonDirectory)
  ) {
    throw new PrMaintenanceConflictError(
      "Task worktree is not attached to the configured source repository",
    );
  }
  const pullRequest = await github.findPullRequestState({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: branch,
    baseBranch: project.repository.defaultBranch,
    project,
  });
  assertAuthoritativePullRequest(project, cardId, operation, pullRequest);
  let prep = operation.localPreparation;
  if (
    existingRebaseState !== null &&
    prep?.status !== "rebasing" &&
    prep?.status !== "conflicted"
  ) {
    throw new PrMaintenanceConflictError(
      "An unrecorded Git rebase is active; refusing to claim or modify its state",
    );
  }
  if (existingRebaseState === null && prep?.status !== "conflicted")
    await assertCleanWorktree(git, worktreePath);
  let currentHead = await git.getHeadSha(worktreePath);
  // A new maintenance attempt must start from the exact published head.
  // Otherwise an unapproved, clean local commit could be rebased and pushed.
  // Once rebase preparation has begun, use the persisted backup/rebase state
  // for recovery rather than requiring the changing local HEAD to match.
  if (
    (prep === undefined ||
      prep.status === "fetching-base" ||
      prep.status === "base-fetched" ||
      prep.status === "backing-up") &&
    currentHead !== operation.expectedRemoteHead
  ) {
    throw new PrMaintenanceConflictError(
      "Local task branch has commits beyond the trusted published PR head; refusing to rebase or publish unverified local commits",
    );
  }
  if (
    !(await git.isAncestor(
      worktreePath,
      operation.expectedRemoteHead,
      currentHead,
    ))
  ) {
    if (
      prep?.backupRef === undefined ||
      prep.originalHead === undefined ||
      (await git.getRefSha(project.repository.path, prep.backupRef)) !==
        prep.originalHead ||
      !(await git.isAncestor(
        worktreePath,
        operation.expectedRemoteHead,
        prep.originalHead,
      ))
    ) {
      throw new PrMaintenanceConflictError(
        "Current task branch does not contain its persisted published PR head and no verified original-head backup proves a rebase is in progress",
      );
    }
  }
  if (prep?.status === "prepared") {
    return {
      status:
        prep.resultingHead === prep.originalHead
          ? "already-current"
          : "prepared",
      operation,
      originalHead: prep.originalHead,
      baseHead: prep.baseHead!,
      resultingHead: prep.resultingHead!,
      ...(prep.backupRef === undefined ? {} : { backupRef: prep.backupRef }),
    };
  }
  if (prep?.status === "conflicted") {
    return {
      status: "conflicted",
      operation,
      originalHead: prep.originalHead,
      baseHead: prep.baseHead!,
      conflictedPaths: prep.conflictedPaths ?? [],
      backupRef: prep.backupRef!,
    };
  }
  const originalHead = prep?.originalHead ?? currentHead;
  if (currentHead !== originalHead && prep?.status !== "rebasing") {
    throw new PrMaintenanceConflictError(
      "Task branch head changed since local preparation began; preserving state for manual inspection",
    );
  }
  if (prep === undefined || prep.status === "fetching-base") {
    if (prep === undefined) {
      maintenanceStore.recordLocalPreparation(
        operationId,
        identity,
        progress("fetching-base", originalHead),
      );
    }
    await git.fetch(
      project.repository.path,
      remote,
      project.repository.defaultBranch,
      project,
    );
    const baseRef = `refs/remotes/${remote}/${project.repository.defaultBranch}`;
    const baseHead = await git.resolveCommitSha(
      project.repository.path,
      baseRef,
    );
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("base-fetched", originalHead, { baseHead }),
    );
    prep = operation.localPreparation!;
  }
  const baseHead = prep.baseHead;
  if (baseHead === undefined)
    throw new PrMaintenanceConflictError(
      "Persisted preparation is missing the fetched base identity",
    );
  if (baseHead !== operation.targetBaseHead)
    throw new PrMaintenanceConflictError(
      "Current fetched base differs from the pinned maintenance base; refusing to rebase or publish",
    );
  if (await git.isAncestor(worktreePath, baseHead, originalHead)) {
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("prepared", originalHead, {
        baseHead,
        resultingHead: originalHead,
      }),
    );
    return {
      status: "already-current",
      operation,
      originalHead,
      baseHead,
      resultingHead: originalHead,
    };
  }

  const backupRef = prep.backupRef ?? backupRefFor(operationId);
  if (prep.status === "base-fetched") {
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("backing-up", originalHead, { baseHead, backupRef }),
    );
    prep = operation.localPreparation!;
  }
  const existingBackup = await git.getRefSha(
    project.repository.path,
    backupRef,
  );
  if (existingBackup !== null && existingBackup !== originalHead) {
    throw new PrMaintenanceConflictError(
      "The maintenance backup ref exists but does not preserve the original task head",
    );
  }
  if (existingBackup === null)
    await git.createRefIfAbsent(
      project.repository.path,
      backupRef,
      originalHead,
    );
  if (prep.status === "backing-up") {
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("rebasing", originalHead, { baseHead, backupRef }),
    );
    prep = operation.localPreparation!;
  }
  if (prep.status !== "rebasing")
    throw new PrMaintenanceConflictError(
      `Preparation cannot resume from ${prep.status}`,
    );

  const rebaseState = await git.getRebaseState(worktreePath);
  if (rebaseState !== null) {
    const conflictedPaths = await git.getConflictedPaths(worktreePath);
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("conflicted", originalHead, {
        baseHead,
        backupRef,
        conflictedPaths,
      }),
    );
    return {
      status: "conflicted",
      operation,
      originalHead,
      baseHead,
      conflictedPaths,
      backupRef,
    };
  }
  currentHead = await git.getHeadSha(worktreePath);
  if (currentHead !== originalHead) {
    if (!(await git.isAncestor(worktreePath, baseHead, currentHead))) {
      throw new PrMaintenanceConflictError(
        "Interrupted rebase changed the task branch to an unverifiable head; original work is preserved by the backup ref",
      );
    }
    await assertCleanWorktree(git, worktreePath);
    operation = maintenanceStore.recordLocalPreparation(
      operationId,
      identity,
      progress("prepared", originalHead, {
        baseHead,
        backupRef,
        resultingHead: currentHead,
      }),
    );
    return {
      status: "prepared",
      operation,
      originalHead,
      baseHead,
      resultingHead: currentHead,
      backupRef,
    };
  }
  try {
    await git.rebase(worktreePath, baseHead, project.repository.gitIdentity);
  } catch (error) {
    const activeRebase = await git.getRebaseState(worktreePath);
    if (activeRebase !== null) {
      const conflictedPaths = await git.getConflictedPaths(worktreePath);
      operation = maintenanceStore.recordLocalPreparation(
        operationId,
        identity,
        progress("conflicted", originalHead, {
          baseHead,
          backupRef,
          conflictedPaths,
        }),
      );
      return {
        status: "conflicted",
        operation,
        originalHead,
        baseHead,
        conflictedPaths,
        backupRef,
      };
    }
    throw error;
  }
  await assertCleanWorktree(git, worktreePath);
  const resultingHead = await git.getHeadSha(worktreePath);
  if (!(await git.isAncestor(worktreePath, baseHead, resultingHead))) {
    throw new PrMaintenanceConflictError(
      "Rebase completed without the fetched base as an ancestor; preserving the original commit",
    );
  }
  operation = maintenanceStore.recordLocalPreparation(
    operationId,
    identity,
    progress("prepared", originalHead, { baseHead, backupRef, resultingHead }),
  );
  return {
    status: "prepared",
    operation,
    originalHead,
    baseHead,
    resultingHead,
    backupRef,
  };
}
