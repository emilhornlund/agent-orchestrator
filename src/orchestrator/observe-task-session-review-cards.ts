import type { ProjectConfig } from "../config/config.js";
import type {
  GitHubClient,
  RequiredCheckObservation,
} from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";

export interface ObservedTaskSessionReviewCard {
  cardId: string;
  pullRequestUrl: string;
  headSha: string;
  checks: RequiredCheckObservation[];
  feedbackIds: string[];
}

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
): Promise<ObservedTaskSessionReviewCard[]> {
  const { project, cards, taskRecordStore, github } = options;
  if (project.executionMode !== "task-session") {
    throw new Error(
      "Task-session review monitoring requires task-session mode",
    );
  }
  const requiredChecks = project.repository.requiredChecks;
  if (requiredChecks === undefined || requiredChecks.length === 0) {
    throw new Error(
      "Task-session review monitoring requires configured required checks",
    );
  }
  const observed: ObservedTaskSessionReviewCard[] = [];
  for (const card of cards) {
    const record = taskRecordStore.read(card.id);
    if (
      record === null ||
      (record.phase !== "human-feedback" && record.phase !== "ci")
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
    if (
      pullRequest === null ||
      pullRequest.state !== "OPEN" ||
      pullRequest.url !== record.pullRequest.url ||
      pullRequest.headRefOid !== headSha
    ) {
      throw new Error(
        `Authoritative pull request identity or head changed for Human Review card ${card.id}`,
      );
    }
    const [checkResult, requestedChanges, conversationComments] =
      await Promise.all([
        github.getRequiredChecks({
          cwd: lookup.cwd,
          repository: project.repository.github,
          headSha,
          requiredChecks,
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
      (latest.phase !== "human-feedback" && latest.phase !== "ci")
    ) {
      throw new Error(
        `Task record changed during read-only review monitoring for card ${card.id}`,
      );
    }
    taskRecordStore.compareAndSwap(card.id, latest.revision, {
      ...latest,
      reviewObservation: {
        headSha,
        observedAt: nextTimestamp(latest.updatedAt),
        checks: checkResult.checks.map(
          ({ name, status, headSha: observedHead }) => ({
            name,
            status,
            headSha: observedHead,
          }),
        ),
        feedbackIds,
      },
      revision: latest.revision + 1,
      updatedAt: nextTimestamp(latest.updatedAt),
    });
    observed.push({
      cardId: card.id,
      pullRequestUrl: record.pullRequest.url,
      headSha,
      checks: checkResult.checks,
      feedbackIds,
    });
  }
  return observed;
}
