import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { inspectPrimaryOpenCodeSession } from "../opencode/inspect-primary-session.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  getLegacyPublishedGitHubReadRecoveryPhase,
  isLegacyFeedbackClassificationFailure,
} from "../task-session/reconcile-task-session.js";
import { assertOwnedTaskWorktreePath } from "../task-session/run-task-session-implementation.js";
import { startupStopProofForExecution } from "../task-session/startup-stop-attestation.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { assertTaskResourceProvenance, runTaskResources } from "../task-session/task-resources.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { readPendingCommitState, readTrustedCommitState } from "./trusted-commit-state.js";
import { readTerminalPrFence } from "../task-session/terminal-pr-fence.js";
import {
  readOwnedProcessInventory,
  processInventoryEntryStopped,
  journalProvesGitHubProcessNeverStarted,
} from "../task-session/owned-process-inventory.js";

/** Narrow recovery for an idle, published classification failure. This does not
 * authorize resuming a failed mutation or an unknown writer. */
export async function inspectPublishedFeedbackRecovery(options: {
  project: ProjectConfig;
  authority: ProjectRunAuthority;
  card: TrelloCard;
  task: TaskExecutionRecord;
  git: GitClient;
  github: GitHubClient;
  commands: CommandRunner;
  signal: AbortSignal;
}) {
  const { project, authority, card, task, git, github, commands, signal } = options;
  authority.assertHeld();
  const run = authority.store.read();
  if (
    readTerminalPrFence(authority) ||
    !run ||
    card.id !== run.cardId ||
    !task.pullRequest ||
    !task.primarySessionId ||
    !isLegacyFeedbackClassificationFailure(task) ||
    getLegacyPublishedGitHubReadRecoveryPhase(run, task) !== "human-feedback"
  )
    throw new Error("Attempt is not an idle published feedback-classification checkpoint");
  if (
    card.idList !== project.trello.reviewListId ||
    (task.expectedTrelloListId !== undefined && task.expectedTrelloListId !== card.idList) ||
    task.feedbackCardMove !== undefined
  )
    throw new Error("Published feedback recovery requires the original Human Review membership");
  const queue = new TaskMutationQueue(run.pinned.storageRoot, project, authority);
  if (
    queue.getActive() ||
    queue
      .list()
      .some(
        (item) =>
          ["active", "failed"].includes(item.status) ||
          (item.status === "queued" && item.cardId !== card.id),
      )
  )
    throw new Error("Published feedback recovery has conflicting mutation ownership");
  const resources = runTaskResources(run);
  if (
    !run.resources.some(
      (resource) => resource.kind === "worktree" && resource.path === resources.path,
    ) ||
    resources.branch !== task.expectedBranch
  )
    throw new Error("Published feedback recovery requires the recorded branch and worktree");
  assertTaskResourceProvenance(run);
  assertOwnedTaskWorktreePath(project, resources.path);
  const store = new TaskExecutionStore(run.pinned.storageRoot, project, authority);
  const executions = readOwnedProcessInventory(store, card.id);
  if (executions.size === 0)
    throw new Error("Published feedback recovery is missing process termination evidence");
  const boundIds = [
    task.setup?.executionId,
    task.sessionCreationExecutionId,
    ...Object.values(task.primaryOperations ?? {}).map((operation) => operation.processExecutionId),
  ].filter((id): id is string => id !== undefined);
  if (boundIds.some((id) => !executions.has(id)))
    throw new Error("Published feedback recovery lacks bound process evidence");
  for (const { file, metadata } of executions.values()) {
    if (
      !processInventoryEntryStopped(metadata) &&
      !journalProvesGitHubProcessNeverStarted(authority, metadata) &&
      !startupStopProofForExecution({
        adopt: false,
        authority,
        task,
        file,
        metadata,
      })
    )
      throw new Error(
        `Published feedback recovery lacks verified process termination; diagnostics: ${path.relative(run.pinned.storageRoot, file)}`,
      );
  }
  const head = task.pullRequest.headSha;
  if (
    !head ||
    readPendingCommitState(project, card.id) ||
    readTrustedCommitState(project, card.id)?.commitSha !== head ||
    (await git.getHeadSha(resources.path)) !== head
  )
    throw new Error(
      "Published feedback recovery trusted commit or local HEAD differs from the recorded PR head",
    );
  if (
    (await git.getCurrentBranch(resources.path)) !== resources.branch ||
    (await git.getCommonGitDirectory(resources.path)) !==
      (await git.getCommonGitDirectory(run.pinned.repositoryPath)) ||
    (await git.getRebaseState(resources.path)) !== null ||
    (await git.getMergeHead(resources.path)) !== null ||
    (await git.getStatus(resources.path)).trim() !== ""
  )
    throw new Error("Published feedback recovery requires the unchanged owned worktree and branch");
  if (
    (await git.getRemoteBranchSha(
      run.pinned.repositoryPath,
      "origin",
      resources.branch,
      project,
    )) !== head
  )
    throw new Error(
      "Published feedback recovery remote branch no longer matches the recorded PR head",
    );
  if (
    (await inspectPrimaryOpenCodeSession({
      commands,
      cwd: resources.path,
      sessionId: task.primarySessionId,
      timeoutMilliseconds: 30_000,
      signal,
    })) !== "reachable"
  )
    throw new Error("Published feedback recovery cannot verify the original primary session");
  const pr = await github.findPullRequestState({
    project,
    cwd: run.pinned.repositoryPath,
    repository: run.pinned.repository,
    headBranch: resources.branch,
    baseBranch: project.repository.defaultBranch,
  });
  const [owner, repository] = run.pinned.repository.toLowerCase().split("/");
  if (
    !pr ||
    pr.state !== "OPEN" ||
    pr.mergedAt !== null ||
    pr.url !== task.pullRequest.url ||
    Number(new URL(pr.url).pathname.split("/").at(-1)) !== task.pullRequest.number ||
    pr.headRefOid !== head ||
    pr.headRefName !== resources.branch ||
    pr.baseRefName !== project.repository.defaultBranch ||
    pr.headRepositoryOwner?.login.toLowerCase() !== owner ||
    pr.headRepository?.name.toLowerCase() !== repository
  )
    throw new Error(
      "Published feedback recovery cannot verify the recorded open PR and exact head",
    );
  signal.throwIfAborted();
  authority.assertHeld();
  if (
    store.read(card.id)?.revision !== task.revision ||
    queue.getActive() ||
    readTerminalPrFence(authority)
  )
    throw new Error("Published feedback recovery task or queue changed during inspection");
  return {
    attemptId: run.attemptId,
    cardId: card.id,
    branch: resources.branch,
    head,
    pullRequestUrl: task.pullRequest.url,
  };
}

export function restorePublishedFeedbackCheckpoint(
  store: TaskExecutionStore,
  task: TaskExecutionRecord,
): void {
  store.compareAndSwap(task.cardId, task.revision, {
    ...task,
    phase: "human-feedback",
    recoveryAttentionReason: undefined,
    recoveryWait: undefined,
    revision: task.revision + 1,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString(),
  });
}
