import type { ProjectConfig } from "../config/config.js";
import { taskResources } from "../task-session/task-resources.js";
import type {
  ChangesRequestedPullRequest,
  GitHubClient,
  PullRequestState,
  PullRequestConversationComment,
} from "../github/github-client.js";
import {
  establishCiCheckExpectations,
  type CiCheckExpectationDecision,
} from "../github/ci-check-expectations.js";
import { evaluateCiChecks, type CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { logger } from "../logging/logger.js";
import { verifyMergedTaskPrHeadContinuity } from "./verify-merged-task-pr-head-continuity.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { recordTerminalPrFence } from "../task-session/terminal-pr-fence.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";

const reportedOutdatedPullRequests = new Map<string, string>();

/** Observation is advisory and never holds a published PR indefinitely. */
export const CI_OBSERVATION_TIMEOUT_MS = 30 * 60_000;

export interface ObservedTaskSessionReviewCard {
  state: "OPEN";
  cardId: string;
  pullRequestUrl: string;
  headSha: string;
  ciEvaluation: CiCheckEvaluation;
  expectedCheckNames: string[];
  feedbackIds: string[];
  requestedChanges: ChangesRequestedPullRequest | null;
  conversationComments: PullRequestConversationComment[];
  automationActor?: string | null;
  baseRelation: "current" | "behind" | "diverged" | "uncertain";
}

export interface ObservedTerminalTaskSessionPullRequest {
  state: "MERGED" | "CLOSED";
  cardId: string;
  pullRequestUrl: string;
  headSha: string | null;
  pullRequest: PullRequestState;
}

export type TaskSessionPullRequestObservation =
  ObservedTaskSessionReviewCard | ObservedTerminalTaskSessionPullRequest;

export interface ObserveTaskSessionReviewCardsOptions {
  project: ProjectConfig;
  cards: readonly TrelloCard[];
  taskRecordStore: TaskExecutionStore;
  github: GitHubClient;
  cwd?: string;
  terminalOnlyCardIds?: ReadonlySet<string>;
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

async function terminalObservation(
  options: ObserveTaskSessionReviewCardsOptions,
  record: TaskExecutionRecord,
  pr: PullRequestState,
): Promise<ObservedTerminalTaskSessionPullRequest> {
  const { project, github } = options;
  const [owner, repository] = project.repository.github.split("/");
  if (
    !record.pullRequest?.headSha ||
    pr.state === "OPEN" ||
    pr.url !== record.pullRequest.url ||
    !pr.headRefOid ||
    pr.baseRefName !== project.repository.defaultBranch ||
    pr.headRefName !== taskResources(options.project, record.cardId).branch ||
    pr.headRepository?.name.toLowerCase() !== repository?.toLowerCase() ||
    pr.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase() ||
    (pr.state === "MERGED") !== (pr.mergedAt !== null)
  )
    throw new Error(
      `Terminal pull request metadata or ownership is ambiguous for Human Review card ${record.cardId}`,
    );
  const authority = ProjectRunAuthority.current(project.id);
  const active = authority
    ? new TaskMutationQueue(authority.store.storageRoot, project, authority).getActive()
    : null;
  const fence = authority
    ? recordTerminalPrFence(
        authority,
        record,
        pr,
        active !== null && active.kind !== "terminal-pr",
        project.repository.defaultBranch,
      )
    : null;
  if (pr.state === "MERGED" && !fence?.preserveArtifacts)
    await verifyMergedTaskPrHeadContinuity({
      github,
      project,
      cwd: options.cwd ?? project.repository.path,
      pullRequestNumber: record.pullRequest.number,
      recordedHeadSha: record.pullRequest.headSha,
      mergedHeadSha: pr.headRefOid,
    });
  return {
    state: pr.state,
    cardId: record.cardId,
    pullRequestUrl: pr.url,
    headSha: pr.headRefOid,
    pullRequest: pr,
  };
}

export async function observeTaskSessionReviewCards(
  options: ObserveTaskSessionReviewCardsOptions,
): Promise<TaskSessionPullRequestObservation[]> {
  const { project, cards, taskRecordStore, github } = options;
  const observed: TaskSessionPullRequestObservation[] = [];
  for (const card of cards) {
    const record = taskRecordStore.read(card.id);
    if (record === null) continue;
    const failedFeedbackReview =
      record.phase === "review" &&
      record.reviewRepair?.status === "exhausted" &&
      record.feedbackRemediation?.status === "changed" &&
      record.feedbackRecoveryAttemptEventId !== record.feedbackRemediation.operationId;
    const owningFeedbackCheckpoint =
      record.feedbackRemediation?.status === "changed" &&
      (record.phase === "validation" ||
        record.phase === "review" ||
        (record.phase === "implementation" &&
          record.reviewRepair?.activePrimaryOperation !== undefined));
    const owningCiReviewCheckpoint =
      record.ciRepair?.activePrimaryOperation !== undefined &&
      record.reviewRepair !== undefined &&
      ["implementation", "validation", "review"].includes(record.phase);
    // Persisted PR identity, rather than the transient correction checkpoint,
    // is the durable authority for observing merge/close. Feedback corrections
    // can move through implementation, validation, review, and publication.
    if (record.pullRequest === undefined) continue;
    if (
      record.projectId !== project.id ||
      record.cardId !== card.id ||
      record.expectedBranch !== taskResources(project, card.id).branch ||
      record.pullRequest === undefined
    ) {
      throw new Error(`Owned Human Review task has ambiguous task-record identity: ${card.id}`);
    }
    const headSha = record.pullRequest.headSha;
    if (headSha === undefined) {
      throw new Error(`Owned Human Review task has no persisted expected PR head: ${card.id}`);
    }
    const lookup = {
      cwd: options.cwd ?? project.repository.path,
      repository: project.repository.github,
      headBranch: taskResources(project, card.id).branch,
      baseBranch: project.repository.defaultBranch,
      project,
    };
    const pullRequest = await github.findPullRequestState(lookup);
    if (pullRequest === null || pullRequest.url !== record.pullRequest.url) {
      throw new Error(
        `Authoritative pull request identity changed for Human Review card ${card.id}`,
      );
    }
    if (pullRequest.state !== "OPEN") {
      observed.push(await terminalObservation(options, record, pullRequest));
      continue;
    }
    if (
      options.terminalOnlyCardIds?.has(card.id) ||
      (record.phase !== "human-feedback" &&
        record.phase !== "ci" &&
        !failedFeedbackReview &&
        !owningFeedbackCheckpoint &&
        !owningCiReviewCheckpoint)
    )
      continue;
    if (pullRequest.headRefOid !== headSha) {
      throw new Error(
        `Authoritative pull request identity or head changed for Human Review card ${card.id}`,
      );
    }
    const [owner, repository] = project.repository.github.split("/");
    const expectedNumber = Number(new URL(record.pullRequest.url).pathname.split("/").at(-1));
    const hasVerifiedOpenIdentity =
      pullRequest.baseRefName !== undefined &&
      pullRequest.headRefName !== undefined &&
      pullRequest.headRepository !== undefined &&
      pullRequest.headRepositoryOwner !== undefined;
    if (
      hasVerifiedOpenIdentity &&
      (pullRequest.baseRefName !== project.repository.defaultBranch ||
        pullRequest.headRefName !== taskResources(project, card.id).branch ||
        pullRequest.headRepository?.name.toLowerCase() !== repository?.toLowerCase() ||
        pullRequest.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase())
    ) {
      throw new Error(
        `Open pull request metadata or ownership is ambiguous for Human Review card ${card.id}`,
      );
    }
    let baseRelation: "current" | "behind" | "diverged" | "uncertain" = "uncertain";
    if (hasVerifiedOpenIdentity && typeof github.comparePullRequestHeadToBase === "function") {
      try {
        baseRelation = await github.comparePullRequestHeadToBase({
          cwd: lookup.cwd,
          repository: project.repository.github,
          baseBranch: project.repository.defaultBranch,
          headSha,
          project,
        });
      } catch {
        baseRelation = "uncertain";
      }
    }
    const diagnosticKey = `${project.id}:${expectedNumber}`;
    if (baseRelation === "behind" || baseRelation === "diverged") {
      const identity = `${baseRelation}:${headSha}`;
      if (reportedOutdatedPullRequests.get(diagnosticKey) !== identity) {
        logger
          .child({ projectId: project.id, cardId: card.id })
          .warn(
            `Owned Human Review PR #${expectedNumber} is outdated (${baseRelation} configured base ${project.repository.defaultBranch})`,
          );
        reportedOutdatedPullRequests.set(diagnosticKey, identity);
      }
    } else {
      reportedOutdatedPullRequests.delete(diagnosticKey);
    }
    const [ciObservation, requestedChanges, conversationComments] = await Promise.all([
      github.getCiObservations({
        cwd: lookup.cwd,
        repository: project.repository.github,
        defaultBranch: project.repository.defaultBranch,
        headSha,
        pullRequestNumber: Number(new URL(record.pullRequest.url).pathname.split("/").at(-1)),
        project,
      }),
      github.findChangesRequestedPullRequest(lookup, true),
      github.getPullRequestConversationComments({
        cwd: lookup.cwd,
        repository: project.repository.github,
        pullRequestUrl: record.pullRequest.url,
        project,
      }),
    ]);
    const expectationDecision: CiCheckExpectationDecision = establishCiCheckExpectations(
      ciObservation.expectationSources,
    );
    const ciEvaluation = evaluateCiChecks({
      expectedHeadSha: headSha,
      observedHeadSha: ciObservation.headSha,
      expectations: expectationDecision,
      checks: ciObservation.checks,
    });
    const finalPullRequest = await github.findPullRequestState(lookup);
    if (finalPullRequest && finalPullRequest.state !== "OPEN") {
      observed.push(await terminalObservation(options, record, finalPullRequest));
      continue;
    }
    if (
      (requestedChanges !== null && requestedChanges.headSha !== headSha) ||
      finalPullRequest === null ||
      finalPullRequest.state !== "OPEN" ||
      finalPullRequest.url !== record.pullRequest.url ||
      finalPullRequest.headRefOid !== headSha
    ) {
      throw new Error(`Pull request head changed while monitoring Human Review card ${card.id}`);
    }
    const feedbackIds = [
      ...(requestedChanges?.feedback.reviews.flatMap((review) => [
        `review:${review.id}`,
        ...review.inlineComments.flatMap((comment) =>
          comment.id === undefined ? [] : [`inline-comment:${comment.id}`],
        ),
      ]) ?? []),
      ...conversationComments.map((comment) => `conversation-comment:${comment.id}`),
    ].sort();
    const latest = taskRecordStore.read(card.id);
    if (latest === null || latest.revision !== record.revision || latest.phase !== record.phase) {
      throw new Error(`Task record changed during read-only review monitoring for card ${card.id}`);
    }
    const openObservation: ObservedTaskSessionReviewCard = {
      state: "OPEN",
      cardId: card.id,
      pullRequestUrl: record.pullRequest.url,
      headSha,
      ciEvaluation,
      expectedCheckNames: expectationDecision.expectedCheckNames,
      feedbackIds,
      requestedChanges,
      conversationComments,
      baseRelation,
      ...(typeof github.getAutomationActor === "function"
        ? {
            automationActor: await github.getAutomationActor({
              cwd: lookup.cwd,
              project,
            }),
          }
        : {}),
    };
    if (failedFeedbackReview || owningFeedbackCheckpoint || owningCiReviewCheckpoint) {
      observed.push(openObservation);
      continue;
    }
    taskRecordStore.compareAndSwap(card.id, latest.revision, {
      ...latest,
      ciObservationWindow: (() => {
        const previous = latest.ciObservationWindow;
        const startedAt =
          previous?.headSha === headSha ? previous.startedAt : new Date().toISOString();
        const deadline =
          previous?.headSha === headSha
            ? previous.deadline
            : new Date(Date.parse(startedAt) + CI_OBSERVATION_TIMEOUT_MS).toISOString();
        return {
          headSha,
          startedAt,
          deadline,
          timedOut:
            (ciEvaluation.status === "waiting" || ciEvaluation.status === "uncertain") &&
            Date.now() >= Date.parse(deadline),
        };
      })(),
      reviewObservation: {
        headSha,
        observedAt: nextTimestamp(latest.updatedAt),
        ciEvaluation: {
          status: ciEvaluation.status,
          expectedCheckNames: expectationDecision.expectedCheckNames,
          missingChecks: ciEvaluation.status === "waiting" ? ciEvaluation.missingChecks : [],
          pendingChecks: ciEvaluation.status === "waiting" ? ciEvaluation.pendingChecks : [],
          failureCheckNames:
            ciEvaluation.status === "failed"
              ? [
                  ...new Set(
                    ciEvaluation.failures.map((check) =>
                      check.source === "check-run" ? check.name : check.context,
                    ),
                  ),
                ]
              : [],
          ...(ciEvaluation.status === "waiting" || ciEvaluation.status === "uncertain"
            ? { diagnostic: ciEvaluation.diagnostic }
            : {}),
        },
        feedbackIds,
      },
      revision: latest.revision + 1,
      updatedAt: nextTimestamp(latest.updatedAt),
    });
    observed.push(openObservation);
  }
  return observed;
}
