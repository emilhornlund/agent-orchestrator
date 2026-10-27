import type { ProjectConfig } from "../config/config.js";
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
import {
  evaluateCiChecks,
  type CiCheckEvaluation,
} from "../github/evaluate-ci-checks.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { logger } from "../logging/logger.js";
import { verifyMergedTaskPrHeadContinuity } from "./verify-merged-task-pr-head-continuity.js";

const reportedOutdatedPullRequests = new Map<string, string>();

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
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
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
      record.feedbackRecoveryAttemptEventId !==
        record.feedbackRemediation.operationId;
    if (
      record.phase !== "human-feedback" &&
      record.phase !== "ci" &&
      !failedFeedbackReview
    ) {
      continue;
    }
    if (
      record.projectId !== project.id ||
      record.cardId !== card.id ||
      record.expectedBranch !== `agent/${card.id}` ||
      record.pullRequest === undefined
    ) {
      throw new Error(
        `Owned Human Review task has ambiguous task-record identity: ${card.id}`,
      );
    }
    const headSha = record.pullRequest.headSha;
    if (headSha === undefined) {
      throw new Error(
        `Owned Human Review task has no persisted expected PR head: ${card.id}`,
      );
    }
    const lookup = {
      cwd: options.cwd ?? project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${card.id}`,
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
      const [owner, repository] = project.repository.github.split("/");
      if (
        pullRequest.baseRefName !== project.repository.defaultBranch ||
        pullRequest.headRefName !== `agent/${card.id}` ||
        pullRequest.headRefOid === undefined ||
        pullRequest.headRepository?.name !== repository ||
        pullRequest.headRepositoryOwner?.login !== owner ||
        (pullRequest.state === "MERGED" && pullRequest.mergedAt === null) ||
        (pullRequest.state === "CLOSED" && pullRequest.mergedAt !== null)
      ) {
        throw new Error(
          `Terminal pull request metadata or ownership is ambiguous for Human Review card ${card.id}`,
        );
      }
      if (pullRequest.state === "MERGED") {
        await verifyMergedTaskPrHeadContinuity({
          github,
          project,
          cwd: lookup.cwd,
          pullRequestNumber: record.pullRequest.number,
          recordedHeadSha: headSha,
          mergedHeadSha: pullRequest.headRefOid,
        });
      } else if (pullRequest.headRefOid !== headSha) {
        throw new Error(
          `Closed pull request head changed for Human Review card ${card.id}`,
        );
      }
      observed.push({
        state: pullRequest.state,
        cardId: card.id,
        pullRequestUrl: pullRequest.url,
        headSha: pullRequest.headRefOid ?? null,
        pullRequest,
      });
      continue;
    }
    if (pullRequest.headRefOid !== headSha) {
      throw new Error(
        `Authoritative pull request identity or head changed for Human Review card ${card.id}`,
      );
    }
    const [owner, repository] = project.repository.github.split("/");
    const expectedNumber = Number(
      new URL(record.pullRequest.url).pathname.split("/").at(-1),
    );
    const hasVerifiedOpenIdentity =
      pullRequest.baseRefName !== undefined &&
      pullRequest.headRefName !== undefined &&
      pullRequest.headRepository !== undefined &&
      pullRequest.headRepositoryOwner !== undefined;
    if (
      hasVerifiedOpenIdentity &&
      (pullRequest.baseRefName !== project.repository.defaultBranch ||
        pullRequest.headRefName !== `agent/${card.id}` ||
        pullRequest.headRepository?.name !== repository ||
        pullRequest.headRepositoryOwner?.login !== owner)
    ) {
      throw new Error(
        `Open pull request metadata or ownership is ambiguous for Human Review card ${card.id}`,
      );
    }
    let baseRelation: "current" | "behind" | "diverged" | "uncertain" =
      "uncertain";
    if (
      hasVerifiedOpenIdentity &&
      typeof github.comparePullRequestHeadToBase === "function"
    ) {
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
    const [ciObservation, requestedChanges, conversationComments] =
      await Promise.all([
        github.getCiObservations({
          cwd: lookup.cwd,
          repository: project.repository.github,
          defaultBranch: project.repository.defaultBranch,
          headSha,
          pullRequestNumber: Number(
            new URL(record.pullRequest.url).pathname.split("/").at(-1),
          ),
          project,
        }),
        github.findChangesRequestedPullRequest(lookup),
        github.getPullRequestConversationComments({
          cwd: lookup.cwd,
          repository: project.repository.github,
          pullRequestUrl: record.pullRequest.url,
          project,
        }),
      ]);
    const expectationDecision: CiCheckExpectationDecision =
      establishCiCheckExpectations(ciObservation.expectationSources);
    const ciEvaluation = evaluateCiChecks({
      expectedHeadSha: headSha,
      observedHeadSha: ciObservation.headSha,
      expectations: expectationDecision,
      checks: ciObservation.checks,
    });
    const finalPullRequest = await github.findPullRequestState(lookup);
    if (
      (requestedChanges !== null && requestedChanges.headSha !== headSha) ||
      finalPullRequest === null ||
      finalPullRequest.state !== "OPEN" ||
      finalPullRequest.url !== record.pullRequest.url ||
      finalPullRequest.headRefOid !== headSha
    ) {
      throw new Error(
        `Pull request head changed while monitoring Human Review card ${card.id}`,
      );
    }
    const feedbackIds = [
      ...(requestedChanges?.feedback.reviews.flatMap((review) => [
        `review:${review.id}`,
        ...review.inlineComments.flatMap((comment) =>
          comment.id === undefined ? [] : [`inline-comment:${comment.id}`],
        ),
      ]) ?? []),
      ...conversationComments.map(
        (comment) => `conversation-comment:${comment.id}`,
      ),
    ].sort();
    const latest = taskRecordStore.read(card.id);
    if (
      latest === null ||
      latest.revision !== record.revision ||
      latest.phase !== record.phase
    ) {
      throw new Error(
        `Task record changed during read-only review monitoring for card ${card.id}`,
      );
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
    };
    if (failedFeedbackReview) {
      observed.push(openObservation);
      continue;
    }
    taskRecordStore.compareAndSwap(card.id, latest.revision, {
      ...latest,
      reviewObservation: {
        headSha,
        observedAt: nextTimestamp(latest.updatedAt),
        ciEvaluation: {
          status: ciEvaluation.status,
          expectedCheckNames: expectationDecision.expectedCheckNames,
          missingChecks:
            ciEvaluation.status === "waiting" ? ciEvaluation.missingChecks : [],
          pendingChecks:
            ciEvaluation.status === "waiting" ? ciEvaluation.pendingChecks : [],
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
          ...(ciEvaluation.status === "waiting" ||
          ciEvaluation.status === "uncertain"
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
