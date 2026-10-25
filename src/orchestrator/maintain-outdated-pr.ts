import { randomUUID } from "node:crypto";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import type { PrMaintenanceOperation } from "../task-session/pr-maintenance-operation.js";
import { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { preparePublishedPrRebase } from "../task-session/prepare-published-pr-rebase.js";
import { verifyPreparedPrMaintenance } from "../task-session/verify-prepared-pr-maintenance.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { GitRebaseState } from "../git/git-client.js";
import { writeTrustedCommitState } from "./trusted-commit-state.js";
import { logger } from "../logging/logger.js";

export interface MaintainOutdatedPrOptions {
  project: ProjectConfig;
  card: TrelloCard;
  task: TaskExecutionRecord;
  worktreePath: string;
  git: GitClient;
  github: Pick<
    GitHubClient,
    | "findPullRequestState"
    | "findChangesRequestedPullRequest"
    | "getPullRequestConversationComments"
  >;
  commands: CommandRunner;
  mutationQueue: TaskMutationQueue;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  signal: AbortSignal;
  requirementIds: readonly string[];
  eligible: boolean;
  hasRequestedChanges: boolean;
  hasUnresolvedFeedback: boolean;
  review: (input: {
    contentIdentity: string;
    preparedHead: string;
    requirementIds: readonly string[];
    signal: AbortSignal;
  }) => Promise<ImplementationReviewResult>;
  remediateConflict?: (input: {
    conflictedPaths: readonly string[];
    rebase: GitRebaseState;
    attempt: number;
    signal: AbortSignal;
  }) => Promise<void>;
}

type MaintenanceIdentity = Pick<
  PrMaintenanceOperation,
  | "projectId"
  | "cardId"
  | "pullRequest"
  | "expectedRemoteHead"
  | "targetBaseHead"
>;

function assertPrIdentity(
  options: MaintainOutdatedPrOptions,
  pr: NonNullable<Awaited<ReturnType<GitHubClient["findPullRequestState"]>>>,
  expectedHead: string,
  expectedBase: string,
): void {
  const [owner, repository] = options.project.repository.github.split("/");
  if (
    pr.url !== options.task.pullRequest?.url ||
    pr.state !== "OPEN" ||
    pr.headRefName !== `agent/${options.card.id}` ||
    pr.baseRefName !== options.project.repository.defaultBranch ||
    pr.headRefOid !== expectedHead ||
    pr.baseRefOid !== expectedBase ||
    pr.headRepository?.name !== repository ||
    pr.headRepositoryOwner?.login !== owner
  ) {
    throw new Error(
      "Authoritative PR head, base, or ownership changed during maintenance",
    );
  }
}

function persistPublishedHead(
  options: MaintainOutdatedPrOptions,
  resultingHead: string,
): void {
  const latest = options.taskStore.read(options.card.id);
  if (
    latest === null ||
    latest.pullRequest === undefined ||
    options.task.pullRequest === undefined ||
    latest.pullRequest.number !== options.task.pullRequest.number ||
    latest.pullRequest.url !== options.task.pullRequest.url
  )
    throw new Error(
      "Task PR identity changed before maintenance reconciliation",
    );
  if (latest.pullRequest.headSha !== resultingHead) {
    options.taskStore.compareAndSwap(latest.cardId, latest.revision, {
      ...latest,
      pullRequest: { ...latest.pullRequest, headSha: resultingHead },
      reviewObservation: undefined,
      revision: latest.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
      ).toISOString(),
    });
  }
  writeTrustedCommitState(options.project, options.card.id, {
    version: 1,
    kind: "trusted-commit",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: `agent/${options.card.id}`,
    defaultBranch: options.project.repository.defaultBranch,
    commitSha: resultingHead,
  });
}

/** Rebase and publish one already-observed, outdated Human Review PR. */
export async function maintainOutdatedPr(
  options: MaintainOutdatedPrOptions,
): Promise<"deferred" | "conflicted" | "published" | "reconciled"> {
  const { project, card, task, maintenanceStore, mutationQueue } = options;
  if (
    project.maintenance?.enabled !== true ||
    !options.eligible ||
    options.hasRequestedChanges ||
    options.hasUnresolvedFeedback ||
    task.phase !== "human-feedback" ||
    task.pullRequest?.headSha === undefined ||
    task.pullRequest.url === undefined ||
    task.pullRequest.number === undefined ||
    options.signal.aborted
  )
    return "deferred";
  if (mutationQueue.getActive() !== null) return "deferred";

  const initial = await options.github.findPullRequestState({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: `agent/${card.id}`,
    baseBranch: project.repository.defaultBranch,
    project,
  });
  if (
    initial === null ||
    initial.baseRefOid === undefined ||
    initial.headRefOid === undefined
  )
    return "deferred";
  assertPrIdentity(
    options,
    initial,
    task.pullRequest.headSha,
    initial.baseRefOid,
  );

  const currentHead = task.pullRequest.headSha;
  const currentBase = initial.baseRefOid;
  const identity: MaintenanceIdentity = {
    projectId: project.id,
    cardId: card.id,
    pullRequest: { number: task.pullRequest.number, url: task.pullRequest.url },
    expectedRemoteHead: currentHead,
    targetBaseHead: currentBase,
  };
  const prior = maintenanceStore
    .inspect()
    .find(
      (item) =>
        item.cardId === card.id &&
        item.expectedRemoteHead === currentHead &&
        item.status !== "completed",
    );
  if (
    prior?.status === "uncertain" &&
    prior.publication === undefined &&
    prior.localPreparation?.status !== "conflicted"
  )
    return "deferred";
  if (
    prior?.qualityVerification?.status === "failed" ||
    prior?.qualityVerification?.status === "uncertain"
  )
    return "deferred";
  const operation =
    prior ??
    maintenanceStore.create({
      ...identity,
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const eventId = `pr-maintenance:${card.id}:${operation.operationId}`;
  const mutation = mutationQueue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId,
    operationKey: operation.operationId,
    kind: "pr-maintenance",
    enqueuedAt: operation.createdAt,
  });
  if (mutation.status === "completed") return "reconciled";
  const ownedMutation = mutationQueue.claimForRecovery(eventId);
  if (ownedMutation === null) return "deferred";

  try {
    let owned = operation;
    if (owned.status === "prepared" || owned.status === "uncertain") {
      owned =
        owned.status === "prepared"
          ? maintenanceStore.advance(
              owned.operationId,
              "prepared",
              "active",
              identity,
            )
          : maintenanceStore.claimForRecovery(owned.operationId, identity);
    } else if (owned.status === "active") {
      owned = maintenanceStore.claimForRecovery(owned.operationId, identity);
    }
    if (owned === null)
      throw new Error("Could not acquire maintenance ownership");

    // A previous process may have pushed successfully and stopped before local persistence.
    if (owned.publication?.status === "push-intended") {
      const remote = await options.github.findPullRequestState({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: `agent/${card.id}`,
        baseBranch: project.repository.defaultBranch,
        project,
      });
      if (remote?.headRefOid !== owned.publication.resultingHead) {
        maintenanceStore.advance(
          owned.operationId,
          "active",
          "uncertain",
          identity,
        );
        mutationQueue.fail(eventId);
        return "deferred";
      }
      assertPrIdentity(
        options,
        remote,
        owned.publication.resultingHead,
        currentBase,
      );
      maintenanceStore.recordPublication(
        owned.operationId,
        identity,
        "verified",
        owned.publication.resultingHead,
      );
      persistPublishedHead(options, owned.publication.resultingHead);
      maintenanceStore.advance(
        owned.operationId,
        "active",
        "completed",
        identity,
      );
      mutationQueue.complete(eventId);
      return "reconciled";
    }

    const prepared = await preparePublishedPrRebase({
      project,
      cardId: card.id,
      operationId: owned.operationId,
      worktreePath: options.worktreePath,
      maintenanceStore,
      taskExecutionStore: options.taskStore,
      git: options.git,
      github: options.github,
    });
    if (prepared.status === "conflicted") {
      const maxPasses = project.opencode.remediation.maxPasses;
      if (options.remediateConflict === undefined || maxPasses < 1) {
        logger
          .child({ projectId: project.id, cardId: card.id })
          .warn(
            `PR maintenance rebase conflict requires manual attention (${prepared.conflictedPaths.join(", ")})`,
          );
        maintenanceStore.advance(
          owned.operationId,
          "active",
          "uncertain",
          identity,
        );
        mutationQueue.fail(eventId);
        return "conflicted";
      }
      let conflictedPaths = prepared.conflictedPaths;
      let completed = false;
      let attempts = owned.conflictRemediationAttempts ?? 0;
      while (attempts < maxPasses) {
        if (options.signal.aborted) break;
        const rebase = await options.git.getRebaseState(options.worktreePath);
        if (rebase === null) {
          completed = true;
          break;
        }
        conflictedPaths = await options.git.getConflictedPaths(
          options.worktreePath,
        );
        if (conflictedPaths.length === 0) break;
        owned = maintenanceStore.recordConflictRemediationAttempt(
          owned.operationId,
          identity,
        );
        attempts = owned.conflictRemediationAttempts ?? attempts + 1;
        await options.remediateConflict({
          conflictedPaths,
          rebase,
          attempt: attempts,
          signal: options.signal,
        });
        if (options.signal.aborted) break;
        const nextRebase = await options.git.getRebaseState(
          options.worktreePath,
        );
        if (nextRebase === null) {
          completed = true;
          break;
        }
        conflictedPaths = await options.git.getConflictedPaths(
          options.worktreePath,
        );
      }
      const finalRebase = await options.git.getRebaseState(
        options.worktreePath,
      );
      if (!completed && finalRebase === null) completed = true;
      if (!completed || finalRebase !== null) {
        logger
          .child({ projectId: project.id, cardId: card.id })
          .warn(
            `PR maintenance conflict remediation did not complete within ${maxPasses} passes; preserved paths: ${conflictedPaths.join(", ")}`,
          );
        maintenanceStore.advance(
          owned.operationId,
          "active",
          "uncertain",
          identity,
        );
        mutationQueue.fail(eventId);
        return "conflicted";
      }
      const resultingHead = await options.git.getHeadSha(options.worktreePath);
      if (
        !(await options.git.isAncestor(
          options.worktreePath,
          prepared.baseHead,
          resultingHead,
        ))
      )
        throw new Error(
          "Remediated PR maintenance head does not contain the fetched base",
        );
      const status = await options.git.getStatus(options.worktreePath);
      if (status.trim().length > 0)
        throw new Error(
          `Remediated PR maintenance worktree is not clean:\n${status}`,
        );
      owned = maintenanceStore.recordLocalPreparation(
        owned.operationId,
        identity,
        {
          status: "prepared",
          originalHead: prepared.originalHead,
          baseHead: prepared.baseHead,
          backupRef: prepared.backupRef,
          resultingHead,
          updatedAt: new Date().toISOString(),
        },
      );
    }
    owned = maintenanceStore.inspect(owned.operationId)!;
    await verifyPreparedPrMaintenance({
      project,
      operation: owned,
      worktreePath: options.worktreePath,
      maintenanceStore,
      git: options.git,
      commands: options.commands,
      signal: options.signal,
      timeoutMilliseconds: 60 * 60 * 1000,
      requirementIds: options.requirementIds,
      review: options.review,
    });

    const beforePush = await options.github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${card.id}`,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    if (beforePush === null)
      throw new Error(
        "Authoritative PR disappeared before maintenance publication",
      );
    assertPrIdentity(options, beforePush, currentHead, currentBase);
    const feedbackLookup = {
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${card.id}`,
      baseBranch: project.repository.defaultBranch,
      project,
    };
    const [requestedChanges, conversationComments] = await Promise.all([
      options.github.findChangesRequestedPullRequest(feedbackLookup),
      options.github.getPullRequestConversationComments({
        cwd: project.repository.path,
        repository: project.repository.github,
        pullRequestUrl: task.pullRequest.url,
        project,
      }),
    ]);
    if (requestedChanges !== null || conversationComments.length > 0)
      throw new Error(
        "New review feedback arrived before maintenance publication",
      );
    const resultingHead = owned.localPreparation?.resultingHead;
    if (resultingHead === undefined)
      throw new Error(
        "Prepared PR maintenance operation has no resulting head",
      );
    maintenanceStore.recordPublication(
      owned.operationId,
      identity,
      "push-intended",
      resultingHead,
    );
    try {
      await options.git.pushWithLease(
        options.worktreePath,
        "origin",
        `agent/${card.id}`,
        currentHead,
        project,
      );
    } catch (error) {
      maintenanceStore.advance(
        owned.operationId,
        "active",
        "uncertain",
        identity,
      );
      mutationQueue.fail(eventId);
      throw new Error(
        "PR maintenance push outcome is ambiguous; publication will not be repeated",
        { cause: error },
      );
    }
    const afterPush = await options.github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${card.id}`,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    if (afterPush === null)
      throw new Error(
        "Authoritative PR disappeared after maintenance publication",
      );
    assertPrIdentity(options, afterPush, resultingHead, currentBase);
    maintenanceStore.recordPublication(
      owned.operationId,
      identity,
      "verified",
      resultingHead,
    );
    persistPublishedHead(options, resultingHead);
    maintenanceStore.advance(
      owned.operationId,
      "active",
      "completed",
      identity,
    );
    mutationQueue.complete(eventId);
    return "published";
  } catch (error) {
    const latestOperation = maintenanceStore.inspect(operation.operationId);
    if (latestOperation?.status === "active") {
      try {
        maintenanceStore.advance(
          operation.operationId,
          "active",
          "uncertain",
          identity,
        );
      } catch {
        // Preserve the active record if ownership cannot be verified for release.
      }
    }
    if (mutationQueue.ownsActive(eventId)) mutationQueue.fail(eventId);
    throw error;
  }
}

/** Reconcile a publication interrupted after its durable push-intent marker. */
export async function reconcileInterruptedPrMaintenance(options: {
  project: ProjectConfig;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
  github: Pick<GitHubClient, "findPullRequestState">;
}): Promise<void> {
  for (const stored of options.maintenanceStore.inspect()) {
    const eventId = `pr-maintenance:${stored.cardId}:${stored.operationId}`;
    if (stored.status === "completed") {
      const completedMutation = options.mutationQueue.claimForRecovery(eventId);
      if (completedMutation !== null) options.mutationQueue.complete(eventId);
      continue;
    }
    if (
      stored.publication === undefined ||
      stored.publication.status === "not-started"
    )
      continue;
    const task = options.taskStore.read(stored.cardId);
    if (
      task === null ||
      task.projectId !== options.project.id ||
      task.pullRequest?.number !== stored.pullRequest.number ||
      task.pullRequest.url !== stored.pullRequest.url
    )
      throw new Error("Interrupted PR maintenance has ambiguous task identity");
    const remote = await options.github.findPullRequestState({
      cwd: options.project.repository.path,
      repository: options.project.repository.github,
      headBranch: `agent/${stored.cardId}`,
      baseBranch: options.project.repository.defaultBranch,
      project: options.project,
    });
    if (
      remote?.url !== stored.pullRequest.url ||
      remote.state !== "OPEN" ||
      remote.headRefName !== `agent/${stored.cardId}` ||
      remote.baseRefName !== options.project.repository.defaultBranch ||
      remote.headRepository?.name !==
        options.project.repository.github.split("/")[1] ||
      remote.headRepositoryOwner?.login !==
        options.project.repository.github.split("/")[0]
    )
      throw new Error(
        "Interrupted PR maintenance publication identity is ambiguous",
      );
    if (
      remote.headRefOid !== stored.publication.resultingHead ||
      remote.baseRefOid !== stored.targetBaseHead
    ) {
      // A recorded push intent is never retried, even if the remote still shows the old head.
      if (stored.publication.status === "push-intended") {
        if (stored.status === "active")
          options.maintenanceStore.reconcileInterrupted(
            stored.operationId,
            stored,
          );
        const mutation = options.mutationQueue.claimForRecovery(eventId);
        if (mutation !== null) options.mutationQueue.fail(eventId);
        continue;
      }
      throw new Error(
        "Verified PR maintenance publication no longer matches GitHub",
      );
    }
    const mutation = options.mutationQueue.claimForRecovery(eventId);
    if (mutation === null)
      throw new Error("Could not reclaim interrupted PR maintenance mutation");
    let owned = stored;
    if (owned.status === "uncertain")
      owned = options.maintenanceStore.claimForRecovery(
        owned.operationId,
        owned,
      );
    else if (owned.status === "active")
      owned = options.maintenanceStore.claimForRecovery(
        owned.operationId,
        owned,
      );
    else
      throw new Error(
        "Published PR maintenance has no recoverable owner state",
      );
    if (owned.publication?.status === "push-intended")
      options.maintenanceStore.recordPublication(
        owned.operationId,
        owned,
        "verified",
        owned.publication.resultingHead,
      );
    const latest = options.taskStore.read(stored.cardId)!;
    if (latest.pullRequest?.headSha !== stored.publication.resultingHead) {
      options.taskStore.compareAndSwap(latest.cardId, latest.revision, {
        ...latest,
        pullRequest: {
          ...latest.pullRequest!,
          headSha: stored.publication.resultingHead,
        },
        reviewObservation: undefined,
        revision: latest.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
        ).toISOString(),
      });
    }
    writeTrustedCommitState(options.project, stored.cardId, {
      version: 1,
      kind: "trusted-commit",
      projectId: options.project.id,
      cardId: stored.cardId,
      taskBranch: `agent/${stored.cardId}`,
      defaultBranch: options.project.repository.defaultBranch,
      commitSha: stored.publication.resultingHead,
    });
    options.maintenanceStore.advance(
      owned.operationId,
      "active",
      "completed",
      owned,
    );
    options.mutationQueue.complete(eventId);
  }
}
