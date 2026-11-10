import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import { buildPrimarySessionContext } from "../task-session/build-primary-session-context.js";
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
import {
  buildFailedEmail,
  enqueueNotification,
  notifyAttentionRequired,
  prepareAttentionNotification,
} from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import {
  captureRepositorySnapshot,
  repositorySnapshotsEqual,
} from "../opencode/commit-result.js";
import {
  CommitMessageAdviceUnavailableError,
  CommitMessageRecoveryBlockedError,
  runTaskSessionCommitMessage,
} from "../task-session/run-task-session-commit-message.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  captureSetupEffects,
  assertSetupInventoryIdentity,
  runRepositorySetup,
} from "../process/run-setup.js";
import {
  buildSetupRelevancePrompt,
  getSetupTrackedDelta,
  resolveSetupCommitScope,
  type PersistedSetupDisposition,
} from "../process/setup-commit-scope.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "../task-session/operation-recovery-policy.js";
import { PrimaryOperationExhaustedError } from "../task-session/primary-operation-ledger.js";
import {
  PrimaryOperationWaitingError,
  type PrimaryOperationEntry,
} from "../task-session/run-primary-operation.js";
import { type TrelloCard, type TrelloClient } from "../trello/trello-client.js";
import { NotificationPreparationError } from "../notifications/notification-outbox.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { hasVerifiedWorkflowMove } from "./reconcile-workflow-mutations.js";
import { buildTaskSessionReviewRepairPrompt } from "../opencode/build-task-session-review-repair-prompt.js";
import {
  hasUndisposedReviewConcerns,
  parseCachedImplementationReviewResult,
  type ImplementationReviewResult,
  reviewConcernsDismissedAsNonMaterialLabel,
} from "../task-session/implementation-review-result.js";
import { buildTaskSessionCiRepairPrompt } from "../opencode/build-task-session-ci-repair-prompt.js";
import { inspectPrimaryOpenCodeSession } from "../opencode/inspect-primary-session.js";
import {
  runTaskPlanningOperation,
  TaskPlanningOperationError,
  TaskClarificationRequiredError,
} from "../task-session/run-task-planning.js";
import {
  runPlanVerification,
  PlanVerificationOperationError,
} from "../task-session/run-plan-verification.js";
import {
  runTaskSessionImplementation,
  TaskSessionImplementationWaitingError,
} from "../task-session/run-task-session-implementation.js";
import {
  runTaskSessionValidation,
  restorePersistedTaskSessionQualityEvidence,
  type TaskSessionValidationResult,
} from "../task-session/run-task-session-validation.js";
import { runTaskSessionCoverage } from "../task-session/run-task-session-coverage.js";
import { runTaskSessionValidationWithRepairs } from "../task-session/run-task-session-validation-repairs.js";
import {
  runTaskSessionReview,
  TaskSessionReviewUnavailableError,
} from "../task-session/run-task-session-review.js";
import {
  carryReviewRepairIntoCiCorrection,
  createReviewRoundRunner,
  parsePrimaryReviewRepairOutcome,
  runTaskSessionReviewWithRepairs,
  TaskSessionReviewRepairError,
} from "../task-session/run-task-session-review-repairs.js";
import { runTaskSessionCiRepairs } from "../task-session/run-task-session-ci-repairs.js";
import {
  runTaskSessionFeedbackCycle,
  refreshCurrentTaskFeedback,
  feedbackOperationId,
} from "./run-task-session-feedback-cycle.js";
import { inspectPrimaryOperationEvidence } from "../task-session/inspect-primary-operation.js";
import { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import {
  canResumeFailedFeedbackReview,
  canResumeFeedbackReviewRepair,
} from "../task-session/can-resume-failed-feedback-review.js";
import { canResumeCiReviewRepair } from "../task-session/can-resume-ci-review-repair.js";
import {
  decideValidatedHumanReviewPublication,
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
  expectedTaskTrelloList,
  persistTaskSessionContextWait,
  type TaskSessionRecoverySnapshot,
} from "../task-session/reconcile-task-session.js";
import {
  transitionTaskExecutionRecord,
  type TaskExecutionEvent,
} from "../task-session/task-execution-transition.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import { runPrMaintenanceReview } from "../task-session/run-pr-maintenance-review.js";
import {
  getTaskSessionReadOnlyIdentity,
  getTaskSessionSourceSnapshotIdentity,
} from "../task-session/source-snapshot.js";
import { publishTaskSessionCard } from "./publish-task-session-card.js";
import { publishCard, type PreparedReviewPublication } from "./publish-card.js";
import {
  assertPrimarySessionReconstructionReadOnly,
  PrimarySessionReconstructionRequiredError,
  runWithPrimaryTaskSession,
} from "../task-session/primary-task-session.js";
import { observeTaskSessionReviewCards } from "./observe-task-session-review-cards.js";
import {
  completeMergedTaskSessionPullRequest,
  returnClosedTaskSessionPullRequestToBacklog,
} from "./reconcile-terminal-task-session-pr.js";
import { getCardsForDiscovery } from "./trello-list-discovery.js";
import { isCardStartDateReached } from "./card-start-eligibility.js";
import { getWorkflowKind } from "./workflow-kind.js";
import {
  hasExhaustedRefinementSetup,
  RefinementSetupAmbiguousError,
  RefinementSetupFailedError,
} from "../refinement/run-refinement-setup.js";
import {
  readRejectedCommitState,
  readTrustedCommitState,
  readPendingCommitState,
  recoverPendingTaskCommit,
} from "./trusted-commit-state.js";
import { logger } from "../logging/logger.js";
import { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import { maintainOutdatedPr } from "./maintain-outdated-pr.js";
import { reconcileUnobservedTerminalPrEvents } from "./reconcile-unobserved-terminal-pr.js";
import { verifyMergedTaskPrHeadContinuity } from "./verify-merged-task-pr-head-continuity.js";
import { TaskMutationBlockStore } from "./task-mutation-block-store.js";
import {
  reconcilePendingFeedbackCardMove,
  ensureFeedbackCardLocation,
  prepareFeedbackCardMove,
} from "./feedback-card-location.js";
import {
  findPrimaryRecoveryError,
  persistPrimaryOperationRecovery,
} from "../task-session/persist-primary-operation-recovery.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  getProcessRuntime,
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";
import type { RunRecord } from "../task-session/run-record.js";
import {
  resumeInitialPublication,
  PublicationWaitingError,
} from "./initial-publication.js";

const lastLoggedCiState = new Map<string, string>();
const reportedMissingMaintenancePlans = new Set<string>();
const reportedDeferredMaintenance = new Set<string>();
const reportedLegacyAttentionRequired = new Set<string>();

export interface RunTaskSessionWorkflowOptions {
  project: ProjectConfig & { contextRoot?: string };
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  openCode: OpenCodeClient;
  commands: CommandRunner;
  signal: AbortSignal;
  retryIntervalMs?: number;
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

async function completeRefinementAuthority(
  authority: ProjectRunAuthority | undefined,
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
): Promise<void> {
  if (!authority) return;
  const observedAt = new Date().toISOString();
  const backlog = await trello.getCards(project.trello.backlogListId);
  if (!backlog.some((card) => card.id === cardId))
    throw new Error(
      `Refinement completion is not verified: ${cardId} was not observed in Backlog`,
    );
  await authority.completeRefinement({
    observationId: `refinement:${cardId}:${observedAt}`,
    observedAt,
    trelloObservationId: `backlog-readback:${cardId}:${observedAt}`,
    trelloVerifiedAt: observedAt,
  });
}

async function finalizeRefinementSetupFailure(options: {
  authority: ProjectRunAuthority;
  queue: TaskMutationQueue;
  queueEventId: string;
  trello: TrelloClient;
  project: ProjectConfig;
  card: TrelloCard;
  reason: string;
  signal: AbortSignal;
}): Promise<void> {
  const { authority, queue, queueEventId, trello, project, card, signal } =
    options;
  const current = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (current.taskKind !== "refinement" || current.cardId !== card.id)
    throw new Error(
      "Setup failure does not match the canonical refinement attempt",
    );
  if (
    current.lifecycle === "failed" &&
    current.terminalEvidence?.prOutcome === "no-pr-failure"
  ) {
    const failed = await getCardsForDiscovery(
      trello,
      project.id,
      project.trello.failedListId,
      "Could not verify terminal refinement setup failure",
      signal,
    );
    if (!failed.some((candidate) => candidate.id === card.id))
      throw new Error("Canonical failed refinement is absent from Failed");
    if (queue.getActive()?.eventId === queueEventId)
      queue.complete(queueEventId);
    await authority.releaseVerifiedTerminal();
    return;
  }
  if (
    current.lifecycle !== "refinement" ||
    !hasExhaustedRefinementSetup(authority, card.id)
  )
    throw new Error("Refinement setup failure is not durably exhausted");
  const failed = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.failedListId,
    "Could not inspect Failed list before refinement setup failure finalization",
    signal,
  );
  const comment = [
    "Agent Orchestrator failed during repository setup for refinement.",
    "",
    "Category: repository setup",
    `Reason: ${options.reason.slice(0, 1_000)}`,
    "Setup-produced worktree changes and process diagnostics have been preserved.",
    "To retry deliberately, move this card to Ready for Agent.",
  ].join("\n");
  await trello.addComment(card.id, comment);
  if (!failed.some((candidate) => candidate.id === card.id)) {
    const working = await getCardsForDiscovery(
      trello,
      project.id,
      project.trello.workingListId,
      "Could not verify Working before refinement setup failure finalization",
      signal,
    );
    if (!working.some((candidate) => candidate.id === card.id))
      throw new Error(
        "Refinement setup failure card is in neither Working nor Failed",
      );
    await trello.moveCard(card.id, project.trello.failedListId);
  }
  const confirmed = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.failedListId,
    "Could not verify Failed transition after refinement setup failure",
    signal,
  );
  if (!confirmed.some((candidate) => candidate.id === card.id))
    throw new Error(
      "Trello did not confirm refinement setup failure in Failed",
    );
  const observedAt = new Date().toISOString();
  await authority.failRefinement({
    observationId: `refinement-setup-failed:${card.id}:${current.attemptId}`,
    observedAt,
    trelloObservationId: `trello-failed-readback:${card.id}:${observedAt}`,
    trelloVerifiedAt: observedAt,
  });
  queue.complete(queueEventId);
  await authority.releaseVerifiedTerminal();
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

export function isPlanningOutageSafeToSkip(
  operation: PrimaryOperationEntry | undefined,
): boolean {
  return (
    operation?.status === "failed" &&
    operation.retrySafe === true &&
    operation.accountedExecution === operation.executions &&
    operation.lastExecutionClassification === "dependency-outage" &&
    (operation.dependencyOutages ?? 0) >= OPERATION_RECOVERY_MAX_EXECUTIONS
  );
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
  mutationBlockStore: TaskMutationBlockStore;
  taskStore: TaskExecutionStore;
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequest: PullRequestState;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  completionComment?: string;
  releaseMutationEventId?: string;
  onMutationReleased?: () => void;
  preserveLegacyMaintenanceArtifacts?: boolean;
}): Promise<"completed" | "deferred"> {
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
    pullRequest.headRepository?.name !== repository ||
    pullRequest.headRepositoryOwner?.login !== owner
  ) {
    throw new Error(`Merged pull request identity is ambiguous for ${card.id}`);
  }
  await verifyMergedTaskPrHeadContinuity({
    github: options.github,
    project,
    cwd: project.repository.path,
    pullRequestNumber: record.pullRequest.number,
    recordedHeadSha: record.pullRequest.headSha!,
    mergedHeadSha: headSha,
  });
  releaseFailedPublishedFeedbackMutation(queue, record, card.id);
  const terminalEvent = queue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId: terminalEventId,
    operationKey: `${record.operationKey}:MERGED:${headSha}`,
    kind: "terminal-pr",
    enqueuedAt: record.updatedAt,
  });
  if (terminalEvent.status === "completed" && record.phase === "done") {
    options.mutationBlockStore.resolve(`terminal:${terminalEventId}`);
    const evidence = await readRunTerminalEvidence({
      trello,
      project,
      card,
      pullRequestNumber: record.pullRequest.number,
      headSha,
      outcome: "merged",
    });
    const authority = ProjectRunAuthority.current(project.id);
    const run = authority?.store.read();
    if (authority && run && run.lifecycle !== "done") {
      const next = {
        ...record,
        recoveryWait: undefined,
        revision: record.revision + 1,
        updatedAt: timestamp(record),
      };
      await taskStore.compareAndSwap(card.id, record.revision, next, {
        event: "merged",
        evidence,
      });
    } else if (authority) {
      await authority.releaseVerifiedTerminal();
    }
    return "completed";
  }
  if (options.releaseMutationEventId !== undefined) {
    if (queue.getActive()?.eventId !== options.releaseMutationEventId) {
      throw new Error("Merged PR cannot release a mutation it does not own");
    }
    queue.complete(options.releaseMutationEventId);
    options.onMutationReleased?.();
  }
  const mutation = queue.claimForRecovery(terminalEventId);
  if (mutation === null || mutation.eventId !== terminalEventId) {
    const blocker = queue.getActive();
    const diagnostic = `Deferred merged PR cleanup; blocking mutation ${blocker?.eventId ?? "unknown"} (${blocker?.kind ?? "unknown"}, ${blocker?.status ?? "unknown"}) retains project queue ownership`;
    if (
      options.mutationBlockStore.report(
        `terminal:${terminalEventId}`,
        `${terminalEventId}|${blocker?.eventId ?? "unknown"}|${blocker?.kind ?? "unknown"}|${blocker?.status ?? "unknown"}`,
        diagnostic,
      )
    )
      logger.child({ projectId: project.id, cardId: card.id }).warn(diagnostic);
    return "deferred";
  }
  options.mutationBlockStore.resolve(`terminal:${terminalEventId}`);
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
      ...(options.preserveLegacyMaintenanceArtifacts ||
      hasExhaustedPublishedFeedbackCorrection(record)
        ? { preserveWorktree: true }
        : {}),
    });
    if (signal.aborted) {
      queue.fail(terminalEventId);
      return "deferred";
    }
    const latest = taskStore.read(card.id);
    if (latest === null || latest.pullRequest?.url !== pullRequest.url) {
      throw new Error(
        `Merged task record changed during cleanup for ${card.id}`,
      );
    }
    let terminalProjection: TaskExecutionRecord;
    if (latest.phase !== "done") {
      if (
        latest.phase === "attention-required" ||
        latest.pullRequest?.url !== pullRequest.url
      ) {
        throw new Error(
          `Cannot complete merged task ${card.id} without its active persisted PR identity`,
        );
      }
      terminalProjection = transitionTaskExecutionRecord(
        { ...latest, recoveryWait: undefined, reviewObservation: undefined },
        {
          type: "pull-request-merged",
          eventId: `${latest.operationKey}:pull-request-merged`,
          projectId: project.id,
          cardId: card.id,
          operationKey: latest.operationKey,
          occurredAt: timestamp(latest),
        },
      );
    } else {
      terminalProjection = {
        ...latest,
        recoveryWait: undefined,
        revision: latest.revision + 1,
        updatedAt: timestamp(latest),
      };
    }
    const evidence = await readRunTerminalEvidence({
      trello,
      project,
      card,
      pullRequestNumber: record.pullRequest.number,
      headSha,
      outcome: "merged",
    });
    if (ProjectRunAuthority.current(project.id))
      await taskStore.compareAndSwap(
        card.id,
        latest.revision,
        terminalProjection,
        { event: "merged", evidence },
      );
    else taskStore.compareAndSwap(card.id, latest.revision, terminalProjection);
    queue.complete(terminalEventId);
    return "completed";
  } catch (error) {
    if (queue.ownsActive(terminalEventId)) queue.fail(terminalEventId);
    throw error;
  }
}

/** A verified human PR outcome supersedes only that task's stopped feedback owner. */
function releaseFailedPublishedFeedbackMutation(
  queue: TaskMutationQueue,
  record: TaskExecutionRecord,
  cardId: string,
): void {
  const active = queue.getActive();
  if (
    active === null ||
    (active.status !== "failed" &&
      !(active.status === "active" && active.ownerToken === undefined)) ||
    active.kind !== "feedback" ||
    active.cardId !== cardId ||
    record.feedbackRemediation?.operationId !== active.eventId
  )
    return;
  const claimed = queue.claimForRecovery(active.eventId);
  if (claimed === null) return;
  queue.complete(claimed.eventId);
}

function hasExhaustedPublishedFeedbackCorrection(
  record: TaskExecutionRecord,
): boolean {
  const operationId = record.feedbackRemediation?.operationId;
  const operation =
    operationId === undefined
      ? undefined
      : record.primaryOperations?.[operationId];
  return (
    record.pullRequest !== undefined &&
    operation?.activity === "feedback-remediation" &&
    operation.status === "exhausted" &&
    (operation.failureExecutions ?? operation.executions) >=
      OPERATION_RECOVERY_MAX_EXECUTIONS
  );
}

async function readRunTerminalEvidence(options: {
  trello: TrelloClient;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestNumber: number;
  headSha: string;
  outcome: "merged" | "closed-unmerged";
}): Promise<NonNullable<RunRecord["terminalEvidence"]>> {
  const listId =
    options.outcome === "merged"
      ? options.project.trello.doneListId
      : options.project.trello.backlogListId;
  const observedAt = new Date().toISOString();
  const cards = await options.trello.getCards(listId);
  if (!cards.some((candidate) => candidate.id === options.card.id))
    throw new Error(
      `Terminal attempt state is not verified: ${options.card.id} was not observed in its destination list`,
    );
  return {
    prOutcome: options.outcome,
    prObservationId: `github-${options.outcome}:${options.pullRequestNumber}:${options.headSha}`,
    prVerifiedAt: observedAt,
    trelloListId: listId,
    trelloObservationId: `trello-${options.outcome}:${options.card.id}:${observedAt}`,
    trelloVerifiedAt: observedAt,
  };
}

async function persistClosedRunTerminal(
  taskStore: TaskExecutionStore,
  trello: TrelloClient,
  project: ProjectConfig,
  card: TrelloCard,
  record: TaskExecutionRecord,
): Promise<void> {
  if (!ProjectRunAuthority.current(project.id) || !record.pullRequest?.headSha)
    return;
  const evidence = await readRunTerminalEvidence({
    trello,
    project,
    card,
    pullRequestNumber: record.pullRequest.number,
    headSha: record.pullRequest.headSha,
    outcome: "closed-unmerged",
  });
  const latest = taskStore.read(card.id);
  if (!latest) throw new Error(`Task projection disappeared for ${card.id}`);
  await taskStore.compareAndSwap(
    card.id,
    latest.revision,
    {
      ...latest,
      recoveryWait: undefined,
      revision: latest.revision + 1,
      updatedAt: timestamp(latest),
    },
    { event: "closed-unmerged", evidence },
  );
}

function noPullRequestFailureEvidence(
  project: ProjectConfig,
  cardId: string,
  operationKey: string,
): NonNullable<RunRecord["terminalEvidence"]> {
  const observedAt = new Date().toISOString();
  return {
    prOutcome: "no-pr-failure",
    prObservationId: `no-pull-request:${operationKey}`,
    prVerifiedAt: observedAt,
    trelloListId: project.trello.failedListId,
    trelloObservationId: `trello-failed-readback:${cardId}:${observedAt}`,
    trelloVerifiedAt: observedAt,
  };
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
  coverage: TaskSessionValidationResult,
): TaskExecutionRecord {
  return updateRecord(store, record, {
    validationRepair: {
      cycleId: record.validationRepair?.cycleId ?? cycleId,
      ...(record.validationRepair?.maxAttempts === undefined
        ? {}
        : { maxAttempts: record.validationRepair.maxAttempts }),
      status:
        validation.status === "skipped" && coverage?.status === "skipped"
          ? "skipped"
          : "passed",
      evidence: {
        command: validation.command,
        startedAt: validation.startedAt,
        completedAt: validation.completedAt,
        exitCode: validation.exitCode,
        status: validation.status,
        diagnostic: validation.diagnostic,
        contentIdentity: validation.contentIdentity,
      },
      coverageEvidence: {
        command: coverage.command,
        startedAt: coverage.startedAt,
        completedAt: coverage.completedAt,
        exitCode: coverage.exitCode,
        status: coverage.status,
        diagnostic: coverage.diagnostic,
        contentIdentity: coverage.contentIdentity,
      },
    },
  });
}

type PersistedQualityEvidence = NonNullable<
  TaskExecutionRecord["publicationQuality"]
>["validation"];

function isLegacySuccessfulQualityEvidence(
  evidence: PersistedQualityEvidence,
): boolean {
  return (
    evidence.status === undefined &&
    evidence.exitCode === 0 &&
    evidence.command.trim().length > 0
  );
}

function toPersistedQualityEvidence(
  result: TaskSessionValidationResult,
): PersistedQualityEvidence {
  return {
    command: result.command,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    exitCode: result.exitCode,
    status: result.status,
    diagnostic: result.diagnostic,
    contentIdentity: result.contentIdentity,
  };
}

function buildUnavailableReviewResult(
  diagnostic: string,
  currentContentIdentity: string,
  priorReview: ImplementationReviewResult | undefined,
  reviewRepair: TaskExecutionRecord["reviewRepair"],
): string {
  const priorDetails: string[] = [];
  if (priorReview?.verdict === "fail") {
    const findings = new Map(
      (reviewRepair?.findings ?? []).map((finding) => [finding.id, finding]),
    );
    for (const finding of priorReview.blockingFindings.slice(0, 20)) {
      const id = finding.id ?? "unassigned finding";
      priorDetails.push(
        `Prior finding ${id}: ${finding.summary}. ${finding.detail}`,
      );
      const disposition = findings.get(id)?.primaryDisposition;
      if (
        finding.id !== undefined &&
        disposition?.reviewedContentIdentity ===
          priorReview.reviewedContentIdentity
      )
        priorDetails.push(
          `Primary disposition for prior source ${priorReview.reviewedContentIdentity}: ${disposition.status}; ${disposition.rationale}`,
        );
      else
        priorDetails.push(
          `No matching primary disposition is recorded for prior finding ${id}.`,
        );
    }
    const requirementDispositions = new Map(
      (reviewRepair?.requirementDispositions ?? []).map((disposition) => [
        disposition.requirementId,
        disposition,
      ]),
    );
    for (const assessment of priorReview.requirementAssessments
      .filter(({ status }) => status === "unsatisfied")
      .slice(0, 20)) {
      priorDetails.push(
        `Prior requirement ${assessment.requirementId} was assessed as unsatisfied: ${assessment.details}. Evidence: ${assessment.evidence.join(", ") || "none reported"}.`,
      );
      const disposition = requirementDispositions.get(assessment.requirementId);
      if (
        disposition?.reviewedContentIdentity ===
        priorReview.reviewedContentIdentity
      )
        priorDetails.push(
          `Primary disposition for prior requirement ${assessment.requirementId} on source ${priorReview.reviewedContentIdentity}: ${disposition.status}; ${disposition.rationale}`,
        );
      else
        priorDetails.push(
          `No matching primary disposition is recorded for prior requirement ${assessment.requirementId}.`,
        );
    }
  }
  const priorDisclosure =
    priorReview?.verdict === "fail"
      ? ` Prior reviewer concerns refer to source ${priorReview.reviewedContentIdentity}, not the current source. ${priorDetails.join(" ")}`
      : "";
  return sanitizeControlledText(
    `Unavailable (independent review of current source ${currentContentIdentity} could not be completed: ${diagnostic}.${priorDisclosure})`,
  ).slice(0, 8_000);
}

function previousFindingIdsFromReview(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("previousFindingAssessments" in value) ||
    !Array.isArray(value.previousFindingAssessments)
  )
    return [];
  return value.previousFindingAssessments.flatMap((assessment) =>
    typeof assessment === "object" &&
    assessment !== null &&
    "findingId" in assessment &&
    typeof assessment.findingId === "string"
      ? [assessment.findingId]
      : [],
  );
}

function qualityEvidenceWasSuccessful(
  evidence: PersistedQualityEvidence,
): boolean {
  return (
    (evidence.status === "passed" && evidence.exitCode === 0) ||
    isLegacySuccessfulQualityEvidence(evidence)
  );
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
  const pullRequestLookup = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: record.expectedBranch ?? `agent/${card.id}`,
    baseBranch: project.repository.defaultBranch,
    project,
  };
  const earlyPullRequest =
    record.phase === "publication" || record.pullRequest !== undefined
      ? await github.findPullRequestState(pullRequestLookup)
      : null;
  if (
    earlyPullRequest !== null &&
    (earlyPullRequest.state === "MERGED" || earlyPullRequest.state === "CLOSED")
  ) {
    const number = Number(
      new URL(earlyPullRequest.url).pathname.split("/").at(-1),
    );
    return {
      primarySessionAccessible: null,
      worktreeExists: false,
      worktreeBranch: null,
      worktreeHeadSha: null,
      worktreeRebaseActive: false,
      trustedCommitSha: null,
      remoteBranchHeadSha: null,
      trelloListId: card.idList,
      pullRequest: {
        number,
        url: earlyPullRequest.url,
        headSha:
          earlyPullRequest.headRefOid ?? record.pullRequest?.headSha ?? "",
        state: earlyPullRequest.state,
      },
      ciEvaluation: null,
      feedbackHeadSha: null,
      uncertainReplyIds: [],
      reconciledReplyIds: [],
    };
  }
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
    (await git.getStatus(worktreePath)).trim().length > 0 &&
    !(
      (record.validationRepair?.status === "exhausted" ||
        record.reviewUnavailable !== undefined) &&
      record.reviewRepair?.finalReview === undefined &&
      readTrustedCommitState(project, card.id) === null
    )
  )
    throw new Error(
      "Publication worktree contains changes not represented by the trusted commit",
    );

  const headSha = record.pullRequest?.headSha;
  let trusted = readTrustedCommitState(project, card.id);
  const trustedExhaustedPublication =
    record.phase === "publication" &&
    (record.reviewRepair?.status === "exhausted" ||
      record.reviewUnavailable !== undefined) &&
    trusted !== null &&
    worktreeHeadSha === trusted.commitSha &&
    isDirectory &&
    !worktreeRebaseActive &&
    (await git.getStatus(worktreePath)).trim().length === 0;
  const sessionId = record.primarySessionId;
  let primarySessionAccessible = trustedExhaustedPublication
    ? true
    : sessionId === undefined
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

  const rejected = readRejectedCommitState(project, card.id);
  if (
    rejected !== null &&
    worktreeHeadSha !== null &&
    (worktreeHeadSha === rejected.commitSha ||
      (await git.isAncestor(worktreePath, rejected.commitSha, worktreeHeadSha)))
  ) {
    throw new Error("Task worktree HEAD descends from a rejected commit");
  }

  let pullRequest = null as TaskSessionRecoverySnapshot["pullRequest"];
  const actual = earlyPullRequest;
  if (record.phase === "publication" || record.pullRequest !== undefined) {
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
    record.phase === "publication" || record.pullRequest !== undefined
      ? await git.getRemoteBranchSha(
          project.repository.path,
          "origin",
          record.expectedBranch ?? `agent/${card.id}`,
          project,
        )
      : null;

  if (
    record.phase === "publication" &&
    isDirectory &&
    !worktreeRebaseActive &&
    readPendingCommitState(project, card.id) !== null
  ) {
    trusted = await recoverPendingTaskCommit({
      project,
      cardId: card.id,
      worktreePath,
      git,
      remoteHeadSha: remoteBranchHeadSha,
      pullRequestExists: pullRequest !== null,
    });
    if (
      trusted !== null &&
      worktreeHeadSha === trusted.commitSha &&
      (record.validationRepair?.status === "exhausted" ||
        record.reviewUnavailable !== undefined) &&
      record.reviewRepair?.finalReview === undefined
    )
      primarySessionAccessible = true;
  }

  const verifiedUncommittedPublication =
    record.phase === "publication" &&
    (record.validationRepair?.status === "exhausted" ||
      record.reviewUnavailable !== undefined) &&
    record.reviewRepair?.finalReview === undefined &&
    trusted === null &&
    pullRequest === null &&
    remoteBranchHeadSha === null &&
    isDirectory &&
    !worktreeRebaseActive &&
    worktreeHeadSha !== null &&
    (await git.getCommitCountBetween(
      worktreePath,
      `origin/${project.repository.defaultBranch}`,
      worktreeHeadSha,
    )) === 0 &&
    (await git.getStatus(worktreePath)).trim().length > 0;
  return {
    verifiedUncommittedPublication,
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

async function readTerminalPullRequestState(
  project: ProjectConfig,
  github: GitHubClient,
  record: TaskExecutionRecord,
): Promise<{
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
} | null> {
  const pullRequest = await github.findPullRequestState({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: record.expectedBranch ?? `agent/${record.cardId}`,
    baseBranch: project.repository.defaultBranch,
    project,
  });
  if (pullRequest === null) return null;
  return {
    number: Number(new URL(pullRequest.url).pathname.split("/").at(-1)),
    url: pullRequest.url,
    state: pullRequest.state,
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
  // Publication resumes before general session recovery/list discovery. A lost
  // move acknowledgment can leave the card in Review while its task checkpoint
  // is still publication; neither absence from Working nor an outage may claim
  // new work or turn this into an absorbing attention-required operation.
  if (
    await resumeInitialPublication({
      project,
      trello,
      git,
      github,
      signal,
      opencode: openCode,
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
    })
  )
    return;
  const validationCommand = project.repository.validationCommand ?? "";
  const root = project.contextRoot;
  if (root === undefined)
    throw new Error(
      "Task-session workflow requires a configured external context root",
    );
  const taskStore = new TaskExecutionStore(root, project);
  const correctionPublicationLocation = (
    source: TaskExecutionRecord | null,
  ) => {
    if (!source?.pullRequest || !source.feedbackRemediation) return {};
    const location = {
      project,
      cardId: source.cardId,
      taskStore,
      trello,
      github,
    };
    return {
      beforeHumanReviewTransition: () =>
        prepareFeedbackCardMove(
          location,
          project.trello.reviewListId,
          `${source.feedbackRemediation!.operationId}:review`,
        ),
      afterHumanReviewTransition: () =>
        reconcilePendingFeedbackCardMove(location),
    };
  };
  const planStore = new TaskPlanStore(root, project);
  const inspectSessionForWorktree = (cwd: string) => (sessionId: string) =>
    inspectPrimaryOpenCodeSession({
      commands,
      cwd,
      sessionId,
      signal,
      timeoutMilliseconds: 30_000,
    });
  const finalizePrimaryFailureEffects = async (
    cardId: string,
    operationKey: string,
    reason: string,
    kind: "implementation" | "clarification" = "implementation",
  ): Promise<void> => {
    const failureCard = await trello.getCard(cardId);
    enqueueNotification(
      emailNotifier,
      project.id,
      "failed",
      `${operationKey}:primary-failure`,
      buildFailedEmail({
        project,
        card: { name: failureCard.name, url: failureCard.url },
        category:
          kind === "clarification"
            ? "essential task information missing"
            : "primary implementation failure",
        reason,
      }),
      {
        cardId,
        listId: project.trello.failedListId,
        boardId: project.trello.boardId,
      },
    );
    await trello.addComment(
      cardId,
      [
        kind === "clarification"
          ? "Agent Orchestrator needs clarification before work can proceed."
          : "Agent Orchestrator failed during primary implementation.",
        "",
        `Category: ${kind === "clarification" ? "essential task information missing" : "primary implementation failure"}`,
        `Reason: ${reason}`,
        ...(kind === "clarification"
          ? [
              "Please clarify the questions above, then explicitly move this card to Ready for Agent.",
            ]
          : ["Partial work and diagnostics are preserved."]),
        "To retry deliberately, move this card to Ready for Agent.",
      ].join("\n"),
    );
  };
  const reconstructPrimarySession = async (
    sourceCard: TrelloCard,
    sourceRecord: TaskExecutionRecord,
    sourceWorktree: string,
  ): Promise<TaskExecutionRecord | null> => {
    const storedPlan = planStore.read(
      sourceCard.id,
      undefined,
      sourceRecord.operationKey,
    );
    const expectedBranch = sourceRecord.expectedBranch;
    const persistRecoveryBlock = (
      reason: string,
      status:
        | "reconstruction-blocked"
        | "reconstruction-process-failed" = "reconstruction-blocked",
    ): never => {
      const current = taskStore.read(sourceCard.id);
      if (current !== null)
        taskStore.compareAndSwap(sourceCard.id, current.revision, {
          ...current,
          sessionRecovery: {
            ...(current.sessionRecovery ?? {
              originalSessionId: current.primarySessionId ?? "unknown-session",
              status: "reconstruction-blocked" as const,
            }),
            status,
            blockReason: reason.slice(0, 1_000),
          },
          revision: current.revision + 1,
          updatedAt: new Date(
            Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
          ).toISOString(),
        });
      throw new Error(reason);
    };
    const persistContextWait = (reason: string): null => {
      const current = taskStore.read(sourceCard.id);
      if (current === null)
        throw new Error(
          "Task record disappeared while waiting for recovery context",
        );
      if (options.retryIntervalMs !== undefined) {
        persistTaskSessionContextWait(
          taskStore,
          current,
          {
            project,
            cardId: sourceCard.id,
            expectedBranch:
              expectedBranch ??
              current.expectedBranch ??
              `agent/${sourceCard.id}`,
            operationKey: current.operationKey,
            worktreePath: sourceWorktree,
            taskRecordStore: taskStore,
            signal,
            retryIntervalMs: options.retryIntervalMs,
            readAuthoritativeSnapshot: async () => {
              throw new Error(
                "Context wait persistence does not read a snapshot",
              );
            },
          },
          reason,
        );
      } else {
        taskStore.compareAndSwap(sourceCard.id, current.revision, {
          ...current,
          sessionRecovery: {
            ...(current.sessionRecovery ?? {
              originalSessionId: current.primarySessionId ?? "unknown-session",
              status: "inspection-pending" as const,
            }),
            contextAvailability: "unavailable",
            contextAvailabilityReason: reason.slice(0, 1_000),
          },
          revision: current.revision + 1,
          updatedAt: new Date(
            Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
          ).toISOString(),
        });
      }
      return null;
    };
    if (expectedBranch === undefined)
      return persistRecoveryBlock(
        "Cannot reconstruct a primary session without a persisted task branch",
      );
    const beforeContext = taskStore.read(sourceCard.id);
    if (
      beforeContext === null ||
      beforeContext.sessionCreationStatus === "creating" ||
      beforeContext.sessionCreationStatus === "ambiguous" ||
      beforeContext.sessionRecovery?.status === "replacement-creating" ||
      beforeContext.sessionRecovery?.status === "replacement-ambiguous"
    )
      return null;
    const currentCard = await trello
      .getCard(sourceCard.id)
      .catch((error: unknown) =>
        persistContextWait(
          `Current task card is unavailable for reconstruction: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    if (currentCard === null) return null;
    const attachments = await options
      .prepareAttachmentContext(currentCard)
      .catch((error: unknown) =>
        persistContextWait(
          `Current task attachments are unavailable for reconstruction: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    if (attachments === null) return null;
    try {
      buildCardAttachmentPromptLines(attachments);
    } catch (error) {
      return persistContextWait(
        `Materialized attachment evidence is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [
      beforeIdentity,
      beforeHead,
      beforeBranch,
      beforeBranchRef,
      beforeDefaultRef,
      beforeRefsIdentity,
    ] = await Promise.all([
      getTaskSessionReadOnlyIdentity(git, sourceWorktree),
      git.getHeadSha(sourceWorktree),
      git.getCurrentBranch(sourceWorktree),
      git.getRefSha(sourceWorktree, `refs/heads/${expectedBranch}`),
      git.getRefSha(
        sourceWorktree,
        `refs/remotes/origin/${project.repository.defaultBranch}`,
      ),
      git.getRefsIdentity(sourceWorktree),
    ]).catch((error: unknown) =>
      persistRecoveryBlock(
        `Could not establish reconstruction baseline: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    const baseline = {
      sourceIdentity: beforeIdentity,
      head: beforeHead,
      branch: beforeBranch,
      branchRef: beforeBranchRef,
      refsIdentity: JSON.stringify([
        beforeBranchRef,
        beforeDefaultRef,
        beforeRefsIdentity,
      ]),
    };
    const authority = ProjectRunAuthority.current(project.id);
    if (authority === undefined)
      return persistRecoveryBlock(
        "Cannot build reconstruction context without canonical attempt authority",
      );
    const context = await buildPrimarySessionContext({
      git,
      projectId: project.id,
      card: currentCard,
      attemptId: authority.store.attemptId,
      worktreePath: sourceWorktree,
      record: sourceRecord,
      plan: storedPlan?.plan ?? null,
      ...(storedPlan === null ? {} : { planRevision: storedPlan.planRevision }),
      ...(storedPlan?.verification === undefined
        ? {}
        : { planReviewAdvice: storedPlan.verification }),
      ...(feedbackLedgerStore.read(sourceCard.id) === null
        ? {}
        : {
            feedbackContent: JSON.stringify(
              feedbackLedgerStore.read(sourceCard.id),
            ),
          }),
      ...(attachments === undefined ? {} : { attachments }),
    }).catch((error: unknown) =>
      persistContextWait(
        `Required reconstruction evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    if (context === null) return null;
    let result: Awaited<ReturnType<typeof runWithPrimaryTaskSession>>;
    try {
      result = await runWithPrimaryTaskSession(
        taskStore,
        openCode,
        project.id,
        sourceCard.id,
        {
          cwd: sourceWorktree,
          model: project.opencode.implementation.model,
          variant: project.opencode.implementation.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
          sessionLabel: "Primary task session reconstruction",
          readOnly: true,
          sessionLogPath: getSessionLogPath(project.id, sourceCard.id),
          prompt:
            "Restore continuity for this same task from the supplied durable context. Inspect but do not modify the preserved changes. Return a concise reconstruction acknowledgement; do not commit or publish.",
        },
        {
          inspect: (sessionId) =>
            inspectPrimaryOpenCodeSession({
              commands,
              cwd: sourceWorktree,
              sessionId,
              signal,
              timeoutMilliseconds: 30_000,
            }),
          context,
          contextDirectory: path.join(
            root,
            "primary-session-context",
            project.id,
            sourceCard.id,
          ),
          forbiddenPaths: [
            project.repository.path,
            project.repository.worktreeRoot,
          ],
          persistArtifact: (content) => {
            const authority = ProjectRunAuthority.current(project.id);
            if (authority === undefined)
              throw new Error(
                "Cannot persist reconstruction context without canonical run authority",
              );
            const artifact = authority.store.writeArtifact(
              content,
              "application/json",
            );
            return { reference: artifact.id, path: artifact.path };
          },
          attemptId: authority.store.attemptId,
          baseline,
        },
        {
          role: "reconstruction",
          operationId: `${sourceRecord.operationKey}:reconstruction-ack:${sourceRecord.primarySessionId ?? sourceRecord.sessionRecovery?.originalSessionId ?? "session"}`,
          readOnlyAcknowledged: true,
          inspectPending: (entry) =>
            inspectPrimaryOperationEvidence(
              taskStore,
              sourceCard.id,
              entry.id,
              {
                trustedRoot:
                  ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                  getProcessRuntime().artifactRoot,
                cwd: sourceWorktree,
              },
            ),
          inspectOwningPrimary: (entry) =>
            inspectPrimaryOperationEvidence(
              taskStore,
              sourceCard.id,
              entry.id,
              {
                trustedRoot:
                  ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                  getProcessRuntime().artifactRoot,
                cwd: sourceWorktree,
              },
            ),
        },
      );
    } catch (error) {
      if (options.retryIntervalMs === undefined) throw error;
      const current = taskStore.read(sourceCard.id);
      if (current === null) throw error;
      const disposition = persistPrimaryOperationRecovery(
        taskStore,
        current,
        error,
        options.retryIntervalMs,
      );
      if (
        disposition === "waiting" ||
        disposition === "published-blockage" ||
        disposition === "prepublication-failure"
      )
        return null;
      throw error;
    }
    const bound = taskStore.read(sourceCard.id);
    if (
      bound?.primarySessionId === undefined ||
      bound.sessionCreationStatus !== "bound" ||
      (result.sessionId !== undefined &&
        bound.primarySessionId !== result.sessionId)
    )
      return persistRecoveryBlock(
        "Reconstructed primary session binding was not durably verified",
      );
    if (result.exitCode !== 0)
      persistRecoveryBlock(
        `Primary session reconstruction exited with code ${result.exitCode}; normal task resume is blocked`,
        "reconstruction-process-failed",
      );
    const [
      afterIdentity,
      afterHead,
      afterBranch,
      afterBranchRef,
      afterDefaultRef,
      afterRefsIdentity,
    ] = await Promise.all([
      getTaskSessionReadOnlyIdentity(git, sourceWorktree),
      git.getHeadSha(sourceWorktree),
      git.getCurrentBranch(sourceWorktree),
      git.getRefSha(sourceWorktree, `refs/heads/${expectedBranch}`),
      git.getRefSha(
        sourceWorktree,
        `refs/remotes/origin/${project.repository.defaultBranch}`,
      ),
      git.getRefsIdentity(sourceWorktree),
    ]);
    try {
      assertPrimarySessionReconstructionReadOnly(
        {
          ...baseline,
        },
        {
          sourceIdentity: afterIdentity,
          head: afterHead,
          branch: afterBranch,
          branchRef: afterBranchRef,
          refsIdentity: JSON.stringify([
            afterBranchRef,
            afterDefaultRef,
            afterRefsIdentity,
          ]),
        },
      );
    } catch {
      persistRecoveryBlock(
        "Primary session reconstruction violated its read-only boundary; repository state changed and normal resume is blocked",
      );
    }
    const verified = taskStore.read(sourceCard.id);
    if (verified?.sessionRecovery === undefined)
      throw new Error("Reconstruction verification state disappeared");
    taskStore.compareAndSwap(sourceCard.id, verified.revision, {
      ...verified,
      recoveryWait: undefined,
      sessionRecovery: {
        ...verified.sessionRecovery,
        status: "reconstruction-verified",
        reconstructionBaseline: undefined,
        contextAvailability: "available",
        contextAvailabilityReason: undefined,
      },
      revision: verified.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(verified.updatedAt) + 1),
      ).toISOString(),
    });
    return bound;
  };
  const reconcileOwnedTaskForResume = async (
    card: TrelloCard,
    record: TaskExecutionRecord,
    worktreePath: string,
  ) => {
    const reconcile = (ownedRecord: TaskExecutionRecord) =>
      reconcileTaskSession({
        project,
        cardId: card.id,
        expectedBranch: `agent/${card.id}`,
        operationKey: ownedRecord.operationKey,
        worktreePath,
        taskRecordStore: taskStore,
        setupGit: git,
        signal,
        readTerminalPullRequest: (current) =>
          readTerminalPullRequestState(project, github, current),
        ...(options.retryIntervalMs === undefined
          ? {}
          : { retryIntervalMs: options.retryIntervalMs }),
        readAuthoritativeSnapshot: (current) =>
          readTaskSessionRecoverySnapshot({
            project,
            card,
            record: current,
            worktreePath,
            git,
            github,
            commands,
            signal,
          }),
      });
    let recovery = await reconcile(record);
    if (recovery.status === "reconstruction-required") {
      const bound = await reconstructPrimarySession(
        card,
        recovery.record,
        worktreePath,
      );
      if (bound === null) return null;
      recovery = await reconcile(bound);
    }
    return recovery;
  };
  const queue = new TaskMutationQueue(root, project);
  const mutationBlockStore = new TaskMutationBlockStore(root, project.id);
  const maintenanceStore = new PrMaintenanceStore(root, project);
  const feedbackLedgerStore = new FeedbackLedgerStore(root, project);
  const unresolvedLegacyMaintenance = maintenanceStore
    .inspect()
    .filter((operation) => {
      if (!["completed", "cancelled"].includes(operation.status)) return true;
      if (operation.publication?.status === "push-intended") return true;
      const locallyPreparedHead = operation.localPreparation?.resultingHead;
      return (
        locallyPreparedHead !== undefined &&
        (operation.publication?.status !== "verified" ||
          operation.publication.resultingHead !== locallyPreparedHead)
      );
    });
  const hasUnresolvedLegacyMaintenance = unresolvedLegacyMaintenance.length > 0;
  const shouldPreserveTerminalMaintenanceArtifacts = (
    cardId: string,
  ): boolean =>
    hasUnresolvedLegacyMaintenance ||
    maintenanceStore.inspect().some((operation) => operation.cardId === cardId);
  if (unresolvedLegacyMaintenance.length > 0) {
    const details = unresolvedLegacyMaintenance
      .map(
        (operation) =>
          `${operation.cardId}/${operation.operationId} (${operation.status})`,
      )
      .join(", ");
    logger
      .child({ projectId: project.id })
      .warn(
        `Published PR maintenance is unavailable; preserving unresolved legacy operation(s): ${details}. Terminal PR reads/reconciliation continue; all project branch writers and new claims remain blocked until these effects are reconciled.`,
      );
  }
  // Retire only provable stale Ready claims before terminal PR processing can
  // try to acquire the project-wide mutation queue. Trello lists and task
  // records are authoritative; PID data alone is not used to infer orphanhood.
  const preflightReadyCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.readyListId,
    "Could not retrieve Ready cards for mutation recovery",
    signal,
  );
  const preflightWorkingCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.workingListId,
    "Could not inspect Working cards for mutation recovery",
    signal,
  );
  const preflightReadyIds = new Set(preflightReadyCards.map((card) => card.id));
  const preflightWorkingIds = new Set(
    preflightWorkingCards.map((card) => card.id),
  );
  let orphanRecoveryBlocked = false;
  for (const queued of queue.list()) {
    if (
      (queued.kind !== "implementation" && queued.kind !== "refinement") ||
      !["queued", "active", "failed", "completed"].includes(queued.status)
    )
      continue;
    const orphanScope = `orphan:${queued.eventId}`;
    if (queued.status === "completed") {
      if (
        preflightReadyIds.has(queued.cardId) &&
        taskStore.read(queued.cardId) === null
      )
        continue;
      mutationBlockStore.resolve(orphanScope);
      continue;
    }
    if (
      preflightReadyIds.has(queued.cardId) ||
      preflightWorkingIds.has(queued.cardId) ||
      taskStore.read(queued.cardId) !== null
    ) {
      mutationBlockStore.resolve(orphanScope);
      continue;
    }
    const attempt = queued.eventId.match(/:attempt:([1-9][0-9]*)$/)?.[1];
    const baseEventId =
      attempt === undefined
        ? queued.eventId
        : queued.eventId.slice(0, -`:attempt:${attempt}`.length);
    const baseOperationKey =
      attempt === undefined
        ? queued.operationKey
        : queued.operationKey.slice(0, -`:attempt:${attempt}`.length);
    const digest = /^[a-f0-9]{16}$/.exec(baseEventId.split(":").at(-1) ?? "")
      ? baseEventId.split(":").at(-1)
      : undefined;
    const eventIdentityMatches =
      digest !== undefined &&
      baseEventId === `implementation:${queued.cardId}:${digest}` &&
      baseOperationKey === `task-session:${queued.cardId}:${digest}`;
    if (!eventIdentityMatches) {
      orphanRecoveryBlocked = true;
      const diagnostic = `Mutation ${queued.eventId} (${queued.kind}, ${queued.status}) has an ambiguous Ready-event identity; preserved for operator recovery`;
      prepareAttentionNotification(emailNotifier, {
        project,
        category: "Workflow",
        reason: diagnostic,
        cardIds: [queued.cardId],
      });
      if (
        mutationBlockStore.report(
          `orphan:${queued.eventId}`,
          `${queued.eventId}|${queued.kind}|${queued.status}|identity-ambiguous`,
          diagnostic,
        )
      ) {
        logger
          .child({ projectId: project.id, cardId: queued.cardId })
          .error(diagnostic);
        await notifyAttentionRequired(
          emailNotifier,
          {
            project,
            category: "Workflow",
            reason: diagnostic,
            cardIds: [queued.cardId],
          },
          logger.child({ projectId: project.id, cardId: queued.cardId }),
        );
      }
      continue;
    }
    if (queued.status === "failed") {
      orphanRecoveryBlocked = true;
      const diagnostic = `Failed mutation ${queued.eventId} (${queued.kind}, failed) retains recovery obligations; it was not retired and requires verified task recovery or operator intervention`;
      prepareAttentionNotification(emailNotifier, {
        project,
        category: "Workflow",
        reason: diagnostic,
        cardIds: [queued.cardId],
      });
      if (
        mutationBlockStore.report(
          `orphan:${queued.eventId}`,
          `${queued.eventId}|${queued.kind}|failed|recovery-required`,
          diagnostic,
        )
      ) {
        logger
          .child({ projectId: project.id, cardId: queued.cardId })
          .error(diagnostic);
        await notifyAttentionRequired(
          emailNotifier,
          {
            project,
            category: "Workflow",
            reason: diagnostic,
            cardIds: [queued.cardId],
          },
          logger.child({ projectId: project.id, cardId: queued.cardId }),
        );
      }
      continue;
    }
    try {
      queue.retireOrphanedReadyEvent(queued.eventId);
      mutationBlockStore.resolve(`orphan:${queued.eventId}`);
      logger
        .child({ projectId: project.id, cardId: queued.cardId })
        .warn(
          `Recovered orphaned mutation ${queued.eventId} (${queued.kind}, ${queued.status}); retired before terminal PR reconciliation`,
        );
    } catch (error) {
      orphanRecoveryBlocked = true;
      const diagnostic = `Could not recover mutation ${queued.eventId} (${queued.kind}, ${queued.status}); operator intervention required: ${error instanceof Error ? error.message : String(error)}`;
      if (
        mutationBlockStore.report(
          `orphan:${queued.eventId}`,
          `${queued.eventId}|${queued.kind}|${queued.status}|${error instanceof Error ? error.message : String(error)}`,
          diagnostic,
        )
      )
        logger
          .child({ projectId: project.id, cardId: queued.cardId })
          .error(diagnostic);
    }
  }
  if (orphanRecoveryBlocked) return;
  const humanReviewCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.reviewListId,
    "Could not retrieve task-session Human Review cards",
    signal,
  );
  const canonicalCardId = ProjectRunAuthority.current(project.id)?.cardId;
  const canonicalTask = canonicalCardId
    ? taskStore.read(canonicalCardId)
    : null;
  let executionRecoveryCard: TrelloCard | undefined;
  if (
    canonicalCardId &&
    canonicalTask?.pullRequest !== undefined &&
    canonicalTask.phase !== "done" &&
    canonicalTask.phase !== "attention-required"
  ) {
    const currentCard =
      humanReviewCards.find((candidate) => candidate.id === canonicalCardId) ??
      (await trello.getCard(canonicalCardId));
    // A published PR's terminal outcome is independent of the local session
    // and worktree. Include the owned card in the read-only terminal observer
    // even if an operator moved it out of Human Review; execution recovery is
    // deliberately deferred until after terminal reconciliation.
    if (!humanReviewCards.some((candidate) => candidate.id === canonicalCardId))
      humanReviewCards.push(currentCard);
    if (
      canonicalTask.recoveryWait !== undefined ||
      canonicalTask.feedbackCardMove !== undefined ||
      currentCard.idList !== project.trello.reviewListId
    )
      executionRecoveryCard = currentCard;
    // Include a published canonical task even when it was moved out of Human
    // Review or is waiting, so terminal PR observation and its owning
    // checkpoint recovery both run before any other task can be claimed.
  }
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
    ...(executionRecoveryCard === undefined
      ? {}
      : { terminalOnlyCardIds: new Set([executionRecoveryCard.id]) }),
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
    const terminalHead = authoritative?.headRefOid;
    const expectedEventId = `terminal-pr:${cardId}:${expectedState}:${terminalHead}`;
    const expectedOperationKey = `${record.operationKey}:${expectedState}:${terminalHead}`;
    if (
      authoritative === null ||
      authoritative.state !== expectedState ||
      authoritative.url !== record.pullRequest.url ||
      authoritative.baseRefName !== project.repository.defaultBranch ||
      authoritative.headRefName !== `agent/${cardId}` ||
      authoritative.headRefOid === undefined ||
      pendingTerminalMutation.eventId !== expectedEventId ||
      pendingTerminalMutation.operationKey !== expectedOperationKey
    ) {
      throw new Error(
        `Persisted terminal PR mutation no longer matches authoritative PR state for ${cardId}`,
      );
    }
    if (isMerged) {
      await verifyMergedTaskPrHeadContinuity({
        github,
        project,
        cwd: project.repository.path,
        pullRequestNumber: record.pullRequest.number,
        recordedHeadSha: record.pullRequest.headSha!,
        mergedHeadSha: authoritative.headRefOid,
      });
    } else if (authoritative.headRefOid !== record.pullRequest.headSha) {
      throw new Error(`Persisted closed PR head changed for ${cardId}`);
    }
    releaseFailedPublishedFeedbackMutation(queue, record, cardId);
    const recoveredTerminalMutation = queue.claimForRecovery(
      pendingTerminalMutation.eventId,
    );
    if (recoveredTerminalMutation !== null) {
      try {
        if (isMerged) {
          const outcome = await completeMergedTaskSession({
            github,
            queue,
            mutationBlockStore,
            taskStore,
            trello,
            git,
            project,
            card,
            pullRequest: authoritative,
            preserveLegacyMaintenanceArtifacts:
              shouldPreserveTerminalMaintenanceArtifacts(cardId),
            ...(emailNotifier === undefined ? {} : { emailNotifier }),
            signal,
          });
          if (outcome === "completed") options.onHumanReviewCardLeft?.(cardId);
        } else {
          await returnClosedTaskSessionPullRequestToBacklog({
            trello,
            git,
            project,
            card,
            pullRequest: authoritative,
            preserveWorktree:
              shouldPreserveTerminalMaintenanceArtifacts(cardId) ||
              hasExhaustedPublishedFeedbackCorrection(record),
            signal,
          });
        }
        if (!isMerged) options.onHumanReviewCardLeft?.(cardId);
        if (!isMerged) {
          if (signal.aborted) queue.fail(recoveredTerminalMutation.eventId);
          else {
            await persistClosedRunTerminal(
              taskStore,
              trello,
              project,
              card,
              record,
            );
            queue.complete(recoveredTerminalMutation.eventId);
          }
        }
      } catch (error) {
        if (!isMerged && queue.ownsActive(recoveredTerminalMutation.eventId)) {
          queue.fail(recoveredTerminalMutation.eventId);
        }
        throw error;
      }
    } else if (isMerged) {
      const outcome = await completeMergedTaskSession({
        github,
        queue,
        mutationBlockStore,
        taskStore,
        trello,
        git,
        project,
        card,
        pullRequest: authoritative,
        preserveLegacyMaintenanceArtifacts:
          shouldPreserveTerminalMaintenanceArtifacts(cardId),
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        signal,
      });
      if (outcome === "completed") options.onHumanReviewCardLeft?.(cardId);
    }
  }
  let executionRecoveryBlocked = false;
  const recoveryCheckedThisPoll = new Set<string>();
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
      releaseFailedPublishedFeedbackMutation(queue, record, observation.cardId);
      if (observation.state === "MERGED") {
        const outcome = await completeMergedTaskSession({
          github,
          queue,
          mutationBlockStore,
          taskStore,
          trello,
          git,
          project,
          card,
          pullRequest: observation.pullRequest,
          preserveLegacyMaintenanceArtifacts:
            shouldPreserveTerminalMaintenanceArtifacts(observation.cardId),
          ...(emailNotifier === undefined ? {} : { emailNotifier }),
          signal,
        });
        if (outcome === "completed") options.onHumanReviewCardLeft?.(card.id);
        // A verified human terminal outcome owns this poll boundary. Do not
        // claim another Ready card until a subsequent poll observes the
        // completed Trello transition.
        return;
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
          preserveWorktree:
            shouldPreserveTerminalMaintenanceArtifacts(card.id) ||
            hasExhaustedPublishedFeedbackCorrection(record),
          signal,
        });
        options.onHumanReviewCardLeft?.(card.id);
        if (signal.aborted) queue.fail(terminalMutation.eventId);
        else {
          await persistClosedRunTerminal(
            taskStore,
            trello,
            project,
            card,
            record,
          );
          queue.complete(terminalMutation.eventId);
        }
      } catch (error) {
        queue.fail(terminalMutation.eventId);
        throw error;
      }
      return;
    }
    if (taskStore.read(observation.cardId)?.feedbackCardMove) {
      await reconcilePendingFeedbackCardMove({
        project,
        cardId: observation.cardId,
        taskStore,
        trello,
        github,
      });
      const currentCard = await trello.getCard(observation.cardId);
      const index = humanReviewCards.findIndex(
        (candidate) => candidate.id === currentCard.id,
      );
      if (index >= 0) humanReviewCards[index] = currentCard;
    }
    const executionCard = humanReviewCards.find(
      (candidate) => candidate.id === observation.cardId,
    );
    const recoveryRecord = taskStore.read(observation.cardId);
    const isCanonicalActiveTask =
      ProjectRunAuthority.current(project.id)?.cardId === observation.cardId;
    if (
      observation.state === "OPEN" &&
      executionCard &&
      recoveryRecord &&
      (isCanonicalActiveTask ||
        recoveryRecord.recoveryWait !== undefined ||
        executionCard.idList !== project.trello.reviewListId)
    ) {
      const recoveryPath = path.join(
        project.repository.worktreeRoot,
        observation.cardId,
      );
      const recovery = await reconcileOwnedTaskForResume(
        executionCard,
        recoveryRecord,
        recoveryPath,
      );
      if (recovery === null || recovery.status !== "resume") {
        executionRecoveryBlocked = true;
        continue;
      }
      recoveryCheckedThisPoll.add(observation.cardId);
    }
    if (executionRecoveryBlocked) continue;
    let record = taskStore.read(observation.cardId);
    if (
      record &&
      ["ci", "human-feedback"].includes(record.phase) &&
      !hasUnresolvedLegacyMaintenance &&
      queue.getActive()?.kind !== "feedback"
    ) {
      const card = humanReviewCards.find(
        (candidate) => candidate.id === observation.cardId,
      )!;
      const worktreePath = path.join(project.repository.worktreeRoot, card.id);
      await refreshCurrentTaskFeedback({
        project,
        cardId: card.id,
        observation,
        ledgerStore: feedbackLedgerStore,
        openCode,
        worktreePath,
        signal,
      });
      const pending =
        feedbackLedgerStore
          .read(card.id)
          ?.entries.filter(
            (entry) =>
              entry.isCurrent !== false &&
              entry.status === "pending" &&
              entry.actionability === "actionable",
          ) ?? [];
      const selectedFeedbackId =
        pending.length === 0
          ? null
          : feedbackOperationId(observation.headSha, pending);
      const ciEventId = `ci-repair:${card.id}:${observation.headSha}`;
      const maintenanceEventId = `pr-maintenance:${card.id}:${observation.headSha}`;
      const maintenanceNeeded =
        project.maintenance?.enabled === true &&
        ["behind", "diverged"].includes(observation.baseRelation);
      for (const queued of queue.list()) {
        if (queued.cardId !== card.id || queued.status !== "queued") continue;
        if (
          (queued.kind === "feedback" &&
            queued.eventId !== selectedFeedbackId) ||
          (queued.kind === "ci-repair" && queued.eventId !== ciEventId) ||
          (queued.kind === "pr-maintenance" &&
            (!maintenanceNeeded || queued.eventId !== maintenanceEventId))
        )
          queue.retireSupersededObservation(queued.eventId);
      }
      if (observation.ciEvaluation.status === "failed")
        queue.enqueue({
          projectId: project.id,
          cardId: card.id,
          eventId: ciEventId,
          operationKey: `${record.operationKey}:ci:${observation.headSha}`,
          kind: "ci-repair",
          enqueuedAt: record.updatedAt,
        });
      if (maintenanceNeeded)
        queue.enqueue({
          projectId: project.id,
          cardId: card.id,
          eventId: maintenanceEventId,
          operationKey: maintenanceEventId,
          kind: "pr-maintenance",
          enqueuedAt: record.updatedAt,
        });
      if (pending.length > 0) {
        const operationId = feedbackOperationId(observation.headSha, pending);
        queue.enqueue({
          projectId: project.id,
          cardId: card.id,
          eventId: operationId,
          operationKey: operationId,
          kind: "feedback",
          enqueuedAt: new Date().toISOString(),
        });
        if (queue.getActive() === null) {
          if (record.phase === "ci") {
            record = taskStore.compareAndSwap(
              card.id,
              record.revision,
              transitionTaskExecutionRecord(record, {
                type: "human-feedback-pending",
                eventId: `${operationId}:pending`,
                projectId: project.id,
                cardId: card.id,
                operationKey: record.operationKey,
                occurredAt: timestamp(record),
              }),
            );
          }
          const result = await runTaskSessionFeedbackCycle({
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
            worktreePath,
            prepareAttachmentContext: () =>
              options.prepareAttachmentContext(card),
            signal,
            ...(emailNotifier === undefined ? {} : { emailNotifier }),
            ...(options.retryIntervalMs === undefined
              ? {}
              : { retryIntervalMs: options.retryIntervalMs }),
          });
          if (result !== "idle") return;
        }
      }
    }
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
    if (hasUnresolvedLegacyMaintenance) continue;
    const resumingCiReview = canResumeCiReviewRepair(record, queue.getActive());
    if (record === null || (record.phase !== "ci" && !resumingCiReview))
      continue;
    if (
      !resumingCiReview &&
      (observation.ciEvaluation.status === "waiting" ||
        observation.ciEvaluation.status === "uncertain")
    ) {
      continue;
    }
    if (observation.ciEvaluation.status === "failed" || resumingCiReview) {
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
      const card = humanReviewCards.find(
        (candidate) => candidate.id === observation.cardId,
      );
      let ciResult;
      try {
        logger
          .child({ projectId: project.id, cardId: observation.cardId })
          .event("CI repair started");
        if (card === undefined || record.primarySessionId === undefined) {
          throw new Error(
            "CI repair requires the owned review card and primary session",
          );
        }
        const worktreePath = path.join(
          project.repository.worktreeRoot,
          card.id,
        );
        // Published PR correction operations are primary writers too. A lost
        // task session must be reconstructed before the CI repair reserves or
        // resumes its durable operation; otherwise the repair callback only
        // discovers the loss after dispatch has already entered the operation.
        const recovered = await reconcileOwnedTaskForResume(
          card,
          record,
          worktreePath,
        );
        if (recovered === null || recovered.status !== "resume") continue;
        record = recovered.record;
        if (record === null || record.primarySessionId === undefined) continue;
        const ciRecord = record;
        const ciSessionId = ciRecord.primarySessionId;
        if (ciSessionId === undefined) continue;
        const expectedBranch = `agent/${card.id}`;
        const operationKey = record.operationKey;
        const ciRepairCycleId =
          ciRecord.ciRepair?.cycleId ?? `${operationKey}:ci`;
        const ciReviewCycleId = `${operationKey}:ci-review:${ciRepairCycleId}`;
        const plan = planStore.read(card.id);
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
        let quality:
          | Awaited<ReturnType<typeof runTaskSessionValidationWithRepairs>>
          | undefined;
        let latestReview: ImplementationReviewResult;
        const refreshQuality = async () => {
          quality = await runTaskSessionValidationWithRepairs({
            validation: validationOptions,
            openCode,
            planStore,
            card,
            expectedPrimarySessionId: ciSessionId,
            inspectPrimarySession: inspectSessionForWorktree(worktreePath),
            primaryOperationEvidence: {
              trustedRoot:
                ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                getProcessRuntime().artifactRoot,
              cwd: worktreePath,
            },
            repairRunOptions: {
              model: project.opencode.remediation.model,
              variant: project.opencode.remediation.variant,
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
            },
          });
        };
        const rerunQualityAndReview = async () => {
          const reservedReview =
            taskStore.read(card.id)?.reviewRepair?.activePrimaryOperation !==
            undefined;
          if (!reservedReview && taskStore.read(card.id)?.phase === "review") {
            const recoveryOptions = {
              ...validationOptions,
              ciReviewRecovery: true,
            };
            quality = {
              validation: await runTaskSessionValidation(recoveryOptions),
              coverage: await runTaskSessionCoverage(recoveryOptions),
              attempts: taskStore.read(card.id)!.retryCounters.validation,
              record: taskStore.read(card.id)!,
            };
          } else if (!reservedReview) await refreshQuality();
          const runReview = async (
            previousFindings: readonly NonNullable<
              NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
            >[number][],
          ) => {
            if (quality === undefined)
              throw new Error(
                "CI review recovery lacks current quality evidence",
              );
            return runTaskSessionReview({
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
              previousFindings,
              runOptions: {
                model: project.opencode.review.model,
                variant: project.opencode.review.variant,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
              },
            });
          };
          const existingRepair = taskStore.read(card.id)?.reviewRepair;
          const initialReviewRound =
            existingRepair?.activePrimaryOperation === undefined &&
            !["passed", "exhausted"].includes(existingRepair?.status ?? "")
              ? await runReview(
                  existingRepair?.cycleId === ciReviewCycleId
                    ? (existingRepair.findings ?? [])
                    : [],
                )
              : undefined;
          const reviewRoundRunner = createReviewRoundRunner(
            initialReviewRound === undefined
              ? undefined
              : {
                  review: initialReviewRound.review,
                  contentIdentity: initialReviewRound.contentIdentity,
                },
            async (previousFindings) => {
              const freshReview = await runReview(previousFindings);
              return {
                review: freshReview.review,
                contentIdentity: freshReview.contentIdentity,
              };
            },
          );
          const repairReview = async (
            review: ImplementationReviewResult,
            attempt: number,
            operationId: string,
            persistedPrompt?: string,
          ) => {
            let latest = taskStore.read(card.id);
            if (latest === null)
              throw new Error("Task state disappeared during CI review repair");
            if (latest.phase === "review")
              taskStore.compareAndSwap(
                card.id,
                latest.revision,
                transitionTaskExecutionRecord(
                  latest,
                  event(latest, "review-failed"),
                ),
              );
            else if (
              latest.phase !== "implementation" &&
              latest.phase !== "validation"
            )
              throw new Error(
                "CI review repair lost its owned execution checkpoint",
              );
            if (
              latest.phase === "validation" &&
              latest.primaryOperations?.[operationId]?.status !== "completed"
            )
              throw new Error(
                "CI review validation checkpoint lacks a completed primary operation",
              );
            const prompt =
              persistedPrompt ??
              buildTaskSessionReviewRepairPrompt({
                projectId: project.id,
                card,
                ...(plan === null ? {} : { approvedPlan: plan.plan }),
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
              { inspect: inspectSessionForWorktree(worktreePath) },
              {
                role: "primary",
                operationId,
                activity: "review-correction",
                inspectPending: (entry) =>
                  inspectPrimaryOperationEvidence(
                    taskStore,
                    card.id,
                    entry.id,
                    {
                      trustedRoot:
                        ProjectRunAuthority.current(project.id)?.store
                          .storageRoot ?? getProcessRuntime().artifactRoot,
                      cwd: worktreePath,
                    },
                  ),
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
            if (latest.phase === "implementation") {
              const validationPhase = transitionTaskExecutionRecord(
                latest,
                event(latest, "implementation-completed"),
              );
              taskStore.compareAndSwap(
                card.id,
                latest.revision,
                validationPhase,
              );
            } else if (latest.phase !== "validation") {
              throw new Error("Task phase changed after CI review repair");
            }
            return parsePrimaryReviewRepairOutcome(
              repaired.output,
              review.blockingFindings.flatMap(({ id }) =>
                id === undefined ? [] : [id],
              ),
              review.requirementAssessments
                .filter(({ status }) => status === "unsatisfied")
                .map(({ requirementId }) => requirementId),
            );
          };
          const ciReviewResult = await runTaskSessionReviewWithRepairs({
            maxAttempts: project.opencode.remediation.maxPasses,
            store: taskStore,
            projectId: project.id,
            cardId: card.id,
            operationKey,
            reviewCycleId: ciReviewCycleId,
            expectedPrimarySessionId: ciSessionId,
            runReview: reviewRoundRunner,
            repair: repairReview,
            buildRepairPrompt: (review, attempt) =>
              buildTaskSessionReviewRepairPrompt({
                projectId: project.id,
                card,
                ...(plan === null ? {} : { approvedPlan: plan.plan }),
                review,
                attempt,
                maxAttempts: project.opencode.remediation.maxPasses,
              }),
            rerunQuality: refreshQuality,
            getCurrentContentIdentity: () =>
              getTaskSessionSourceSnapshotIdentity(git, worktreePath),
          });
          latestReview = ciReviewResult.review;
          if (ciReviewResult.review.verdict !== "pass")
            throw new Error(
              "CI repair review remains blocking after the configured repair limit",
            );
          let latest = taskStore.read(card.id);
          if (latest === null)
            throw new Error("Task state disappeared after CI review");
          if (
            latest.reviewRepair !== undefined &&
            latest.reviewRepair.cycleId !== ciReviewCycleId
          )
            latest = updateRecord(taskStore, latest, {
              reviewRepair: {
                ...latest.reviewRepair,
                cycleId: ciReviewCycleId,
              },
            });
          taskStore.compareAndSwap(
            card.id,
            latest.revision,
            transitionTaskExecutionRecord(
              latest,
              event(latest, "review-passed"),
            ),
          );
        };
        ciResult = await runTaskSessionCiRepairs({
          resumeReviewRepair: resumingCiReview,
          store: taskStore,
          projectId: project.id,
          cardId: card.id,
          operationKey,
          expectedPrimarySessionId: ciSessionId,
          headSha: observation.headSha,
          observeChecks: async (headSha) => {
            const ciObservation = await github.getCiObservations({
              cwd: project.repository.path,
              repository: project.repository.github,
              defaultBranch: project.repository.defaultBranch,
              headSha,
              ...(ciRecord.pullRequest == null
                ? {}
                : { pullRequestNumber: ciRecord.pullRequest.number }),
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
          repairPrimarySession: async (
            diagnostics,
            attempt,
            sessionId,
            operationId,
          ) => {
            const latestOperation = taskStore.read(card.id);
            if (
              latestOperation?.reviewRepair?.activePrimaryOperation !==
              undefined
            )
              throw new Error(
                "CI primary correction cannot replace a reserved review writer",
              );
            const activePrimaryOperation =
              latestOperation?.ciRepair?.activePrimaryOperation;
            const failedHeadSha =
              diagnostics[0]?.headSha ??
              (activePrimaryOperation?.promptArtifact === undefined
                ? undefined
                : latestOperation?.ciRepair?.headSha);
            if (
              failedHeadSha === undefined ||
              (diagnostics.length > 0 &&
                diagnostics.some(
                  (diagnostic) => diagnostic.headSha !== failedHeadSha,
                ))
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
              const ciReviewRepair = carryReviewRepairIntoCiCorrection(
                latest.reviewRepair,
                ciReviewCycleId,
              );
              latest = updateRecord(taskStore, latest, {
                reviewObservation: undefined,
                publicationQuality: undefined,
                reviewRepair: ciReviewRepair,
              });
            }
            // The card and its attachments are mutable while a task is paused;
            // refresh them at the point the primary writer is about to run.
            let currentCard: TrelloCard;
            let attachmentContext: CardAttachmentPromptContext | undefined;
            try {
              currentCard = await trello.getCard(card.id);
              attachmentContext =
                await options.prepareAttachmentContext(currentCard);
              buildCardAttachmentPromptLines(attachmentContext);
            } catch (error) {
              throw new Error(
                `CI repair is waiting for current Trello attachment context: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
            const sameCiReviewEpisode =
              latest.reviewRepair?.cycleId === ciReviewCycleId;
            const pendingFinish = latest.reviewRepair?.finishAfterNextReview;
            const stoppedReview = latest.reviewRepair?.stopReason;
            const finishAfterNextReview =
              pendingFinish === true
                ? ("finished-early" as const)
                : pendingFinish ||
                  (stoppedReview === "no-change" ||
                  stoppedReview === "finished-early"
                    ? stoppedReview
                    : undefined);
            const ciFailedTransitionInput = sameCiReviewEpisode
              ? {
                  ...latest,
                  reviewRepair: {
                    ...latest.reviewRepair!,
                    status: "active" as const,
                    stopReason: undefined,
                    activePrimaryOperation: undefined,
                    finishAfterNextReview,
                    finalReview: undefined,
                  },
                }
              : latest;
            latest = taskStore.compareAndSwap(
              card.id,
              latest.revision,
              transitionTaskExecutionRecord(
                ciFailedTransitionInput,
                event(latest, "ci-failed"),
              ),
            );
            if (!sameCiReviewEpisode) {
              latest = updateRecord(taskStore, latest, {
                retryCounters: { ...latest.retryCounters, review: 0 },
                reviewRepair: {
                  cycleId: ciReviewCycleId,
                  status: "active",
                  maxAttempts: project.opencode.remediation.maxPasses,
                },
              });
            }
            let prompt: string;
            const persistedPromptArtifact =
              latest.ciRepair?.activePrimaryOperation?.promptArtifact;
            if (persistedPromptArtifact !== undefined) {
              const persisted: unknown = taskStore.readPrimaryResultArtifact({
                reference:
                  persistedPromptArtifact.reference as `sha256:${string}`,
                bytes: persistedPromptArtifact.bytes,
                ...(persistedPromptArtifact.path === undefined
                  ? {}
                  : { path: persistedPromptArtifact.path }),
              });
              if (
                typeof persisted !== "object" ||
                persisted === null ||
                !("prompt" in persisted) ||
                typeof persisted.prompt !== "string"
              )
                throw new Error(
                  "Persisted CI repair prompt artifact is invalid",
                );
              prompt = persisted.prompt;
            } else {
              prompt = buildTaskSessionCiRepairPrompt({
                projectId: project.id,
                card: currentCard,
                ...(plan === null ? {} : { approvedPlan: plan.plan }),
                headSha: failedHeadSha,
                attempt,
                maxAttempts: 2,
                diagnostics,
                ...(attachmentContext === undefined
                  ? {}
                  : { attachmentContext }),
              });
              const promptArtifact = taskStore.writePrimaryResultArtifact(
                `${operationId}:prompt`,
                { prompt },
              );
              if (
                latest.ciRepair?.activePrimaryOperation?.operationId !==
                operationId
              )
                throw new Error(
                  "CI repair primary reservation changed before prompt persistence",
                );
              taskStore.compareAndSwap(card.id, latest.revision, {
                ...latest,
                ciRepair: {
                  ...latest.ciRepair,
                  activePrimaryOperation: {
                    ...latest.ciRepair.activePrimaryOperation,
                    promptArtifact,
                  },
                },
                revision: latest.revision + 1,
                updatedAt: timestamp(latest),
              });
            }
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
              { inspect: inspectSessionForWorktree(worktreePath) },
              {
                role: "primary",
                operationId,
                activity: "ci-correction",
                inspectPending: (entry) =>
                  inspectPrimaryOperationEvidence(
                    taskStore,
                    card.id,
                    entry.id,
                    {
                      trustedRoot:
                        ProjectRunAuthority.current(project.id)?.store
                          .storageRoot ?? getProcessRuntime().artifactRoot,
                      cwd: worktreePath,
                    },
                  ),
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
            if (validationRecord?.reviewRepair?.cycleId !== ciReviewCycleId)
              throw new Error(
                "CI correction lost its durable review budget episode",
              );
          },
          rerunLocalGatesAndReview: rerunQualityAndReview,
          publishSamePullRequest: async () => {
            if (quality === undefined)
              throw new Error("CI publication lacks current quality evidence");
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
              review: latestReview,
            };
            if (!decideValidatedHumanReviewPublication(gateInput).allowed)
              throw new Error("CI repair publication gates failed");
            const existingPullRequestUrl = taskStore.read(card.id)?.pullRequest
              ?.url;
            if (existingPullRequestUrl === undefined) {
              throw new Error(
                "CI repair cannot publish without the persisted existing PR URL",
              );
            }
            const ciRepairOperationId = taskStore.read(card.id)?.ciRepair
              ?.activePrimaryOperation?.operationId;
            if (ciRepairOperationId === undefined)
              throw new Error(
                "CI repair commit message has no durable commit intent",
              );
            const commitMessage = await runTaskSessionCommitMessage({
              project,
              card,
              operationKey,
              commitIntentId: ciRepairOperationId,
              operationId: `${ciRepairOperationId}:commit-message`,
              worktreePath,
              taskRecordStore: taskStore,
              git,
              openCode,
              runOptions: commitMessageRunOptions(
                project,
                signal,
                getSessionLogPath(project.id, card.id),
              ),
            });
            let preparedGate = gateInput;
            const newHead = await publishTaskSessionCard({
              trello,
              git,
              github,
              opencode: openCode,
              commands,
              project,
              card,
              worktreePath,
              branch: expectedBranch,
              expectedExistingPullRequestUrl: existingPullRequestUrl,
              commitMessage,
              reviewResult:
                latestReview.verdict === "pass" ? "Passed" : "Failed",
              remediationResult: `CI repair attempt ${taskStore.read(card.id)?.retryCounters.ci ?? 1}`,
              ...(emailNotifier === undefined ? {} : { emailNotifier }),
              claimHumanReviewNotification: (commitSha) =>
                taskStore.claimHumanReviewNotification(card.id, commitSha),
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
                    validation: toPersistedQualityEvidence(validationNow),
                    coverageEvidence: toPersistedQualityEvidence(coverageNow),
                    review: reviewNow.review,
                    reviewPreviousFindingIds:
                      reviewNow.review.previousFindingAssessments?.map(
                        ({ findingId }) => findingId,
                      ) ?? [],
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
        const current = taskStore.read(observation.cardId);
        if (current !== null && options.retryIntervalMs !== undefined) {
          const disposition = persistPrimaryOperationRecovery(
            taskStore,
            current,
            error,
            options.retryIntervalMs,
          );
          if (
            disposition === "waiting" ||
            disposition === "published-blockage"
          ) {
            if (queue.ownsActive(ciEventId))
              queue.releaseForRecovery(ciEventId);
            continue;
          }
        }
        if (queue.ownsActive(ciEventId)) queue.fail(ciEventId);
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
      if (ciResult.status === "passed") {
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
    taskStore.compareAndSwap(
      record.cardId,
      record.revision,
      transitionTaskExecutionRecord(
        record,
        event(record, "ci-passed-awaiting-human"),
      ),
    );
    // Passing CI and local quality evidence never authorizes an orchestrator merge.
  }
  if (executionRecoveryBlocked) return;
  if (
    executionRecoveryCard !== undefined &&
    canonicalCardId !== undefined &&
    !recoveryCheckedThisPoll.has(canonicalCardId)
  ) {
    if (taskStore.read(executionRecoveryCard.id)?.feedbackCardMove) {
      await reconcilePendingFeedbackCardMove({
        project,
        cardId: executionRecoveryCard.id,
        taskStore,
        trello,
        github,
      });
      executionRecoveryCard = await trello.getCard(executionRecoveryCard.id);
    }
    const recoveryRecord = taskStore.read(executionRecoveryCard.id);
    if (recoveryRecord === null)
      throw new Error(
        `Canonical recovery task disappeared: ${executionRecoveryCard.id}`,
      );
    const recoveryPath = path.join(
      project.repository.worktreeRoot,
      executionRecoveryCard.id,
    );
    const recovery = await reconcileOwnedTaskForResume(
      executionRecoveryCard,
      recoveryRecord,
      recoveryPath,
    );
    if (recovery === null || recovery.status !== "resume") {
      logger
        .child({ projectId: project.id, cardId: executionRecoveryCard.id })
        .event(
          recovery === null
            ? "Published task recovery remains waiting for reconstruction evidence"
            : `Published task recovery remains ${recovery.status}; no writer was scheduled`,
        );
      return;
    }
    recoveryCheckedThisPoll.add(canonicalCardId);
  }
  const latestHumanReviewCards = await getCardsForDiscovery(
    trello,
    project.id,
    project.trello.reviewListId,
    "Could not re-read task-session Human Review cards",
    signal,
  );
  const latestCanonicalCardId = ProjectRunAuthority.current(project.id)?.cardId;
  const latestCanonicalTask = latestCanonicalCardId
    ? taskStore.read(latestCanonicalCardId)
    : null;
  if (
    latestCanonicalCardId &&
    (latestCanonicalTask?.phase === "ci" ||
      latestCanonicalTask?.phase === "human-feedback" ||
      canResumeFeedbackReviewRepair(latestCanonicalTask, queue.getActive())) &&
    !latestHumanReviewCards.some(
      (candidate) => candidate.id === latestCanonicalCardId,
    )
  )
    latestHumanReviewCards.push(await trello.getCard(latestCanonicalCardId));
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
  for (const observation of latestObservations) {
    if (observation.state !== "OPEN") continue;
    const card = latestHumanReviewCards.find(
      (candidate) => candidate.id === observation.cardId,
    );
    const record = taskStore.read(observation.cardId);
    if (!card || !record) continue;
    if (
      ProjectRunAuthority.current(project.id)?.cardId !== observation.cardId &&
      record.recoveryWait === undefined &&
      card.idList === project.trello.reviewListId &&
      !recoveryCheckedThisPoll.has(observation.cardId)
    )
      continue;
    const recoveryPath = path.join(
      project.repository.worktreeRoot,
      observation.cardId,
    );
    const recovery = await reconcileOwnedTaskForResume(
      card,
      record,
      recoveryPath,
    );
    if (recovery === null || recovery.status !== "resume") return;
  }
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
      if (maintenanceResult === "deferred") {
        const diagnosticKey = `${project.id}:${observation.cardId}:${observation.pullRequestUrl}`;
        if (!reportedDeferredMaintenance.has(diagnosticKey)) {
          logger
            .child({ projectId: project.id, cardId: observation.cardId })
            .warn(
              `Routine PR maintenance is unavailable; preserving published history, local worktree, and PR ${observation.pullRequestUrl}`,
            );
          reportedDeferredMaintenance.add(diagnosticKey);
        }
        // Avoid repeatedly dispatching routine maintenance this poll. Do not
        // claim the unresolved legacy-operation block: ordinary maintenance
        // deferral alone does not block unrelated safe writers.
      }
    }
  }
  let feedbackNeedsAttention = false;
  for (const observation of latestObservations) {
    if (observation.state !== "OPEN") continue;
    if (hasUnresolvedLegacyMaintenance) continue;
    const initialRecord = taskStore.read(observation.cardId);
    if (initialRecord === null) continue;
    const resumableFeedbackReview = canResumeFailedFeedbackReview(
      initialRecord,
      queue.getActive(),
    );
    const resumableFeedbackRepair = canResumeFeedbackReviewRepair(
      initialRecord,
      queue.getActive(),
    );
    if (
      initialRecord.phase !== "human-feedback" &&
      !resumableFeedbackReview &&
      !resumableFeedbackRepair
    )
      continue;
    // A healthy, idle Human Review task has no operation to resume. Avoid
    // turning a routine poll into a primary-session/worktree recovery check;
    // that check is required immediately before acting on feedback, but an
    // idle review remains owned by the human. PR terminal state was already
    // authoritatively observed above and remains handled by the terminal path.
    const idleHumanReview =
      initialRecord.phase === "human-feedback" &&
      !resumableFeedbackReview &&
      observation.feedbackIds.length === 0 &&
      observation.requestedChanges === null &&
      observation.conversationComments.length === 0;
    const card = latestHumanReviewCards.find(
      (candidate) => candidate.id === initialRecord.cardId,
    );
    if (card === undefined)
      throw new Error(
        `Observed task-session review card disappeared: ${initialRecord.cardId}`,
      );
    const recovery = idleHumanReview
      ? null
      : await reconcileOwnedTaskForResume(
          card,
          initialRecord,
          path.join(project.repository.worktreeRoot, card.id),
        );
    if (!idleHumanReview && (recovery === null || recovery.status !== "resume"))
      continue;
    const record = recovery?.record ?? initialRecord;
    if (record.primarySessionId === undefined) continue;
    if (resumableFeedbackReview) {
      // Durable one-shot authorization. An unsuccessful retry must not be
      // reattempted by every poll or by a fresh worker after restart.
      taskStore.compareAndSwap(record.cardId, record.revision, {
        ...record,
        feedbackRecoveryAttemptEventId: queue.getActive()!.eventId,
        revision: record.revision + 1,
        updatedAt: timestamp(record),
      });
    }
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
      ...(emailNotifier === undefined ? {} : { emailNotifier }),
      signal,
      ...(options.retryIntervalMs === undefined
        ? {}
        : { retryIntervalMs: options.retryIntervalMs }),
    });
    if (feedbackResult === "attention-required") feedbackNeedsAttention = true;
  }
  if (feedbackNeedsAttention) return;
  const pendingFeedbackReview = queue.getActive();
  const pendingFeedbackTask =
    pendingFeedbackReview?.kind === "feedback"
      ? taskStore.read(pendingFeedbackReview.cardId)
      : null;
  if (
    pendingFeedbackTask?.feedbackRemediation?.status === "changed" &&
    pendingFeedbackTask.reviewRepair !== undefined &&
    ["implementation", "validation", "review"].includes(
      pendingFeedbackTask.phase,
    )
  ) {
    // A feedback-owned review must never fall through to initial implementation
    // recovery if its reservation, identity or owning queue cannot be resumed.
    return;
  }
  if (pendingFeedbackReview?.kind === "ci-repair") {
    const pendingCi = taskStore.read(pendingFeedbackReview.cardId);
    if (
      pendingCi?.ciRepair?.activePrimaryOperation !== undefined &&
      pendingCi.reviewRepair !== undefined &&
      ["implementation", "validation", "review"].includes(pendingCi.phase)
    )
      return;
  }
  const refinementAuthority = ProjectRunAuthority.current(project.id);
  const canonicalRun = refinementAuthority?.store.read();
  if (
    refinementAuthority &&
    canonicalRun?.taskKind === "refinement" &&
    canonicalRun.lifecycle === "failed" &&
    canonicalRun.terminalEvidence?.prOutcome === "no-pr-failure"
  ) {
    const failed = await getCardsForDiscovery(
      trello,
      project.id,
      project.trello.failedListId,
      "Could not verify terminal refinement failure before releasing ownership",
      signal,
    );
    if (!failed.some((candidate) => candidate.id === canonicalRun.cardId))
      throw new Error("Terminal refinement failure is not present in Failed");
    const event = queue.getActive();
    if (event?.kind === "refinement" && event.cardId === canonicalRun.cardId) {
      const owner = queue.claimForRecovery(event.eventId);
      if (owner === null)
        throw new Error("Could not recover terminal refinement queue event");
      queue.complete(owner.eventId);
    }
    await refinementAuthority.releaseVerifiedTerminal();
    return;
  }
  const pendingRefinementFailure = queue.getActive();
  if (
    refinementAuthority &&
    pendingRefinementFailure?.kind === "refinement" &&
    hasExhaustedRefinementSetup(
      refinementAuthority,
      pendingRefinementFailure.cardId,
    )
  ) {
    const owner = queue.claimForRecovery(pendingRefinementFailure.eventId);
    if (owner === null)
      throw new Error(
        "Could not claim exhausted refinement setup for recovery",
      );
    try {
      const failureCard = await trello.getCard(owner.cardId);
      await finalizeRefinementSetupFailure({
        authority: refinementAuthority,
        queue,
        queueEventId: owner.eventId,
        trello,
        project,
        card: failureCard,
        reason:
          "Repository setup failed after three bounded executions; setup effects and process evidence are preserved",
        signal,
      });
    } catch (error) {
      if (queue.ownsActive(owner.eventId))
        queue.releaseForRecovery(owner.eventId);
      throw error;
    }
    return;
  }
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
      if (
        strandedRecord.terminalFailure?.kind !== "implementation" &&
        strandedRecord.terminalFailure?.kind !== "clarification"
      ) {
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
      (currentRecord.terminalFailure?.kind === "implementation" ||
        currentRecord.terminalFailure?.kind === "clarification") &&
      currentRecord.terminalFailure.outcome !== "confirmed"
    ) {
      try {
        await finalizePrimaryFailureEffects(
          strandedMutation.cardId,
          currentRecord.operationKey,
          currentRecord.terminalFailure.reason,
          currentRecord.terminalFailure.kind,
        );
      } catch (error) {
        if (queue.ownsActive(owner.eventId))
          queue.releaseForRecovery(owner.eventId);
        throw error;
      }
    }
    // Canonical project authority must observe the terminal failure only after
    // Failed-list readback and all journaled effects have reconciled. Also run
    // this projection when the compatibility record was already confirmed but
    // the process stopped before updating the canonical RunStore.
    const latestTerminalRecord = taskStore.read(strandedMutation.cardId);
    if (latestTerminalRecord?.terminalFailure === undefined) {
      // Preserve legacy terminal records: they have no verified failure
      // outcome to project into canonical RunStore terminal evidence.
      queue.complete(owner.eventId);
      return;
    }
    if (
      latestTerminalRecord === null ||
      (latestTerminalRecord.terminalFailure?.kind !== "implementation" &&
        latestTerminalRecord.terminalFailure?.kind !== "clarification")
    )
      throw new Error(
        "Terminal failure disappeared before canonical projection",
      );
    const confirmedFailure = {
      ...latestTerminalRecord,
      terminalFailure: {
        ...latestTerminalRecord.terminalFailure,
        outcome: "confirmed" as const,
      },
      revision: latestTerminalRecord.revision + 1,
      updatedAt: timestamp(latestTerminalRecord),
    };
    if (
      ProjectRunAuthority.current(project.id) &&
      latestTerminalRecord.pullRequest === undefined &&
      latestTerminalRecord.externalRecovery === undefined
    ) {
      taskStore.compareAndSwap(
        latestTerminalRecord.cardId,
        latestTerminalRecord.revision,
        confirmedFailure,
        {
          event: "failed",
          evidence: noPullRequestFailureEvidence(
            project,
            latestTerminalRecord.cardId,
            latestTerminalRecord.operationKey,
          ),
        },
      );
    } else if (latestTerminalRecord.terminalFailure.outcome !== "confirmed") {
      taskStore.compareAndSwap(
        latestTerminalRecord.cardId,
        latestTerminalRecord.revision,
        confirmedFailure,
      );
    }
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
  const ownedCardId = ProjectRunAuthority.current(project.id)?.cardId;
  const ownedTask = ownedCardId ? taskStore.read(ownedCardId) : null;
  if (
    ownedCardId &&
    ownedTask &&
    ownedTask.phase !== "human-feedback" &&
    ownedTask.phase !== "ci" &&
    !workingCards.some((candidate) => candidate.id === ownedCardId)
  ) {
    workingCards.push(await trello.getCard(ownedCardId));
  }
  // Terminal PR observation/reconciliation above is read-only-safe, but legacy
  // maintenance may represent a branch effect for any card, including an
  // archived or manually moved card. Do not resume Working/refinement writers.
  if (hasUnresolvedLegacyMaintenance) return;
  const activeMutation = queue.getActive();
  // A claim move can be accepted before its local task projection is created.
  // Bind that verified original effect rather than treating the owned Working
  // card as a fresh task (or sending the move again).
  const claimAuthority = ProjectRunAuthority.current(project.id);
  const claimRun = claimAuthority?.store.read();
  if (
    claimRun?.lifecycle === "planning" &&
    activeMutation?.kind === "implementation" &&
    workingCards.some((card) => card.id === claimRun.cardId) &&
    taskStore.read(claimRun.cardId) === null &&
    activeMutation.cardId === claimRun.cardId &&
    hasVerifiedWorkflowMove(claimAuthority!, claimRun.pinned.lists.working)
  ) {
    const ownedPath = path.join(claimRun.pinned.worktreeRoot, claimRun.cardId);
    if (
      (await git.getCurrentBranch(ownedPath)) !== `agent/${claimRun.cardId}` ||
      (await git.getCommonGitDirectory(ownedPath)) !==
        (await git.getCommonGitDirectory(claimRun.pinned.repositoryPath))
    )
      throw new Error("Accepted claim has ambiguous worktree provenance");
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: claimRun.cardId,
      phase: "planning",
      expectedBranch: `agent/${claimRun.cardId}`,
      operationKey: activeMutation.operationKey,
      setup: {
        command: project.repository.setupCommand ?? null,
        status:
          project.repository.setupCommand === undefined
            ? "not-required"
            : "pending",
        attempts: 0,
        history: [],
      },
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
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
      await completeRefinementAuthority(
        ProjectRunAuthority.current(project.id),
        trello,
        project,
        card.id,
      );
      if (signal.aborted) queue.fail(recovered.eventId);
      else queue.complete(recovered.eventId);
      return;
    } catch (error) {
      if (error instanceof RefinementSetupFailedError) {
        try {
          const authority = ProjectRunAuthority.current(project.id);
          if (!authority)
            throw new Error("Refinement failure has no canonical authority", {
              cause: error,
            });
          await finalizeRefinementSetupFailure({
            authority,
            queue,
            queueEventId: recovered.eventId,
            trello,
            project,
            card,
            reason:
              "Repository setup failed after three bounded executions; setup effects and process evidence are preserved",
            signal,
          });
          return;
        } catch (finalizationError) {
          if (queue.ownsActive(recovered.eventId))
            queue.releaseForRecovery(recovered.eventId);
          throw finalizationError;
        }
      }
      if (
        error instanceof NotificationPreparationError ||
        error instanceof RefinementSetupAmbiguousError
      )
        queue.releaseForRecovery(recovered.eventId);
      else queue.fail(recovered.eventId);
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
    let record = taskStore.read(card.id);
    if (record === null)
      throw new Error(`Task execution record disappeared for ${card.id}`);
    // A stale-review publication failure is recoverable when its exact
    // committed implementation and final review remain durably recorded.
    // Reopening this checkpoint must never rerun implementation or repairs.
    if (
      record.phase === "attention-required" &&
      record.terminalFailure === undefined &&
      record.reviewRepair?.finalReview !== undefined &&
      record.publicationQuality !== undefined
    ) {
      const trusted = readTrustedCommitState(project, card.id);
      const ownedPath = path.join(project.repository.worktreeRoot, card.id);
      if (
        trusted !== null &&
        (await git.getCurrentBranch(ownedPath)) === trusted.taskBranch &&
        (await git.getHeadSha(ownedPath)) === trusted.commitSha &&
        (await git.getStatus(ownedPath)).trim().length === 0
      ) {
        const identity = await getTaskSessionSourceSnapshotIdentity(
          git,
          ownedPath,
        );
        if (
          (record.publicationQuality.contentIdentity === identity ||
            record.reviewRepair.status === "exhausted") &&
          JSON.stringify(record.publicationQuality.review) ===
            JSON.stringify(record.reviewRepair.finalReview)
        ) {
          record = taskStore.compareAndSwap(card.id, record.revision, {
            ...record,
            phase: "publication",
            reviewObservation: undefined,
            revision: record.revision + 1,
            updatedAt: timestamp(record),
          });
          logger
            .child({ projectId: project.id, cardId: card.id })
            .event(
              "Restored verified publication checkpoint from attention-required",
            );
        }
      }
    }
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
        (latestFailureRecord.terminalFailure?.kind !== "implementation" &&
          latestFailureRecord.terminalFailure?.kind !== "clarification")
      )
        throw new Error(`Terminal failure identity changed for ${card.id}`);
      try {
        await finalizePrimaryFailureEffects(
          card.id,
          latestFailureRecord.operationKey,
          latestFailureRecord.terminalFailure.reason,
          latestFailureRecord.terminalFailure.kind,
        );
      } catch (error) {
        if (queue.ownsActive(owner.eventId))
          queue.releaseForRecovery(owner.eventId);
        throw error;
      }
      const confirmedFailure = {
        ...latestFailureRecord,
        terminalFailure: {
          ...latestFailureRecord.terminalFailure,
          outcome: "confirmed" as const,
        },
        revision: latestFailureRecord.revision + 1,
        updatedAt: timestamp(latestFailureRecord),
      };
      if (
        ProjectRunAuthority.current(project.id) &&
        latestFailureRecord.pullRequest === undefined &&
        latestFailureRecord.externalRecovery === undefined
      ) {
        taskStore.compareAndSwap(
          card.id,
          latestFailureRecord.revision,
          confirmedFailure,
          {
            event: "failed",
            evidence: noPullRequestFailureEvidence(
              project,
              card.id,
              latestFailureRecord.operationKey,
            ),
          },
        );
      } else {
        taskStore.compareAndSwap(
          card.id,
          latestFailureRecord.revision,
          confirmedFailure,
        );
      }
      queue.complete(owner.eventId);
      return;
    }
    const worktreePath = path.join(project.repository.worktreeRoot, card.id);
    const hasReservedPrimaryRepair =
      record.validationRepair?.activePrimaryOperation !== undefined ||
      record.reviewRepair?.activePrimaryOperation !== undefined;
    if (
      record.reviewRemediationFailure !== undefined &&
      !hasReservedPrimaryRepair
    ) {
      const failure = record.reviewRemediationFailure;
      const identity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      if (
        !failure.unchanged ||
        failure.after === null ||
        failure.after !== failure.before ||
        identity !== failure.after
      )
        throw new Error(
          "Interrupted review remediation has changed or unverified source; refusing automatic restart",
        );
      const validation = record.validationRepair;
      if (
        signal.aborted ||
        !["implementation", "validation", "review", "publication"].includes(
          record.phase,
        ) ||
        record.expectedBranch !== `agent/${card.id}` ||
        record.primarySessionId === undefined ||
        failure.cycleId !== record.operationKey ||
        validation?.status !== "passed" ||
        validation.evidence?.contentIdentity !== identity ||
        validation.evidence.command !== project.repository.validationCommand ||
        (project.repository.coverageCommand === undefined
          ? validation.coverageEvidence !== undefined
          : validation.coverageEvidence?.command !==
              project.repository.coverageCommand ||
            validation.coverageEvidence.contentIdentity !== identity) ||
        (await git.getCurrentBranch(worktreePath)) !== record.expectedBranch ||
        (await git.getCommitCountBetween(
          worktreePath,
          `origin/${project.repository.defaultBranch}`,
          await git.getHeadSha(worktreePath),
        )) !== 0 ||
        (await git.getStatus(worktreePath)).trim().length === 0 ||
        (await git.getRebaseState(worktreePath)) !== null ||
        (await git.getRemoteBranchSha(
          project.repository.path,
          "origin",
          record.expectedBranch,
          project,
        )) !== null ||
        (await github.findPullRequestState({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: record.expectedBranch,
          baseBranch: project.repository.defaultBranch,
          project,
        })) !== null
      )
        throw new Error(
          "Interrupted review remediation lacks safe owned quality/branch evidence for handoff",
        );
      let restored = record;
      for (const [phase, type] of [
        ["implementation", "implementation-completed"],
        ["validation", "validation-passed"],
        ["review", "review-unavailable"],
      ] as const) {
        if (restored.phase === phase) {
          restored = taskStore.compareAndSwap(
            card.id,
            restored.revision,
            transitionTaskExecutionRecord(restored, event(restored, type)),
          );
        }
      }
      if (restored.phase !== "publication")
        throw new Error(
          "Interrupted remediation has an invalid recovery phase",
        );
      updateRecord(taskStore, restored, {
        reviewUnavailable: {
          contentIdentity: identity,
          diagnostic:
            "Review remediation interrupted; unchanged implementation requires human review",
        },
        reviewRemediationFailure: undefined,
      });
    }
    const priorRecoveryNotificationId = record.recoveryWait?.notificationId;
    const recovery = await reconcileOwnedTaskForResume(
      card,
      record,
      worktreePath,
    );
    if (recovery === null) return;
    if (recovery.status !== "resume") {
      if (recovery.status === "waiting") {
        if (
          recovery.record.recoveryWait?.notificationId !==
          priorRecoveryNotificationId
        ) {
          logger
            .child({ projectId: project.id, cardId: card.id })
            .warn(
              `Recovery wait ${recovery.record.recoveryWait?.notificationId ?? "unknown"}: verified ${recovery.checkpoint} checkpoint; authoritative dependency read will be retried on a later project poll: ${recovery.reason}`,
            );
        }
      }
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

    const correctionOperationId = record.feedbackRemediation?.operationId;
    const correctionEvents =
      correctionOperationId === undefined
        ? []
        : queue
            .list()
            .filter(
              (event) =>
                event.cardId === card.id &&
                event.projectId === project.id &&
                event.kind === "feedback" &&
                event.eventId === correctionOperationId,
            );
    const matchingEvents =
      correctionEvents.length > 0
        ? correctionEvents
        : queue
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
        activeEvent.operationKey !== recoveryEvent.operationKey)
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
    const readyCards = preflightReadyCards;
    const hasActiveHumanReview = humanReviewCards.some((card) => {
      const record = taskStore.read(card.id);
      return record?.phase === "human-feedback" || record?.phase === "ci";
    });
    const authority = ProjectRunAuthority.current(project.id);
    const authorityAttempt = authority?.store.read();
    const eligibleCards =
      hasUnresolvedLegacyMaintenance || hasActiveHumanReview
        ? []
        : readyCards.filter(
            (card) =>
              isCardStartDateReached(card, Date.now()) &&
              getWorkflowKind(card, project) !== null &&
              (authorityAttempt === undefined ||
                authorityAttempt === null ||
                authorityAttempt.cardId === card.id),
          );
    // Ready cards may have been moved externally while their queued claim
    // persisted. Reconcile verified orphans before claiming the next event:
    // otherwise a stale claim can monopolize the project mutation queue and
    // prevent merged PRs from transitioning to Done.
    const readyCardIds = new Set(readyCards.map((card) => card.id));
    const workingCardIds = new Set(workingCards.map((card) => card.id));
    for (const queued of queue.list()) {
      if (
        (queued.kind !== "implementation" && queued.kind !== "refinement") ||
        (queued.status !== "queued" && queued.status !== "active") ||
        readyCardIds.has(queued.cardId) ||
        workingCardIds.has(queued.cardId) ||
        taskStore.read(queued.cardId) !== null
      )
        continue;
      queue.retireOrphanedReadyEvent(queued.eventId);
      logger
        .child({ projectId: project.id, cardId: queued.cardId })
        .event("Retired verified orphaned Ready mutation");
    }
    let readyRecoveryEvent: TaskMutationEvent | null = null;
    let firstEligibleEvent: TaskMutationEvent | null = null;
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
      const baseEventId = `implementation:${card.id}:${digest}`;
      const priorAttempts = queue
        .list()
        .filter(
          (event) =>
            event.cardId === card.id &&
            (event.eventId === baseEventId ||
              event.eventId.startsWith(`${baseEventId}:attempt:`)),
        );
      const priorCompleted = priorAttempts.find(
        (event) => event.status === "completed",
      );
      if (priorCompleted !== undefined) {
        const diagnostic = `Ready card ${card.id} has a completed implementation mutation ${priorCompleted.eventId} but no task record; its outcome is ambiguous and operator recovery is required before scheduling`;
        prepareAttentionNotification(emailNotifier, {
          project,
          category: "Workflow",
          reason: diagnostic,
          cardIds: [card.id],
        });
        if (
          mutationBlockStore.report(
            `orphan:${priorCompleted.eventId}`,
            `${priorCompleted.eventId}|completed-without-task-record`,
            diagnostic,
          )
        ) {
          logger
            .child({ projectId: project.id, cardId: card.id })
            .error(diagnostic);
          await notifyAttentionRequired(
            emailNotifier,
            {
              project,
              category: "Workflow",
              reason: diagnostic,
              cardIds: [card.id],
            },
            logger.child({ projectId: project.id, cardId: card.id }),
          );
        }
        return;
      }
      const liveAttempts = priorAttempts.filter((event) =>
        ["queued", "active", "failed"].includes(event.status),
      );
      if (liveAttempts.length > 1) {
        const diagnostic = `Ready card ${card.id} has multiple nonterminal mutation attempts for the same operation identity (${liveAttempts.map((event) => event.eventId).join(", ")}); preserved for operator recovery`;
        prepareAttentionNotification(emailNotifier, {
          project,
          category: "Workflow",
          reason: diagnostic,
          cardIds: [card.id],
        });
        if (
          mutationBlockStore.report(
            `attempts:${baseEventId}`,
            liveAttempts
              .map((event) => `${event.eventId}:${event.status}`)
              .sort()
              .join("|"),
            diagnostic,
          )
        ) {
          logger
            .child({ projectId: project.id, cardId: card.id })
            .error(diagnostic);
          await notifyAttentionRequired(
            emailNotifier,
            {
              project,
              category: "Workflow",
              reason: diagnostic,
              cardIds: [card.id],
            },
            logger.child({ projectId: project.id, cardId: card.id }),
          );
        }
        return;
      }
      mutationBlockStore.resolve(`attempts:${baseEventId}`);
      mutationBlockStore.resolve(`orphan:${baseEventId}`);
      let queuedEvent = liveAttempts[0];
      if (queuedEvent === undefined) {
        const retiredAttempts = priorAttempts.filter(
          (event) => event.status === "retired",
        );
        const attemptNumber =
          retiredAttempts.length === 0
            ? 0
            : Math.max(
                ...retiredAttempts.map((event) =>
                  event.eventId === baseEventId
                    ? 0
                    : Number(
                        event.eventId.match(/:attempt:([1-9][0-9]*)$/)?.[1],
                      ),
                ),
              ) + 1;
        const eventId =
          attemptNumber === 0
            ? baseEventId
            : `${baseEventId}:attempt:${attemptNumber}`;
        const operationKey =
          attemptNumber === 0
            ? `task-session:${card.id}:${digest}`
            : `task-session:${card.id}:${digest}:attempt:${attemptNumber}`;
        queuedEvent = queue.enqueue({
          projectId: project.id,
          cardId: card.id,
          eventId,
          operationKey,
          kind: getWorkflowKind(card, project)!,
          // Preserve Trello's Ready-list order even when cards are observed in
          // the same clock millisecond and the queue's stable tie-break applies.
          enqueuedAt: new Date(Date.now() + readyIndex).toISOString(),
        });
      }
      const activeEvent = queue.getActive();
      firstEligibleEvent ??= queuedEvent;
      if (
        activeEvent !== null &&
        activeEvent.cardId === card.id &&
        activeEvent.operationKey !== queuedEvent.operationKey
      ) {
        throw new Error(
          `Ready card ${card.id} changed identity while its prior task-session operation remains active`,
        );
      }
      if (queuedEvent.status === "completed") continue;
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
        ? firstEligibleEvent === null
          ? null
          : queue.claimForRecovery(firstEligibleEvent.eventId)
        : queue.claimForRecovery(readyRecoveryEvent.eventId);
    if (mutation === null) return;
    selectedCard =
      eligibleCards.find((candidate) => candidate.id === mutation!.cardId) ??
      null;
    if (selectedCard === null) {
      // Do not strand ownership when an eligible card disappears between
      // discovery and claim. The next poll will verify and retire the orphan.
      if (queue.ownsActive(mutation.eventId))
        queue.releaseForRecovery(mutation.eventId);
      const diagnostic = `Claimed mutation ${mutation.eventId} (${mutation.kind}, ${mutation.status}) was no longer eligible because card ${mutation.cardId} disappeared from Ready for Agent; ownership was released for authoritative reconciliation on the next poll`;
      if (
        mutationBlockStore.report(
          `orphan:${mutation.eventId}`,
          `${mutation.eventId}|${mutation.kind}|disappeared-after-claim`,
          diagnostic,
        )
      )
        logger
          .child({ projectId: project.id, cardId: mutation.cardId })
          .warn(diagnostic);
      return;
    }
  }
  if (mutation === null || selectedCard === null) return;
  let card = selectedCard;
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  try {
    // The discovery snapshot can become stale while another poller or a user
    // moves the card. Revalidate after claiming and before any implementation
    // setup or Trello transition so an unstarted claim can be retired safely.
    if (recoveryRecord === null) {
      let currentlyReady: TrelloCard[];
      try {
        currentlyReady = await getCardsForDiscovery(
          trello,
          project.id,
          project.trello.readyListId,
          "Could not verify Ready eligibility after mutation claim",
          signal,
        );
      } catch (error) {
        if (queue.ownsActive(mutation.eventId))
          queue.releaseForRecovery(mutation.eventId);
        throw error;
      }
      if (!currentlyReady.some((candidate) => candidate.id === card.id)) {
        queue.retireOrphanedReadyEvent(mutation.eventId);
        mutationBlockStore.resolve(`orphan:${mutation.eventId}`);
        return;
      }
      const firstEligible = currentlyReady.find(
        (candidate) =>
          isCardStartDateReached(candidate, Date.now()) &&
          getWorkflowKind(candidate, project) !== null,
      );
      if (
        firstEligible?.id !== card.id ||
        getWorkflowKind(firstEligible, project) !== mutation.kind
      ) {
        queue.requeueAfterVerifiedRecovery(mutation.eventId);
        return;
      }
      card = firstEligible;
    }
    if (recoveryRecord !== null) {
      cardLog.event(
        `Recovering existing task in ${recoveryRecord.phase} phase`,
      );
      if (
        mutation.kind === "feedback" &&
        recoveryRecord.pullRequest !== undefined &&
        !(
          recoveryRecord.phase === "publication" &&
          expectedTaskTrelloList(project, recoveryRecord) ===
            project.trello.reviewListId
        )
      ) {
        await ensureFeedbackCardLocation(
          { project, cardId: card.id, taskStore, trello, github },
          project.trello.workingListId,
          `${mutation.eventId}:working`,
        );
        recoveryRecord = taskStore.read(card.id)!;
        card = await trello.getCard(card.id);
      }
    }
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
      const stillReady = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.readyListId,
        "Could not verify Ready eligibility before refinement claim",
        signal,
      );
      if (!stillReady.some((candidate) => candidate.id === card.id)) {
        queue.retireOrphanedReadyEvent(mutation.eventId);
        mutationBlockStore.resolve(`orphan:${mutation.eventId}`);
        return;
      }
      const claimedCard = await trello.moveCard(
        card.id,
        project.trello.workingListId,
      );
      cardLog.event("Card claimed; transition to Working succeeded");
      try {
        await options.processRefinement(claimedCard ?? card, worktree);
      } catch (error) {
        if (error instanceof RefinementSetupFailedError) {
          try {
            const authority = ProjectRunAuthority.current(project.id);
            if (!authority)
              throw new Error("Refinement failure has no canonical authority", {
                cause: error,
              });
            await finalizeRefinementSetupFailure({
              authority,
              queue,
              queueEventId: mutation.eventId,
              trello,
              project,
              card: claimedCard ?? card,
              reason:
                "Repository setup failed after three bounded executions; setup effects and process evidence are preserved",
              signal,
            });
            return;
          } catch (finalizationError) {
            if (queue.ownsActive(mutation.eventId))
              queue.releaseForRecovery(mutation.eventId);
            throw finalizationError;
          }
        }
        if (error instanceof RefinementSetupAmbiguousError) {
          if (queue.ownsActive(mutation.eventId))
            queue.releaseForRecovery(mutation.eventId);
          return;
        }
        throw error;
      }
      await completeRefinementAuthority(
        ProjectRunAuthority.current(project.id),
        trello,
        project,
        card.id,
      );
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
      const stillReady = await getCardsForDiscovery(
        trello,
        project.id,
        project.trello.readyListId,
        "Could not verify Ready eligibility before implementation claim",
        signal,
      );
      if (!stillReady.some((candidate) => candidate.id === card.id)) {
        queue.retireOrphanedReadyEvent(mutation.eventId);
        mutationBlockStore.resolve(`orphan:${mutation.eventId}`);
        return;
      }
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
          attempts: 0,
          history: [],
        },
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const worktreePath = worktree.path;
    let recordBeforeSetup = taskStore.read(activeCard.id);
    if (project.repository.setupCommand !== undefined) {
      for (
        let retry = 0;
        retry < OPERATION_RECOVERY_MAX_EXECUTIONS &&
        recordBeforeSetup?.setup?.status === "pending";
        retry += 1
      ) {
        const attemptRecord = recordBeforeSetup;
        const before = taskStore.writePrimaryResultArtifact(
          `setup-before-${activeCard.id}-${recordBeforeSetup.revision}`,
          JSON.parse(
            (await captureSetupEffects(git, worktreePath, signal)).toString(
              "utf8",
            ),
          ) as unknown,
        );
        updateRecord(taskStore, attemptRecord, {
          setup: {
            command: project.repository.setupCommand,
            status: "active",
            worktreePath,
            // `before` is the immutable pre-first-attempt baseline used to
            // attribute the cumulative setup effects at publication. Keep a
            // distinct per-dispatch snapshot for recovery/history evidence.
            before: attemptRecord.setup?.before ?? before.reference,
            attemptBefore: before.reference,
            attempts: (attemptRecord.setup?.attempts ?? 0) + 1,
            history: attemptRecord.setup?.history ?? [],
          },
        });
        let setupResult:
          Awaited<ReturnType<typeof runRepositorySetup>> | undefined;
        let setupError: unknown;
        const setupArtifactDirectory = taskStore.processExecutionDirectory(
          activeCard.id,
        );
        try {
          setupResult = await runRepositorySetup(commands, {
            cwd: worktreePath,
            command: project.repository.setupCommand,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
            ...(setupArtifactDirectory === undefined
              ? {}
              : { artifactDirectory: setupArtifactDirectory }),
            sessionLogPath: getSessionLogPath(project.id, activeCard.id),
            sessionLabel: "Task-session repository setup",
            onExecutionStarted: (executionId) => {
              const runningRecord = taskStore.read(activeCard.id);
              if (
                runningRecord?.setup?.status !== "active" ||
                runningRecord.setup.executionId !== undefined
              )
                throw new Error(
                  "Setup execution binding conflicts with persisted intent",
                );
              updateRecord(taskStore, runningRecord, {
                setup: { ...runningRecord.setup, executionId },
              });
            },
          });
          if (setupResult.exitCode !== 0)
            setupError = new Error(
              `Task-session repository setup exited with code ${setupResult.exitCode}`,
            );
        } catch (error) {
          setupError = error;
        }
        const after = taskStore.writePrimaryResultArtifact(
          `setup-after-${activeCard.id}-${attemptRecord.revision}`,
          JSON.parse(
            (
              await captureSetupEffects(git, worktreePath, signal, true)
            ).toString("utf8"),
          ) as unknown,
        );
        const setupRecord = taskStore.read(activeCard.id);
        if (setupRecord !== null) {
          const setupState = setupRecord.setup;
          if (!setupState || setupState.status !== "active")
            throw new Error("Setup state changed while setup was running");
          const executionId =
            setupResult?.executionId ?? setupState.executionId;
          const processEvidence = executionId
            ? taskStore.readProcessExecution(activeCard.id, executionId)
            : null;
          const expectedExecution =
            executionId !== undefined && setupState.command !== null
              ? {
                  executionId,
                  command: setupState.command,
                  cwd: worktreePath,
                }
              : undefined;
          const successfulEvidence =
            expectedExecution !== undefined &&
            isVerifiedSuccessfulExecution(processEvidence, expectedExecution);
          const stopped =
            expectedExecution !== undefined &&
            isVerifiedStoppedExecution(processEvidence, expectedExecution);
          if (
            setupError === undefined &&
            (setupResult?.exitCode !== 0 || !successfulEvidence)
          )
            setupError = new Error(
              "Setup completion lacks authoritative successful process evidence",
            );
          const attempts = setupState.attempts ?? 1;
          const mayRetry =
            setupError !== undefined &&
            stopped &&
            attempts < OPERATION_RECOVERY_MAX_EXECUTIONS;
          const history = [
            ...(setupState.history ?? []),
            {
              command: setupState.command!,
              worktreePath,
              before: setupState.attemptBefore ?? setupState.before!,
              after: after.reference,
              ...(executionId === undefined ? {} : { executionId }),
              exitCode: setupResult?.exitCode ?? null,
              outcome:
                setupError === undefined && successfulEvidence
                  ? ("passed" as const)
                  : stopped
                    ? ("failed" as const)
                    : ("ambiguous" as const),
            },
          ];
          updateRecord(taskStore, setupRecord, {
            setup: {
              ...setupState,
              status:
                setupError === undefined && successfulEvidence
                  ? "passed"
                  : !stopped
                    ? "ambiguous"
                    : mayRetry
                      ? "pending"
                      : "failed",
              after: after.reference,
              history,
              ...(executionId === undefined ? {} : { executionId }),
              ...(setupResult === undefined
                ? {}
                : { exitCode: setupResult.exitCode }),
              ...(setupError === undefined
                ? {}
                : {
                    diagnostic:
                      setupError instanceof Error
                        ? setupError.message.slice(0, 2_000)
                        : String(setupError).slice(0, 2_000),
                  }),
            },
          });
        }
        recordBeforeSetup = taskStore.read(activeCard.id);
        if (
          signal.aborted &&
          (recordBeforeSetup?.setup?.status === "pending" ||
            recordBeforeSetup?.setup?.status === "ambiguous")
        )
          throw new TaskSessionImplementationWaitingError(
            "Setup was interrupted after its effects were recorded; resume from the persisted setup checkpoint",
          );
        if (
          setupError !== undefined &&
          recordBeforeSetup?.setup?.status !== "pending"
        )
          throw setupError;
      }
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
      if (
        planStore.read(activeCard.id) === null &&
        taskRecord.planningAdvice === undefined
      ) {
        cardLog.event("Planning started");
        try {
          await runTaskPlanningOperation({
            taskRecordStore: taskStore,
            planStore,
            openCode,
            projectId: project.id,
            card: activeCard,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            primaryOperation: {
              operationId: `${operationKey}:planning`,
              activity: "planning",
              trustedRoot:
                ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                getProcessRuntime().artifactRoot,
              cwd: worktreePath,
              inspectPending: (entry) =>
                inspectPrimaryOperationEvidence(
                  taskStore,
                  activeCard.id,
                  entry.id,
                  {
                    trustedRoot:
                      ProjectRunAuthority.current(project.id)?.store
                        .storageRoot ?? getProcessRuntime().artifactRoot,
                    cwd: worktreePath,
                  },
                ),
            },
            runOptions: {
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
              sessionLabel: "Task-session planning",
              sessionLogPath,
              ...(project.opencode.planning ?? {}),
              cwd: worktreePath,
            },
          });
        } catch (error) {
          const failedPlanningOperation =
            error instanceof PrimaryOperationWaitingError
              ? taskStore.read(activeCard.id)?.primaryOperations?.[
                  error.operationId
                ]
              : undefined;
          const exhaustedPlanningOutage =
            error instanceof PrimaryOperationWaitingError &&
            isPlanningOutageSafeToSkip(failedPlanningOperation);
          if (
            (error instanceof TaskPlanningOperationError &&
              error.advisoryFailure) ||
            error instanceof PrimaryOperationExhaustedError ||
            exhaustedPlanningOutage
          ) {
            const current = taskStore.read(activeCard.id);
            if (
              current === null ||
              current.operationKey !== operationKey ||
              current.phase !== "planning"
            )
              throw error;
            taskRecord = updateRecord(taskStore, current, {
              planningAdvice: {
                status:
                  !(error instanceof TaskPlanningOperationError) ||
                  error.runResult === undefined ||
                  error.runResult.exitCode !== 0
                    ? "unavailable"
                    : "invalid",
                diagnostic: error.message.slice(0, 2_000),
              },
            });
            cardLog.event(
              "Planning advice unavailable; continuing with task context",
            );
          } else if (!(error instanceof TaskClarificationRequiredError))
            throw error;
          if (error instanceof TaskClarificationRequiredError) {
            if (mutation === null || !queue.ownsActive(mutation.eventId))
              throw new Error(
                "Clarification result has no current task ownership",
                {
                  cause: error,
                },
              );
            const current = taskStore.read(activeCard.id);
            if (
              current === null ||
              current.operationKey !== operationKey ||
              current.phase !== "planning" ||
              current.pullRequest !== undefined ||
              current.externalRecovery !== undefined
            )
              throw new Error(
                "Clarification outcome does not match an unpublished owned planning task",
                { cause: error },
              );
            const observedPullRequest = await github.findPullRequestState({
              cwd: project.repository.path,
              repository: project.repository.github,
              headBranch: worktree.branch,
              baseBranch: project.repository.defaultBranch,
              project,
            });
            if (observedPullRequest !== null) {
              queue.releaseForRecovery(mutation.eventId);
              return;
            }
            const currentCard = await trello.getCard(activeCard.id);
            if (
              currentCard.id !== activeCard.id ||
              currentCard.idList !== project.trello.workingListId
            ) {
              queue.releaseForRecovery(mutation.eventId);
              return;
            }
            const clarification = error.clarification;
            const reason = `${clarification.reason}\n\nQuestions:\n${clarification.questions.map((question) => `- ${question}`).join("\n")}`;
            const artifact = taskStore.writePrimaryResultArtifact(
              `${activeCard.id}-clarification`,
              {
                version: 1,
                decision: clarification,
                task: {
                  projectId: project.id,
                  cardId: activeCard.id,
                  operationKey,
                  title: currentCard.name,
                  description: currentCard.desc,
                  listId: currentCard.idList,
                  labels: currentCard.idLabels,
                },
                attachmentContext:
                  attachmentContext === undefined
                    ? null
                    : {
                        projectId: attachmentContext.projectId,
                        cardId: attachmentContext.cardId,
                        manifest: attachmentContext.manifest,
                      },
              },
            );
            const terminal = transitionTaskExecutionRecord(current, {
              type: "attention-required",
              eventId: `${operationKey}:clarification-required`,
              projectId: project.id,
              cardId: activeCard.id,
              operationKey,
              occurredAt: timestamp(current),
            });
            taskStore.compareAndSwap(activeCard.id, current.revision, {
              ...terminal,
              terminalFailure: {
                kind: "clarification",
                reason: reason.slice(0, 4_000),
                clarificationArtifact: artifact.reference,
                outcome: "pending",
              },
            });
            cardLog.event("Essential task clarification durably recorded");
            // The existing terminal-failure reconciler performs the verified
            // Failed move and journaled comment on this or the next poll.
            if (mutation && queue.ownsActive(mutation.eventId))
              queue.releaseForRecovery(mutation.eventId);
            return;
          }
        }
        if (planStore.read(activeCard.id) !== null)
          cardLog.event("Planning completed");
      }
      const savedPlan = planStore.read(activeCard.id, undefined, operationKey);
      if (
        savedPlan !== null &&
        savedPlan.verification === undefined &&
        taskStore.read(activeCard.id)?.planReviewAdvice === undefined
      ) {
        cardLog.event("Independent plan verification started");
        try {
          const verification = await runPlanVerification({
            taskRecordStore: taskStore,
            planStore,
            openCode,
            projectId: project.id,
            card: activeCard,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            runOptions: {
              cwd: worktreePath,
              ...project.opencode.planReview,
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
              readOnly: true,
            },
          });
          const current = taskStore.read(activeCard.id);
          if (
            current !== null &&
            current.operationKey === operationKey &&
            current.phase === "planning"
          ) {
            updateRecord(taskStore, current, {
              planReviewAdvice: {
                status: "completed",
                diagnostic: `Plan review returned ${verification.verification.verdict}`,
                planRevision: savedPlan.planRevision,
                taskRecordRevision: savedPlan.taskRecordRevision,
                operationKey,
              },
            });
          }
          cardLog.event("Independent plan feedback recorded; continuing");
        } catch (error) {
          if (
            !(error instanceof PlanVerificationOperationError) ||
            !error.advisoryFailure
          )
            throw error;
          const current = taskStore.read(activeCard.id);
          if (
            current === null ||
            current.operationKey !== operationKey ||
            current.phase !== "planning"
          )
            throw error;
          updateRecord(taskStore, current, {
            planReviewAdvice: {
              status:
                error.runResult === undefined || error.runResult.exitCode !== 0
                  ? "unavailable"
                  : "invalid",
              diagnostic: error.message.slice(0, 2_000),
              planRevision: savedPlan.planRevision,
              taskRecordRevision: savedPlan.taskRecordRevision,
              operationKey,
            },
          });
          cardLog.event("Independent plan review unavailable; continuing");
        }
      }
      if (
        savedPlan?.verification !== undefined &&
        taskStore.read(activeCard.id)?.planReviewAdvice === undefined
      ) {
        const current = taskStore.read(activeCard.id);
        if (
          current === null ||
          current.operationKey !== operationKey ||
          current.phase !== "planning" ||
          (savedPlan.taskOperationKey === undefined &&
            savedPlan.taskRecordRevision !== current.revision)
        )
          throw new Error(
            "Persisted plan review cannot be associated safely with the current task operation",
          );
        updateRecord(taskStore, current, {
          planReviewAdvice: {
            status: "completed",
            diagnostic: `Persisted plan review returned ${savedPlan.verification.verdict}`,
            planRevision: savedPlan.planRevision,
            taskRecordRevision: savedPlan.taskRecordRevision,
            operationKey,
          },
        });
      }
    }
    taskRecord = taskStore.read(activeCard.id);
    if (taskRecord === null)
      throw new Error("Task record disappeared before implementation");
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

    // A review repair is a durable primary operation, not a request to restart
    // the task's initial implementation. Recover it before the generic
    // implementation or validation routes can dispatch another operation.
    if (
      (taskRecord.phase === "implementation" ||
        taskRecord.phase === "validation") &&
      taskRecord.reviewRepair?.activePrimaryOperation !== undefined
    ) {
      if (taskRecord.phase === "implementation") {
        taskRecord = taskStore.compareAndSwap(
          activeCard.id,
          taskRecord.revision,
          {
            ...transitionTaskExecutionRecord(
              taskRecord,
              event(taskRecord, "implementation-completed"),
            ),
          },
        );
      }
      const expectedSession = taskRecord.primarySessionId;
      if (expectedSession === undefined)
        throw new Error("Reserved review repair has no primary session");
      let recoveredQuality:
        | Awaited<ReturnType<typeof runTaskSessionValidationWithRepairs>>
        | undefined;
      let recoveredValidation: TaskSessionValidationResult | undefined;
      let recoveredCoverage: TaskSessionValidationResult | null = null;
      const runReservedReview = async (
        previousFindings: readonly NonNullable<
          NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
        >[number][] = taskStore.read(activeCard.id)?.reviewRepair?.findings ??
          [],
      ) => {
        if (recoveredValidation === undefined)
          throw new Error("Reserved review repair quality was not restored");
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
          validation: recoveredValidation,
          coverage: recoveredCoverage,
          previousFindings,
          ...(attachmentContext === undefined ? {} : { attachmentContext }),
          runOptions: {
            model: project.opencode.review.model,
            variant: project.opencode.review.variant,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
          },
        });
        return {
          review: result.review,
          contentIdentity: result.contentIdentity,
        };
      };
      const runReservedRepair = async (
        review: ImplementationReviewResult,
        attempt: number,
        operationId: string,
        persistedPrompt?: string,
      ) => {
        const current = taskStore.read(activeCard.id);
        if (current === null)
          throw new Error(
            "Task record disappeared during review repair recovery",
          );
        if (current.phase === "review") {
          const implementation = transitionTaskExecutionRecord(
            current,
            event(current, "review-failed"),
          );
          taskStore.compareAndSwap(
            activeCard.id,
            current.revision,
            implementation,
          );
        }
        const plan = planStore.read(activeCard.id);
        const prompt =
          persistedPrompt ??
          buildTaskSessionReviewRepairPrompt({
            projectId: project.id,
            card: activeCard,
            ...(plan === null ? {} : { approvedPlan: plan.plan }),
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
            ...project.opencode.remediation,
            timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
            signal,
            sessionLabel: "Task-session review remediation",
            sessionLogPath,
            cwd: worktreePath,
            prompt,
          },
          { inspect: inspectSessionForWorktree(worktreePath) },
          {
            role: "primary",
            operationId,
            activity: "review-correction",
            inspectPending: (entry) =>
              inspectPrimaryOperationEvidence(
                taskStore,
                activeCard.id,
                entry.id,
                {
                  trustedRoot:
                    ProjectRunAuthority.current(project.id)?.store
                      .storageRoot ?? getProcessRuntime().artifactRoot,
                  cwd: worktreePath,
                },
              ),
          },
        );
        if (repaired.exitCode !== 0)
          throw new Error(
            `Primary review repair exited with code ${repaired.exitCode}`,
          );
        const latest = taskStore.read(activeCard.id);
        if (latest === null)
          throw new Error(
            "Task record disappeared after review repair recovery",
          );
        if (latest.phase === "implementation") {
          const validation = transitionTaskExecutionRecord(
            latest,
            event(latest, "implementation-completed"),
          );
          taskStore.compareAndSwap(activeCard.id, latest.revision, validation);
        }
        return parsePrimaryReviewRepairOutcome(
          repaired.output,
          review.blockingFindings.flatMap(({ id }) =>
            id === undefined ? [] : [id],
          ),
          review.requirementAssessments
            .filter(({ status }) => status === "unsatisfied")
            .map(({ requirementId }) => requirementId),
        );
      };
      try {
        await runTaskSessionReviewWithRepairs({
          maxAttempts: project.opencode.remediation.maxPasses,
          store: taskStore,
          projectId: project.id,
          cardId: activeCard.id,
          operationKey,
          expectedPrimarySessionId: expectedSession,
          runReview: runReservedReview,
          repair: runReservedRepair,
          buildRepairPrompt: (review, attempt) => {
            const advisoryPlan = planStore.read(activeCard.id);
            return buildTaskSessionReviewRepairPrompt({
              projectId: project.id,
              card: activeCard,
              ...(advisoryPlan === null
                ? {}
                : { approvedPlan: advisoryPlan.plan }),
              review,
              attempt,
              maxAttempts: project.opencode.remediation.maxPasses,
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
            });
          },
          rerunQuality: async () => {
            recoveredQuality = await runTaskSessionValidationWithRepairs({
              validation: validationOptions,
              openCode,
              planStore,
              card: activeCard,
              expectedPrimarySessionId: expectedSession,
              inspectPrimarySession: inspectSessionForWorktree(worktreePath),
              primaryOperationEvidence: {
                trustedRoot:
                  ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                  getProcessRuntime().artifactRoot,
                cwd: worktreePath,
              },
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
              repairRunOptions: {
                model: project.opencode.remediation.model,
                variant: project.opencode.remediation.variant,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
              },
            });
            recoveredValidation = recoveredQuality.validation;
            recoveredCoverage = recoveredQuality.coverage;
          },
          getCurrentContentIdentity: () =>
            getTaskSessionSourceSnapshotIdentity(git, worktreePath),
        });
      } catch (error) {
        const primaryRecoveryError = findPrimaryRecoveryError(error);
        if (primaryRecoveryError !== undefined) throw primaryRecoveryError;
        if (error instanceof TaskSessionReviewUnavailableError) {
          if (signal.aborted) throw error;
          const current = taskStore.read(activeCard.id);
          if (current === null || current.phase !== "review") throw error;
          if (
            current.reviewRepair?.activePrimaryOperation !== undefined ||
            Object.values(current.primaryOperations ?? {}).some(
              (operation) =>
                operation !== undefined &&
                (["intent", "dispatched", "ambiguous"].includes(
                  operation.status,
                ) ||
                  (operation.status === "failed" &&
                    operation.retrySafe !== true)),
            )
          )
            throw new Error(
              "Cannot skip unavailable independent review while primary execution remains unresolved",
              { cause: error },
            );
          const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
            git,
            worktreePath,
          );
          if (
            current.validationRepair?.evidence?.contentIdentity !==
              contentIdentity ||
            (current.validationRepair?.coverageEvidence !== undefined &&
              current.validationRepair.coverageEvidence.contentIdentity !==
                contentIdentity)
          )
            throw new Error(
              "Cannot skip unavailable review after the source changed",
              { cause: error },
            );
          const unavailable = taskStore.compareAndSwap(
            activeCard.id,
            current.revision,
            transitionTaskExecutionRecord(
              {
                ...current,
                reviewRepair:
                  current.reviewRepair?.status === "active"
                    ? {
                        ...current.reviewRepair,
                        status: "stopped",
                        stopReason: "review-unavailable",
                        activePrimaryOperation: undefined,
                        finishAfterNextReview: undefined,
                        finalReview: undefined,
                      }
                    : current.reviewRepair,
                reviewUnavailable: {
                  contentIdentity,
                  diagnostic: error.message.slice(0, 500),
                  ...(current.reviewRepair?.finalReview?.verdict === "fail"
                    ? { priorReview: current.reviewRepair.finalReview }
                    : {}),
                },
                revision: current.revision,
                updatedAt: current.updatedAt,
              },
              event(current, "review-unavailable"),
            ),
          );
          taskRecord = unavailable;
        } else throw error;
      }
      taskRecord = taskStore.read(activeCard.id);
      if (taskRecord === null)
        throw new Error("Task record disappeared after review repair recovery");
    }
    if (
      taskRecord.phase === "planning" ||
      taskRecord.phase === "implementation"
    ) {
      cardLog.event("Implementation started");
      await runTaskSessionImplementation({
        taskRecordStore: taskStore,
        planStore,
        git,
        recoveryGit: git,
        commands,
        recoveryContextRoot: root,
        ...(ProjectRunAuthority.current(project.id) === undefined
          ? {}
          : {
              recoveryAttemptId: ProjectRunAuthority.current(project.id)!.store
                .attemptId,
            }),
        ...(feedbackLedgerStore.read(activeCard.id) === null
          ? {}
          : {
              feedbackContent: JSON.stringify(
                feedbackLedgerStore.read(activeCard.id),
              ),
            }),
        openCode,
        project,
        card: activeCard,
        expectedBranch: worktree.branch,
        operationKey,
        ...(options.retryIntervalMs === undefined
          ? {}
          : { retryIntervalMs: options.retryIntervalMs }),
        worktreePath,
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        resume: taskRecord.phase === "implementation",
        runOptions: commonRunOptions,
      });
      cardLog.event("Implementation completed");
    }
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
          inspectPrimarySession: inspectSessionForWorktree(worktreePath),
          primaryOperationEvidence: {
            trustedRoot:
              ProjectRunAuthority.current(project.id)?.store.storageRoot ??
              getProcessRuntime().artifactRoot,
            cwd: worktreePath,
          },
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
      phaseRecord.phase === "publication" &&
      phaseRecord.validationRepair?.status === "exhausted" &&
      phaseRecord.reviewRepair?.finalReview === undefined
    ) {
      // An interrupted validation-exhausted publication has no AI review.
      // Reuse unchanged final evidence; changed source/config gets fresh
      // quality observations without consuming further repair attempts.
      quality = await runTaskSessionValidationWithRepairs({
        validation: validationOptions,
        openCode,
        planStore,
        card: activeCard,
        expectedPrimarySessionId: phaseRecord.primarySessionId!,
        inspectPrimarySession: inspectSessionForWorktree(worktreePath),
        primaryOperationEvidence: {
          trustedRoot:
            ProjectRunAuthority.current(project.id)?.store.storageRoot ??
            getProcessRuntime().artifactRoot,
          cwd: worktreePath,
        },
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        repairRunOptions: {
          model: project.opencode.remediation.model,
          variant: project.opencode.remediation.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
        },
      });
    } else if (
      phaseRecord.phase === "review" ||
      phaseRecord.phase === "publication"
    ) {
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      const checkpoint = phaseRecord.publicationQuality;
      const trusted =
        phaseRecord.phase === "publication"
          ? readTrustedCommitState(project, activeCard.id)
          : null;
      const verifiedCheckpoint =
        checkpoint !== undefined &&
        trusted !== null &&
        (await git.getHeadSha(worktreePath)) === trusted.commitSha &&
        checkpoint.contentIdentity === currentIdentity &&
        (await git.getRebaseState(worktreePath)) === null &&
        (await git.getStatus(worktreePath)).trim().length === 0;
      const validationEvidence = verifiedCheckpoint
        ? checkpoint.validation
        : phaseRecord.validationRepair?.evidence;
      const coverageEvidence = verifiedCheckpoint
        ? checkpoint.coverageEvidence
        : phaseRecord.validationRepair?.coverageEvidence;
      const qualityExhausted =
        phaseRecord.validationRepair?.status === "exhausted";
      const trustedPreparedCheckpoint = verifiedCheckpoint;
      if (
        (phaseRecord.validationRepair?.status !== "passed" &&
          phaseRecord.validationRepair?.status !== "skipped" &&
          !qualityExhausted) ||
        validationEvidence === undefined ||
        (project.repository.validationCommand === undefined
          ? validationEvidence.status !== "skipped" &&
            !isLegacySuccessfulQualityEvidence(validationEvidence)
          : validationEvidence.command !== validationCommand ||
            (!qualityExhausted &&
              !trustedPreparedCheckpoint &&
              !qualityEvidenceWasSuccessful(validationEvidence))) ||
        (project.repository.coverageCommand === undefined
          ? coverageEvidence !== undefined &&
            coverageEvidence.status !== "skipped" &&
            !isLegacySuccessfulQualityEvidence(coverageEvidence)
          : coverageEvidence === undefined ||
            coverageEvidence.command !== project.repository.coverageCommand ||
            (!qualityExhausted &&
              !trustedPreparedCheckpoint &&
              !qualityEvidenceWasSuccessful(coverageEvidence)))
      ) {
        throw new Error(
          "Persisted review/publication phase has incomplete local quality evidence",
        );
      }
      const stale =
        currentIdentity !== validationEvidence.contentIdentity ||
        (coverageEvidence !== undefined &&
          currentIdentity !== coverageEvidence.contentIdentity);
      const trustedCommittedPublicationNeedsRefresh =
        stale &&
        phaseRecord.phase === "publication" &&
        trusted !== null &&
        (await git.getHeadSha(worktreePath)) === trusted.commitSha &&
        (await git.getRebaseState(worktreePath)) === null &&
        (await git.getStatus(worktreePath)).trim().length === 0;
      if (trustedCommittedPublicationNeedsRefresh) {
        // A verified clean trusted commit may have a new source snapshot after
        // base maintenance. Refresh local checks without changing their outcome
        // into a pass, then refresh the advisory review below.
        const freshValidation =
          await runTaskSessionValidation(validationOptions);
        const freshCoverage = await runTaskSessionCoverage(validationOptions);
        const afterChecksIdentity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktreePath,
        );
        if (afterChecksIdentity !== currentIdentity)
          throw new Error(
            "Prepared publication source changed while refreshing local checks",
          );
        const updated = taskStore.read(activeCard.id);
        if (updated === null)
          throw new Error("Task record disappeared during legacy recovery");
        const refreshed = updateRecord(taskStore, updated, {
          publicationQuality: {
            contentIdentity: currentIdentity,
            validation: toPersistedQualityEvidence(freshValidation),
            coverageEvidence: toPersistedQualityEvidence(freshCoverage),
            review: null,
          },
        });
        quality = {
          validation: freshValidation,
          coverage: freshCoverage,
          attempts: refreshed.retryCounters.validation,
          record: refreshed,
        };
      } else {
        if (stale)
          throw new Error(
            "Persisted local quality evidence is stale after task-session restart",
          );
        const validation =
          restorePersistedTaskSessionQualityEvidence(validationEvidence);
        const coverage =
          coverageEvidence === undefined
            ? await runTaskSessionCoverage(validationOptions)
            : restorePersistedTaskSessionQualityEvidence(coverageEvidence);
        quality = {
          validation,
          coverage,
          attempts: phaseRecord.retryCounters.validation,
          record: phaseRecord,
        };
      }
    } else {
      throw new Error(
        `Cannot resume local task-session work from phase ${phaseRecord.phase}`,
      );
    }
    const publicationMutationEventId = mutation.eventId;
    const publishWithoutReview = async (
      reason: "validation-exhausted" | "review-unavailable",
      unavailableDiagnostic = "",
    ): Promise<void> => {
      // Quality exhaustion is not a successful AI review. Publish its actual
      // failed diagnostics directly, rather than inventing a review verdict.
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      const failedEvidence: VerifiedPublicationDecisionInput = {
        currentContentIdentity: currentIdentity,
        validationCommand,
        validation: quality.validation,
        ...(project.repository.coverageCommand === undefined
          ? {}
          : { coverageCommand: project.repository.coverageCommand }),
        coverage: quality.coverage,
        review: null,
      };
      let beforePublication = taskStore.read(activeCard.id);
      if (beforePublication === null)
        throw new Error("Task record missing before no-review publication");
      const retainedPriorReview =
        beforePublication.reviewRepair?.finalReview?.verdict === "fail"
          ? beforePublication.reviewRepair.finalReview
          : beforePublication.reviewUnavailable?.priorReview;
      const stopReviewRepairForAdvisoryOutcome =
        beforePublication.reviewRepair !== undefined &&
        (beforePublication.reviewRepair.status === "active" ||
          (reason === "review-unavailable" &&
            (beforePublication.reviewRepair.status !== "stopped" ||
              beforePublication.reviewRepair.finalReview !== undefined)));
      if (stopReviewRepairForAdvisoryOutcome) {
        if (
          beforePublication.reviewRepair?.activePrimaryOperation !== undefined
        )
          throw new Error(
            "Cannot hand off validation exhaustion while a review-repair writer is reserved",
          );
        const unresolvedWriter = Object.values(
          beforePublication.primaryOperations ?? {},
        ).find(
          (operation) =>
            operation !== undefined &&
            (["intent", "dispatched", "ambiguous"].includes(operation.status) ||
              (operation.status === "failed" && operation.retrySafe !== true)),
        );
        if (unresolvedWriter !== undefined)
          throw new Error(
            `Cannot hand off validation exhaustion while primary operation ${unresolvedWriter.id} is unresolved`,
          );
      }
      const reviewUnavailableMarker =
        reason === "review-unavailable"
          ? {
              contentIdentity: failedEvidence.currentContentIdentity,
              diagnostic: unavailableDiagnostic,
              ...(retainedPriorReview === undefined
                ? {}
                : { priorReview: retainedPriorReview }),
            }
          : undefined;
      const handoffRecord = {
        ...beforePublication,
        ...(stopReviewRepairForAdvisoryOutcome
          ? {
              reviewRepair: {
                ...beforePublication.reviewRepair!,
                status: "stopped" as const,
                stopReason: reason,
                activePrimaryOperation: undefined,
                finishAfterNextReview: undefined,
                finalReview: undefined,
              },
            }
          : {}),
        ...(reviewUnavailableMarker === undefined
          ? {}
          : { reviewUnavailable: reviewUnavailableMarker }),
      };
      if (beforePublication.phase !== "publication") {
        const publication = transitionTaskExecutionRecord(
          handoffRecord,
          event(
            handoffRecord,
            reason === "review-unavailable"
              ? "review-unavailable"
              : "validation-exhausted",
          ),
        );
        beforePublication = taskStore.compareAndSwap(
          activeCard.id,
          beforePublication.revision,
          publication,
        );
      } else if (
        stopReviewRepairForAdvisoryOutcome ||
        (reviewUnavailableMarker !== undefined &&
          JSON.stringify(beforePublication.reviewUnavailable) !==
            JSON.stringify(reviewUnavailableMarker))
      ) {
        beforePublication = taskStore.compareAndSwap(
          activeCard.id,
          beforePublication.revision,
          {
            ...handoffRecord,
            revision: beforePublication.revision + 1,
            updatedAt: timestamp(beforePublication),
          },
        );
      }
      const retainedReview = beforePublication.reviewUnavailable?.priorReview;
      const retainedReviewFacts: string[] = [];
      if (
        reason === "review-unavailable" &&
        retainedReview?.verdict === "fail"
      ) {
        const reviewedIdentity = retainedReview.reviewedContentIdentity;
        retainedReviewFacts.push(
          `A prior independent review returned a negative result for source ${reviewedIdentity}; the follow-up review for current source ${failedEvidence.currentContentIdentity} was unavailable (${unavailableDiagnostic}). The following concerns and dispositions refer only to the prior source snapshot and are not a current review result.`,
        );
        const trackedFindings = new Map(
          (beforePublication.reviewRepair?.findings ?? []).map((finding) => [
            finding.id,
            finding,
          ]),
        );
        for (const finding of retainedReview.blockingFindings.slice(0, 20)) {
          const id = finding.id ?? "unassigned finding";
          retainedReviewFacts.push(
            `Prior review concern ${id} (${finding.kind}): ${finding.summary}. ${finding.detail}`,
          );
          const disposition = trackedFindings.get(id)?.primaryDisposition;
          if (disposition?.reviewedContentIdentity === reviewedIdentity)
            retainedReviewFacts.push(
              `Primary-session disposition for prior concern ${id} on source ${reviewedIdentity}: ${disposition.status}; ${disposition.rationale}`,
            );
          else
            retainedReviewFacts.push(
              `No matching primary-session disposition is recorded for prior concern ${id} on source ${reviewedIdentity}.`,
            );
        }
        const requirementDispositions = new Map(
          (beforePublication.reviewRepair?.requirementDispositions ?? []).map(
            (disposition) => [disposition.requirementId, disposition],
          ),
        );
        for (const assessment of retainedReview.requirementAssessments
          .filter(({ status }) => status === "unsatisfied")
          .slice(0, 20)) {
          retainedReviewFacts.push(
            `Prior review assessed requirement ${assessment.requirementId} as unsatisfied: ${assessment.details}. Evidence: ${assessment.evidence.join(", ") || "none reported"}.`,
          );
          const disposition = requirementDispositions.get(
            assessment.requirementId,
          );
          if (disposition?.reviewedContentIdentity === reviewedIdentity)
            retainedReviewFacts.push(
              `Primary-session disposition for requirement ${assessment.requirementId} on prior source ${reviewedIdentity}: ${disposition.status}; ${disposition.rationale}`,
            );
          else
            retainedReviewFacts.push(
              `No matching primary-session disposition is recorded for requirement ${assessment.requirementId} on prior source ${reviewedIdentity}.`,
            );
        }
      }
      const safeRetainedReviewFacts = retainedReviewFacts.map((fact) =>
        sanitizeControlledText(fact.replace(/[\r\n]+/gu, " ").slice(0, 2_000)),
      );
      const retainedReviewDisclosure = safeRetainedReviewFacts.join(" | ");
      const boundedRetainedReviewDisclosure =
        retainedReviewDisclosure.length > 6_000
          ? `${retainedReviewDisclosure.slice(0, 6_000)}; further prior concerns remain in preserved task state`
          : retainedReviewDisclosure;
      let preparedEvidence = failedEvidence;
      const publishOptions = {
        trello,
        git,
        github,
        opencode: openCode,
        commands,
        project,
        card: activeCard,
        worktreePath,
        branch: worktree.branch,
        reviewResult:
          reason === "review-unavailable"
            ? `Unavailable (AI review execution failed)${boundedRetainedReviewDisclosure.length === 0 ? "" : `; prior source-bound review concerns: ${boundedRetainedReviewDisclosure}`}`
            : "Not run (local validation exhausted)",
        remediationResult:
          reason === "review-unavailable"
            ? "Not completed: AI review unavailable"
            : `${quality.attempts} validation repair(s); local quality failed`,
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        claimHumanReviewNotification: (commitSha: string) =>
          taskStore.claimHumanReviewNotification(activeCard.id, commitSha),
        verifiedDescriptionFacts: () => [
          `Approved implementation plan: ${JSON.stringify(planStore.read(activeCard.id)?.plan ?? "unavailable")}`,
          `Validation result: ${JSON.stringify(preparedEvidence.validation)}`,
          `Coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
          reason === "review-unavailable"
            ? `AI implementation review unavailable: ${unavailableDiagnostic}`
            : "AI implementation review: not run because validation was exhausted",
          ...safeRetainedReviewFacts,
        ],
        signal,
        beforePushVerification: async () => {
          const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
            git,
            worktreePath,
          );
          const finalEvidenceMatchesCurrent =
            currentIdentity === failedEvidence.currentContentIdentity &&
            failedEvidence.validation !== null &&
            failedEvidence.validation.command === validationCommand &&
            failedEvidence.coverage !== null &&
            failedEvidence.coverage.command ===
              (project.repository.coverageCommand ?? "");
          if (finalEvidenceMatchesCurrent) {
            preparedEvidence = failedEvidence;
          } else {
            const validation =
              await runTaskSessionValidation(validationOptions);
            const coverage = await runTaskSessionCoverage(validationOptions);
            preparedEvidence = {
              ...failedEvidence,
              currentContentIdentity:
                await getTaskSessionSourceSnapshotIdentity(git, worktreePath),
              validation,
              coverage,
            };
          }
          const decision = decideHumanReviewPublication(
            preparedEvidence,
            undefined,
          );
          if (!decision.allowed)
            throw new Error(
              `Prepared unreviewed publication is unsafe: ${decision.reasons.join("; ")}`,
            );
        },
      };
      const trusted = readTrustedCommitState(project, activeCard.id);
      if (beforePublication.phase === "publication" && trusted === null) {
        const freshHead = await git.getHeadSha(worktreePath);
        const remoteTaskBranch = await git.getRemoteBranchSha(
          project.repository.path,
          "origin",
          worktree.branch,
          project,
        );
        const existingPr = await github.findPullRequestState({
          cwd: project.repository.path,
          repository: project.repository.github,
          headBranch: worktree.branch,
          baseBranch: project.repository.defaultBranch,
          project,
        });
        if (
          remoteTaskBranch !== null ||
          existingPr !== null ||
          (await git.getCommitCountBetween(
            worktreePath,
            `origin/${project.repository.defaultBranch}`,
            freshHead,
          )) !== 0 ||
          (await git.getStatus(worktreePath)).trim().length === 0
        )
          throw new Error(
            "Interrupted unreviewed publication has ambiguous untrusted Git state",
          );
      }
      if (
        trusted !== null &&
        ((await git.getHeadSha(worktreePath)) !== trusted.commitSha ||
          (await git.getStatus(worktreePath)).trim().length > 0)
      )
        throw new Error(
          "Interrupted unreviewed publication does not match trusted clean commit",
        );
      let publishedSha: string;
      if (trusted !== null) {
        await publishCard({
          ...publishOptions,
          commitSha: trusted.commitSha,
          ...(recoveryRecord?.pullRequest?.url === undefined
            ? {}
            : {
                expectedExistingPullRequestUrl: recoveryRecord.pullRequest.url,
              }),
          ...correctionPublicationLocation(recoveryRecord),
        });
        publishedSha = await git.getHeadSha(worktreePath);
      } else {
        publishedSha = await publishTaskSessionCard({
          ...publishOptions,
          commitMessage: `chore(task): implement Trello card ${activeCard.id}`,
          initialEvidence: failedEvidence,
          verifyPreparedContent: async () => {
            await publishOptions.beforePushVerification();
            return preparedEvidence;
          },
        });
      }
      const pr = await github.findPullRequestState({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: worktree.branch,
        baseBranch: project.repository.defaultBranch,
        project,
      });
      if (pr === null || pr.state !== "OPEN" || pr.headRefOid !== publishedSha)
        throw new Error(
          "Exhausted-validation publication could not verify the PR head",
        );
      const prNumber = Number(new URL(pr.url).pathname.split("/").at(-1));
      if (!Number.isSafeInteger(prNumber) || prNumber < 1)
        throw new Error("Published PR URL contains an invalid number");
      const current = taskStore.read(activeCard.id);
      if (current === null)
        throw new Error("Task record disappeared after publication");
      const ci = transitionTaskExecutionRecord(current, {
        type: "publication-completed",
        eventId: `${operationKey}:publication-completed`,
        projectId: project.id,
        cardId: activeCard.id,
        operationKey,
        occurredAt: timestamp(current),
        pullRequest: { number: prNumber, url: pr.url, headSha: publishedSha },
      });
      taskStore.compareAndSwap(activeCard.id, current.revision, ci);
      cardLog.event(`Unreviewed PR published for human review: ${pr.url}`);
      queue.complete(publicationMutationEventId);
      mutation = null;
      return;
    };
    if (
      phaseRecord.phase === "publication" &&
      phaseRecord.reviewUnavailable !== undefined
    ) {
      await publishWithoutReview(
        phaseRecord.reviewUnavailable === undefined
          ? "validation-exhausted"
          : "review-unavailable",
        phaseRecord.reviewUnavailable?.diagnostic,
      );
      return;
    }
    let currentValidation = quality.validation;
    let currentCoverage = quality.coverage;
    const expectedSession = taskStore.read(activeCard.id)!.primarySessionId!;
    const runReview = async (
      previousFindings: readonly NonNullable<
        NonNullable<TaskExecutionRecord["reviewRepair"]>["findings"]
      >[number][] = taskStore.read(activeCard.id)?.reviewRepair?.cycleId ===
      operationKey
        ? (taskStore.read(activeCard.id)?.reviewRepair?.findings ?? [])
        : [],
    ) => {
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
        previousFindings,
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
      return {
        review: result.review,
        contentIdentity: result.contentIdentity,
        previousFindings: result.previousFindings,
      };
    };
    const runQualityAgain = async () => {
      quality = await runTaskSessionValidationWithRepairs({
        validation: validationOptions,
        openCode,
        planStore,
        card: activeCard,
        expectedPrimarySessionId: expectedSession,
        inspectPrimarySession: inspectSessionForWorktree(worktreePath),
        primaryOperationEvidence: {
          trustedRoot:
            ProjectRunAuthority.current(project.id)?.store.storageRoot ??
            getProcessRuntime().artifactRoot,
          cwd: worktreePath,
        },
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
      let review: Omit<
        Awaited<ReturnType<typeof runReview>>,
        "previousFindings"
      > & {
        previousFindings?: Awaited<
          ReturnType<typeof runReview>
        >["previousFindings"];
      };
      const identity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      const publicationReviewCheckpoint = current.publicationQuality;
      const reviewRequirementIds =
        planStore.read(activeCard.id)?.plan.requirements.map(({ id }) => id) ??
        [];
      const priorFindings = current.reviewRepair?.findings ?? [];
      const parsePersistedReview = (
        value: unknown,
        previousFindingIds: readonly string[],
        originalPreviousFindings?: readonly {
          id: string;
          sourceContentIdentity?: string | undefined;
          sourceIdentities: readonly string[];
          status: "unresolved" | "resolved" | "superseded";
        }[],
      ) => {
        return parseCachedImplementationReviewResult(value, {
          projectId: project.id,
          cardId: activeCard.id,
          requirementIds: reviewRequirementIds,
          contentIdentity: identity,
          previousFindingIds,
          ...(originalPreviousFindings === undefined
            ? {}
            : {
                previousFindings: originalPreviousFindings.map(
                  ({
                    id,
                    sourceContentIdentity,
                    sourceIdentities,
                    status,
                  }) => ({
                    id,
                    ...(sourceContentIdentity === undefined
                      ? {}
                      : { sourceContentIdentity }),
                    sourceIdentities,
                    status,
                  }),
                ),
              }),
        });
      };
      if (
        publicationReviewCheckpoint?.contentIdentity === identity &&
        publicationReviewCheckpoint.review !== null &&
        publicationReviewCheckpoint.review !== undefined
      ) {
        const originalPreviousFindings =
          publicationReviewCheckpoint.reviewPreviousFindings?.map(
            ({ id, sourceContentIdentity, sourceIdentities, status }) => ({
              id,
              ...(sourceContentIdentity === undefined
                ? {}
                : { sourceContentIdentity }),
              sourceIdentities,
              status,
            }),
          );
        const previousFindingIds =
          publicationReviewCheckpoint.reviewPreviousFindingIds ??
          originalPreviousFindings?.map(({ id }) => id) ??
          previousFindingIdsFromReview(publicationReviewCheckpoint.review);
        review = {
          review: parsePersistedReview(
            publicationReviewCheckpoint.review,
            previousFindingIds,
            originalPreviousFindings,
          ),
          contentIdentity: identity,
          ...(originalPreviousFindings === undefined
            ? {}
            : { previousFindings: originalPreviousFindings }),
        };
      } else if (
        persistedReview !== undefined &&
        persistedReview.reviewedContentIdentity === identity
      ) {
        review = {
          review: persistedReview,
          contentIdentity: identity,
        };
      } else {
        try {
          // A changed publication snapshot receives a fresh read-only review
          // even after the primary correction budget is exhausted. The result
          // informs disclosure only; it does not authorize or block PR delivery.
          review = await runReview(priorFindings);
        } catch (error) {
          if (!(error instanceof TaskSessionReviewUnavailableError))
            throw error;
          if (signal.aborted) throw error;
          const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
            git,
            worktreePath,
          );
          if (currentIdentity !== identity)
            throw new Error(
              "Publication review became unavailable after the source changed",
              { cause: error },
            );
          await publishWithoutReview("review-unavailable", error.message);
          return;
        }
      }
      current = taskStore.read(activeCard.id);
      if (current === null)
        throw new Error(
          "Task record disappeared while persisting publication review evidence",
        );
      current = updateRecord(taskStore, current, {
        publicationQuality: {
          contentIdentity: identity,
          validation: toPersistedQualityEvidence(quality.validation),
          coverageEvidence: toPersistedQualityEvidence(quality.coverage),
          review: review.review,
          reviewPreviousFindingIds:
            review.previousFindings?.map(({ id }) => id) ??
            publicationReviewCheckpoint?.reviewPreviousFindingIds ??
            review.review.previousFindingAssessments?.map(
              ({ findingId }) => findingId,
            ) ??
            [],
          ...(review.previousFindings === undefined
            ? {}
            : {
                reviewPreviousFindings: review.previousFindings.map(
                  ({
                    id,
                    sourceContentIdentity,
                    sourceIdentities,
                    status,
                  }) => ({
                    id,
                    ...(sourceContentIdentity === undefined
                      ? {}
                      : { sourceContentIdentity }),
                    sourceIdentities: [...sourceIdentities],
                    status,
                  }),
                ),
              }),
        },
      });
      finalReview = {
        ...review,
        attempts: current.retryCounters.review,
        record: current,
      };
    } else {
      try {
        finalReview = await runTaskSessionReviewWithRepairs({
          maxAttempts: project.opencode.remediation.maxPasses,
          store: taskStore,
          projectId: project.id,
          cardId: activeCard.id,
          operationKey,
          expectedPrimarySessionId: expectedSession,
          runReview,
          buildRepairPrompt: (review, attempt) => {
            const advisoryPlan = planStore.read(activeCard.id);
            return buildTaskSessionReviewRepairPrompt({
              projectId: project.id,
              card: activeCard,
              ...(advisoryPlan === null
                ? {}
                : { approvedPlan: advisoryPlan.plan }),
              review,
              attempt,
              maxAttempts: project.opencode.remediation.maxPasses,
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
            });
          },
          repair: async (review, attempt, operationId, persistedPrompt) => {
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
            const prompt =
              persistedPrompt ??
              buildTaskSessionReviewRepairPrompt({
                projectId: project.id,
                card: activeCard,
                ...(plan === null ? {} : { approvedPlan: plan.plan }),
                review,
                attempt,
                maxAttempts: project.opencode.remediation.maxPasses,
                ...(attachmentContext === undefined
                  ? {}
                  : { attachmentContext }),
              });
            const repaired = await runWithPrimaryTaskSession(
              taskStore,
              openCode,
              project.id,
              activeCard.id,
              {
                ...project.opencode.remediation,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
                sessionLabel: "Task-session review remediation",
                sessionLogPath,
                cwd: worktreePath,
                prompt,
              },
              { inspect: inspectSessionForWorktree(worktreePath) },
              {
                role: "primary",
                operationId,
                activity: "review-correction",
                inspectPending: (entry) =>
                  inspectPrimaryOperationEvidence(
                    taskStore,
                    activeCard.id,
                    entry.id,
                    {
                      trustedRoot:
                        ProjectRunAuthority.current(project.id)?.store
                          .storageRoot ?? getProcessRuntime().artifactRoot,
                      cwd: worktreePath,
                    },
                  ),
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
            taskStore.compareAndSwap(
              activeCard.id,
              current.revision,
              implemented,
            );
            return parsePrimaryReviewRepairOutcome(
              repaired.output,
              review.blockingFindings.flatMap(({ id }) =>
                id === undefined ? [] : [id],
              ),
              review.requirementAssessments
                .filter(({ status }) => status === "unsatisfied")
                .map(({ requirementId }) => requirementId),
            );
          },
          rerunQuality: runQualityAgain,
          getCurrentContentIdentity: () =>
            getTaskSessionSourceSnapshotIdentity(git, worktreePath),
        });
      } catch (error) {
        const primaryRecoveryError = findPrimaryRecoveryError(error);
        if (primaryRecoveryError !== undefined) throw primaryRecoveryError;
        if (error instanceof TaskSessionReviewRepairError) {
          const failure = error.sourceIdentity;
          const current = taskStore.read(activeCard.id);
          const identity = await getTaskSessionSourceSnapshotIdentity(
            git,
            worktreePath,
          );
          if (
            signal.aborted ||
            current === null ||
            current.phase !== "implementation" ||
            current.reviewRemediationFailure?.unchanged !== true ||
            current.reviewRemediationFailure.after !== identity ||
            failure?.unchanged !== true ||
            failure.after !== identity ||
            identity !== currentValidation.contentIdentity ||
            (currentCoverage !== null &&
              identity !== currentCoverage.contentIdentity) ||
            (await git.getCurrentBranch(worktreePath)) !== worktree.branch ||
            (await git.getRebaseState(worktreePath)) !== null ||
            (await git.getCommitCountBetween(
              worktreePath,
              `origin/${project.repository.defaultBranch}`,
              await git.getHeadSha(worktreePath),
            )) !== 0 ||
            (await git.getStatus(worktreePath)).trim().length === 0 ||
            (await git.getRemoteBranchSha(
              project.repository.path,
              "origin",
              worktree.branch,
              project,
            )) !== null ||
            (await github.findPullRequestState({
              cwd: project.repository.path,
              repository: project.repository.github,
              headBranch: worktree.branch,
              baseBranch: project.repository.defaultBranch,
              project,
            })) !== null
          )
            throw error;
          let handoff = current;
          for (const [phase, type] of [
            ["implementation", "implementation-completed"],
            ["validation", "validation-passed"],
            ["review", "review-unavailable"],
          ] as const) {
            if (handoff.phase === phase) {
              handoff = taskStore.compareAndSwap(
                activeCard.id,
                handoff.revision,
                transitionTaskExecutionRecord(handoff, event(handoff, type)),
              );
            }
          }
          updateRecord(taskStore, handoff, {
            reviewUnavailable: {
              contentIdentity: identity,
              diagnostic:
                "Review remediation failed; unchanged implementation requires human review",
            },
            reviewRemediationFailure: undefined,
          });
          await publishWithoutReview(
            "review-unavailable",
            "Review remediation failed; unchanged implementation requires human review",
          );
          return;
        }
        if (!(error instanceof TaskSessionReviewUnavailableError)) throw error;
        if (signal.aborted) throw error;
        const identity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktreePath,
        );
        if (
          identity !== currentValidation.contentIdentity ||
          (currentCoverage !== null &&
            identity !== currentCoverage.contentIdentity)
        )
          throw new Error(
            "Refusing unavailable-review publication after source change",
            { cause: error },
          );
        await publishWithoutReview(
          "review-unavailable",
          error.message.slice(0, 500),
        );
        return;
      }
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
    const hasUndisposedReviewConcern = hasUndisposedReviewConcerns(
      finalReview.review,
      finalReview.record.reviewRepair?.findings ?? [],
      finalReview.record.reviewRepair?.requirementDispositions ?? [],
    );
    let exhaustedReview =
      finalReview.review.verdict === "fail" && hasUndisposedReviewConcern
        ? finalReview.review
        : undefined;
    let reviewResult =
      finalReview.review.verdict === "pass"
        ? "Passed"
        : !hasUndisposedReviewConcern
          ? reviewConcernsDismissedAsNonMaterialLabel
          : "Failed (human review required; material findings unresolved)";
    let preparedReviewPublication: PreparedReviewPublication = {
      reviewResult,
      reviewDisclosure: exhaustedReview ?? null,
      qualityNeedsDraft:
        initialEvidence.validation?.status !== "passed" ||
        initialEvidence.coverage?.status !== "passed",
    };
    const trustedCheckpoint = readTrustedCommitState(project, activeCard.id);
    const allowRecoveredExhaustedReview =
      phaseRecord.phase === "publication" &&
      exhaustedReview !== undefined &&
      finalReview.record.publicationQuality?.contentIdentity ===
        initialEvidence.currentContentIdentity &&
      JSON.stringify(finalReview.record.publicationQuality.review) ===
        JSON.stringify(exhaustedReview) &&
      trustedCheckpoint !== null &&
      (await git.getHeadSha(worktreePath)) === trustedCheckpoint.commitSha &&
      (await git.getStatus(worktreePath)).trim().length === 0;
    if (
      !decideHumanReviewPublication(initialEvidence, exhaustedReview, {
        allowStaleExhaustedReview: allowRecoveredExhaustedReview,
      }).allowed
    )
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
    let setupDisposition: PersistedSetupDisposition | undefined;
    if (recoveredTrustedCommit === null) {
      const commitOptions = commitMessageRunOptions(
        project,
        signal,
        getSessionLogPath(project.id, activeCard.id),
      );
      const snapshotBefore = await captureRepositorySnapshot(git, worktreePath);
      const setupCheckpoint = taskStore.read(activeCard.id)?.setup;
      if (setupCheckpoint?.command !== null && setupCheckpoint !== undefined) {
        if (
          setupCheckpoint.status !== "passed" ||
          setupCheckpoint.before === undefined ||
          setupCheckpoint.after === undefined
        )
          throw new Error(
            "Setup attribution is unavailable or uncertain; initial publication blocked",
          );
        const beforeInventory = taskStore.readPrimaryResultArtifact(
          setupCheckpoint.before,
        );
        const afterInventory = taskStore.readPrimaryResultArtifact(
          setupCheckpoint.after,
        );
        assertSetupInventoryIdentity(
          beforeInventory,
          worktreePath,
          worktree.branch,
        );
        assertSetupInventoryIdentity(
          afterInventory,
          worktreePath,
          worktree.branch,
        );
        const currentInventory = JSON.parse(
          (await captureSetupEffects(git, worktreePath, signal)).toString(
            "utf8",
          ),
        ) as unknown;
        assertSetupInventoryIdentity(
          currentInventory,
          worktreePath,
          worktree.branch,
        );
        const { candidates, contextDigest } = getSetupTrackedDelta(
          beforeInventory,
          afterInventory,
          currentInventory,
        );
        let relevanceVerdict: unknown = {
          version: 1,
          contextDigest,
          changes: [],
        };
        if (candidates.length > 0) {
          const judgment = await openCode.run({
            ...commitOptions,
            cwd: worktreePath,
            prompt: buildSetupRelevancePrompt(
              activeCard.name,
              beforeInventory,
              afterInventory,
              currentInventory,
            ),
            readOnly: true,
            sessionLabel: "Setup change relevance judgment",
          });
          if (judgment.exitCode !== 0)
            throw new Error(
              `Setup relevance judgment failed with exit code ${judgment.exitCode}; initial publication blocked`,
            );
          relevanceVerdict = JSON.parse(judgment.output.trim()) as unknown;
        }
        const resolvedScope = resolveSetupCommitScope(
          beforeInventory as Parameters<typeof resolveSetupCommitScope>[0],
          afterInventory as Parameters<typeof resolveSetupCommitScope>[1],
          currentInventory as Parameters<typeof resolveSetupCommitScope>[2],
          relevanceVerdict,
        );
        const afterJudgmentSnapshot = await captureRepositorySnapshot(
          git,
          worktreePath,
        );
        if (!repositorySnapshotsEqual(snapshotBefore, afterJudgmentSnapshot))
          throw new Error(
            "Setup relevance judgment modified repository content; initial publication blocked",
          );
        const persistedJudgment = taskStore.writePrimaryResultArtifact(
          `setup-relevance-${activeCard.id}-${taskStore.read(activeCard.id)?.revision ?? 0}`,
          {
            version: 1,
            before: setupCheckpoint.before,
            after: setupCheckpoint.after,
            current: currentInventory,
            verdict: relevanceVerdict,
            scope: resolvedScope,
          },
        );
        const judgmentRecord = taskStore.read(activeCard.id);
        if (!judgmentRecord?.setup)
          throw new Error(
            "Setup attribution state disappeared before publication",
          );
        updateRecord(taskStore, judgmentRecord, {
          setup: {
            ...judgmentRecord.setup,
            relevance: persistedJudgment.reference,
          },
        });
        setupDisposition = {
          version: 1,
          artifactReference: persistedJudgment.reference,
          contextDigest: resolvedScope.contextDigest,
          exclude: resolvedScope.exclude,
        };
      }
      // AI commit-message generation is optional presentation metadata. Never
      // let it strand a usable implementation, but retain the repository
      // snapshot safety check below even when generation fails.
      const fallbackCommitMessage = `chore(task): implement Trello card ${activeCard.id}`;
      try {
        commitMessage = await runTaskSessionCommitMessage({
          project,
          card: activeCard,
          operationKey,
          commitIntentId: "initial-publication",
          operationId: `${operationKey}:commit-message`,
          worktreePath,
          taskRecordStore: taskStore,
          git,
          openCode,
          runOptions: commitOptions,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          !(error instanceof CommitMessageAdviceUnavailableError) ||
          findPrimaryRecoveryError(error) !== undefined ||
          error instanceof CommitMessageRecoveryBlockedError
        )
          throw error;
        cardLog.warn(
          `Commit message generation failed (${error instanceof Error ? error.name : "unknown failure"}); diagnostics are available in session log ${getSessionLogPath(project.id, activeCard.id)}. Using deterministic fallback.`,
        );
        commitMessage = fallbackCommitMessage;
      }
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
      const freshIdentity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      const preparedQualityPassed =
        (freshValidation.status === "passed" ||
          freshValidation.status === "skipped") &&
        (freshCoverage.status === "passed" ||
          freshCoverage.status === "skipped");
      if (
        !preparedQualityPassed &&
        freshIdentity === preparedEvidence.currentContentIdentity &&
        finalReview.record.reviewRepair?.status !== "exhausted" &&
        finalReview.record.validationRepair?.status !== "exhausted"
      )
        throw new Error("Prepared publication quality checks failed");
      let current = taskStore.read(activeCard.id);
      if (current === null)
        throw new Error(
          "Task record disappeared during publication preparation",
        );
      if (preparedQualityPassed)
        current = persistQualityEvidence(
          taskStore,
          current,
          operationKey,
          freshValidation,
          freshCoverage,
        );
      currentValidation = freshValidation;
      currentCoverage = freshCoverage;
      const priorFindings = current.reviewRepair?.findings ?? [];
      const parseCurrentReview = (
        value: unknown,
        previousFindingIds: readonly string[],
        originalPreviousFindings?: NonNullable<
          NonNullable<
            TaskExecutionRecord["publicationQuality"]
          >["reviewPreviousFindings"]
        >,
      ) => {
        return parseCachedImplementationReviewResult(value, {
          projectId: project.id,
          cardId: activeCard.id,
          requirementIds:
            planStore
              .read(activeCard.id)
              ?.plan.requirements.map(({ id }) => id) ?? [],
          contentIdentity: freshIdentity,
          previousFindingIds,
          ...(originalPreviousFindings === undefined
            ? {}
            : { previousFindings: originalPreviousFindings }),
        });
      };
      let currentReview: ImplementationReviewResult | null;
      let unavailableDiagnostic: string | undefined;
      const cachedReview = current.publicationQuality;
      let currentReviewPreviousFindings:
        | readonly {
            id: string;
            sourceContentIdentity?: string | undefined;
            sourceIdentities: readonly string[];
            status: "unresolved" | "resolved" | "superseded";
          }[]
        | undefined = undefined;
      if (
        preparedEvidence.currentContentIdentity === freshIdentity &&
        preparedEvidence.review !== null
      ) {
        currentReview = preparedEvidence.review;
        if (cachedReview?.contentIdentity === freshIdentity)
          currentReviewPreviousFindings = cachedReview.reviewPreviousFindings;
      } else if (current.reviewUnavailable?.contentIdentity === freshIdentity) {
        currentReview = null;
        unavailableDiagnostic = current.reviewUnavailable.diagnostic;
      } else if (finalReview.review.reviewedContentIdentity === freshIdentity) {
        currentReview = finalReview.review;
        currentReviewPreviousFindings = finalReview.previousFindings;
      } else if (
        cachedReview?.contentIdentity === freshIdentity &&
        cachedReview.review !== null &&
        cachedReview.review !== undefined
      ) {
        currentReviewPreviousFindings = cachedReview.reviewPreviousFindings;
        currentReview = parseCurrentReview(
          cachedReview.review,
          cachedReview.reviewPreviousFindingIds ??
            previousFindingIdsFromReview(cachedReview.review),
          cachedReview.reviewPreviousFindings,
        );
      } else if (
        cachedReview?.contentIdentity === freshIdentity &&
        cachedReview.review === null
      ) {
        currentReview = null;
        unavailableDiagnostic =
          "The current publication snapshot has no completed review result";
      } else {
        try {
          const reviewResult = await runReview(priorFindings);
          currentReview = reviewResult.review;
          currentReviewPreviousFindings = reviewResult.previousFindings;
        } catch (error) {
          const primaryRecoveryError = findPrimaryRecoveryError(error);
          if (primaryRecoveryError !== undefined) throw primaryRecoveryError;
          if (!(error instanceof TaskSessionReviewUnavailableError))
            throw error;
          if (signal.aborted) throw error;
          if (
            (await getTaskSessionSourceSnapshotIdentity(git, worktreePath)) !==
            freshIdentity
          )
            throw new Error(
              "Publication review became unavailable after the source changed",
              { cause: error },
            );
          currentReview = null;
          unavailableDiagnostic = error.message;
        }
      }

      if (unavailableDiagnostic !== undefined) {
        const unresolvedWriter = Object.values(
          current.primaryOperations ?? {},
        ).find(
          (operation) =>
            operation !== undefined &&
            (["intent", "dispatched", "ambiguous"].includes(operation.status) ||
              (operation.status === "failed" && operation.retrySafe !== true)),
        );
        if (
          current.reviewRepair?.activePrimaryOperation !== undefined ||
          unresolvedWriter !== undefined
        )
          throw new Error(
            "Cannot skip unavailable prepared review while primary execution remains unresolved",
          );
        const priorReview =
          current.reviewUnavailable?.priorReview ??
          (finalReview.review.verdict === "fail"
            ? finalReview.review
            : undefined);
        current = updateRecord(taskStore, current, {
          reviewRepair:
            current.reviewRepair === undefined
              ? undefined
              : {
                  ...current.reviewRepair,
                  status: "stopped",
                  stopReason: "review-unavailable",
                  activePrimaryOperation: undefined,
                  finishAfterNextReview: undefined,
                  finalReview: undefined,
                },
          reviewUnavailable: {
            contentIdentity: freshIdentity,
            diagnostic: unavailableDiagnostic.slice(0, 500),
            ...(priorReview === undefined ? {} : { priorReview }),
          },
          publicationQuality: {
            contentIdentity: freshIdentity,
            validation: toPersistedQualityEvidence(freshValidation),
            coverageEvidence: toPersistedQualityEvidence(freshCoverage),
            review: null,
          },
        });
        reviewResult = buildUnavailableReviewResult(
          unavailableDiagnostic,
          freshIdentity,
          priorReview,
          current.reviewRepair,
        );
        exhaustedReview = undefined;
        preparedReviewPublication = {
          reviewResult,
          reviewDisclosure: null,
          qualityNeedsDraft:
            freshValidation.status !== "passed" ||
            freshCoverage.status !== "passed",
        };
      } else {
        if (currentReview === null)
          throw new Error(
            "Current publication review outcome is missing without an unavailable-review marker",
          );
        current = updateRecord(taskStore, current, {
          publicationQuality: {
            contentIdentity: freshIdentity,
            validation: toPersistedQualityEvidence(freshValidation),
            coverageEvidence: toPersistedQualityEvidence(freshCoverage),
            review: currentReview,
            reviewPreviousFindingIds:
              cachedReview?.contentIdentity === freshIdentity
                ? (cachedReview.reviewPreviousFindingIds ??
                  previousFindingIdsFromReview(currentReview))
                : previousFindingIdsFromReview(currentReview),
            ...(cachedReview?.contentIdentity === freshIdentity &&
            cachedReview.reviewPreviousFindings !== undefined
              ? {
                  reviewPreviousFindings: cachedReview.reviewPreviousFindings,
                }
              : currentReviewPreviousFindings === undefined
                ? {}
                : {
                    reviewPreviousFindings: currentReviewPreviousFindings.map(
                      ({
                        id,
                        sourceContentIdentity,
                        sourceIdentities,
                        status,
                      }) => ({
                        id,
                        ...(sourceContentIdentity === undefined
                          ? {}
                          : { sourceContentIdentity }),
                        sourceIdentities: [...sourceIdentities],
                        status,
                      }),
                    ),
                  }),
          },
        });
        const hasCurrentMaterialConcerns =
          currentReview.verdict === "fail" &&
          hasUndisposedReviewConcerns(
            currentReview,
            current.reviewRepair?.findings ?? [],
            current.reviewRepair?.requirementDispositions ?? [],
          );
        exhaustedReview = hasCurrentMaterialConcerns
          ? currentReview
          : undefined;
        reviewResult =
          currentReview.verdict === "pass"
            ? "Passed"
            : hasCurrentMaterialConcerns
              ? "Failed (human review required; material findings unresolved)"
              : reviewConcernsDismissedAsNonMaterialLabel;
        preparedReviewPublication = {
          reviewResult,
          reviewDisclosure: exhaustedReview ?? null,
          qualityNeedsDraft:
            freshValidation.status !== "passed" ||
            freshCoverage.status !== "passed",
        };
      }
      preparedEvidence = {
        currentContentIdentity: freshIdentity,
        validationCommand,
        validation: freshValidation,
        ...(project.repository.coverageCommand === undefined
          ? {}
          : { coverageCommand: project.repository.coverageCommand }),
        coverage: freshCoverage,
        review: currentReview,
      };
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
        project,
        card: activeCard,
        worktreePath,
        branch: worktree.branch,
        commitSha: recoveredTrustedCommit.commitSha,
        reviewResult,
        qualityNeedsDraft:
          preparedEvidence.validation?.status !== "passed" ||
          preparedEvidence.coverage?.status !== "passed",
        remediationResult: `${finalReview.attempts} review repair(s)`,
        ...(exhaustedReview === undefined ? {} : { exhaustedReview }),
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        claimHumanReviewNotification: (commitSha) =>
          taskStore.claimHumanReviewNotification(activeCard.id, commitSha),
        verifiedDescriptionFacts: () => [
          `Approved implementation plan: ${JSON.stringify(planStore.read(activeCard.id)?.plan ?? "unavailable")}`,
          `Validation result: ${JSON.stringify(preparedEvidence.validation)}`,
          ...(preparedEvidence.coverage === null
            ? []
            : [
                `Coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
              ]),
          `Independent review result: ${JSON.stringify(preparedEvidence.review)}`,
        ],
        signal,
        ...(recoveryRecord?.pullRequest?.url === undefined
          ? {}
          : { expectedExistingPullRequestUrl: recoveryRecord.pullRequest.url }),
        ...correctionPublicationLocation(recoveryRecord),
        beforePushVerification: async () => {
          preparedEvidence = await verifyPreparedContent();
          const reviewDisclosure =
            preparedReviewPublication.reviewDisclosure ?? undefined;
          if (
            reviewDisclosure !== undefined &&
            reviewDisclosure.reviewedContentIdentity !==
              preparedEvidence.currentContentIdentity
          )
            throw new Error(
              "Prepared review disclosure belongs to an earlier source snapshot",
            );
          const decision = decideHumanReviewPublication(
            preparedEvidence,
            reviewDisclosure,
          );
          if (!decision.allowed)
            throw new Error(
              `Prepared human-review publication evidence is invalid: ${decision.reasons.join("; ")}`,
            );
          return {
            ...preparedReviewPublication,
            readinessEvidence: preparedEvidence,
          };
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
        project,
        card: activeCard,
        worktreePath,
        branch: worktree.branch,
        commitMessage,
        ...(setupDisposition === undefined ? {} : { setupDisposition }),
        reviewResult,
        qualityNeedsDraft:
          preparedEvidence.validation?.status !== "passed" ||
          preparedEvidence.coverage?.status !== "passed",
        remediationResult: `${finalReview.attempts} review repair(s)`,
        ...(exhaustedReview === undefined ? {} : { exhaustedReview }),
        getPreparedReviewPublication: () => preparedReviewPublication,
        ...(emailNotifier === undefined ? {} : { emailNotifier }),
        claimHumanReviewNotification: (commitSha) =>
          taskStore.claimHumanReviewNotification(activeCard.id, commitSha),
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
    if (mutation !== null) queue.complete(mutation.eventId);
  } catch (error) {
    if (error instanceof NotificationPreparationError) {
      if (mutation && queue.ownsActive(mutation.eventId))
        queue.releaseForRecovery(mutation.eventId);
      throw error;
    }
    if (
      ProjectRunAuthority.current(project.id)
        ?.store.read()
        ?.pendingOperations.some(
          (entry) =>
            entry.id.startsWith("workflow:") &&
            !["completed", "cancelled"].includes(entry.status),
        )
    ) {
      if (mutation && queue.ownsActive(mutation.eventId))
        queue.releaseForRecovery(mutation.eventId);
      throw error;
    }
    const failedRecord =
      mutation === null ? null : taskStore.read(mutation.cardId);
    const recoveryCandidate =
      mutation === null
        ? recoveryRecord === null
          ? null
          : taskStore.read(recoveryRecord.cardId)
        : failedRecord;
    if (recoveryCandidate !== null && options.retryIntervalMs !== undefined) {
      const disposition = persistPrimaryOperationRecovery(
        taskStore,
        recoveryCandidate,
        error,
        options.retryIntervalMs,
      );
      if (disposition === "waiting" || disposition === "published-blockage") {
        const owned = queue.getActive();
        if (owned !== null && queue.ownsActive(owned.eventId))
          queue.releaseForRecovery(owned.eventId);
        return;
      }
    }
    if (error instanceof TaskSessionImplementationWaitingError) {
      if (mutation && queue.ownsActive(mutation.eventId))
        queue.releaseForRecovery(mutation.eventId);
      return;
    }
    if (error instanceof PrimarySessionReconstructionRequiredError) {
      if (mutation && queue.ownsActive(mutation.eventId))
        queue.releaseForRecovery(mutation.eventId);
      return;
    }
    if (error instanceof PublicationWaitingError) {
      if (mutation && queue.ownsActive(mutation.eventId))
        queue.fail(mutation.eventId);
      return;
    }
    if (
      mutation !== null &&
      failedRecord?.phase === "attention-required" &&
      (failedRecord.terminalFailure?.kind === "implementation" ||
        failedRecord.terminalFailure?.kind === "clarification") &&
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
        (latest.terminalFailure?.kind !== "implementation" &&
          latest.terminalFailure?.kind !== "clarification")
      )
        throw new Error(
          `Terminal failure identity changed for ${mutation.cardId}`,
          { cause: error },
        );
      try {
        await finalizePrimaryFailureEffects(
          mutation.cardId,
          latest.operationKey,
          latest.terminalFailure.reason,
          latest.terminalFailure.kind,
        );
      } catch (finalizationError) {
        if (queue.ownsActive(mutation.eventId))
          queue.releaseForRecovery(mutation.eventId);
        throw finalizationError;
      }
      const confirmedFailure = {
        ...latest,
        terminalFailure: {
          ...latest.terminalFailure,
          outcome: "confirmed" as const,
        },
        revision: latest.revision + 1,
        updatedAt: timestamp(latest),
      };
      if (
        ProjectRunAuthority.current(project.id) &&
        latest.pullRequest === undefined &&
        latest.externalRecovery === undefined
      ) {
        taskStore.compareAndSwap(
          mutation.cardId,
          latest.revision,
          confirmedFailure,
          {
            event: "failed",
            evidence: noPullRequestFailureEvidence(
              project,
              mutation.cardId,
              latest.operationKey,
            ),
          },
        );
      } else {
        taskStore.compareAndSwap(
          mutation.cardId,
          latest.revision,
          confirmedFailure,
        );
      }
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
      const staleReviewFailure =
        error instanceof Error &&
        (error.message.includes(
          "Persisted exhausted review is stale after publication",
        ) ||
          error.message.includes(
            "Task-session publication is blocked: Final implementation review is stale",
          ));
      if (
        latest !== null &&
        latest.phase !== "attention-required" &&
        latest.phase !== "done" &&
        (!commitVerified || staleReviewFailure)
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
