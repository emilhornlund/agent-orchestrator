import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { GitClient } from "../git/git-client.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { transitionTaskExecutionRecord } from "../task-session/task-execution-transition.js";

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
  github: Pick<GitHubClient, "getPullRequestStateByNumber">;
  git: Pick<GitClient, "hasEquivalentImplementationCommit">;
  taskStore: TaskExecutionStore;
  queue: TaskMutationQueue;
  trello: TrelloClient;
  readTrelloListId: () => Promise<string>;
  doneListId: string;
}): Promise<void> {
  const { project, association, taskStore, queue } = options;
  if (
    association.projectId !== project.id ||
    association.cardId.trim() !== association.cardId ||
    association.implementationCommit.trim() !==
      association.implementationCommit ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(
      association.implementationCommit,
    ) ||
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
    record.expectedBranch !== `agent/${association.cardId}`
  ) {
    throw new Error(
      "External recovery does not match an attention-required task",
    );
  }

  const [repositoryOwner, repositoryName] =
    project.repository.github.split("/");
  const pullRequest = await options.github.getPullRequestStateByNumber({
    cwd: project.repository.path,
    repository: project.repository.github,
    pullRequestNumber: association.pullRequestNumber,
    project,
  });
  if (pullRequest === null) {
    throw new Error(
      "External pull request could not be found in the configured repository",
    );
  }
  const url = new URL(pullRequest.url);
  if (
    pullRequest.state !== "MERGED" ||
    pullRequest.mergedAt === null ||
    pullRequest.headRefName !== association.recoveryBranch ||
    pullRequest.baseRefName !== project.repository.defaultBranch ||
    url.hostname !== "github.com" ||
    url.pathname !==
      `/${repositoryOwner}/${repositoryName}/pull/${association.pullRequestNumber}`
  ) {
    throw new Error(
      "External pull request identity or merge target is mismatched",
    );
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
    throw new Error(
      "External recovery requires exactly one matching mutation event",
    );
  }
  const mutation = matchingEvents[0]!;
  const active = queue.getActive();
  if (active !== null && active.eventId !== mutation.eventId)
    throw new Error("Another worker owns the project mutation queue");

  if (
    pullRequest.headRefOid === undefined ||
    !(await options.git.hasEquivalentImplementationCommit({
      project,
      implementationCommit: association.implementationCommit,
      pullRequestNumber: association.pullRequestNumber,
      pullRequestHeadSha: pullRequest.headRefOid,
    }))
  ) {
    throw new Error(
      "External pull request changes do not match the implementation",
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
    throw new Error(
      "Conflicting external recovery intent is already persisted",
    );
  }

  if (
    record.phase === "done" &&
    (existingIntent === undefined || existingIntent.status !== "card-moved")
  ) {
    throw new Error(
      "Completed task has no matching persisted recovery evidence",
    );
  }

  let claimedMutation = false;
  if (mutation.status !== "completed") {
    const claimed = queue.claimForRecovery(mutation.eventId);
    if (claimed === null) {
      throw new Error(
        "Original implementation mutation is still owned by a live worker",
      );
    }
    claimedMutation = true;
  }

  try {
    let latest = taskStore.read(association.cardId);
    if (latest === null)
      throw new Error("Task record disappeared during recovery");

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

      const currentListId = await options.readTrelloListId();
      if (currentListId !== options.doneListId) {
        await options.trello.moveCard(association.cardId, options.doneListId, {
          dueComplete: true,
        });
      }

      latest = taskStore.read(association.cardId);
      if (latest === null)
        throw new Error("Task record disappeared during recovery");
      const occurredAt = new Date(
        Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
      ).toISOString();
      latest = taskStore.compareAndSwap(latest.cardId, latest.revision, {
        ...latest,
        pullRequest: {
          number: association.pullRequestNumber,
          url: pullRequest.url,
          headSha: pullRequest.headRefOid,
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
        occurredAt: new Date(
          Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
        ).toISOString(),
      });
      taskStore.compareAndSwap(latest.cardId, latest.revision, transitioned);
    }

    if (claimedMutation) queue.complete(mutation.eventId);
  } catch (error) {
    if (claimedMutation && queue.ownsActive(mutation.eventId)) {
      queue.fail(mutation.eventId);
    }
    throw error;
  }
}
