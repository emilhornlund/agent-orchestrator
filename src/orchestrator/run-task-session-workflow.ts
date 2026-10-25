import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import type {
  CiCheckObservation,
  FailedCheckDiagnostic,
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import { establishCiCheckExpectations } from "../github/ci-check-expectations.js";
import { evaluateCiChecks } from "../github/evaluate-ci-checks.js";
import { getSessionLogPath } from "../logging/session-log.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { buildCommitPrompt } from "../opencode/build-commit-prompt.js";
import {
  captureRepositorySnapshot,
  clearCommitResult,
  readCommitResult,
  repositorySnapshotsEqual,
} from "../opencode/commit-result.js";
import type { CommandRunner } from "../process/command-runner.js";
import { runRepositorySetup } from "../process/run-setup.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";
import { buildTaskSessionReviewRepairPrompt } from "../opencode/build-task-session-review-repair-prompt.js";
import { buildTaskSessionCiRepairPrompt } from "../opencode/build-task-session-ci-repair-prompt.js";
import { inspectPrimaryOpenCodeSession } from "../opencode/inspect-primary-session.js";
import { runTaskPlanningOperation } from "../task-session/run-task-planning.js";
import { runPlanVerification } from "../task-session/run-plan-verification.js";
import { runTaskSessionImplementation } from "../task-session/run-task-session-implementation.js";
import {
  runTaskSessionValidation,
  type TaskSessionValidationResult,
} from "../task-session/run-task-session-validation.js";
import { runTaskSessionCoverage } from "../task-session/run-task-session-coverage.js";
import { runTaskSessionValidationWithRepairs } from "../task-session/run-task-session-validation-repairs.js";
import { runTaskSessionReview } from "../task-session/run-task-session-review.js";
import { runTaskSessionReviewWithRepairs } from "../task-session/run-task-session-review-repairs.js";
import { runTaskSessionCiRepairs } from "../task-session/run-task-session-ci-repairs.js";
import { runTaskSessionFeedbackCycle } from "./run-task-session-feedback-cycle.js";
import { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import {
  decideVerifiedPublication,
  decideHumanReviewPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskPlanStore } from "../task-session/task-plan-store.js";
import {
  TaskMutationQueue,
  type TaskMutationEvent,
} from "../task-session/task-mutation-queue.js";
import {
  reconcileTaskSession,
  type TaskSessionRecoverySnapshot,
} from "../task-session/reconcile-task-session.js";
import {
  transitionTaskExecutionRecord,
  type TaskExecutionEvent,
} from "../task-session/task-execution-transition.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import { runPrMaintenanceReview } from "../task-session/run-pr-maintenance-review.js";
import { parseImplementationReviewResult } from "../task-session/implementation-review-result.js";
import { decideTaskSessionAutoMergeReadiness } from "../task-session/task-session-auto-merge-readiness.js";
import { getTaskSessionSourceSnapshotIdentity } from "../task-session/source-snapshot.js";
import { publishTaskSessionCard } from "./publish-task-session-card.js";
import {
  publishCard,
  enrichMaintainedPullRequestDescription,
} from "./publish-card.js";
import { runWithPrimaryTaskSession } from "../task-session/primary-task-session.js";
import { buildAutoMergeSummary } from "./auto-merge.js";
import { mergeTaskSessionPullRequest } from "./merge-task-session-pull-request.js";
import { observeTaskSessionReviewCards } from "./observe-task-session-review-cards.js";
import {
  completeMergedTaskSessionPullRequest,
  returnClosedTaskSessionPullRequestToBacklog,
} from "./reconcile-terminal-task-session-pr.js";
import { getCardsForDiscovery } from "./trello-list-discovery.js";
import { isCardStartDateReached } from "./card-start-eligibility.js";
import { getWorkflowKind } from "./workflow-kind.js";
import {
  readRejectedCommitState,
  readTrustedCommitState,
} from "./trusted-commit-state.js";
import { logger } from "../logging/logger.js";
import { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import {
  maintainOutdatedPr,
  reconcileInterruptedPrMaintenance,
  retireFailedUnpublishedPrMaintenance,
} from "./maintain-outdated-pr.js";
import { reconcileUnobservedTerminalPrEvents } from "./reconcile-unobserved-terminal-pr.js";

const lastLoggedCiState = new Map<string, string>();
const reportedMissingMaintenancePlans = new Set<string>();
const reportedLegacyAttentionRequired = new Set<string>();

export interface RunTaskSessionWorkflowOptions {
  project: ProjectConfig & { contextRoot?: string };
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  openCode: OpenCodeClient;
  commands: CommandRunner;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  prepareAttachmentContext: (
    card: TrelloCard,
  ) => Promise<CardAttachmentPromptContext | undefined>;
  processRefinement?: (
    card: TrelloCard,
    worktree: { path: string; branch: string },
  ) => Promise<void>;
  onHumanReviewCardsObserved?: (cardIds: string[]) => void;
  onHumanReviewCardLeft?: (cardId: string) => void;
}

function timestamp(record: TaskExecutionRecord): string {
  return new Date(
    Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
  ).toISOString();
}

function updateRecord(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  update: Partial<TaskExecutionRecord>,
): TaskExecutionRecord {
  return store.compareAndSwap(record.cardId, record.revision, {
    ...record,
    ...update,
    revision: record.revision + 1,
    updatedAt: timestamp(record),
  });
}

function event(
  record: TaskExecutionRecord,
  type: TaskExecutionEvent["type"],
): TaskExecutionEvent {
  return {
    type,
    eventId: `${record.operationKey}:${type}`,
    projectId: record.projectId,
    cardId: record.cardId,
    operationKey: record.operationKey,
    occurredAt: timestamp(record),
  } as TaskExecutionEvent;
}

async function completeMergedTaskSession(options: {
  queue: TaskMutationQueue;
  taskStore: TaskExecutionStore;
  trello: TrelloClient;
  git: GitClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  completionComment?: string;
  releaseMutationEventId?: string;
  onMutationReleased?: () => void;
}): Promise<void> {
  const { queue, taskStore, trello, git, project, card, pullRequest, signal } =
    options;
  const headSha = pullRequest.headRefOid;
  if (headSha === undefined) {
    throw new Error(`Merged pull request has no head identity for ${card.id}`);
  }
  const terminalEventId = `terminal-pr:${card.id}:MERGED:${headSha}`;
  const record = taskStore.read(card.id);
  if (record === null || record.pullRequest?.url !== pullRequest.url) {
    throw new Error(
      `Merged pull request has no matching task record for ${card.id}`,
    );
  }
  const [owner, repository] = project.repository.github.split("/");
  if (
    pullRequest.state !== "MERGED" ||
    pullRequest.mergedAt === null ||
    pullRequest.baseRefName !== project.repository.defaultBranch ||
    pullRequest.headRefName !== `agent/${card.id}` ||
    headSha !== record.pullRequest.headSha ||
    pullRequest.headRepository?.name !== repository ||
    pullRequest.headRepositoryOwner?.login !== owner
  ) {
    throw new Error(`Merged pull request identity is ambiguous for ${card.id}`);
  }
  const terminalEvent = queue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId: terminalEventId,
    operationKey: `${record.operationKey}:MERGED:${headSha}`,
    kind: "terminal-pr",
    enqueuedAt: record.updatedAt,
  });
  if (terminalEvent.status === "completed" && record.phase === "done") return;
  if (options.releaseMutationEventId !== undefined) {
    if (queue.getActive()?.eventId !== options.releaseMutationEventId) {
      throw new Error("Merged PR cannot release a mutation it does not own");
    }
    queue.complete(options.releaseMutationEventId);
    options.onMutationReleased?.();
  }
  const mutation = queue.claimForRecovery(terminalEventId);
  if (mutation === null || mutation.eventId !== terminalEventId) {
    throw new Error(`Could not claim terminal PR cleanup for ${card.id}`);
  }
  try {
    await completeMergedTaskSessionPullRequest({
      trello,
      git,
      project,
      card,
      pullRequest,
      ...(options.completionComment === undefined
        ? {}
        : { completionComment: options.completionComment }),
      ...(options.emailNotifier === undefined
        ? {}
        : { emailNotifier: options.emailNotifier }),
      signal,
    });
    if (signal.aborted) {
      queue.fail(terminalEventId);
      return;
    }
    const latest = taskStore.read(card.id);
    if (latest === null || latest.pullRequest?.url !== pullRequest.url) {
      throw new Error(
        `Merged task record changed during cleanup for ${card.id}`,
      );
    }
    if (latest.phase !== "done") {
      if (latest.phase !== "ci" && latest.phase !== "human-feedback") {
        throw new Error(
          `Cannot complete merged task ${card.id} from phase ${latest.phase}`,
        );
      }
      taskStore.compareAndSwap(
        card.id,
        latest.revision,
        transitionTaskExecutionRecord(
          { ...latest, reviewObservation: undefined },
          {
            type: "pull-request-merged",
            eventId: `${latest.operationKey}:pull-request-merged`,
            projectId: project.id,
            cardId: card.id,
            operationKey: latest.operationKey,
            occurredAt: timestamp(latest),
          },
        ),
      );
    }
    queue.complete(terminalEventId);
  } catch (error) {
    if (queue.ownsActive(terminalEventId)) queue.fail(terminalEventId);
    throw error;
  }
}

function commitMessageRunOptions(
  project: ProjectConfig,
  signal: AbortSignal,
  sessionLogPath: string,
) {
  return {
    model: project.opencode.commit.model,
    variant: project.opencode.commit.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    signal,
    sessionLogPath,
    sessionLabel: "Task-session commit message",
  };
}

function persistQualityEvidence(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  cycleId: string,
  validation: TaskSessionValidationResult,
  coverage: TaskSessionValidationResult | null,
): TaskExecutionRecord {
  return updateRecord(store, record, {
    validationRepair: {
      cycleId,
      status: "passed",
      evidence: {
        command: validation.command,
        startedAt: validation.startedAt,
        completedAt: validation.completedAt,
        exitCode: 0,
        diagnostic: validation.diagnostic,
        contentIdentity: validation.contentIdentity,
      },
      ...(coverage === null
        ? {}
        : {
            coverageEvidence: {
              command: coverage.command,
              startedAt: coverage.startedAt,
              completedAt: coverage.completedAt,
              exitCode: 0 as const,
              diagnostic: coverage.diagnostic,
              contentIdentity: coverage.contentIdentity,
            },
          }),
    },
  });
}

async function readTaskSessionRecoverySnapshot(options: {
  project: ProjectConfig;
  card: TrelloCard;
  record: TaskExecutionRecord;
  worktreePath: string;
  git: GitClient;
  github: GitHubClient;
  commands: CommandRunner;
  signal: AbortSignal;
}): Promise<TaskSessionRecoverySnapshot> {
  const { project, card, record, worktreePath, git, github, commands, signal } =
    options;
  const stat = fs.lstatSync(worktreePath, { throwIfNoEntry: false });
  const worktreeExists = stat !== undefined;
  const isDirectory = stat?.isDirectory() === true && !stat.isSymbolicLink();
  const worktreeBranch = isDirectory
    ? await git.getCurrentBranch(worktreePath)
    : null;
  const worktreeHeadSha = isDirectory
    ? await git.getHeadSha(worktreePath)
    : null;
  const worktreeRebaseActive = isDirectory
    ? (await git.getRebaseState(worktreePath)) !== null
    : false;
  if (isDirectory && (await git.getConflictedPaths(worktreePath)).length > 0)
    throw new Error("Owned task worktree has unresolved conflict paths");
  if (
    isDirectory &&
    record.phase === "publication" &&
    (await git.getStatus(worktreePath)).trim().length > 0
  )
    throw new Error(
      "Publication worktree contains changes not represented by the trusted commit",
    );

  const headSha = record.pullRequest?.headSha;
  const sessionId = record.primarySessionId;
  const primarySessionAccessible =
    sessionId === undefined
      ? record.phase === "planning"
        ? true
        : null
      : !isDirectory
        ? null
        : await inspectPrimaryOpenCodeSession({
            commands,
            cwd: worktreePath,
            sessionId,
            signal,
            timeoutMilliseconds: 30_000,
          });

  const trusted = readTrustedCommitState(project, card.id);
  const rejected = readRejectedCommitState(project, card.id);
  if (
    rejected !== null &&
    worktreeHeadSha !== null &&
    (worktreeHeadSha === rejected.commitSha ||
      (await git.isAncestor(worktreePath, rejected.commitSha, worktreeHeadSha)))
  ) {
    throw new Error("Task worktree HEAD descends from a rejected commit");
  }

  let pullRequest: {
    number: number;
    url: string;
    headSha: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  } | null = null;
  const pullRequestLookup = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: record.expectedBranch ?? `agent/${card.id}`,
    baseBranch: project.repository.defaultBranch,
    project,
  };
  if (
    record.phase === "publication" ||
    record.phase === "ci" ||
    record.phase === "human-feedback" ||
    record.phase === "done"
  ) {
    const actual = await github.findPullRequestState(pullRequestLookup);
    if (actual !== null) {
      if (actual.headRefOid === undefined)
        throw new Error("Authoritative pull request has no observed head SHA");
      const number = Number(new URL(actual.url).pathname.split("/").at(-1));
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Authoritative pull request URL has an invalid number");
      pullRequest = {
        number,
        url: actual.url,
        headSha: actual.headRefOid,
        state: actual.state,
      };
    }
  }

  const authoritativeHead = pullRequest?.headSha ?? headSha;
  const ciObservation =
    (record.phase === "ci" || record.phase === "human-feedback") &&
    authoritativeHead !== undefined
      ? await github.getCiObservations({
          cwd: project.repository.path,
          repository: project.repository.github,
          defaultBranch: project.repository.defaultBranch,
          headSha: authoritativeHead,
          ...(pullRequest === null
            ? {}
            : { pullRequestNumber: pullRequest.number }),
          project,
        })
      : null;
  const ciEvaluation =
    ciObservation === null || authoritativeHead === undefined
      ? null
      : evaluateCiChecks({
          expectedHeadSha: authoritativeHead,
          observedHeadSha: ciObservation.headSha,
          expectations: establishCiCheckExpectations(
            ciObservation.expectationSources,
          ),
          checks: ciObservation.checks,
        });
  const remoteBranchHeadSha =
    record.phase === "publication" ||
    record.phase === "ci" ||
    record.phase === "human-feedback" ||
    record.phase === "done"
      ? await git.getRemoteBranchSha(
          project.repository.path,
          "origin",
          record.expectedBranch ?? `agent/${card.id}`,
          project,
        )
      : null;

  return {
    primarySessionAccessible,
    worktreeExists,
    worktreeBranch,
    worktreeHeadSha,
    worktreeRebaseActive,
    trustedCommitSha: trusted?.commitSha ?? null,
    remoteBranchHeadSha,
    trelloListId: card.idList,
    pullRequest,
    ciEvaluation,
    feedbackHeadSha:
      record.phase === "human-feedback"
        ? (record.reviewObservation?.headSha ?? null)
        : null,
    uncertainReplyIds: [],
    reconciledReplyIds: [],
  };
}

async function collectCiFailureDiagnostics(
  github: GitHubClient,
  project: ProjectConfig,
  headSha: string,
  failures: readonly CiCheckObservation[],
): Promise<FailedCheckDiagnostic[]> {
  const checkRunFailures = failures.filter(
    (
      failure,
    ): failure is Extract<CiCheckObservation, { source: "check-run" }> =>
      failure.source === "check-run",
  );
  const checkRunDiagnostics =
    checkRunFailures.length === 0
      ? []
      : await github.getCiCheckRunDiagnostics({
          cwd: project.repository.path,
          repository: project.repository.github,
          headSha,
          checks: checkRunFailures,
          project,
        });
  const statusDiagnostics: FailedCheckDiagnostic[] = failures
    .filter(
      (
        failure,
      ): failure is Extract<CiCheckObservation, { source: "commit-status" }> =>
        failure.source === "commit-status",
    )
    .map((failure) => ({
      name: failure.context,
      headSha,
      logUrl: failure.url,
      available: failure.description !== null,
      diagnostic:
        failure.description ??
        `Commit status ${failure.context} concluded ${failure.state}${failure.url === null ? "" : ` (${failure.url})`}`,
    }));
  return [...checkRunDiagnostics, ...statusDiagnostics];
}

/** Executes one new Ready for Agent implementation through the task-session gates. */
export async function runTaskSessionWorkflow(
  options: RunTaskSessionWorkflowOptions,
): Promise<void> {
  const {
    project,
    trello,
    git,
    github,
    openCode,
    commands,
    signal,
    emailNotifier,
  } = options;
  const validationCommand = project.repository.validationCommand;
  if (
    validationCommand === undefined ||
    validationCommand.trim().length === 0
  ) {
    throw new Error("Unified workflow requires repository.validationCommand");
  }
  const root = project.contextRoot;
  if (root === undefined)
    throw new Error(
      "Task-session workflow requires a configured external context root",
    );
  const taskStore = new TaskExecutionStore(root, project);
  const planStore = new TaskPlanStore(root, project);
  const queue = new TaskMutationQueue(root, project);
  const maintenanceStore = new PrMaintenanceStore(root, project);
  const feedbackLedgerStore = new FeedbackLedgerStore(root, project);
  retireFailedUnpublishedPrMaintenance({
    project,
    maintenanceStore,
    mutationQueue: queue,
  });
  await reconcileInterruptedPrMaintenance({
    project,
    taskStore,
    maintenanceStore,
    mutationQueue: queue,
    github,
  });
  const humanReviewCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.reviewListId,
    "Could not retrieve task-session Human Review cards",
    signal,
  );
  options.onHumanReviewCardsObserved?.(humanReviewCards.map((card) => card.id));
  await reconcileUnobservedTerminalPrEvents({
    project,
    queue,
    taskStore,
    maintenanceStore,
    github,
    trello,
    signal,
    observedReviewCardIds: humanReviewCards.map((card) => card.id),
  });
  const observations = await observeTaskSessionReviewCards({
    project,
    cards: humanReviewCards,
    taskRecordStore: taskStore,
    github,
    cwd: project.repository.path,
  });
  const pendingTerminalMutation = queue.getActive();
  if (pendingTerminalMutation?.kind === "terminal-pr") {
    const isMerged = pendingTerminalMutation.eventId.includes(":MERGED:");
    const isClosed = pendingTerminalMutation.eventId.includes(":CLOSED:");
    if (!isMerged && !isClosed) {
      throw new Error("Persisted terminal PR mutation has an invalid identity");
    }
    const cardId = pendingTerminalMutation.cardId;
    const destinationListId = isMerged
      ? project.trello.doneListId
      : project.trello.backlogListId;
    const terminalCards = await getCardsForDiscovery(
      trello,
      project.id,
      destinationListId,
      `Could not recover terminal PR card ${cardId}`,
      signal,
    );
    const card =
      humanReviewCards.find((candidate) => candidate.id === cardId) ??
      terminalCards.find((candidate) => candidate.id === cardId);
    const record = taskStore.read(cardId);
    if (card === undefined || record?.pullRequest === undefined) {
      throw new Error(
        `Persisted terminal PR mutation has no matching task card and record for ${cardId}`,
      );
    }
    const authoritative = await github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${cardId}`,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    const expectedState = isMerged ? "MERGED" : "CLOSED";
    if (
      authoritative === null ||
      authoritative.state !== expectedState ||
      authoritative.url !== record.pullRequest.url ||
      authoritative.baseRefName !== project.repository.defaultBranch ||
      authoritative.headRefName !== `agent/${cardId}` ||
      authoritative.headRefOid !== record.pullRequest.headSha
    ) {
      throw new Error(
        `Persisted terminal PR mutation no longer matches authoritative PR state for ${cardId}`,
      );
    }
    const recoveredTerminalMutation = queue.claimForRecovery(
      pendingTerminalMutation.eventId,
    );
    if (recoveredTerminalMutation !== null) {
      try {
        if (isMerged) {
          await completeMergedTaskSession({
            queue,
            taskStore,
            trello,
            git,
            project,
            card,
            pullRequest: authoritative,
            ...(emailNotifier === undefined ? {} : { emailNotifier }),
            signal,
          });
        } else {
          await returnClosedTaskSessionPullRequestToBacklog({
            trello,
            git,
            project,
            card,
            pullRequest: authoritative,
            preserveWorktree: maintenanceStore
              .inspect()
              .some(
                (item) =>
                  item.cardId === cardId &&
                  item.status === "cancelled" &&
                  item.localPreparation?.status === "prepared",
              ),
            signal,
          });
        }
        options.onHumanReviewCardLeft?.(cardId);
        if (!isMerged) {
          if (signal.aborted) queue.fail(recoveredTerminalMutation.eventId);
          else queue.complete(recoveredTerminalMutation.eventId);
        }
      } catch (error) {
        if (!isMerged && queue.ownsActive(recoveredTerminalMutation.eventId)) {
          queue.fail(recoveredTerminalMutation.eventId);
        }
        throw error;
      }
    }
  }
  for (const observation of observations) {
    if (observation.state !== "OPEN") {
      const record = taskStore.read(observation.cardId);
      const card = humanReviewCards.find(
        (candidate) => candidate.id === observation.cardId,
      );
      if (record === null || card === undefined) {
        throw new Error(
          `Terminal PR observation lost task ownership for ${observation.cardId}`,
        );
      }
      const headIdentity = observation.headSha ?? record.pullRequest?.headSha;
      if (headIdentity === undefined) {
        throw new Error(
          `Terminal PR has no stable head identity for ${observation.cardId}`,
        );
      }
      const terminalEventId = `terminal-pr:${observation.cardId}:${observation.state}:${headIdentity}`;
      queue.enqueue({
        projectId: project.id,
        cardId: observation.cardId,
        eventId: terminalEventId,
        operationKey: `${record.operationKey}:${observation.state}:${headIdentity}`,
        kind: "terminal-pr",
        enqueuedAt: record.updatedAt,
      });
      if (observation.state === "MERGED") {
        await completeMergedTaskSession({
          queue,
          taskStore,
          trello,
          git,
          project,
          card,
          pullRequest: observation.pullRequest,
          ...(emailNotifier === undefined ? {} : { emailNotifier }),
          signal,
        });
        options.onHumanReviewCardLeft?.(card.id);
        continue;
      }
      const terminalMutation = queue.claimForRecovery(terminalEventId);
      if (terminalMutation === null) continue;
      try {
        await returnClosedTaskSessionPullRequestToBacklog({
          trello,
          git,
          project,
          card,
          pullRequest: observation.pullRequest,
          preserveWorktree: maintenanceStore
            .inspect()
            .some(
              (item) =>
                item.cardId === card.id &&
                item.status === "cancelled" &&
                item.localPreparation?.status === "prepared",
            ),
          signal,
        });
        options.onHumanReviewCardLeft?.(card.id);
        if (signal.aborted) queue.fail(terminalMutation.eventId);
        else queue.complete(terminalMutation.eventId);
      } catch (error) {
        queue.fail(terminalMutation.eventId);
        throw error;
      }
      continue;
    }
    let record = taskStore.read(observation.cardId);
    const ciStateKey = `${project.id}/${observation.cardId}/${observation.headSha}`;
    const ciState = observation.ciEvaluation.status;
    if (lastLoggedCiState.get(ciStateKey) !== ciState) {
      logger
        .child({ projectId: project.id, cardId: observation.cardId })
        .event(
          ciState === "waiting"
            ? `CI waiting for ${observation.headSha}`
            : ciState === "failed"
              ? `CI failed for ${observation.headSha}`
              : ciState === "passed"
                ? `CI passed for ${observation.headSha}`
                : `CI state uncertain for ${observation.headSha}`,
        );
      lastLoggedCiState.set(ciStateKey, ciState);
    }
    if (
      record !== null &&
      record.phase === "human-feedback" &&
      observation.ciEvaluation.status === "failed"
    ) {
      taskStore.compareAndSwap(
        record.cardId,
        record.revision,
        transitionTaskExecutionRecord(record, {
          type: "feedback-ci-failed",
          eventId: `${record.operationKey}:feedback-ci-failed:${observation.headSha}`,
          projectId: project.id,
          cardId: record.cardId,
          operationKey: record.operationKey,
          occurredAt: timestamp(record),
        }),
      );
      record = taskStore.read(observation.cardId);
    }
    if (record === null || record.phase !== "ci") continue;
    if (
      observation.ciEvaluation.status === "waiting" ||
      observation.ciEvaluation.status === "uncertain"
    ) {
      continue;
    }
    if (observation.ciEvaluation.status === "failed") {
      const ciEventId = `ci-repair:${observation.cardId}:${observation.headSha}`;
      queue.enqueue({
        projectId: project.id,
        cardId: observation.cardId,
        eventId: ciEventId,
        operationKey: `${record.operationKey}:ci:${observation.headSha}`,
        kind: "ci-repair",
        enqueuedAt: record.updatedAt,
      });
      const activeMutation = queue.claimForRecovery(ciEventId);
      if (activeMutation === null || activeMutation.eventId !== ciEventId)
        continue;
      logger
        .child({ projectId: project.id, cardId: observation.cardId })
        .event("CI repair started");
      const card = humanReviewCards.find(
        (candidate) => candidate.id === observation.cardId,
      );
      if (card === undefined || record.primarySessionId === undefined) {
        throw new Error(
          "CI repair requires the owned review card and primary session",
        );
      }
      const worktreePath = path.join(project.repository.worktreeRoot, card.id);
      const expectedBranch = `agent/${card.id}`;
      const operationKey = record.operationKey;
      const plan = planStore.read(card.id);
      if (plan === null || plan.verification?.verdict !== "pass") {
        throw new Error("CI repair requires the independently verified plan");
      }
      const validationOptions = {
        project,
        cardId: card.id,
        expectedBranch,
        operationKey,
        worktreePath,
        taskRecordStore: taskStore,
        git,
        commands,
        signal,
        timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      };
      let quality: Awaited<
        ReturnType<typeof runTaskSessionValidationWithRepairs>
      >;
      let latestReview: Awaited<ReturnType<typeof runTaskSessionReview>>;
      const rerunQualityAndReview = async () => {
        quality = await runTaskSessionValidationWithRepairs({
          validation: validationOptions,
          openCode,
          planStore,
          card,
          expectedPrimarySessionId: record.primarySessionId!,
          repairRunOptions: {
            model: project.opencode.remediation.model,
            variant: project.opencode.remediation.variant,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
          },
        });
        const runReview = async () =>
          runTaskSessionReview({
            project,
            card,
            expectedBranch,
            operationKey,
            worktreePath,
            taskRecordStore: taskStore,
            planStore,
            git,
            openCode,
            validation: quality.validation,
            coverage: quality.coverage,
            runOptions: {
              model: project.opencode.review.model,
              variant: project.opencode.review.variant,
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
            },
          });
        let first = await runReview();
        const repairReview = async (
          review: typeof first.review,
          attempt: number,
        ) => {
          let latest = taskStore.read(card.id);
          if (latest === null)
            throw new Error("Task state disappeared during CI review repair");
          taskStore.compareAndSwap(
            card.id,
            latest.revision,
            transitionTaskExecutionRecord(
              latest,
              event(latest, "review-failed"),
            ),
          );
          const prompt = buildTaskSessionReviewRepairPrompt({
            projectId: project.id,
            card,
            approvedPlan: plan.plan,
            review,
            attempt,
            maxAttempts: project.opencode.remediation.maxPasses,
          });
          const repaired = await runWithPrimaryTaskSession(
            taskStore,
            openCode,
            project.id,
            card.id,
            {
              model: project.opencode.remediation.model,
              variant: project.opencode.remediation.variant,
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
              cwd: worktreePath,
              prompt,
            },
          );
          if (repaired.exitCode !== 0)
            throw new Error(
              "Primary-session review correction failed during CI repair",
            );
          latest = taskStore.read(card.id);
          if (latest === null)
            throw new Error(
              "Task state disappeared after CI review correction",
            );
          const validationPhase = transitionTaskExecutionRecord(
            latest,
            event(latest, "implementation-completed"),
          );
          latest = taskStore.compareAndSwap(
            card.id,
            latest.revision,
            validationPhase,
          );
          updateRecord(taskStore, latest, {
            retryCounters: { ...latest.retryCounters, validation: 0 },
            validationRepair: { cycleId: operationKey, status: "active" },
          });
        };
        let roundIndex = 0;
        const ciReviewResult = await runTaskSessionReviewWithRepairs({
          maxAttempts: project.opencode.remediation.maxPasses,
          store: taskStore,
          projectId: project.id,
          cardId: card.id,
          operationKey,
          expectedPrimarySessionId: record.primarySessionId!,
          runReview: async () => {
            if (roundIndex++ === 0)
              return {
                review: first.review,
                contentIdentity: first.contentIdentity,
              };
            first = await runReview();
            return {
              review: first.review,
              contentIdentity: first.contentIdentity,
            };
          },
          repair: repairReview,
          rerunQuality: async () => {
            quality = await runTaskSessionValidationWithRepairs({
              validation: validationOptions,
              openCode,
              planStore,
              card,
              expectedPrimarySessionId: record.primarySessionId!,
              repairRunOptions: {
                model: project.opencode.remediation.model,
                variant: project.opencode.remediation.variant,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
              },
            });
          },
          getCurrentContentIdentity: () =>
            getTaskSessionSourceSnapshotIdentity(git, worktreePath),
        });
        latestReview = first;
        if (ciReviewResult.review.verdict !== "pass")
          throw new Error(
            "CI repair review remains blocking after the configured repair limit",
          );
        const latest = taskStore.read(card.id);
        if (latest === null)
          throw new Error("Task state disappeared after CI review");
        taskStore.compareAndSwap(
          card.id,
          latest.revision,
          transitionTaskExecutionRecord(latest, event(latest, "review-passed")),
        );
      };
      let ciResult;
      try {
        ciResult = await runTaskSessionCiRepairs({
          store: taskStore,
          projectId: project.id,
          cardId: card.id,
          operationKey,
          expectedPrimarySessionId: record.primarySessionId,
          headSha: observation.headSha,
          observeChecks: async (headSha) => {
            const ciObservation = await github.getCiObservations({
              cwd: project.repository.path,
              repository: project.repository.github,
              defaultBranch: project.repository.defaultBranch,
              headSha,
              ...(record.pullRequest == null
                ? {}
                : { pullRequestNumber: record.pullRequest.number }),
              project,
            });
            return evaluateCiChecks({
              expectedHeadSha: headSha,
              observedHeadSha: ciObservation.headSha,
              expectations: establishCiCheckExpectations(
                ciObservation.expectationSources,
              ),
              checks: ciObservation.checks,
            });
          },
          collectDiagnostics: (headSha, failures) =>
            collectCiFailureDiagnostics(github, project, headSha, failures),
          repairPrimarySession: async (diagnostics, attempt, sessionId) => {
            const failedHeadSha = diagnostics[0]?.headSha;
            if (
              failedHeadSha === undefined ||
              diagnostics.some(
                (diagnostic) => diagnostic.headSha !== failedHeadSha,
              )
            ) {
              throw new Error(
                "CI repair diagnostics do not share one authoritative current head",
              );
            }
            let latest = taskStore.read(card.id);
            if (latest === null || latest.primarySessionId !== sessionId)
              throw new Error("CI repair primary session ownership changed");
            if (
              latest.reviewObservation !== undefined ||
              latest.publicationQuality !== undefined ||
              latest.reviewRepair !== undefined
            ) {
              latest = updateRecord(taskStore, latest, {
                reviewObservation: undefined,
                publicationQuality: undefined,
                reviewRepair: undefined,
              });
            }
            taskStore.compareAndSwap(
              card.id,
              latest.revision,
              transitionTaskExecutionRecord(latest, event(latest, "ci-failed")),
            );
            const prompt = buildTaskSessionCiRepairPrompt({
              projectId: project.id,
              card,
              approvedPlan: plan.plan,
              headSha: failedHeadSha,
              attempt,
              maxAttempts: 2,
              diagnostics,
            });
            const repaired = await runWithPrimaryTaskSession(
              taskStore,
              openCode,
              project.id,
              card.id,
              {
                model: project.opencode.remediation.model,
                variant: project.opencode.remediation.variant,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
                cwd: worktreePath,
                prompt,
              },
            );
            if (repaired.exitCode !== 0)
              throw new Error("Primary-session CI repair failed");
            latest = taskStore.read(card.id);
            if (latest === null)
              throw new Error("Task state disappeared after primary CI repair");
            taskStore.compareAndSwap(
              card.id,
              latest.revision,
              transitionTaskExecutionRecord(
                latest,
                event(latest, "implementation-completed"),
              ),
            );
            const validationRecord = taskStore.read(card.id);
            if (validationRecord !== null)
              updateRecord(taskStore, validationRecord, {
                retryCounters: {
                  ...validationRecord.retryCounters,
                  validation: 0,
                },
                validationRepair: { cycleId: operationKey, status: "active" },
                reviewRepair: { cycleId: operationKey, status: "active" },
              });
          },
          rerunLocalGatesAndReview: rerunQualityAndReview,
          publishSamePullRequest: async () => {
            let latest = taskStore.read(card.id);
            if (latest === null || latest.phase !== "publication")
              throw new Error("CI repair did not reach publication phase");
            const qualityIdentity = await getTaskSessionSourceSnapshotIdentity(
              git,
              worktreePath,
            );
            const validationEvidence = quality.validation;
            const gateInput: VerifiedPublicationDecisionInput = {
              currentContentIdentity: qualityIdentity,
              validationCommand,
              validation: validationEvidence,
              ...(project.repository.coverageCommand === undefined
                ? {}
                : { coverageCommand: project.repository.coverageCommand }),
              coverage: quality.coverage,
              review: latestReview.review,
            };
            if (!decideVerifiedPublication(gateInput).allowed)
              throw new Error("CI repair publication gates failed");
            const existingPullRequestUrl = taskStore.read(card.id)?.pullRequest
              ?.url;
            if (existingPullRequestUrl === undefined) {
              throw new Error(
                "CI repair cannot publish without the persisted existing PR URL",
              );
            }
            const snapshotBefore = await captureRepositorySnapshot(
              git,
              worktreePath,
            );
            clearCommitResult(worktreePath);
            const commitMessageRun = await runWithPrimaryTaskSession(
              taskStore,
              openCode,
              project.id,
              card.id,
              {
                ...commitMessageRunOptions(
                  project,
                  signal,
                  getSessionLogPath(project.id, card.id),
                ),
                cwd: worktreePath,
                prompt: buildCommitPrompt(card),
              },
            );
            if (commitMessageRun.exitCode !== 0)
              throw new Error("CI correction commit-message generation failed");
            const commitMessage = readCommitResult(worktreePath).message;
            clearCommitResult(worktreePath);
            if (
              !repositorySnapshotsEqual(
                snapshotBefore,
                await captureRepositorySnapshot(git, worktreePath),
              )
            ) {
              throw new Error(
                "CI correction commit-message session modified source files",
              );
            }
            let preparedGate = gateInput;
            const newHead = await publishTaskSessionCard({
              trello,
              git,
              github,
              opencode: openCode,
              commands,
              project: { ...project, autoMerge: false },
              card,
              worktreePath,
              branch: expectedBranch,
              expectedExistingPullRequestUrl: existingPullRequestUrl,
              commitMessage,
              reviewResult: "Passed",
              remediationResult: `CI repair attempt ${taskStore.read(card.id)?.retryCounters.ci ?? 1}`,
              verifiedDescriptionFacts: () => [
                `Approved implementation plan: ${JSON.stringify(planStore.read(card.id)?.plan ?? "unavailable")}`,
                `Verified validation result: ${JSON.stringify(preparedGate.validation)}`,
                ...(preparedGate.coverage === null
                  ? []
                  : [
                      `Verified coverage result: ${JSON.stringify(preparedGate.coverage)}`,
                    ]),
                `Independent review result: ${JSON.stringify(preparedGate.review)}`,
              ],
              signal,
              initialEvidence: gateInput,
              verifyPreparedContent: async () => {
                const validationNow =
                  await runTaskSessionValidation(validationOptions);
                const coverageNow =
                  await runTaskSessionCoverage(validationOptions);
                persistQualityEvidence(
                  taskStore,
                  taskStore.read(card.id)!,
                  operationKey,
                  validationNow,
                  coverageNow,
                );
                const reviewNow = await runTaskSessionReview({
                  project,
                  card,
                  expectedBranch,
                  operationKey,
                  worktreePath,
                  taskRecordStore: taskStore,
                  planStore,
                  git,
                  openCode,
                  validation: validationNow,
                  coverage: coverageNow,
                  runOptions: {
                    model: project.opencode.review.model,
                    variant: project.opencode.review.variant,
                    timeoutMilliseconds:
                      project.opencode.timeoutMinutes * 60_000,
                    signal,
                  },
                });
                const identity = await getTaskSessionSourceSnapshotIdentity(
                  git,
                  worktreePath,
                );
                preparedGate = {
                  currentContentIdentity: identity,
                  validationCommand,
                  validation: validationNow,
                  ...(project.repository.coverageCommand === undefined
                    ? {}
                    : { coverageCommand: project.repository.coverageCommand }),
                  coverage: coverageNow,
                  review: reviewNow.review,
                };
                const evidenceRecord = taskStore.read(card.id);
                if (evidenceRecord === null)
                  throw new Error(
                    "Task record disappeared while storing CI repair publication evidence",
                  );
                updateRecord(taskStore, evidenceRecord, {
                  publicationQuality: {
                    contentIdentity: identity,
                    validation: {
                      command: validationNow.command,
                      startedAt: validationNow.startedAt,
                      completedAt: validationNow.completedAt,
                      exitCode: 0,
                      diagnostic: validationNow.diagnostic,
                      contentIdentity: validationNow.contentIdentity,
                    },
                    ...(coverageNow === null
                      ? {}
                      : {
                          coverageEvidence: {
                            command: coverageNow.command,
                            startedAt: coverageNow.startedAt,
                            completedAt: coverageNow.completedAt,
                            exitCode: 0,
                            diagnostic: coverageNow.diagnostic,
                            contentIdentity: coverageNow.contentIdentity,
                          },
                        }),
                    review: reviewNow.review,
                  },
                });
                return preparedGate;
              },
            });
            const pr = await github.findPullRequestState({
              cwd: project.repository.path,
              repository: project.repository.github,
              headBranch: expectedBranch,
              baseBranch: project.repository.defaultBranch,
              project,
            });
            if (pr === null || pr.headRefOid !== newHead || pr.state !== "OPEN")
              throw new Error(
                "CI correction did not update the existing open PR to its published head",
              );
            latest = taskStore.read(card.id);
            if (latest === null || latest.phase !== "publication")
              throw new Error(
                "Task state changed during CI correction publication",
              );
            taskStore.compareAndSwap(
              card.id,
              latest.revision,
              transitionTaskExecutionRecord(latest, {
                type: "publication-completed",
                eventId: `${operationKey}:ci-repair-publication:${taskStore.read(card.id)?.retryCounters.ci ?? 1}`,
                projectId: project.id,
                cardId: card.id,
                operationKey,
                occurredAt: timestamp(latest),
                pullRequest: {
                  number: Number(new URL(pr.url).pathname.split("/").at(-1)),
                  url: pr.url,
                  headSha: newHead,
                },
              }),
            );
            return newHead;
          },
        });
      } catch (error) {
        queue.fail(ciEventId);
        throw error;
      }
      if (ciResult.status === "exhausted") queue.fail(ciEventId);
      else queue.complete(ciEventId);
      logger
        .child({ projectId: project.id, cardId: observation.cardId })
        .event(
          ciResult.status === "passed"
            ? "CI repair succeeded"
            : "CI repair failed",
        );
      if (
        ciResult.status === "passed" &&
        (!project.autoMerge || observation.feedbackIds.length > 0)
      ) {
        const latest = taskStore.read(card.id);
        if (latest !== null && latest.phase === "ci")
          taskStore.compareAndSwap(
            card.id,
            latest.revision,
            transitionTaskExecutionRecord(
              latest,
              event(latest, "ci-passed-awaiting-human"),
            ),
          );
      }
      continue;
    }
    const checksPassed = observation.ciEvaluation.status === "passed";
    if (!checksPassed) continue;
    if (
      !project.autoMerge ||
      observation.feedbackIds.length > 0 ||
      record.reviewRepair?.status === "exhausted"
    ) {
      taskStore.compareAndSwap(
        record.cardId,
        record.revision,
        transitionTaskExecutionRecord(
          record,
          event(record, "ci-passed-awaiting-human"),
        ),
      );
      continue;
    }
    const storedPlan = planStore.read(observation.cardId);
    const rawQuality = record.publicationQuality as
      | {
          contentIdentity: string;
          validation: NonNullable<
            NonNullable<TaskExecutionRecord["validationRepair"]>["evidence"]
          >;
          coverageEvidence?: NonNullable<
            NonNullable<
              TaskExecutionRecord["validationRepair"]
            >["coverageEvidence"]
          >;
          review: unknown;
        }
      | undefined;
    if (storedPlan === null || rawQuality === undefined) continue;
    const worktreePath = path.join(
      project.repository.worktreeRoot,
      observation.cardId,
    );
    const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      worktreePath,
    );
    if (currentIdentity !== rawQuality.contentIdentity) continue;
    const review = parseImplementationReviewResult(rawQuality.review, {
      projectId: project.id,
      cardId: observation.cardId,
      requirementIds: storedPlan.plan.requirements.map(
        (requirement) => requirement.id,
      ),
      contentIdentity: currentIdentity,
    });
    const validation: TaskSessionValidationResult = {
      ...rawQuality.validation,
      status: "passed",
      timedOut: false,
      aborted: false,
    };
    const coverage: TaskSessionValidationResult | null =
      rawQuality.coverageEvidence === undefined
        ? null
        : {
            ...rawQuality.coverageEvidence,
            status: "passed",
            timedOut: false,
            aborted: false,
          };
    const readiness = {
      expectedHeadSha: observation.headSha,
      observedHeadSha: observation.headSha,
      ciEvaluation: observation.ciEvaluation,
      localEvidence: {
        currentContentIdentity: currentIdentity,
        validationCommand,
        validation,
        ...(project.repository.coverageCommand === undefined
          ? {}
          : { coverageCommand: project.repository.coverageCommand }),
        coverage,
        review,
      },
    };
    const readinessDecision = decideTaskSessionAutoMergeReadiness(readiness);
    if (!readinessDecision.allowed) continue;
    const card = humanReviewCards.find(
      (candidate) => candidate.id === observation.cardId,
    );
    if (card === undefined || record.pullRequest === undefined) continue;
    await mergeTaskSessionPullRequest(
      github,
      project,
      card,
      observation.pullRequestUrl,
      observation.headSha,
      project.repository.path,
      readiness,
      signal,
    );
    const mergedPullRequest = await github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: `agent/${card.id}`,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    if (mergedPullRequest === null) {
      throw new Error(`Could not verify merged pull request for ${card.id}`);
    }
    await completeMergedTaskSession({
      queue,
      taskStore,
      trello,
      git,
      project,
      card,
      pullRequest: mergedPullRequest,
      completionComment: buildAutoMergeSummary({
        pullRequestUrl: observation.pullRequestUrl,
        commitSha: observation.headSha,
        reviewResult: "Passed",
        remediationResult:
          "Task-session quality and current-head required checks passed",
      }),
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      signal,
    });
  }
  const latestHumanReviewCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.reviewListId,
    "Could not re-read task-session Human Review cards",
    signal,
  );
  options.onHumanReviewCardsObserved?.(
    latestHumanReviewCards.map((card) => card.id),
  );
  const latestObservations = await observeTaskSessionReviewCards({
    project,
    cards: latestHumanReviewCards,
    taskRecordStore: taskStore,
    github,
    cwd: project.repository.path,
  });
  await reconcileUnobservedTerminalPrEvents({
    project,
    queue,
    taskStore,
    maintenanceStore,
    github,
    trello,
    signal,
    observedReviewCardIds: latestHumanReviewCards.map((card) => card.id),
  });
  const maintenanceHandledCardIds = new Set<string>();
  if (project.maintenance?.enabled === true) {
    for (const observation of latestObservations) {
      if (
        observation.state !== "OPEN" ||
        (observation.baseRelation !== "behind" &&
          observation.baseRelation !== "diverged")
      )
        continue;
      const task = taskStore.read(observation.cardId);
      const card = latestHumanReviewCards.find(
        (candidate) => candidate.id === observation.cardId,
      );
      const storedPlan = planStore.read(observation.cardId);
      if (task === null || card === undefined) continue;
      if (storedPlan === null) {
        const diagnosticKey = `${project.id}:${observation.cardId}:${observation.headSha}`;
        if (!reportedMissingMaintenancePlans.has(diagnosticKey)) {
          logger
            .child({ projectId: project.id, cardId: observation.cardId })
            .warn(
              "PR maintenance skipped: approved task plan is missing from context storage; cannot verify original requirements safely",
            );
          reportedMissingMaintenancePlans.add(diagnosticKey);
        }
        continue;
      }
      const maintenanceResult = await maintainOutdatedPr({
        project,
        card,
        task,
        worktreePath: path.join(project.repository.worktreeRoot, card.id),
        git,
        github,
        commands,
        mutationQueue: queue,
        taskStore,
        maintenanceStore,
        signal,
        eligible:
          observation.baseRelation === "behind" ||
          observation.baseRelation === "diverged",
        hasRequestedChanges: observation.requestedChanges !== null,
        hasUnresolvedFeedback: observation.feedbackIds.length > 0,
        requirementIds: storedPlan.plan.requirements.map(
          (requirement) => requirement.id,
        ),
        review: async ({
          contentIdentity,
          preparedHead,
          baseHead,
          requirementIds,
          validation,
          coverage,
          signal: reviewSignal,
        }) =>
          runPrMaintenanceReview({
            openCode,
            project,
            card,
            worktreePath: path.join(project.repository.worktreeRoot, card.id),
            approvedRequirements: storedPlan.plan.requirements,
            changedFiles: await git.getChangedFiles(
              path.join(project.repository.worktreeRoot, card.id),
              baseHead,
            ),
            requirementIds,
            preparedHead,
            contentIdentity,
            validation,
            coverage,
            signal: reviewSignal,
          }),
        remediateConflict: async ({
          conflictedPaths,
          rebase,
          attempt,
          signal: remediationSignal,
        }) => {
          if (task.primarySessionId === undefined)
            throw new Error(
              "PR maintenance conflict remediation requires the primary task session",
            );
          const result = await openCode.run({
            cwd: path.join(project.repository.worktreeRoot, card.id),
            model: project.opencode.remediation.model,
            variant: project.opencode.remediation.variant,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal: remediationSignal,
            sessionId: task.primarySessionId,
            sessionLogPath: getSessionLogPath(project.id, card.id),
            sessionLabel: `PR maintenance conflict remediation pass ${attempt}`,
            prompt: [
              "Resolve only the active conflicts in this existing published task branch rebase.",
              `Task: ${card.name}`,
              `Task description: ${card.desc.trim() || "(No task description was provided.)"}`,
              `Task branch: agent/${card.id}`,
              `Rebase target commit: ${rebase.onto}`,
              `Original task head: ${rebase.originalHead}`,
              `Rebase progress: ${rebase.currentStep ?? "unknown"} of ${rebase.totalSteps ?? "unknown"}`,
              `Attempt: ${attempt} of ${project.opencode.remediation.maxPasses}`,
              `Exact currently conflicted paths:\n${conflictedPaths.map((file) => `- ${file}`).join("\n")}`,
              "Preserve both the task's intended changes and compatible changes from upstream; never discard either side automatically. Inspect current repository and Git state, resolve and stage only the active conflicts, then continue the rebase. Re-inspect paths at each subsequent rebase stop and continue until complete.",
              "Run the configured validation command if applicable. Do not push, create or modify pull requests, or perform unrelated work.",
            ].join("\n\n"),
          });
          if (result.exitCode !== 0)
            throw new Error(
              `PR maintenance conflict remediation exited with code ${result.exitCode}`,
            );
        },
      });
      if (
        maintenanceResult === "published" ||
        maintenanceResult === "reconciled" ||
        maintenanceResult === "conflicted"
      ) {
        maintenanceHandledCardIds.add(observation.cardId);
      }
      if (
        maintenanceResult === "published" ||
        maintenanceResult === "reconciled"
      ) {
        const published = taskStore.read(observation.cardId);
        if (
          published?.pullRequest?.url === observation.pullRequestUrl &&
          typeof published.pullRequest.headSha === "string" &&
          published.pullRequest.headSha !== observation.headSha
        ) {
          try {
            await enrichMaintainedPullRequestDescription({
              git,
              github,
              opencode: openCode,
              project,
              card,
              worktreePath: path.join(project.repository.worktreeRoot, card.id),
              pullRequestUrl: observation.pullRequestUrl,
              commitSha: published.pullRequest.headSha,
              verifiedFacts: [
                `Configured validation passed for maintained commit ${published.pullRequest.headSha}.`,
                "Independent implementation review passed for the maintained source.",
                "Fresh GitHub CI for the maintained head has not yet been verified.",
              ],
              signal,
            });
          } catch {
            logger
              .child({ projectId: project.id, cardId: card.id })
              .warn(
                "PR description enrichment failed after verified maintenance; publication and CI state remain intact",
              );
          }
        }
      }
    }
  }
  let feedbackNeedsAttention = false;
  for (const observation of latestObservations) {
    if (observation.state !== "OPEN") continue;
    if (maintenanceHandledCardIds.has(observation.cardId)) continue;
    const record = taskStore.read(observation.cardId);
    if (record === null || record.phase !== "human-feedback") continue;
    const card = latestHumanReviewCards.find(
      (candidate) => candidate.id === record.cardId,
    );
    if (card === undefined)
      throw new Error(
        `Observed task-session review card disappeared: ${record.cardId}`,
      );
    const feedbackResult = await runTaskSessionFeedbackCycle({
      project,
      card,
      observation,
      taskStore,
      planStore,
      ledgerStore: feedbackLedgerStore,
      mutationQueue: queue,
      trello,
      git,
      github,
      openCode,
      commands,
      worktreePath: path.join(project.repository.worktreeRoot, card.id),
      prepareAttachmentContext: () => options.prepareAttachmentContext(card),
      signal,
    });
    if (feedbackResult === "attention-required") feedbackNeedsAttention = true;
  }
  if (feedbackNeedsAttention) return;
  const strandedMutation = queue.getActive();
  const strandedTask =
    strandedMutation?.kind === "implementation"
      ? taskStore.read(strandedMutation.cardId)
      : null;
  if (
    strandedMutation?.kind === "implementation" &&
    strandedTask?.phase === "attention-required"
  ) {
    const strandedRecord = strandedTask;
    if (
      strandedRecord.projectId !== project.id ||
      strandedRecord.operationKey !== strandedMutation.operationKey ||
      strandedRecord.expectedBranch !== `agent/${strandedMutation.cardId}`
    )
      throw new Error(
        "Terminal failure record and queue identity do not match",
      );
    const failedCards = await getCardsForDiscovery(
      trello,
      project.id,
      project.trello.failedListId,
      "Could not verify Failed list before terminal recovery",
      signal,
    );
    const alreadyFailed = failedCards.some(
      (candidate) => candidate.id === strandedMutation.cardId,
    );
    if (!alreadyFailed) {
      if (strandedRecord.terminalFailure?.kind !== "implementation") {
        // This state predates the terminal-failure protocol. Keep the task,
        // queue and worktree intact, but never throw the same un-actionable
        // error every poll (which sends repeated attention emails).
        if (!reportedLegacyAttentionRequired.has(strandedMutation.eventId)) {
          reportedLegacyAttentionRequired.add(strandedMutation.eventId);
          logger
            .child({
              projectId: project.id,
              cardId: strandedMutation.cardId,
            })
            .warn(
              "Legacy attention-required publication remains preserved and blocked. Explicit operator recovery is required; no automatic Trello move, queue retirement, or repeated failure notification.",
            );
        }
        return;
      }
      const working = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.workingListId,
        "Could not verify Working list before terminal recovery",
        signal,
      );
      if (
        !working.some((candidate) => candidate.id === strandedMutation.cardId)
      )
        throw new Error(
          `Terminal failure card ${strandedMutation.cardId} is in neither its expected Working nor Failed list`,
        );
      await trello.moveCard(
        strandedMutation.cardId,
        project.trello.failedListId,
      );
      const confirmed = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.failedListId,
        "Could not confirm Failed transition during terminal recovery",
        signal,
      );
      if (
        !confirmed.some((candidate) => candidate.id === strandedMutation.cardId)
      )
        throw new Error(
          `Trello did not confirm terminal Failed transition for ${strandedMutation.cardId}`,
        );
      logger
        .child({ projectId: project.id, cardId: strandedMutation.cardId })
        .event("Terminal failure transition to Failed confirmed");
    }
    // Establish the operator-authorized terminal state before mutating queue
    // ownership. A missing authorization must leave a failed event recoverable
    // on the next poll without stranding it as an active claim.
    const owner = queue.claimForRecovery(strandedMutation.eventId);
    if (owner === null)
      throw new Error(
        `Terminal failure recovery cannot claim the verified queue event for ${strandedMutation.cardId}`,
      );
    const currentRecord = taskStore.read(strandedMutation.cardId);
    if (
      currentRecord === null ||
      currentRecord.operationKey !== strandedMutation.operationKey ||
      currentRecord.expectedBranch !== `agent/${strandedMutation.cardId}`
    )
      throw new Error(
        "Terminal failure identity changed during reconciliation",
      );
    if (
      currentRecord.terminalFailure?.kind === "implementation" &&
      currentRecord.terminalFailure.outcome !== "confirmed"
    )
      taskStore.compareAndSwap(currentRecord.cardId, currentRecord.revision, {
        ...currentRecord,
        terminalFailure: {
          ...currentRecord.terminalFailure,
          outcome: "confirmed",
        },
        revision: currentRecord.revision + 1,
        updatedAt: timestamp(currentRecord),
      });
    queue.complete(owner.eventId);
    return;
  }

  const workingCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.workingListId,
    "Could not inspect task-session Working cards",
    signal,
  );
  const activeMutation = queue.getActive();
  if (
    workingCards.length === 1 &&
    activeMutation?.kind === "refinement" &&
    activeMutation.cardId === workingCards[0]!.id &&
    activeMutation.projectId === project.id
  ) {
    const card = workingCards[0]!;
    const worktreePath = path.join(project.repository.worktreeRoot, card.id);
    const matchingEvents = queue
      .list()
      .filter(
        (candidate) =>
          candidate.kind === "refinement" &&
          candidate.projectId === project.id &&
          candidate.cardId === card.id &&
          candidate.eventId === activeMutation.eventId &&
          candidate.operationKey === activeMutation.operationKey,
      );
    if (
      matchingEvents.length !== 1 ||
      taskStore.read(card.id) !== null ||
      (await git.getCurrentBranch(worktreePath)) !== `agent/${card.id}`
    ) {
      throw new Error(
        `Refinement restart ownership is ambiguous for Working card ${card.id}`,
      );
    }
    const recovered = queue.claimForRecovery(activeMutation.eventId);
    if (recovered === null || options.processRefinement === undefined)
      throw new Error(
        `Could not safely resume refinement mutation for ${card.id}`,
      );
    try {
      await options.processRefinement(card, {
        path: worktreePath,
        branch: `agent/${card.id}`,
      });
      if (signal.aborted) queue.fail(recovered.eventId);
      else queue.complete(recovered.eventId);
      return;
    } catch (error) {
      queue.fail(recovered.eventId);
      throw error;
    }
  }
  let selectedCard: TrelloCard | null;
  let mutation: TaskMutationEvent | null = null;
  let recoveryRecord: TaskExecutionRecord | null = null;
  let recoveryWorktreePath: string | null = null;
  if (workingCards.length > 0) {
    const unowned = workingCards.filter(
      (card) => taskStore.read(card.id) === null,
    );
    if (unowned.length > 0) {
      throw new Error(
        `Refusing to process unowned Working card(s) without task-session records; operator recovery is required: ${unowned.map((card) => card.id).join(", ")}`,
      );
    }
    if (workingCards.length > 1) {
      throw new Error(
        `Multiple task-session Working cards require recovery: ${workingCards.map(({ id }) => id).join(", ")}`,
      );
    }
    const card = workingCards[0]!;
    const record = taskStore.read(card.id);
    if (record === null)
      throw new Error(`Task execution record disappeared for ${card.id}`);
    if (record.phase === "attention-required" && record.terminalFailure) {
      const matching = queue
        .list()
        .filter(
          (candidate) =>
            candidate.projectId === project.id &&
            candidate.cardId === card.id &&
            candidate.operationKey === record.operationKey &&
            candidate.kind === "implementation",
        );
      if (matching.length !== 1)
        throw new Error(
          `Terminal failure recovery requires one matching mutation event for ${project.id}/${card.id}`,
        );
      const owner = queue.claimForRecovery(matching[0]!.eventId);
      if (owner === null)
        throw new Error(
          `Terminal failure recovery cannot claim the verified queue event for ${card.id}`,
        );
      const failedCards = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.failedListId,
        "Could not verify Failed list before terminal recovery",
        signal,
      );
      if (!failedCards.some((candidate) => candidate.id === card.id)) {
        const currentWorkingCard = workingCards.find(
          (candidate) => candidate.id === card.id,
        );
        if (currentWorkingCard === undefined)
          throw new Error(
            "Terminal failure card identity changed during recovery",
          );
        await trello.moveCard(card.id, project.trello.failedListId);
        const confirmed = await getCardsForDiscovery(
          trello,
          project.id,
          project.trello.failedListId,
          "Could not confirm Failed transition during terminal recovery",
          signal,
        );
        if (!confirmed.some((candidate) => candidate.id === card.id))
          throw new Error(
            `Trello did not confirm terminal Failed transition for ${card.id}`,
          );
        logger
          .child({ projectId: project.id, cardId: card.id })
          .event("Terminal failure transition to Failed confirmed");
      }
      const latestFailureRecord = taskStore.read(card.id);
      if (
        latestFailureRecord === null ||
        latestFailureRecord.operationKey !== record.operationKey ||
        latestFailureRecord.terminalFailure?.kind !== "implementation"
      )
        throw new Error(`Terminal failure identity changed for ${card.id}`);
      if (latestFailureRecord.terminalFailure.outcome !== "confirmed")
        taskStore.compareAndSwap(card.id, latestFailureRecord.revision, {
          ...latestFailureRecord,
          terminalFailure: {
            ...latestFailureRecord.terminalFailure,
            outcome: "confirmed",
          },
          revision: latestFailureRecord.revision + 1,
          updatedAt: timestamp(latestFailureRecord),
        });
      queue.complete(owner.eventId);
      return;
    }
    const worktreePath = path.join(project.repository.worktreeRoot, card.id);
    const recovery = await reconcileTaskSession({
      project,
      cardId: card.id,
      expectedBranch: `agent/${card.id}`,
      operationKey: record.operationKey,
      worktreePath,
      taskRecordStore: taskStore,
      signal,
      readAuthoritativeSnapshot: (ownedRecord) =>
        readTaskSessionRecoverySnapshot({
          project,
          card,
          record: ownedRecord,
          worktreePath,
          git,
          github,
          commands,
          signal,
        }),
    });
    if (recovery.status !== "resume") {
      if (
        recovery.status === "attention-required" &&
        record.phase !== "attention-required"
      )
        throw new Error(
          `Task-session restart requires attention for ${card.id}: ${recovery.reason}`,
        );
      return;
    }
    if (signal.aborted) return;

    const matchingEvents = queue
      .list()
      .filter(
        (event) =>
          event.cardId === card.id &&
          event.projectId === project.id &&
          event.kind === "implementation" &&
          event.operationKey === record.operationKey,
      );
    if (matchingEvents.length !== 1) {
      const latest = taskStore.read(card.id);
      if (latest !== null && latest.phase !== "attention-required")
        taskStore.compareAndSwap(
          card.id,
          latest.revision,
          transitionTaskExecutionRecord(latest, {
            type: "attention-required",
            eventId: `${latest.operationKey}:recovery-missing-queue:${latest.revision}`,
            projectId: project.id,
            cardId: card.id,
            operationKey: latest.operationKey,
            occurredAt: timestamp(latest),
          }),
        );
      throw new Error(
        `Task-session restart has no unique mutation queue event for ${card.id}`,
      );
    }
    const recoveryEvent = matchingEvents[0]!;
    const activeEvent = queue.getActive();
    if (
      activeEvent !== null &&
      (activeEvent.eventId !== recoveryEvent.eventId ||
        activeEvent.cardId !== card.id ||
        activeEvent.operationKey !== record.operationKey)
    ) {
      throw new Error(
        `Task-session restart cannot resume ${card.id}; another task owns the project mutation queue`,
      );
    }
    if (recoveryEvent.status === "completed") {
      const latest = taskStore.read(card.id);
      if (latest !== null && latest.phase !== "attention-required")
        taskStore.compareAndSwap(
          card.id,
          latest.revision,
          transitionTaskExecutionRecord(latest, {
            type: "attention-required",
            eventId: `${latest.operationKey}:recovery-queue-completed:${latest.revision}`,
            projectId: project.id,
            cardId: card.id,
            operationKey: latest.operationKey,
            occurredAt: timestamp(latest),
          }),
        );
      throw new Error(
        `Task-session restart found a completed queue event for active card ${card.id}`,
      );
    }
    const claimedRecoveryEvent = queue.claimForRecovery(recoveryEvent.eventId);
    if (claimedRecoveryEvent === null)
      throw new Error(
        `Task-session restart could not claim the verified recovery event for ${card.id}`,
      );

    selectedCard = card;
    mutation = claimedRecoveryEvent;
    recoveryRecord = recovery.record;
    recoveryWorktreePath = worktreePath;
  } else {
    const readyCards = await getCardsForDiscovery(
      trello,
      project.id,
      project.trello.readyListId,
      "Could not retrieve Ready for Agent cards",
      signal,
    );
    const eligibleCards = readyCards.filter(
      (card) =>
        isCardStartDateReached(card, Date.now()) &&
        getWorkflowKind(card, project) !== null,
    );
    let readyRecoveryEvent: TaskMutationEvent | null = null;
    for (const [readyIndex, card] of eligibleCards.entries()) {
      if (taskStore.read(card.id) !== null) {
        throw new Error(
          `Ready card ${card.id} already has task-session ownership; refusing to start a duplicate task`,
        );
      }
      const digest = createHash("sha256")
        .update(`${card.name}\0${card.desc}\0${card.idLabels.join(",")}`)
        .digest("hex")
        .slice(0, 16);
      const queuedEvent = queue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: `implementation:${card.id}:${digest}`,
        operationKey: `task-session:${card.id}:${digest}`,
        kind: getWorkflowKind(card, project)!,
        // Preserve Trello's Ready-list order even when cards are observed in
        // the same clock millisecond and the queue's stable tie-break applies.
        enqueuedAt: new Date(Date.now() + readyIndex).toISOString(),
      });
      const activeEvent = queue.getActive();
      if (
        activeEvent !== null &&
        activeEvent.cardId === card.id &&
        activeEvent.operationKey !== queuedEvent.operationKey
      ) {
        throw new Error(
          `Ready card ${card.id} changed identity while its prior task-session operation remains active`,
        );
      }
      if (queuedEvent.status === "completed") {
        throw new Error(
          `Ready card ${card.id} has a completed implementation event but no task record; operator recovery is required`,
        );
      }
      if (queuedEvent.status === "active" || queuedEvent.status === "failed") {
        if (readyRecoveryEvent !== null)
          throw new Error(
            "Multiple interrupted task-session Ready claims require recovery",
          );
        readyRecoveryEvent = queuedEvent;
      }
    }
    mutation =
      readyRecoveryEvent === null
        ? queue.claimNext()
        : queue.claimForRecovery(readyRecoveryEvent.eventId);
    if (mutation === null) return;
    selectedCard =
      eligibleCards.find((candidate) => candidate.id === mutation!.cardId) ??
      null;
    if (selectedCard === null)
      throw new Error(
        `Queued task ${mutation.cardId} is no longer in Ready for Agent`,
      );
  }
  if (mutation === null || selectedCard === null) return;
  const card = selectedCard;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  if (recoveryRecord !== null) {
    cardLog.event(`Recovering existing task in ${recoveryRecord.phase} phase`);
  }
  try {
    if (mutation.kind === "refinement") {
      if (recoveryRecord !== null) {
        throw new Error(
          "Refinement recovery cannot reuse an implementation task record",
        );
      }
      if (options.processRefinement === undefined) {
        throw new Error("Unified scheduler has no refinement operation");
      }
      const worktree = await prepareWorktree(git, project, card.id);
      cardLog.event("Worktree prepared");
      const claimedCard = await trello.moveCard(
        card.id,
        project.trello.workingListId,
      );
      cardLog.event("Card claimed; transition to Working succeeded");
      await options.processRefinement(claimedCard ?? card, worktree);
      if (signal.aborted) queue.fail(mutation.eventId);
      else queue.complete(mutation.eventId);
      return;
    }
    let worktree: { path: string; branch: string };
    let activeCard: TrelloCard;
    let operationKey: string;
    if (recoveryRecord !== null) {
      worktree = {
        path: recoveryWorktreePath!,
        branch: recoveryRecord.expectedBranch!,
      };
      activeCard = card;
      operationKey = recoveryRecord.operationKey;
    } else {
      worktree = await prepareWorktree(git, project, card.id);
      cardLog.event("Worktree prepared");
      const claimedCard = await trello.moveCard(
        card.id,
        project.trello.workingListId,
      );
      cardLog.event("Card claimed; transition to Working succeeded");
      activeCard = claimedCard ?? card;
      operationKey = mutation.operationKey;
      taskStore.create({
        version: 1,
        projectId: project.id,
        cardId: activeCard.id,
        phase: "planning",
        expectedBranch: worktree.branch,
        operationKey,
        setup: {
          command: project.repository.setupCommand ?? null,
          status:
            project.repository.setupCommand === undefined
              ? "not-required"
              : "pending",
        },
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const worktreePath = worktree.path;
    const recordBeforeSetup = taskStore.read(activeCard.id);
    if (
      project.repository.setupCommand !== undefined &&
      recordBeforeSetup?.setup?.status === "pending"
    ) {
      updateRecord(taskStore, recordBeforeSetup, {
        setup: { command: project.repository.setupCommand, status: "active" },
      });
      const setup = await runRepositorySetup(commands, {
        cwd: worktreePath,
        command: project.repository.setupCommand,
        timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        signal,
        sessionLogPath: getSessionLogPath(project.id, activeCard.id),
        sessionLabel: "Task-session repository setup",
      });
      if (setup.exitCode !== 0) {
        throw new Error(
          `Task-session repository setup exited with code ${setup.exitCode}`,
        );
      }
      const setupRecord = taskStore.read(activeCard.id);
      if (setupRecord !== null)
        updateRecord(taskStore, setupRecord, {
          setup: { command: project.repository.setupCommand, status: "passed" },
        });
    }
    const attachmentContext =
      await options.prepareAttachmentContext(activeCard);
    const sessionLogPath = getSessionLogPath(project.id, activeCard.id);
    const commonRunOptions = {
      model: project.opencode.implementation.model,
      variant: project.opencode.implementation.variant,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
      signal,
      sessionLabel: "Task-session engineering",
      sessionLogPath,
    };
    let taskRecord = taskStore.read(activeCard.id);
    if (taskRecord === null)
      throw new Error("Task record disappeared before task-session execution");
    if (taskRecord.phase === "planning") {
      if (planStore.read(activeCard.id) === null) {
        cardLog.event("Planning started");
        await runTaskPlanningOperation({
          taskRecordStore: taskStore,
          planStore,
          openCode,
          projectId: project.id,
          card: activeCard,
          ...(attachmentContext === undefined ? {} : { attachmentContext }),
          runOptions: { ...commonRunOptions, cwd: worktreePath },
        });
        cardLog.event("Planning completed");
      }
      const savedPlan = planStore.read(activeCard.id);
      if (savedPlan === null)
        throw new Error("Task planning completed without a persisted plan");
      if (savedPlan.verification?.verdict !== "pass") {
        cardLog.event("Independent plan verification started");
        const verification = await runPlanVerification({
          taskRecordStore: taskStore,
          planStore,
          openCode,
          projectId: project.id,
          card: activeCard,
          ...(attachmentContext === undefined ? {} : { attachmentContext }),
          runOptions: {
            cwd: worktreePath,
            model: project.opencode.review.model,
            variant: project.opencode.review.variant,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
            readOnly: true,
          },
        });
        if (verification.verification.verdict !== "pass") {
          cardLog.event("Independent plan verification failed");
          throw new Error("Independent plan verification did not pass");
        }
        cardLog.event("Independent plan verification passed");
      }
    } else {
      const savedPlan = planStore.read(activeCard.id);
      if (savedPlan?.verification?.verdict !== "pass")
        throw new Error(
          "Persisted task phase has no independently verified plan",
        );
    }
    taskRecord = taskStore.read(activeCard.id);
    if (taskRecord === null)
      throw new Error("Task record disappeared before implementation");
    if (
      taskRecord.phase === "planning" ||
      taskRecord.phase === "implementation"
    ) {
      if (
        taskRecord.phase === "implementation" &&
        taskRecord.reviewRepair?.status === "active"
      ) {
        throw new Error(
          "Interrupted review repair does not contain its persisted findings; manual attention is required",
        );
      }
      cardLog.event("Implementation started");
      await runTaskSessionImplementation({
        taskRecordStore: taskStore,
        planStore,
        git,
        openCode,
        project,
        card: activeCard,
        expectedBranch: worktree.branch,
        operationKey,
        worktreePath,
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        resume: taskRecord.phase === "implementation",
        runOptions: commonRunOptions,
      });
      cardLog.event("Implementation completed");
    }
    const validationOptions = {
      project,
      cardId: activeCard.id,
      expectedBranch: worktree.branch,
      operationKey,
      worktreePath,
      taskRecordStore: taskStore,
      git,
      commands,
      signal,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    };
    const phaseRecord = taskStore.read(activeCard.id);
    if (phaseRecord === null)
      throw new Error("Task record disappeared before local quality gates");
    let quality: Awaited<
      ReturnType<typeof runTaskSessionValidationWithRepairs>
    >;
    if (phaseRecord.phase === "validation") {
      cardLog.event("Validation started");
      try {
        quality = await runTaskSessionValidationWithRepairs({
          validation: validationOptions,
          openCode,
          planStore,
          card: activeCard,
          expectedPrimarySessionId: phaseRecord.primarySessionId!,
          ...(attachmentContext === undefined ? {} : { attachmentContext }),
          repairRunOptions: {
            model: project.opencode.remediation.model,
            variant: project.opencode.remediation.variant,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
          },
        });
        cardLog.event("Validation passed");
      } catch (error) {
        cardLog.event("Validation failed");
        throw error;
      }
    } else if (
      phaseRecord.phase === "review" ||
      phaseRecord.phase === "publication"
    ) {
      const validationEvidence = phaseRecord.validationRepair?.evidence;
      const coverageEvidence = phaseRecord.validationRepair?.coverageEvidence;
      if (
        phaseRecord.validationRepair?.status !== "passed" ||
        validationEvidence === undefined ||
        validationEvidence.command !== validationCommand ||
        (project.repository.coverageCommand !== undefined &&
          coverageEvidence?.command !== project.repository.coverageCommand)
      ) {
        throw new Error(
          "Persisted review/publication phase has incomplete local quality evidence",
        );
      }
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      if (
        currentIdentity !== validationEvidence.contentIdentity ||
        (coverageEvidence !== undefined &&
          currentIdentity !== coverageEvidence.contentIdentity)
      ) {
        throw new Error(
          "Persisted local quality evidence is stale after task-session restart",
        );
      }
      const restoreEvidence = (
        evidence: NonNullable<typeof validationEvidence>,
      ): TaskSessionValidationResult => ({
        ...evidence,
        status: "passed",
        timedOut: false,
        aborted: false,
      });
      const validation = restoreEvidence(validationEvidence);
      const coverage =
        coverageEvidence === undefined
          ? null
          : restoreEvidence(coverageEvidence);
      quality = {
        validation,
        coverage,
        attempts: phaseRecord.retryCounters.validation,
        record: phaseRecord,
      };
    } else {
      throw new Error(
        `Cannot resume local task-session work from phase ${phaseRecord.phase}`,
      );
    }
    let currentValidation = quality.validation;
    let currentCoverage = quality.coverage;
    const expectedSession = taskStore.read(activeCard.id)!.primarySessionId!;
    const runReview = async () => {
      cardLog.event("Review started");
      const result = await runTaskSessionReview({
        project,
        card: activeCard,
        expectedBranch: worktree.branch,
        operationKey,
        worktreePath,
        taskRecordStore: taskStore,
        planStore,
        git,
        openCode,
        validation: currentValidation,
        coverage: currentCoverage,
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        runOptions: {
          model: project.opencode.review.model,
          variant: project.opencode.review.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
        },
      });
      cardLog.event(
        result.review.verdict === "pass" ? "Review passed" : "Review failed",
      );
      return { review: result.review, contentIdentity: result.contentIdentity };
    };
    const runQualityAgain = async () => {
      quality = await runTaskSessionValidationWithRepairs({
        validation: validationOptions,
        openCode,
        planStore,
        card: activeCard,
        expectedPrimarySessionId: expectedSession,
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        repairRunOptions: {
          model: project.opencode.remediation.model,
          variant: project.opencode.remediation.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
        },
      });
      currentValidation = quality.validation;
      currentCoverage = quality.coverage;
    };
    let finalReview: Awaited<
      ReturnType<typeof runTaskSessionReviewWithRepairs>
    >;
    if (phaseRecord.phase === "publication") {
      let current = taskStore.read(activeCard.id);
      if (current === null)
        throw new Error("Task record disappeared during publication recovery");
      const persistedReview = current.reviewRepair?.finalReview;
      let review: Awaited<ReturnType<typeof runReview>>;
      if (persistedReview !== undefined) {
        const identity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktreePath,
        );
        if (persistedReview.reviewedContentIdentity === identity) {
          review = { review: persistedReview, contentIdentity: identity };
        } else if (current.reviewRepair?.status === "exhausted") {
          // Exhausted reviews may not silently authorize changed content or
          // trigger further AI review rounds after the configured limit.
          throw new Error(
            "Persisted exhausted review is stale after publication",
          );
        } else {
          // A successful pre-commit review may need refresh if a commit
          // changes the source snapshot identity used by the reviewer.
          review = await runReview();
          if (review.review.verdict !== "pass")
            throw new Error("Publication recovery review did not pass");
          current = updateRecord(taskStore, current, {
            reviewRepair: {
              ...current.reviewRepair!,
              finalReview: review.review,
            },
          });
        }
      } else {
        // Legacy publication records may predate the durable final review.
        review = await runReview();
        if (
          review.review.verdict !== "pass" &&
          current.reviewRepair?.status !== "exhausted"
        )
          throw new Error(
            "Interrupted publication has no accepted review evidence",
          );
        current = updateRecord(taskStore, current, {
          reviewRepair: {
            cycleId: operationKey,
            status: review.review.verdict === "pass" ? "passed" : "exhausted",
            maxAttempts: Math.max(
              current.retryCounters.review,
              project.opencode.remediation.maxPasses,
            ),
            finalReview: review.review,
          },
        });
      }
      finalReview = {
        ...review,
        attempts: current.retryCounters.review,
        record: current,
      };
    } else {
      finalReview = await runTaskSessionReviewWithRepairs({
        maxAttempts: project.opencode.remediation.maxPasses,
        store: taskStore,
        projectId: project.id,
        cardId: activeCard.id,
        operationKey,
        expectedPrimarySessionId: expectedSession,
        runReview,
        repair: async (review, attempt) => {
          cardLog.event(`Review repair attempt ${attempt} started`);
          let current = taskStore.read(activeCard.id);
          if (current === null)
            throw new Error(
              "Task record disappeared during review remediation",
            );
          const failed = transitionTaskExecutionRecord(
            current,
            event(current, "review-failed"),
          );
          taskStore.compareAndSwap(activeCard.id, current.revision, failed);
          const plan = planStore.read(activeCard.id);
          if (plan === null)
            throw new Error(
              "Approved plan disappeared during review remediation",
            );
          const prompt = buildTaskSessionReviewRepairPrompt({
            projectId: project.id,
            card: activeCard,
            approvedPlan: plan.plan,
            review,
            attempt,
            maxAttempts: project.opencode.remediation.maxPasses,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
          });
          const repaired = await runWithPrimaryTaskSession(
            taskStore,
            openCode,
            project.id,
            activeCard.id,
            {
              ...commonRunOptions,
              cwd: worktreePath,
              prompt,
            },
          );
          if (repaired.exitCode !== 0)
            throw new Error(
              `Primary review repair exited with code ${repaired.exitCode}`,
            );
          cardLog.event(`Review repair attempt ${attempt} completed`);
          current = taskStore.read(activeCard.id);
          if (current === null)
            throw new Error("Task record disappeared after review repair");
          const implemented = transitionTaskExecutionRecord(
            current,
            event(current, "implementation-completed"),
          );
          const inValidation = taskStore.compareAndSwap(
            activeCard.id,
            current.revision,
            implemented,
          );
          updateRecord(taskStore, inValidation, {
            retryCounters: { ...inValidation.retryCounters, validation: 0 },
            validationRepair: { cycleId: operationKey, status: "active" },
          });
        },
        rerunQuality: runQualityAgain,
        getCurrentContentIdentity: () =>
          getTaskSessionSourceSnapshotIdentity(git, worktreePath),
      });
    }
    const identity = await getTaskSessionSourceSnapshotIdentity(
      git,
      worktreePath,
    );
    const initialEvidence: VerifiedPublicationDecisionInput = {
      currentContentIdentity: identity,
      validationCommand,
      validation: currentValidation,
      ...(project.repository.coverageCommand === undefined
        ? {}
        : { coverageCommand: project.repository.coverageCommand }),
      coverage: currentCoverage,
      review: finalReview.review,
    };
    const exhaustedReview =
      finalReview.record.reviewRepair?.status === "exhausted"
        ? finalReview.record.reviewRepair.finalReview
        : undefined;
    if (!decideHumanReviewPublication(initialEvidence, exhaustedReview).allowed)
      throw new Error(
        "Final local evidence does not allow task-session publication",
      );
    const recoveredTrustedCommit =
      phaseRecord.phase === "publication"
        ? readTrustedCommitState(project, activeCard.id)
        : null;
    if (phaseRecord.phase === "publication" && recoveredTrustedCommit === null)
      throw new Error(
        "Interrupted publication has no trusted commit; refusing to guess whether commit creation completed",
      );
    if (
      recoveredTrustedCommit !== null &&
      (await git.getHeadSha(worktreePath)) !== recoveredTrustedCommit.commitSha
    )
      throw new Error(
        "Trusted publication commit does not match the recovered worktree HEAD",
      );
    let commitMessage: string | undefined;
    if (recoveredTrustedCommit === null) {
      const commitOptions = commitMessageRunOptions(
        project,
        signal,
        getSessionLogPath(project.id, activeCard.id),
      );
      clearCommitResult(worktreePath);
      const snapshotBefore = await captureRepositorySnapshot(git, worktreePath);
      const commitMessageResult = await runWithPrimaryTaskSession(
        taskStore,
        openCode,
        project.id,
        activeCard.id,
        {
          ...commitOptions,
          cwd: worktreePath,
          prompt: buildCommitPrompt(activeCard),
        },
      );
      if (commitMessageResult.exitCode !== 0)
        throw new Error(
          `Commit message session exited with code ${commitMessageResult.exitCode}`,
        );
      commitMessage = readCommitResult(worktreePath).message;
      clearCommitResult(worktreePath);
      const snapshotAfter = await captureRepositorySnapshot(git, worktreePath);
      if (!repositorySnapshotsEqual(snapshotBefore, snapshotAfter))
        throw new Error("Commit message generation changed source files");
      const latest = taskStore.read(activeCard.id);
      if (latest === null)
        throw new Error("Task record disappeared before publication");
      if (latest.phase === "review") {
        const publication = transitionTaskExecutionRecord(
          latest,
          event(
            latest,
            exhaustedReview === undefined
              ? "review-passed"
              : "review-exhausted",
          ),
        );
        taskStore.compareAndSwap(activeCard.id, latest.revision, publication);
      } else if (latest.phase !== "publication") {
        throw new Error(
          `Task phase changed unexpectedly before publication: ${latest.phase}`,
        );
      }
    }

    let preparedEvidence = initialEvidence;
    const verifyPreparedContent = async () => {
      const freshValidation = await runTaskSessionValidation(validationOptions);
      const freshCoverage = await runTaskSessionCoverage(validationOptions);
      if (
        freshValidation.status !== "passed" ||
        (freshCoverage !== null && freshCoverage.status !== "passed")
      ) {
        throw new Error("Prepared publication quality checks failed");
      }
      const current = taskStore.read(activeCard.id);
      if (current === null)
        throw new Error(
          "Task record disappeared during publication preparation",
        );
      persistQualityEvidence(
        taskStore,
        current,
        operationKey,
        freshValidation,
        freshCoverage,
      );
      // Do not consume further AI review rounds after the configured limit.
      // A rebased snapshot may be published with the persisted failed review
      // only if its content identity remains exactly the same.
      const freshReview =
        finalReview.review.reviewedContentIdentity ===
        (await getTaskSessionSourceSnapshotIdentity(git, worktreePath))
          ? { review: finalReview.review }
          : exhaustedReview === undefined
            ? await runTaskSessionReview({
                project,
                card: activeCard,
                expectedBranch: worktree.branch,
                operationKey,
                worktreePath,
                taskRecordStore: taskStore,
                planStore,
                git,
                openCode,
                validation: freshValidation,
                coverage: freshCoverage,
                runOptions: {
                  model: project.opencode.review.model,
                  variant: project.opencode.review.variant,
                  timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                  signal,
                },
              })
            : { review: exhaustedReview };
      const freshIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      preparedEvidence = {
        currentContentIdentity: freshIdentity,
        validationCommand,
        validation: freshValidation,
        ...(project.repository.coverageCommand === undefined
          ? {}
          : { coverageCommand: project.repository.coverageCommand }),
        coverage: freshCoverage,
        review: freshReview.review,
      };
      const preparedRecord = taskStore.read(activeCard.id);
      if (preparedRecord === null)
        throw new Error(
          "Task record disappeared while persisting final publication evidence",
        );
      updateRecord(taskStore, preparedRecord, {
        publicationQuality: {
          contentIdentity: freshIdentity,
          validation: {
            command: freshValidation.command,
            startedAt: freshValidation.startedAt,
            completedAt: freshValidation.completedAt,
            exitCode: 0,
            diagnostic: freshValidation.diagnostic,
            contentIdentity: freshValidation.contentIdentity,
          },
          ...(freshCoverage === null
            ? {}
            : {
                coverageEvidence: {
                  command: freshCoverage.command,
                  startedAt: freshCoverage.startedAt,
                  completedAt: freshCoverage.completedAt,
                  exitCode: 0,
                  diagnostic: freshCoverage.diagnostic,
                  contentIdentity: freshCoverage.contentIdentity,
                },
              }),
          review: freshReview.review,
        },
      });
      return preparedEvidence;
    };
    let publishedSha: string;
    if (recoveredTrustedCommit !== null) {
      await publishCard({
        trello,
        git,
        github,
        opencode: openCode,
        commands,
        project: { ...project, autoMerge: false },
        card: activeCard,
        worktreePath,
        branch: worktree.branch,
        commitSha: recoveredTrustedCommit.commitSha,
        reviewResult:
          exhaustedReview === undefined
            ? "Passed"
            : "Failed (human review required; automatic repairs exhausted)",
        remediationResult: `${finalReview.attempts} review repair(s)`,
        ...(exhaustedReview === undefined ? {} : { exhaustedReview }),
        verifiedDescriptionFacts: () => [
          `Approved implementation plan: ${JSON.stringify(planStore.read(activeCard.id)?.plan ?? "unavailable")}`,
          `Verified validation result: ${JSON.stringify(preparedEvidence.validation)}`,
          ...(preparedEvidence.coverage === null
            ? []
            : [
                `Verified coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
              ]),
          `Independent review result: ${JSON.stringify(preparedEvidence.review)}`,
        ],
        signal,
        ...(recoveryRecord?.pullRequest?.url === undefined
          ? {}
          : { expectedExistingPullRequestUrl: recoveryRecord.pullRequest.url }),
        beforePushVerification: async () => {
          preparedEvidence = await verifyPreparedContent();
          const rebasedHead = await git.getHeadSha(worktreePath);
          const allowStaleExhaustedReview =
            exhaustedReview !== undefined &&
            rebasedHead !== recoveredTrustedCommit.commitSha;
          if (
            allowStaleExhaustedReview &&
            (await git.getStatus(worktreePath)).trim().length > 0
          )
            throw new Error(
              "Refusing exhausted-review publication from a dirty rebased worktree",
            );
          const decision = decideHumanReviewPublication(
            preparedEvidence,
            exhaustedReview,
            { allowStaleExhaustedReview },
          );
          if (!decision.allowed)
            throw new Error(
              `Prepared human-review publication evidence is invalid: ${decision.reasons.join("; ")}`,
            );
        },
      });
      publishedSha = await git.getHeadSha(worktreePath);
    } else {
      if (commitMessage === undefined)
        throw new Error("Task-session commit message is unavailable");
      publishedSha = await publishTaskSessionCard({
        trello,
        git,
        github,
        opencode: openCode,
        commands,
        project: { ...project, autoMerge: false },
        card: activeCard,
        worktreePath,
        branch: worktree.branch,
        commitMessage,
        reviewResult:
          finalReview.review.verdict === "pass"
            ? "Passed"
            : "Failed (human review required; automatic repairs exhausted)",
        remediationResult: `${finalReview.attempts} review repair(s)`,
        ...(exhaustedReview === undefined ? {} : { exhaustedReview }),
        verifiedDescriptionFacts: () => [
          `Approved implementation plan: ${JSON.stringify(planStore.read(activeCard.id)?.plan ?? "unavailable")}`,
          `Verified validation result: ${JSON.stringify(preparedEvidence.validation)}`,
          ...(preparedEvidence.coverage === null
            ? []
            : [
                `Verified coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
              ]),
          `Independent review result: ${JSON.stringify(preparedEvidence.review)}`,
        ],
        signal,
        initialEvidence,
        verifyPreparedContent,
      });
    }
    cardLog.event(
      `${recoveredTrustedCommit === null ? "Commit created" : "Trusted commit reused"}: ${publishedSha}`,
    );
    const pr = await github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: worktree.branch,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    if (pr === null || pr.headRefOid !== publishedSha || pr.state !== "OPEN")
      throw new Error(
        "Published PR could not be verified on its expected head",
      );
    cardLog.event(
      `Pull request published or reused: #${Number(new URL(pr.url).pathname.split("/").at(-1))} ${pr.url}`,
    );
    const current = taskStore.read(activeCard.id);
    if (current === null)
      throw new Error("Task record disappeared after PR publication");
    const prNumber = Number(new URL(pr.url).pathname.split("/").at(-1));
    if (!Number.isSafeInteger(prNumber) || prNumber < 1)
      throw new Error("Published pull request URL contains an invalid number");
    const ci = transitionTaskExecutionRecord(current, {
      type: "publication-completed",
      eventId: `${operationKey}:publication-completed`,
      projectId: project.id,
      cardId: activeCard.id,
      operationKey,
      occurredAt: timestamp(current),
      pullRequest: { number: prNumber, url: pr.url, headSha: pr.headRefOid },
    });
    taskStore.compareAndSwap(activeCard.id, current.revision, ci);
    if (project.autoMerge && exhaustedReview === undefined) {
      const ciObservation = await github.getCiObservations({
        cwd: project.repository.path,
        repository: project.repository.github,
        defaultBranch: project.repository.defaultBranch,
        headSha: publishedSha,
        pullRequestNumber: prNumber,
        project,
      });
      const ciEvaluation = evaluateCiChecks({
        expectedHeadSha: publishedSha,
        observedHeadSha: ciObservation.headSha,
        expectations: establishCiCheckExpectations(
          ciObservation.expectationSources,
        ),
        checks: ciObservation.checks,
      });
      cardLog.event(
        `CI ${ciEvaluation.status === "waiting" ? "waiting" : ciEvaluation.status === "failed" ? "failed" : "passed"} for ${publishedSha}`,
      );
      if (ciEvaluation.status === "passed") {
        await mergeTaskSessionPullRequest(
          github,
          project,
          activeCard,
          pr.url,
          publishedSha,
          project.repository.path,
          {
            expectedHeadSha: publishedSha,
            observedHeadSha: publishedSha,
            ciEvaluation,
            localEvidence: preparedEvidence,
          },
          signal,
        );
        const mergedPullRequest = await github.findPullRequestState({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: worktree.branch,
          baseBranch: project.repository.defaultBranch,
          project,
        });
        if (mergedPullRequest === null) {
          throw new Error(
            `Could not verify merged pull request for ${activeCard.id}`,
          );
        }
        await completeMergedTaskSession({
          queue,
          taskStore,
          trello,
          git,
          project,
          card: activeCard,
          pullRequest: mergedPullRequest,
          completionComment: buildAutoMergeSummary({
            pullRequestUrl: pr.url,
            commitSha: publishedSha,
            reviewResult: "Passed",
            remediationResult: `${finalReview.attempts} review repair(s)`,
          }),
          releaseMutationEventId: mutation.eventId,
          onMutationReleased: () => {
            mutation = null;
          },
          ...(emailNotifier === undefined ? {} : { emailNotifier }),
          signal,
        });
        mutation = null;
      }
    }
    if (mutation !== null) queue.complete(mutation.eventId);
  } catch (error) {
    const failedRecord =
      mutation === null ? null : taskStore.read(mutation.cardId);
    if (
      mutation !== null &&
      failedRecord?.phase === "attention-required" &&
      failedRecord.terminalFailure?.kind === "implementation" &&
      failedRecord.terminalFailure.outcome === "pending" &&
      queue.ownsActive(mutation.eventId) &&
      !signal.aborted
    ) {
      const failedCards = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.failedListId,
        "Could not verify Failed list after implementation failure",
        signal,
      );
      if (!failedCards.some((candidate) => candidate.id === mutation!.cardId)) {
        await trello.moveCard(mutation.cardId, project.trello.failedListId);
        const confirmed = await getCardsForDiscovery(
          trello,
          project.id,
          project.trello.failedListId,
          "Could not confirm Failed transition after implementation failure",
          signal,
        );
        if (!confirmed.some((candidate) => candidate.id === mutation!.cardId))
          throw new Error(
            `Trello did not confirm terminal Failed transition for ${mutation.cardId}`,
            { cause: error },
          );
      }
      const latest = taskStore.read(mutation.cardId);
      if (
        latest === null ||
        latest.operationKey !== mutation.operationKey ||
        latest.terminalFailure?.kind !== "implementation"
      )
        throw new Error(
          `Terminal failure identity changed for ${mutation.cardId}`,
          { cause: error },
        );
      if (latest.terminalFailure.outcome !== "confirmed")
        taskStore.compareAndSwap(mutation.cardId, latest.revision, {
          ...latest,
          terminalFailure: { ...latest.terminalFailure, outcome: "confirmed" },
          revision: latest.revision + 1,
          updatedAt: timestamp(latest),
        });
      queue.complete(mutation.eventId);
      mutation = null;
      throw error;
    }
    if (recoveryRecord !== null && !signal.aborted) {
      const latest = taskStore.read(recoveryRecord.cardId);
      let commitVerified = false;
      if (latest?.phase === "publication") {
        try {
          const trusted = readTrustedCommitState(
            project,
            recoveryRecord.cardId,
          );
          commitVerified =
            trusted !== null &&
            (await git.getHeadSha(recoveryWorktreePath!)) === trusted.commitSha;
        } catch {
          commitVerified = false;
        }
      }
      if (
        latest !== null &&
        latest.phase !== "attention-required" &&
        latest.phase !== "done" &&
        !commitVerified
      ) {
        try {
          taskStore.compareAndSwap(
            latest.cardId,
            latest.revision,
            transitionTaskExecutionRecord(latest, {
              type: "attention-required",
              eventId: `${latest.operationKey}:resume-failed:${latest.revision}`,
              projectId: project.id,
              cardId: latest.cardId,
              operationKey: latest.operationKey,
              occurredAt: timestamp(latest),
            }),
          );
        } catch (stateError) {
          throw new AggregateError(
            [error, stateError],
            `Task-session recovery failed and attention state could not be persisted for ${latest.cardId}`,
            { cause: stateError },
          );
        }
      }
    }
    const activeMutation = queue.getActive();
    if (activeMutation !== null && queue.ownsActive(activeMutation.eventId)) {
      queue.fail(activeMutation.eventId);
    }
    throw error;
  }
}
