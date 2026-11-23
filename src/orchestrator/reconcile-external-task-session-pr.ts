import type { ProjectConfig } from "../config/config.js";
import { taskResources } from "../task-session/task-resources.js";
import type { GitHubClient } from "../github/github-client.js";
import type { GitClient } from "../git/git-client.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { transitionTaskExecutionRecord } from "../task-session/task-execution-transition.js";
import { establishCiCheckExpectations } from "../github/ci-check-expectations.js";
import { evaluateCiChecks } from "../github/evaluate-ci-checks.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { isConclusiveOperationResolution } from "../task-session/run-record.js";
import {
  readOwnedProcessInventory,
  processInventoryEntryStopped,
  journalProvesGitHubProcessNeverStarted,
} from "../task-session/owned-process-inventory.js";
import { startupStopProofForExecution } from "../task-session/startup-stop-attestation.js";
import { TaskExecutionStore as ExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue as MutationQueue } from "../task-session/task-mutation-queue.js";
import { logger } from "../logging/logger.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { z } from "zod";

const externalRecoveryWait = z.strictObject({ reason: z.string(), retryAt: z.string().datetime() });

/** Resume only an association explicitly verified and persisted by a previous
 * release. Never discover an association by branch name or patch similarity. */
export async function resumeRetainedExternalRecovery(options: {
  authority: ProjectRunAuthority;
  project: ProjectConfig;
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
}): Promise<boolean> {
  const { authority, project, trello, git, github } = options;
  const cardId = authority.cardId;
  if (!cardId) return false;
  const taskStore = new ExecutionStore(authority.store.storageRoot, project, authority);
  const task = taskStore.read(cardId);
  const recovery = task?.externalRecovery;
  if (!task || !recovery) return false;
  const key = "retained-external-pr-recovery-wait";
  const prior = authority.read(key, externalRecoveryWait.parse);
  if (prior && Date.now() < Date.parse(prior.retryAt)) return true;
  try {
    const run = authority.store.assertCurrentLease(authority.ownerGeneration);
    if (!run.pendingOperations.every(isConclusiveOperationResolution))
      throw new Error("External recovery awaits conclusive mutation readback");
    const entries = readOwnedProcessInventory(taskStore, cardId);
    const boundIds = [
      task.setup?.executionId,
      task.sessionCreationExecutionId,
      ...Object.values(task.primaryOperations ?? {}).map(
        (operation) => operation.processExecutionId,
      ),
    ].filter((id): id is string => id !== undefined);
    if (
      entries.size === 0 ||
      boundIds.some((id) => !entries.has(id)) ||
      [...entries.values()].some(
        ({ file, metadata }) =>
          !processInventoryEntryStopped(metadata) &&
          !journalProvesGitHubProcessNeverStarted(authority, metadata) &&
          !startupStopProofForExecution({ authority, task, file, metadata, adopt: false }),
      )
    )
      throw new Error("External recovery awaits stopped-process evidence for the original attempt");
    const currentList = (await trello.getCard(cardId)).idList;
    if (
      ![
        project.trello.workingListId,
        project.trello.reviewListId,
        project.trello.doneListId,
      ].includes(currentList)
    )
      throw new Error(
        "External recovery awaits the original Working, Human Review or Done card membership",
      );
    await reconcileExternalTaskSessionPullRequest({
      project,
      association: {
        projectId: project.id,
        cardId,
        implementationCommit: recovery.implementationCommit,
        recoveryBranch: recovery.recoveryBranch,
        pullRequestNumber: recovery.pullRequestNumber,
      },
      github,
      git,
      trello,
      taskStore,
      queue: new MutationQueue(authority.store.storageRoot, project, authority),
      readTrelloListId: async () => (await trello.getCard(cardId)).idList,
      doneListId: project.trello.doneListId,
      release: false,
    });
  } catch (error) {
    const reason = sanitizeControlledText(
      error instanceof Error ? error.message : "External recovery unavailable",
    ).slice(0, 2000);
    const wait = { reason, retryAt: new Date(Date.now() + 60_000).toISOString() };
    authority.mutate(
      key,
      wait,
      () => ({ value: wait, result: undefined }),
      externalRecoveryWait.parse,
    );
    if (reason !== prior?.reason) logger.child({ projectId: project.id, cardId }).warn(reason);
  }
  return true;
}

export interface ExternalTaskSessionRecoveryAssociation {
  projectId: string;
  cardId: string;
  implementationCommit: string;
  recoveryBranch: string;
  pullRequestNumber: number;
}

/**
 * Reconcile an operator-specified external merge after independently verifying
 * its changed content against the original implementation. The GitClient
 * comparison uses normalized zero-context patches, so rebases and squash
 * commits can be verified without trusting commit identity alone. This
 * function never creates or merges a pull request.
 */
export async function reconcileExternalTaskSessionPullRequest(options: {
  project: ProjectConfig;
  association: ExternalTaskSessionRecoveryAssociation;
  github: Pick<
    GitHubClient,
    "getPullRequestStateByNumber" | "getPullRequestCommitShas" | "getCiObservations"
  >;
  git: Pick<GitClient, "hasEquivalentImplementationCommit">;
  taskStore: TaskExecutionStore;
  queue: TaskMutationQueue;
  trello: TrelloClient;
  readTrelloListId: () => Promise<string>;
  doneListId: string;
  release?: boolean;
}): Promise<void> {
  const { project, association, taskStore, queue } = options;
  if (
    typeof association.projectId !== "string" ||
    association.projectId !== project.id ||
    typeof association.cardId !== "string" ||
    association.cardId.trim() !== association.cardId ||
    typeof association.implementationCommit !== "string" ||
    association.implementationCommit.trim() !== association.implementationCommit ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(association.implementationCommit) ||
    typeof association.recoveryBranch !== "string" ||
    association.recoveryBranch.trim() !== association.recoveryBranch ||
    association.recoveryBranch.length === 0 ||
    association.pullRequestNumber < 1 ||
    !Number.isSafeInteger(association.pullRequestNumber)
  ) {
    throw new Error("External recovery association is invalid");
  }

  const record = taskStore.read(association.cardId);
  if (
    record === null ||
    record.projectId !== project.id ||
    (record.phase !== "attention-required" && record.phase !== "done") ||
    record.expectedBranch !== taskResources(project, association.cardId).branch
  ) {
    throw new Error("External recovery does not match an attention-required task");
  }

  if (record.phase === "done") {
    const completedRecovery = record.externalRecovery;
    if (
      completedRecovery === undefined ||
      completedRecovery.status !== "card-moved" ||
      completedRecovery.implementationCommit !== association.implementationCommit ||
      completedRecovery.recoveryBranch !== association.recoveryBranch ||
      completedRecovery.pullRequestNumber !== association.pullRequestNumber
    ) {
      throw new Error("Completed task has no matching persisted recovery evidence");
    }
    const matchingEvents = queue
      .list()
      .filter(
        (event) =>
          event.projectId === project.id &&
          event.cardId === association.cardId &&
          event.kind === "implementation" &&
          event.operationKey === record.operationKey,
      );
    if (matchingEvents.length !== 1)
      throw new Error("External recovery requires exactly one matching mutation event");
    const mutation = matchingEvents[0]!;
    const authority = ProjectRunAuthority.current(project.id);
    if (mutation.status === "completed") {
      if (authority) {
        const pullRequest = await ProjectRunAuthority.dispatch(project.id, () =>
          options.github.getPullRequestStateByNumber({
            cwd: project.repository.path,
            repository: project.repository.github,
            pullRequestNumber: association.pullRequestNumber,
            project,
          }),
        );
        if (
          !pullRequest ||
          pullRequest.state !== "MERGED" ||
          pullRequest.mergedAt === null ||
          pullRequest.url !== completedRecovery.pullRequestUrl
        )
          throw new Error("Completed recovery PR is no longer verified merged");
        const listId = await ProjectRunAuthority.dispatch(project.id, options.readTrelloListId);
        if (listId !== options.doneListId)
          throw new Error("Completed recovery card is not verified in Done");
        const verifiedAt = new Date().toISOString();
        const next = {
          ...record,
          revision: record.revision + 1,
          updatedAt: verifiedAt,
        };
        await taskStore.compareAndSwap(association.cardId, record.revision, next, {
          event: "merged",
          evidence: {
            prOutcome: "merged",
            prObservationId: `external-pr-recovery:${association.pullRequestNumber}:${pullRequest.headRefOid ?? "merged"}`,
            prVerifiedAt: verifiedAt,
            trelloListId: options.doneListId,
            trelloObservationId: `external-pr-done:${association.cardId}:${verifiedAt}`,
            trelloVerifiedAt: verifiedAt,
          },
        });
        if (options.release !== false) await authority.releaseVerifiedTerminal();
      }
      return;
    }
    const active = queue.getActive();
    if (active !== null && active.eventId !== mutation.eventId)
      throw new Error("Another worker owns the project mutation queue");
    const claimed = queue.claimForRecovery(mutation.eventId);
    if (claimed === null)
      throw new Error("Original implementation mutation is still owned by a live worker");
    try {
      queue.complete(mutation.eventId);
    } catch (error) {
      if (queue.ownsActive(mutation.eventId)) queue.releaseForRecovery(mutation.eventId);
      throw error;
    }
    return;
  }

  const [repositoryOwner, repositoryName] = project.repository.github.split("/");
  const pullRequest = await ProjectRunAuthority.dispatch(project.id, () =>
    options.github.getPullRequestStateByNumber({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestNumber: association.pullRequestNumber,
      project,
    }),
  );
  if (pullRequest === null) {
    throw new Error("External pull request could not be found in the configured repository");
  }
  const url = new URL(pullRequest.url);
  if (
    pullRequest.state !== "MERGED" ||
    pullRequest.mergedAt === null ||
    pullRequest.headRefName !== association.recoveryBranch ||
    pullRequest.baseRefName !== project.repository.defaultBranch ||
    url.hostname !== "github.com" ||
    url.pathname !== `/${repositoryOwner}/${repositoryName}/pull/${association.pullRequestNumber}`
  ) {
    throw new Error("External pull request identity or merge target is mismatched");
  }

  const pullRequestCommitShas = await ProjectRunAuthority.dispatch(project.id, () =>
    options.github.getPullRequestCommitShas({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestNumber: association.pullRequestNumber,
      project,
    }),
  );
  const pullRequestHeadSha = pullRequest.headRefOid;
  if (
    pullRequestHeadSha === undefined ||
    !pullRequestCommitShas.some((sha) => sha.toLowerCase() === pullRequestHeadSha.toLowerCase())
  ) {
    throw new Error("Merged pull request has incomplete commit evidence");
  }

  const matchingEvents = queue
    .list()
    .filter(
      (event) =>
        event.projectId === project.id &&
        event.cardId === association.cardId &&
        event.kind === "implementation" &&
        event.operationKey === record.operationKey,
    );
  if (matchingEvents.length !== 1) {
    throw new Error("External recovery requires exactly one matching mutation event");
  }
  const mutation = matchingEvents[0]!;
  const active = queue.getActive();
  if (active !== null && active.eventId !== mutation.eventId)
    throw new Error("Another worker owns the project mutation queue");

  if (
    !(await ProjectRunAuthority.dispatch(project.id, () =>
      options.git.hasEquivalentImplementationCommit({
        project,
        implementationCommit: association.implementationCommit,
        pullRequestNumber: association.pullRequestNumber,
        pullRequestHeadSha,
        pullRequestCommitShas,
      }),
    ))
  ) {
    throw new Error("External pull request changes do not match the implementation");
  }

  const observations = await ProjectRunAuthority.dispatch(project.id, () =>
    options.github.getCiObservations({
      cwd: project.repository.path,
      repository: project.repository.github,
      defaultBranch: project.repository.defaultBranch,
      baseBranch: project.repository.defaultBranch,
      headSha: pullRequestHeadSha,
      pullRequestNumber: association.pullRequestNumber,
      project,
    }),
  );
  const ciEvaluation = evaluateCiChecks({
    expectedHeadSha: pullRequestHeadSha,
    observedHeadSha: observations.headSha,
    expectations: establishCiCheckExpectations(observations.expectationSources),
    checks: observations.checks,
  });
  if (ciEvaluation.status !== "passed") {
    const diagnostic = "diagnostic" in ciEvaluation ? `: ${ciEvaluation.diagnostic}` : "";
    throw new Error(
      `Merged pull request publication checks are not verified: ${ciEvaluation.status}${diagnostic}`,
    );
  }

  const existingIntent = record.externalRecovery;
  const intent = {
    implementationCommit: association.implementationCommit,
    recoveryBranch: association.recoveryBranch,
    pullRequestNumber: association.pullRequestNumber,
    pullRequestUrl: pullRequest.url,
    status: "verified" as const,
    requestedAt: existingIntent?.requestedAt ?? new Date().toISOString(),
  };
  if (
    existingIntent !== undefined &&
    (existingIntent.implementationCommit !== intent.implementationCommit ||
      existingIntent.recoveryBranch !== intent.recoveryBranch ||
      existingIntent.pullRequestNumber !== intent.pullRequestNumber ||
      existingIntent.pullRequestUrl !== intent.pullRequestUrl)
  ) {
    throw new Error("Conflicting external recovery intent is already persisted");
  }

  let claimedMutation = false;
  if (mutation.status !== "completed") {
    const claimed = queue.claimForRecovery(mutation.eventId);
    if (claimed === null) {
      throw new Error("Original implementation mutation is still owned by a live worker");
    }
    claimedMutation = true;
  }

  try {
    let latest = taskStore.read(association.cardId);
    if (latest === null) throw new Error("Task record disappeared during recovery");

    if (latest.phase !== "done") {
      if (latest.externalRecovery?.status !== "move-pending") {
        const occurredAt = new Date(
          Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
        ).toISOString();
        latest = taskStore.compareAndSwap(latest.cardId, latest.revision, {
          ...latest,
          externalRecovery: { ...intent, status: "move-pending" },
          revision: latest.revision + 1,
          updatedAt: occurredAt,
        });
      }

      const currentListId = await ProjectRunAuthority.dispatch(
        project.id,
        options.readTrelloListId,
      );
      if (currentListId !== options.doneListId) {
        await ProjectRunAuthority.dispatch(project.id, () =>
          options.trello.moveCard(association.cardId, options.doneListId, {
            dueComplete: true,
          }),
        );
      }

      const authority = ProjectRunAuthority.current(project.id);
      if (authority) {
        const confirmedListId = await ProjectRunAuthority.dispatch(
          project.id,
          options.readTrelloListId,
        );
        if (confirmedListId !== options.doneListId)
          throw new Error("Trello did not confirm the external recovery Done move");
      }

      latest = taskStore.read(association.cardId);
      if (latest === null) throw new Error("Task record disappeared during recovery");
      const occurredAt = new Date(
        Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
      ).toISOString();
      latest = taskStore.compareAndSwap(latest.cardId, latest.revision, {
        ...latest,
        pullRequest: {
          number: association.pullRequestNumber,
          url: pullRequest.url,
          headSha: pullRequestHeadSha,
        },
        externalRecovery: { ...intent, status: "card-moved" },
        revision: latest.revision + 1,
        updatedAt: occurredAt,
      });

      const transitioned = transitionTaskExecutionRecord(latest, {
        type: "external-pull-request-reconciled",
        eventId: `${latest.operationKey}:external-pr-reconciled:${association.pullRequestNumber}`,
        projectId: project.id,
        cardId: association.cardId,
        operationKey: latest.operationKey,
        occurredAt: new Date(Math.max(Date.now(), Date.parse(latest.updatedAt) + 1)).toISOString(),
      });
      if (!authority) taskStore.compareAndSwap(latest.cardId, latest.revision, transitioned);
      if (claimedMutation) {
        queue.complete(mutation.eventId);
        claimedMutation = false;
      }
      const terminalAt = new Date(
        Math.max(Date.now(), Date.parse(transitioned.updatedAt) + 1),
      ).toISOString();
      if (authority) {
        await taskStore.compareAndSwap(
          latest.cardId,
          latest.revision,
          { ...transitioned, updatedAt: terminalAt },
          {
            event: "merged",
            evidence: {
              prOutcome: "merged",
              prObservationId: `external-pr-recovery:${association.pullRequestNumber}:${pullRequestHeadSha}`,
              prVerifiedAt: terminalAt,
              trelloListId: options.doneListId,
              trelloObservationId: `external-pr-done:${association.cardId}:${terminalAt}`,
              trelloVerifiedAt: terminalAt,
            },
          },
        );
        if (options.release !== false) await authority.releaseVerifiedTerminal();
      }
    }

    if (claimedMutation) queue.complete(mutation.eventId);
  } catch (error) {
    if (claimedMutation && queue.ownsActive(mutation.eventId)) {
      const latest = taskStore.read(association.cardId);
      if (latest?.phase === "done") {
        queue.releaseForRecovery(mutation.eventId);
      } else {
        queue.fail(mutation.eventId);
      }
    }
    throw error;
  }
}
