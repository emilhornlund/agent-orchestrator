import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient, PullRequestState } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import type { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { isConclusiveOperationResolution, type RunRecord } from "../task-session/run-record.js";
import { logger } from "../logging/logger.js";
import { assertTaskResourceProvenance, runTaskResources } from "../task-session/task-resources.js";
import { assertOwnedTaskWorktreePath } from "../task-session/run-task-session-implementation.js";
import {
  otherTaskWriterIsActive,
  readTerminalPrFence,
  recordTerminalPrFence,
} from "../task-session/terminal-pr-fence.js";
import {
  journalProvesGitHubProcessNeverStarted,
  processInventoryEntryStopped,
  readOwnedProcessInventory,
} from "../task-session/owned-process-inventory.js";
import { startupStopProofForExecution } from "../task-session/startup-stop-attestation.js";
import {
  readPendingCommitState,
  readRejectedCommitState,
  readTrustedCommitState,
} from "./trusted-commit-state.js";

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Legacy recovery could escalate if a PR changed between the poll and its
 * recovery snapshot. Only reopen that specific checkpoint after full adoption. */
export function externalHeadAttentionPhase(run: RunRecord, task: TaskExecutionRecord) {
  if (
    run.lifecycle !== "waiting" ||
    run.publicationState !== "open" ||
    task.phase !== "attention-required" ||
    !task.pullRequest ||
    run.wait?.reason !== "task-attention-required" ||
    task.recoveryAttentionReason !==
      "Persisted and authoritative pull request identity/head are ambiguous"
  )
    return null;
  return run.checkpoint === "human-review"
    ? "human-feedback"
    : run.checkpoint === "ci"
      ? "ci"
      : null;
}

function assertExternalHeadPrIdentity(
  project: ProjectConfig,
  task: TaskExecutionRecord,
  pr: PullRequestState,
): asserts pr is PullRequestState & { headRefOid: string } {
  const [owner, repository] = project.repository.github.toLowerCase().split("/");
  if (
    !task.pullRequest ||
    task.pullRequest.url.toLowerCase() !==
      `https://github.com/${owner}/${repository}/pull/${task.pullRequest.number}` ||
    pr.url !== task.pullRequest.url ||
    pr.headRefName !== task.expectedBranch ||
    pr.baseRefName !== project.repository.defaultBranch ||
    pr.headRepositoryOwner?.login.toLowerCase() !== owner ||
    pr.headRepository?.name.toLowerCase() !== repository ||
    !pr.headRefOid ||
    !sha.test(pr.headRefOid) ||
    (pr.state === "MERGED") !== (pr.mergedAt !== null)
  )
    throw new Error(
      "External PR head reconciliation cannot verify the original PR number, repository, head and base branches",
    );
}

function stoppedFailureBaseline(task: TaskExecutionRecord): string[] | null | undefined {
  const prior = task.externalHeadAdoption?.stoppedCiFailures;
  if (task.ciRepair?.status !== "stopped" && task.ciRepair?.status !== "exhausted") return prior;
  const observation = task.reviewObservation;
  if (
    prior === null ||
    !observation ||
    observation.headSha !== task.ciRepair.headSha ||
    observation.ciEvaluation.status !== "failed" ||
    observation.ciEvaluation.failureCheckNames.length === 0
  )
    return null;
  return [...new Set([...(prior ?? []), ...observation.ciEvaluation.failureCheckNames])];
}

/** Only the polling writer calls this. There are no GitHub or Trello writes in
 * adoption: local Git is read back before a single canonical publication CAS. */
export async function reconcileExternalOpenPrHead(options: {
  project: ProjectConfig;
  card: TrelloCard;
  git: GitClient;
  github: GitHubClient;
  taskStore: TaskExecutionStore;
  queue: TaskMutationQueue;
  maintenanceStore: PrMaintenanceStore;
  feedbackLedgerStore: FeedbackLedgerStore;
  signal: AbortSignal;
}): Promise<void> {
  const { project, card, git, github, taskStore, queue, signal } = options;
  const authority = ProjectRunAuthority.current(project.id);
  const run = authority?.store.assertCurrentLease(authority.ownerGeneration);
  let task = taskStore.read(card.id);
  if (
    !authority ||
    !run ||
    !task?.pullRequest?.headSha ||
    run.taskKind !== "implementation" ||
    run.publicationState !== "open" ||
    run.cardId !== card.id ||
    task.cardId !== card.id ||
    task.projectId !== project.id ||
    run.operation.id !== task.operationKey ||
    run.pinned.repositoryPath !== project.repository.path ||
    run.pinned.repository !== project.repository.github ||
    run.sessions.primary !== task.primarySessionId ||
    !task.primarySessionId ||
    !sha.test(task.pullRequest.headSha) ||
    !run.resources.some(
      (r) =>
        r.kind === "pull-request" &&
        r.id === String(task!.pullRequest!.number) &&
        r.path === task!.pullRequest!.url,
    )
  )
    throw new Error(
      "External PR head reconciliation requires the original canonical published attempt",
    );

  const published = { ...task.pullRequest, headSha: task.pullRequest.headSha };
  const phase = externalHeadAttentionPhase(run, task) ?? task.phase;
  const { path: cwd, branch } = runTaskResources(run);
  const active = queue.getActive();
  const eventId = `external-pr-head:${task.operationKey}:${published.headSha}`;
  const hasOwnActive = active?.kind === "external-pr-head" && active.cardId === card.id;
  if (readTerminalPrFence(authority)) return;
  if (
    hasOwnActive &&
    active.eventId === task.externalHeadAdoption?.eventId &&
    !task.externalHeadIntent
  ) {
    // Crash between the canonical CAS and completing its queue descriptor.
    if (queue.claimForRecovery(active.eventId)) queue.complete(active.eventId);
    return;
  }
  if (
    (active && (!hasOwnActive || active.eventId !== eventId || active.operationKey !== eventId)) ||
    otherTaskWriterIsActive(authority)
  )
    throw new Error("External PR head reconciliation awaits the existing mutation owner");
  if (
    card.idList !== project.trello.reviewListId ||
    (task.expectedTrelloListId !== undefined && task.expectedTrelloListId !== card.idList) ||
    !["ci", "human-feedback"].includes(phase) ||
    (task.recoveryWait &&
      (task.recoveryWait.kind !== "dependency" ||
        task.recoveryWait.resumePhase !== phase ||
        Date.now() < Date.parse(task.recoveryWait.retryAt))) ||
    task.externalRecovery ||
    task.terminalFailure ||
    task.feedbackCardMove ||
    task.validationRepair?.activePrimaryOperation ||
    task.reviewRepair?.activePrimaryOperation ||
    task.ciRepair?.activePrimaryOperation ||
    (task.feedbackRemediation &&
      (task.feedbackRemediation.status === "active" ||
        (task.feedbackRemediation.status === "no-op" &&
          task.feedbackRemediation.outcomeReported !== true))) ||
    !run.pendingOperations.every(isConclusiveOperationResolution) ||
    (task.sessionRecovery && task.sessionRecovery.status !== "reconstruction-verified") ||
    Object.values(task.primaryOperations ?? {}).some(
      (op) =>
        ["intent", "dispatched", "ambiguous"].includes(op.status) ||
        (op.status === "failed" && op.retrySafe !== true),
    ) ||
    options.maintenanceStore
      .inspect()
      .some(
        (op) =>
          !["completed", "cancelled"].includes(op.status) ||
          op.publication?.status === "push-intended",
      ) ||
    options.feedbackLedgerStore
      .read(card.id)
      ?.entries.some(
        (entry) => entry.replyState === "sending" || entry.replyState === "outcome-unknown",
      ) ||
    readPendingCommitState(project, card.id)
  )
    throw new Error(
      "External PR head reconciliation awaits an idle Human Review checkpoint with all execution and publication effects resolved",
    );

  const executions = readOwnedProcessInventory(taskStore, card.id);
  const boundIds = [
    task.setup?.executionId,
    task.sessionCreationExecutionId,
    ...Object.values(task.primaryOperations ?? {}).map((op) => op.processExecutionId),
  ];
  if (
    !executions.size ||
    boundIds.some((id) => id !== undefined && !executions.has(id)) ||
    [...executions.values()].some(
      ({ file, metadata }) =>
        !processInventoryEntryStopped(metadata) &&
        !journalProvesGitHubProcessNeverStarted(authority, metadata) &&
        !startupStopProofForExecution({ authority, task: task!, file, metadata, adopt: false }),
    )
  )
    throw new Error(
      "External PR head reconciliation awaits verified process termination for the owned attempt",
    );

  if (
    branch !== task.expectedBranch ||
    !run.resources.some((r) => r.kind === "worktree" && r.path === cwd)
  )
    throw new Error("External PR head reconciliation has no pinned worktree and branch");
  assertTaskResourceProvenance(run);
  assertOwnedTaskWorktreePath(project, cwd);
  if (
    (await git.getCommonGitDirectory(cwd)) !==
      (await git.getCommonGitDirectory(run.pinned.repositoryPath)) ||
    (await git.getCurrentBranch(cwd)) !== branch
  )
    throw new Error(
      "External PR head reconciliation worktree metadata does not match the owned branch and repository",
    );
  await git.assertCleanLinkedWorktree(cwd, branch);
  const local = await git.getHeadSha(cwd);
  const intent = task.externalHeadIntent;
  if (
    local !== published.headSha &&
    !(
      hasOwnActive &&
      intent &&
      intent.eventId === eventId &&
      intent.publishedHead === published.headSha &&
      (local === intent.localHead || local === intent.targetHead)
    )
  )
    throw new Error(
      "Local task HEAD has unpublished or unattributed commits; preserve the worktree for inspection",
    );
  const trusted = readTrustedCommitState(project, card.id);
  if (
    !trusted ||
    !sha.test(trusted.commitSha) ||
    (trusted.commitSha !== published.headSha &&
      !(await git.isAncestor(cwd, trusted.commitSha, published.headSha)))
  )
    throw new Error("External PR head reconciliation cannot verify the prior trusted publication");

  const lookup = {
    cwd: run.pinned.repositoryPath,
    repository: run.pinned.repository,
    pullRequestNumber: published.number,
    headBranch: branch,
    baseBranch: project.repository.defaultBranch,
    project,
  };
  const observe = async () => {
    signal.throwIfAborted();
    const pr = await github.getPullRequestStateByNumber(lookup);
    assertExternalHeadPrIdentity(project, task!, pr);
    if (pr.state !== "OPEN") {
      recordTerminalPrFence(
        authority,
        task!,
        pr,
        hasOwnActive || !!task!.externalHeadIntent,
        lookup.baseBranch,
      );
      return null;
    }
    return pr.headRefOid;
  };
  const target = await observe();
  if (target === null) return;
  if (target === published.headSha && !active && !intent) return;
  if (
    target === published.headSha ||
    !(await github.isAncestorCommit({
      ...lookup,
      ancestorSha: published.headSha,
      descendantSha: target,
    }))
  )
    throw new Error(
      `PR head ${target} does not extend the recorded publication ${published.headSha}; inspect remote history`,
    );
  const destinations = await git.resolvePublicationDestinations(cwd, run.pinned.repository);
  const endpoints = new Set([destinations.fetch, destinations.push]);
  const verifyRemote = async () => {
    for (const endpoint of endpoints)
      if ((await git.getRemoteBranchSha(cwd, endpoint, branch, project)) !== target)
        throw new Error("Remote task branch changed or does not match the authoritative PR head");
  };
  await verifyRemote();
  signal.throwIfAborted();
  if (taskStore.read(card.id)?.revision !== task.revision || readTerminalPrFence(authority)) return;
  queue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId,
    operationKey: eventId,
    kind: "external-pr-head",
    enqueuedAt: task.updatedAt,
  });
  if (!queue.claimForRecovery(eventId)) return;
  try {
    await git.fetchBranchObjects(cwd, destinations.fetch, branch, project);
    const rejected = readRejectedCommitState(project, card.id);
    if (
      rejected &&
      (!sha.test(rejected.commitSha) || (await git.isAncestor(cwd, rejected.commitSha, target)))
    )
      throw new Error(
        "Advanced PR head includes a rejected commit; preserve the worktree for inspection",
      );
    if (
      !(await git.isAncestor(cwd, published.headSha, target)) ||
      !(await git.isAncestor(cwd, local, target))
    )
      throw new Error(
        "Fetched branch is not a fast-forward of the recorded and owned local heads; preserve both histories",
      );
    await verifyRemote();
    if ((await observe()) !== target) return;
    await git.assertCleanLinkedWorktree(cwd, branch);
    if (readTerminalPrFence(authority)) return;
    signal.throwIfAborted();
    const updatedAt = () =>
      new Date(Math.max(Date.now(), Date.parse(task!.updatedAt) + 1)).toISOString();
    task = taskStore.compareAndSwap(card.id, task.revision, {
      ...task,
      externalHeadIntent: {
        eventId,
        publishedHead: published.headSha,
        localHead: local,
        targetHead: target,
      },
      revision: task.revision + 1,
      updatedAt: updatedAt(),
    });
    if (local !== target) await git.fastForwardTaskWorktree(cwd, local, target);
    await git.assertCleanLinkedWorktree(cwd, branch);
    if ((await git.getHeadSha(cwd)) !== target || (await git.getCurrentBranch(cwd)) !== branch)
      throw new Error("Task branch did not reach the verified PR head");
    await verifyRemote();
    if ((await observe()) !== target || readTerminalPrFence(authority)) return;
    signal.throwIfAborted();
    const previousState = taskStore.writeSetupArtifact(`external-pr-head-${published.headSha}`, {
      task,
      trusted,
      budgets: run.budgets,
    });
    const stoppedCiFailures = stoppedFailureBaseline(task);
    const carryCiEpisode = task.ciRepair?.status === "active";
    for (const entry of queue.list())
      if (
        entry.cardId === card.id &&
        entry.status === "queued" &&
        ["feedback", "ci-repair", "pr-maintenance"].includes(entry.kind)
      )
        queue.retireSupersededObservation(entry.eventId);
    taskStore.compareAndSwap(
      card.id,
      task.revision,
      {
        ...task,
        pullRequest: { ...published, headSha: target },
        phase,
        recoveryAttentionReason: undefined,
        externalHeadIntent: undefined,
        externalHeadAdoption: {
          eventId,
          previousHead: published.headSha,
          head: target,
          previousState,
          ...(stoppedCiFailures === undefined ? {} : { stoppedCiFailures }),
        },
        reviewObservation: undefined,
        ciObservationWindow: undefined,
        publicationQuality: undefined,
        validationRepair: undefined,
        reviewRepair: undefined,
        reviewRemediationFailure: undefined,
        reviewUnavailable: undefined,
        feedbackRemediation: undefined,
        feedbackRecoveryAttemptEventId: undefined,
        ciRepair: carryCiEpisode
          ? { ...task.ciRepair!, headSha: target, reviewSourceAttempts: undefined }
          : undefined,
        retryCounters: {
          ...task.retryCounters,
          ci: carryCiEpisode ? task.retryCounters.ci : 0,
          validation: 0,
          review: 0,
        },
        revision: task.revision + 1,
        updatedAt: updatedAt(),
      },
      undefined,
      { eventId, trustedHead: trusted.commitSha },
    );
    queue.complete(eventId);
    logger
      .child({ projectId: project.id, cardId: card.id })
      .event(`Adopted external head ${target} for owned PR #${published.number}`);
  } finally {
    if (queue.ownsActive(eventId)) queue.releaseForRecovery(eventId);
  }
}
