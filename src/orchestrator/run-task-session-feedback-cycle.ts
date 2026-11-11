import { createHash } from "node:crypto";
import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { buildTaskSessionReviewRepairPrompt } from "../opencode/build-task-session-review-repair-prompt.js";
import { inspectPrimaryOpenCodeSession } from "../opencode/inspect-primary-session.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import type { ObservedTaskSessionReviewCard } from "./observe-task-session-review-cards.js";
import { runTaskSessionFeedbackRemediation } from "../task-session/run-task-session-feedback-remediation.js";
import { runAdvisoryTaskSessionFeedbackVerification } from "../task-session/run-task-session-feedback-verification.js";
import { publishVerifiedFeedbackReplies } from "../task-session/publish-verified-feedback-replies.js";
import type { FeedbackVerificationResult } from "../task-session/feedback-verification.js";
import { reconcileFeedbackRound } from "../task-session/reconcile-feedback-round.js";
import { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "../task-session/feedback-ledger.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import {
  hasUndisposedReviewConcerns,
  reviewConcernsDismissedAsNonMaterialLabel,
  type ImplementationReviewResult,
} from "../task-session/implementation-review-result.js";
import { TaskPlanStore } from "../task-session/task-plan-store.js";
import { transitionTaskExecutionRecord } from "../task-session/task-execution-transition.js";
import { runWithPrimaryTaskSession } from "../task-session/primary-task-session.js";
import { runTaskSessionValidationWithRepairs } from "../task-session/run-task-session-validation-repairs.js";
import {
  CommitMessageAdviceUnavailableError,
  CommitMessageRecoveryBlockedError,
  runTaskSessionCommitMessage,
} from "../task-session/run-task-session-commit-message.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import { runTaskSessionValidation } from "../task-session/run-task-session-validation.js";
import { runTaskSessionCoverage } from "../task-session/run-task-session-coverage.js";
import {
  runTaskSessionReview,
  TaskSessionReviewUnavailableError,
} from "../task-session/run-task-session-review.js";
import {
  createReviewRoundRunner,
  parsePrimaryReviewRepairOutcome,
  runTaskSessionReviewWithRepairs,
} from "../task-session/run-task-session-review-repairs.js";
import {
  decideValidatedHumanReviewPublication,
  decideHumanReviewPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import { getTaskSessionSourceSnapshotIdentity } from "../task-session/source-snapshot.js";
import { publishTaskSessionCard } from "./publish-task-session-card.js";
import { inspectPrimaryOperationEvidence } from "../task-session/inspect-primary-operation.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import { canResumeFeedbackReviewRepair } from "../task-session/can-resume-failed-feedback-review.js";
import {
  findPrimaryRecoveryError,
  persistPrimaryOperationRecovery,
} from "../task-session/persist-primary-operation-recovery.js";
import { classifyCurrentFeedback } from "../task-session/classify-current-feedback.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "../task-session/operation-recovery-policy.js";
import { updateMaintenanceStatus } from "./maintenance-status.js";
import type { ManagedPullRequestStatus } from "../github/pull-request-status.js";
import { prepareInitialPublicationBody } from "./publish-card.js";
import { enrichPullRequestDescription } from "../github/enrich-pull-request-description.js";
import {
  ensureFeedbackCardLocation,
  prepareFeedbackCardMove,
  reconcilePendingFeedbackCardMove,
} from "./feedback-card-location.js";

export interface RunTaskSessionFeedbackCycleOptions {
  project: ProjectConfig;
  card: TrelloCard;
  observation: ObservedTaskSessionReviewCard;
  taskStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  ledgerStore: FeedbackLedgerStore;
  mutationQueue: TaskMutationQueue;
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  openCode: OpenCodeClient;
  commands: CommandRunner;
  worktreePath: string;
  attachmentContext?: CardAttachmentPromptContext;
  prepareAttachmentContext?: () => Promise<
    CardAttachmentPromptContext | undefined
  >;
  signal: AbortSignal;
  retryIntervalMs?: number;
  emailNotifier?: EmailNotifier;
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
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
    ).toISOString(),
  });
}

export function persistQualityEvidence(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  cycleId: string,
  validation: TaskSessionValidationResult,
  coverage: TaskSessionValidationResult,
): TaskExecutionRecord {
  const storedEvidence = (result: TaskSessionValidationResult) => ({
    command: result.command,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    exitCode: result.exitCode,
    status: result.status,
    diagnostic: result.diagnostic,
    contentIdentity: result.contentIdentity,
  });
  return updateRecord(store, record, {
    validationRepair: {
      cycleId: record.validationRepair?.cycleId ?? cycleId,
      ...(record.validationRepair?.maxAttempts === undefined
        ? {}
        : { maxAttempts: record.validationRepair.maxAttempts }),
      status:
        validation.status === "skipped" && coverage?.status === "skipped"
          ? "skipped"
          : [validation.status, coverage.status].some(
                (status) => status !== "passed" && status !== "skipped",
              )
            ? "exhausted"
            : "passed",
      evidence: storedEvidence(validation),
      coverageEvidence: storedEvidence(coverage),
    },
  });
}

function toFeedbackEntries(
  observation: ObservedTaskSessionReviewCard,
): FeedbackLedgerEntry[] {
  const entries: FeedbackLedgerEntry[] = [];
  const isHuman = (item: {
    author: string | null;
    authorIsBot?: boolean;
    body: string | null;
  }) =>
    item.author !== null &&
    item.authorIsBot !== true &&
    item.author !== observation.automationActor &&
    !item.body?.includes("<!-- agent-orchestrator-");
  for (const review of observation.requestedChanges?.feedback.reviews ?? []) {
    if (
      isHuman(review) &&
      review.body !== null &&
      review.body.trim().length > 0
    ) {
      entries.push({
        kind: "review",
        id: String(review.id),
        author: review.author,
        createdAt: review.submittedAt,
        updatedAt: null,
        body: review.body,
        ...(review.commitSha === undefined
          ? {}
          : { commitSha: review.commitSha }),
        headSha: observation.headSha,
        actionability: "unclassified",
        status: "pending",
        verificationEvidence: [],
      });
    }
    for (const comment of review.inlineComments) {
      if (comment.id === undefined || !isHuman(comment)) continue;
      entries.push({
        kind: "inline-comment",
        id: String(comment.id),
        author: comment.author,
        createdAt: review.submittedAt,
        updatedAt: null,
        body: comment.body,
        ...(comment.commitSha === undefined
          ? {}
          : { commitSha: comment.commitSha }),
        headSha: observation.headSha,
        ...(comment.path === undefined ? {} : { path: comment.path }),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(comment.originalLine === undefined
          ? {}
          : { originalLine: comment.originalLine }),
        ...(comment.diffHunk === undefined
          ? {}
          : { diffHunk: comment.diffHunk }),
        ...(comment.threadId === undefined
          ? {}
          : { threadId: comment.threadId }),
        ...(comment.isResolved === undefined
          ? {}
          : { isResolved: comment.isResolved }),
        ...(comment.isOutdated === undefined
          ? {}
          : { isOutdated: comment.isOutdated }),
        actionability:
          comment.isResolved === true || comment.isOutdated === true
            ? "not-actionable"
            : "unclassified",
        status: "pending",
        verificationEvidence: [],
      });
    }
  }
  for (const comment of observation.conversationComments) {
    if (!isHuman(comment)) continue;
    entries.push({
      kind: "conversation-comment",
      id: String(comment.id),
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      body: comment.body,
      ...(comment.commitSha === undefined
        ? {}
        : { commitSha: comment.commitSha }),
      headSha: observation.headSha,
      actionability: "unclassified",
      status: "pending",
      verificationEvidence: [],
    });
  }
  return entries;
}

function reviewRunOptions(project: ProjectConfig, signal: AbortSignal) {
  return {
    model: project.opencode.review.model,
    variant: project.opencode.review.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    signal,
  };
}

export async function refreshCurrentTaskFeedback(options: {
  project: ProjectConfig;
  cardId: string;
  observation: ObservedTaskSessionReviewCard;
  ledgerStore: FeedbackLedgerStore;
  openCode: OpenCodeClient;
  worktreePath: string;
  signal: AbortSignal;
}): Promise<void> {
  const previous = options.ledgerStore.read(options.cardId);
  const incoming = await classifyCurrentFeedback({
    ...options,
    incoming: toFeedbackEntries(options.observation),
    previous: previous?.entries ?? [],
  });
  if (previous === null) options.ledgerStore.create(options.cardId, incoming);
  else
    reconcileFeedbackRound({
      store: options.ledgerStore,
      projectId: options.project.id,
      cardId: options.cardId,
      previousHeadSha: options.observation.headSha,
      observedHeadSha: options.observation.headSha,
      newlyObservedFeedback: incoming,
    });
}

export function feedbackOperationId(
  headSha: string,
  feedback: readonly FeedbackLedgerEntry[],
): string {
  return `feedback:${headSha}:${createHash("sha256")
    .update(
      feedback
        .map(
          (item) =>
            `${item.kind}:${item.id}:${item.body}${(item.requestRevision ?? 0) > 0 ? `\0request:${item.requestRevision}:${item.sourceRevision ?? ""}` : ""}`,
        )
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16)}`;
}

export function feedbackReplyOperationId(
  headSha: string,
  entries: readonly FeedbackLedgerEntry[],
): string {
  const ids = entries
    .filter(
      (entry) =>
        entry.actionability === "actionable" &&
        ["verified", "escalated", "published"].includes(entry.status) &&
        entry.remediationCommitSha === headSha,
    )
    .map(
      (entry) =>
        `${entry.kind}:${entry.id}:request:${entry.requestRevision ?? 0}`,
    )
    .sort();
  return `feedback-replies:${headSha}:${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16)}`;
}

function validationRepairRunOptions(
  project: ProjectConfig,
  signal: AbortSignal,
) {
  return {
    model: project.opencode.remediation.model,
    variant: project.opencode.remediation.variant,
    timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    signal,
  };
}

async function runBoundedFeedbackReview(
  options: Parameters<typeof runTaskSessionReview>[0],
) {
  const identity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  for (;;) {
    const current = options.taskRecordStore.read(options.card.id);
    const feedback = current?.feedbackRemediation;
    if (!current || !feedback)
      throw new Error("Feedback review lost its correction identity");
    const attempts = feedback.reviewSourceAttempts?.[identity] ?? 0;
    if (attempts >= OPERATION_RECOVERY_MAX_EXECUTIONS)
      throw new TaskSessionReviewUnavailableError(
        "Independent feedback review exhausted its bounded attempts for the current source",
      );
    updateRecord(options.taskRecordStore, current, {
      feedbackRemediation: {
        ...feedback,
        reviewSourceAttempts: {
          ...feedback.reviewSourceAttempts,
          [identity]: attempts + 1,
        },
      },
    });
    try {
      return await runTaskSessionReview(options);
    } catch (error) {
      if (
        !(error instanceof TaskSessionReviewUnavailableError) ||
        options.runOptions.signal.aborted
      )
        throw error;
      if (
        (await getTaskSessionSourceSnapshotIdentity(
          options.git,
          options.worktreePath,
        )) !== identity
      )
        throw new Error(
          "Feedback source changed during unavailable advisory review",
          { cause: error },
        );
    }
  }
}

export async function runTaskSessionFeedbackCycle(
  options: RunTaskSessionFeedbackCycleOptions,
): Promise<"idle" | "attention-required" | "remediated" | "published"> {
  const {
    project,
    card,
    observation,
    taskStore,
    planStore,
    ledgerStore,
    trello,
    git,
    github,
    openCode,
    commands,
    worktreePath,
    signal,
  } = options;
  const record = taskStore.read(card.id);
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  const resumingReviewRepair = canResumeFeedbackReviewRepair(
    record,
    options.mutationQueue.getActive(),
  );
  if (
    record === null ||
    (record.phase !== "human-feedback" &&
      record.phase !== "review" &&
      !resumingReviewRepair) ||
    record.pullRequest?.headSha !== observation.headSha
  ) {
    throw new Error(
      "Feedback round task record does not match the current owned PR head",
    );
  }
  const recoveringReview = record.phase === "review" && !resumingReviewRepair;
  const finishNoOp = async (): Promise<boolean> => {
    const current = taskStore.read(card.id);
    const correction = current?.feedbackRemediation;
    if (!current || correction?.status !== "no-op") return false;
    const ledger = ledgerStore.read(card.id);
    if (!ledger) throw new Error("No-op feedback ledger is unavailable");
    const ids = new Set(
      correction.feedbackIds ??
        ledger.entries
          .filter(
            (entry) =>
              entry.status === "pending" &&
              entry.actionability === "actionable",
          )
          .map((entry) => `${entry.kind}:${entry.id}`),
    );
    const attempted = ledger.entries.filter((entry) =>
      ids.has(`${entry.kind}:${entry.id}`),
    );
    if (
      attempted.length !== ids.size ||
      feedbackOperationId(correction.headSha, attempted) !==
        correction.operationId
    )
      throw new Error(
        "Original no-op feedback context cannot be established; preserve the ledger and primary operation for reconciliation",
      );
    if (attempted.some((entry) => entry.status === "pending"))
      ledgerStore.compareAndSwap(card.id, ledger.revision, {
        ...ledger,
        revision: ledger.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(ledger.updatedAt) + 1),
        ).toISOString(),
        entries: ledger.entries.map((entry) =>
          ids.has(`${entry.kind}:${entry.id}`) && entry.status === "pending"
            ? {
                ...entry,
                status: "escalated" as const,
                resolution: "unresolved" as const,
                remediationCommitSha: correction.headSha,
                unresolvedReason:
                  "This correction attempt produced no repository changes; fulfillment was not verified.",
              }
            : entry,
        ),
      });
    const active = options.mutationQueue.getActive();
    if (active && active.eventId !== correction.operationId) return false;
    if (
      active &&
      options.mutationQueue.claimForRecovery(active.eventId) === null
    )
      return false;
    await ensureFeedbackCardLocation(
      { project, cardId: card.id, taskStore, trello, github },
      project.trello.reviewListId,
      `${correction.operationId}:review`,
    );
    // The primary no-op is verified stopped and has no new commit to publish.
    // Presentation may reconcile independently while the open PR retains ownership.
    if (options.mutationQueue.ownsActive(correction.operationId))
      options.mutationQueue.complete(correction.operationId);
    await refreshCurrentTaskFeedback({
      project,
      cardId: card.id,
      observation,
      ledgerStore,
      openCode,
      worktreePath,
      signal,
    });
    await github.ensurePullRequestDraft({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestUrl: record.pullRequest!.url,
      project,
    });
    const facts = [
      `Correction ${correction.operationId} made no repository changes; no new commit or fulfilled request is claimed.`,
      "No new validation, coverage or independent review was run by this no-op correction.",
      `Latest recorded quality evidence (with its original source identity): ${JSON.stringify(current.publicationQuality ?? { status: "unavailable" })}`,
      `Current human feedback: ${JSON.stringify(
        ledgerStore
          .read(card.id)
          ?.entries.filter(
            (entry) =>
              entry.isCurrent !== false && entry.actionability === "actionable",
          )
          .map((entry) => ({
            id: `${entry.kind}:${entry.id}`,
            status:
              entry.resolution ??
              (entry.status === "pending" ? "pending" : "unresolved"),
            reason: entry.unresolvedReason ?? "Awaiting fulfillment evidence",
          })) ?? [],
      )}`,
    ];
    const generated = await prepareInitialPublicationBody(
      {
        project,
        card,
        worktreePath,
        branch: record.expectedBranch!,
        trello,
        git,
        github,
        reviewResult: "Unresolved human feedback",
        remediationResult: "No repository changes from the correction attempt",
        verifiedDescriptionFacts: () => facts,
      },
      false,
    );
    const request = {
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestUrl: record.pullRequest!.url,
      project,
    };
    const currentBody = await github.getPullRequestDescription(request);
    const nextBody = enrichPullRequestDescription(
      currentBody,
      generated,
      card,
      project.repository.gitIdentity.name,
    );
    if (nextBody === null)
      throw new Error(
        "Human-owned PR description has no safely replaceable managed section; no-op feedback outcome remains pending",
      );
    if (nextBody !== currentBody)
      await github.editPullRequestDescription({
        ...request,
        body: nextBody,
        expectedBody: currentBody,
      });
    if ((await github.getPullRequestDescription(request)) !== nextBody)
      throw new Error("No-op feedback description was not verified");
    await updateMaintenanceStatus(
      github,
      project,
      card,
      record.pullRequest!.url,
      null,
      "feedback no-op completed",
      cardLog,
    );
    const latest = taskStore.read(card.id);
    if (
      !latest ||
      latest.feedbackRemediation?.operationId !== correction.operationId
    )
      throw new Error("No-op feedback reporting ownership changed");
    updateRecord(taskStore, latest, {
      feedbackRemediation: {
        ...latest.feedbackRemediation,
        outcomeReported: true,
      },
    });
    return true;
  };
  if (
    record.feedbackRemediation?.status === "no-op" &&
    record.feedbackRemediation.outcomeReported !== true
  )
    return (await finishNoOp()) ? "remediated" : "idle";
  if (
    recoveringReview &&
    (record.reviewRepair?.status !== "exhausted" ||
      record.reviewRepair.finalReview?.verdict !== "fail")
  )
    throw new Error(
      "Feedback review checkpoint is not eligible for exhausted-review recovery",
    );
  const storedPlan = planStore.read(card.id);
  const resumingReservedRound =
    resumingReviewRepair ||
    recoveringReview ||
    (record.feedbackRemediation?.status === "active" &&
      record.feedbackRemediation.feedbackIds !== undefined &&
      options.mutationQueue.getActive()?.eventId ===
        record.feedbackRemediation.operationId);
  if (!resumingReservedRound)
    await refreshCurrentTaskFeedback({
      project,
      cardId: card.id,
      worktreePath,
      observation,
      ledgerStore,
      openCode,
      signal,
    });
  const ledgerBeforeSync = ledgerStore.read(card.id);
  const activeReply = options.mutationQueue.getActive();
  const resumingReply =
    activeReply?.kind === "feedback" &&
    activeReply.eventId.startsWith("feedback-replies:");
  if (
    !resumingReservedRound &&
    ledgerBeforeSync !== null &&
    record.publicationQuality !== undefined &&
    (resumingReply ||
      ledgerBeforeSync.entries.some(
        (entry) =>
          entry.isCurrent !== false &&
          entry.actionability === "actionable" &&
          ["verified", "escalated"].includes(entry.status) &&
          entry.remediationCommitSha === observation.headSha,
      ))
  ) {
    const replyOperationId = resumingReply
      ? activeReply.eventId
      : feedbackReplyOperationId(observation.headSha, ledgerBeforeSync.entries);
    if (!resumingReply) {
      options.mutationQueue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: replyOperationId,
        operationKey: replyOperationId,
        kind: "feedback",
        enqueuedAt: record.createdAt,
      });
    }
    const owner = options.mutationQueue.claimForRecovery(replyOperationId);
    if (owner === null || owner.eventId !== replyOperationId) return "idle";
    let replyResult!: Awaited<
      ReturnType<typeof publishVerifiedFeedbackReplies>
    >;
    try {
      const publicationQuality = record.publicationQuality as {
        contentIdentity: string;
      };
      const verification: FeedbackVerificationResult = {
        version: 1,
        projectId: project.id,
        cardId: card.id,
        headSha: observation.headSha,
        contentIdentity: publicationQuality.contentIdentity,
        dispositions: ledgerBeforeSync.entries
          .filter(
            (entry) =>
              entry.actionability === "actionable" &&
              ["verified", "escalated", "published"].includes(entry.status) &&
              entry.remediationCommitSha === observation.headSha,
          )
          .map((entry) => {
            const feedbackId = `${entry.kind}:${entry.id}`;
            if (
              (entry.status === "verified" || entry.status === "published") &&
              (entry.resolution === undefined ||
                entry.resolution === "verified-fixed") &&
              entry.remediationCommitSha === observation.headSha &&
              entry.verificationEvidence.length > 0
            ) {
              return {
                feedbackId,
                status: "verified-fixed" as const,
                evidence: entry.verificationEvidence,
              };
            }
            return {
              feedbackId,
              status:
                entry.resolution === "uncertain"
                  ? ("uncertain" as const)
                  : ("unresolved" as const),
              reason:
                entry.unresolvedReason ??
                "This feedback item is not verified on the published PR head.",
            };
          }),
      };
      replyResult = await publishVerifiedFeedbackReplies({
        project,
        cardId: card.id,
        pullRequestUrl: record.pullRequest!.url,
        publishedCommitSha: observation.headSha,
        observedHeadSha: observation.headSha,
        ciEvaluation: observation.ciEvaluation,
        verification,
        ledgerStore,
        reconcileReply: async (entry, marker) => {
          if (entry.kind === "inline-comment" && entry.threadId !== undefined) {
            const replyId = await github.findReviewThreadReplyByMarker({
              cwd: project.repository.path,
              repository: project.repository.github,
              pullRequestUrl: record.pullRequest!.url,
              threadId: entry.threadId,
              marker,
              project,
            });
            return replyId === null
              ? { status: "absent" as const }
              : { status: "found" as const, replyId };
          }
          {
            const comments = await github.getPullRequestConversationComments({
              cwd: project.repository.path,
              repository: project.repository.github,
              pullRequestUrl: record.pullRequest!.url,
              project,
            });
            const reply = comments.find((comment) =>
              comment.body.includes(marker),
            );
            return reply === undefined
              ? { status: "absent" as const }
              : { status: "found" as const, replyId: String(reply.id) };
          }
        },
        sendReply: async (entry, body) => {
          if (entry.kind === "inline-comment" && entry.threadId !== undefined) {
            const reply = await github.replyToReviewThread({
              cwd: project.repository.path,
              repository: project.repository.github,
              pullRequestUrl: record.pullRequest!.url,
              threadId: entry.threadId,
              body,
              project,
            });
            return reply.id;
          }
          {
            const reply = await github.replyToConversationComment({
              cwd: project.repository.path,
              repository: project.repository.github,
              pullRequestUrl: record.pullRequest!.url,
              body,
              project,
            });
            return reply.id;
          }
        },
      });
      options.mutationQueue.complete(replyOperationId);
      if (replyResult.publishedReplyIds.length > 0) {
        const latest = taskStore.read(card.id);
        if (latest !== null && latest.phase === "human-feedback") {
          taskStore.compareAndSwap(
            card.id,
            latest.revision,
            transitionTaskExecutionRecord(latest, {
              type: "feedback-replies-published",
              eventId: `${replyOperationId}:completed`,
              projectId: project.id,
              cardId: card.id,
              operationKey: latest.operationKey,
              occurredAt: new Date(
                Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
              ).toISOString(),
            }),
          );
        }
        return "published";
      }
    } catch (error) {
      if (options.mutationQueue.ownsActive(replyOperationId)) {
        options.mutationQueue.fail(replyOperationId);
      }
      throw error;
    }
  }
  const ledger = ledgerStore.read(card.id);
  if (ledger === null)
    throw new Error("Feedback ledger could not be loaded after observation");
  const pendingIds = new Set(
    resumingReservedRound
      ? (record.feedbackRemediation?.feedbackIds ??
          ledger.entries
            .filter(
              (entry) =>
                entry.status === "pending" &&
                entry.actionability === "actionable",
            )
            .map((entry) => `${entry.kind}:${entry.id}`))
      : ledger.entries
          .filter(
            (item) =>
              item.isCurrent !== false &&
              item.actionability === "actionable" &&
              item.status === "pending",
          )
          .map((item) => `${item.kind}:${item.id}`),
  );
  const actionableFeedback = ledger.entries.filter(
    (item) =>
      pendingIds.has(`${item.kind}:${item.id}`) &&
      (resumingReviewRepair || item.status === "pending") &&
      item.actionability === "actionable",
  );
  if (
    resumingReviewRepair &&
    (actionableFeedback.length === 0 ||
      actionableFeedback.length !== pendingIds.size)
  )
    throw new Error(
      "Reserved feedback review has no matching persisted feedback context",
    );
  if (actionableFeedback.length === 0) return "idle";
  cardLog.event(
    `Requested-changes remediation started (${actionableFeedback.length} actionable item(s))`,
  );
  const operationId = feedbackOperationId(
    observation.headSha,
    actionableFeedback,
  );
  if (
    resumingReviewRepair &&
    record.feedbackRemediation?.operationId !== operationId
  )
    throw new Error(
      "Reserved feedback review does not match its original feedback round",
    );
  if (
    !recoveringReview &&
    !resumingReviewRepair &&
    record.feedbackRemediation?.operationId === operationId
  ) {
    if (record.feedbackRemediation.status === "active") {
      const primary = record.primaryOperations?.[operationId];
      if (
        primary === undefined ||
        primary.activity !== "feedback-remediation"
      ) {
        throw new Error(
          "Active feedback remediation has no matching durable primary operation; refusing execution",
        );
      }
      // The feedback checkpoint is persisted before primary dispatch. Let the
      // primary-operation ledger inspect/reconcile this exact operation; it
      // alone can authorize replay after proving the previous process stopped.
    } else {
      return "idle";
    }
  }
  if (recoveringReview) {
    const active = options.mutationQueue.getActive();
    if (
      active?.eventId !== operationId ||
      active.cardId !== card.id ||
      active.kind !== "feedback" ||
      active.status !== "failed" ||
      record.feedbackRemediation?.operationId !== operationId ||
      record.feedbackRemediation.status !== "changed" ||
      record.feedbackRecoveryAttemptEventId !== operationId ||
      (await git.getCurrentBranch(worktreePath)) !== record.expectedBranch ||
      (await git.getHeadSha(worktreePath)) !== observation.headSha ||
      (await git.getStatus(worktreePath)).trim().length === 0 ||
      (await getTaskSessionSourceSnapshotIdentity(git, worktreePath)) !==
        record.reviewRepair?.finalReview?.reviewedContentIdentity
    ) {
      throw new Error(
        "Failed feedback recovery lacks verified queue, branch, PR head or source evidence",
      );
    }
  }
  options.mutationQueue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId: operationId,
    operationKey: operationId,
    kind: "feedback",
    enqueuedAt: record.createdAt,
  });
  const mutation = options.mutationQueue.claimForRecovery(operationId);
  if (mutation === null || mutation.eventId !== operationId) return "idle";
  const cardLocation = { project, cardId: card.id, taskStore, trello, github };
  const setActivity = (status: ManagedPullRequestStatus | null) =>
    updateMaintenanceStatus(
      github,
      project,
      card,
      record.pullRequest!.url,
      status,
      "human feedback correction",
      cardLog,
    );
  try {
    await github.ensurePullRequestDraft({
      cwd: project.repository.path,
      repository: project.repository.github,
      pullRequestUrl: record.pullRequest!.url,
      project,
    });
    const attachmentContext =
      options.prepareAttachmentContext === undefined
        ? options.attachmentContext
        : await options.prepareAttachmentContext();
    await setActivity("addressing-review-feedback");
    await ensureFeedbackCardLocation(
      cardLocation,
      project.trello.workingListId,
      `${operationId}:working`,
    );
    let quality:
      | {
          validation: TaskSessionValidationResult;
          coverage: TaskSessionValidationResult;
        }
      | undefined;
    let finalReview: { review: ImplementationReviewResult | null } = {
      review: null,
    };
    let firstReview:
      Awaited<ReturnType<typeof runTaskSessionReview>> | undefined;
    const validationOptions = {
      project,
      cardId: card.id,
      expectedBranch: record.expectedBranch!,
      operationKey: record.operationKey,
      worktreePath,
      taskRecordStore: taskStore,
      git,
      commands,
      signal,
      timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
    };
    if (
      resumingReviewRepair &&
      record.reviewRepair?.activePrimaryOperation === undefined
    ) {
      await setActivity("validating-review-changes");
      const recoveryValidation = {
        ...validationOptions,
        feedbackReviewRecovery: record.phase === "review",
      };
      quality = {
        validation: await runTaskSessionValidation(recoveryValidation),
        coverage: await runTaskSessionCoverage(recoveryValidation),
      };
    }
    try {
      if (recoveringReview) {
        await setActivity("validating-review-changes");
        const validationOptions = {
          project,
          cardId: card.id,
          expectedBranch: record.expectedBranch!,
          operationKey: record.operationKey,
          worktreePath,
          taskRecordStore: taskStore,
          git,
          commands,
          signal,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          feedbackReviewRecovery: true,
        };
        const validation = await runTaskSessionValidation(validationOptions);
        const coverage = await runTaskSessionCoverage(validationOptions);
        quality = { validation, coverage };
        finalReview = { review: record.reviewRepair!.finalReview! };
        cardLog.event(
          "Resuming failed feedback review with preserved implementation and exhausted review",
        );
      } else {
        if (!resumingReviewRepair) {
          const remediation = await runTaskSessionFeedbackRemediation({
            project,
            card,
            expectedBranch: record.expectedBranch!,
            operationKey: record.operationKey,
            operationId,
            expectedPrimarySessionId: record.primarySessionId!,
            inspectPrimarySession: (sessionId) =>
              inspectPrimaryOpenCodeSession({
                commands,
                cwd: worktreePath,
                sessionId,
                signal,
                timeoutMilliseconds: 30_000,
              }),
            expectedPullRequestHeadSha: observation.headSha,
            worktreePath,
            taskRecordStore: taskStore,
            planStore,
            feedbackLedgerStore: ledgerStore,
            git,
            openCode,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            runOptions: {
              model: project.opencode.remediation.model,
              variant: project.opencode.remediation.variant,
              timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
              signal,
            },
          });
          cardLog.event(`Requested-changes remediation ${remediation.status}`);
          if (remediation.status === "no-op") {
            await finishNoOp();
            return "remediated";
          }
          let current = taskStore.read(card.id);
          if (current === null)
            throw new Error(
              "Task record disappeared after feedback remediation",
            );
          current = updateRecord(taskStore, current, {
            ciRepair: undefined,
            reviewObservation: undefined,
            publicationQuality: undefined,
            reviewRepair: undefined,
            reviewUnavailable: undefined,
          });
          const feedbackReceived = transitionTaskExecutionRecord(current, {
            type: "feedback-received",
            eventId: `${operationId}:feedback-received`,
            projectId: project.id,
            cardId: card.id,
            operationKey: current.operationKey,
            occurredAt: new Date(
              Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
            ).toISOString(),
          });
          current = taskStore.compareAndSwap(
            card.id,
            current.revision,
            feedbackReceived,
          );
          const implementationCompleted = transitionTaskExecutionRecord(
            current,
            {
              type: "implementation-completed",
              eventId: `${operationId}:implementation-completed`,
              projectId: project.id,
              cardId: card.id,
              operationKey: current.operationKey,
              occurredAt: new Date(
                Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
              ).toISOString(),
            },
          );
          current = taskStore.compareAndSwap(
            card.id,
            current.revision,
            implementationCompleted,
          );
          await setActivity("validating-review-changes");
          quality = await runTaskSessionValidationWithRepairs({
            validation: validationOptions,
            openCode,
            planStore,
            card,
            expectedPrimarySessionId: record.primarySessionId!,
            inspectPrimarySession: (sessionId) =>
              inspectPrimaryOpenCodeSession({
                commands,
                cwd: worktreePath,
                sessionId,
                signal,
                timeoutMilliseconds: 30_000,
              }),
            primaryOperationEvidence: {
              trustedRoot:
                ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                getProcessRuntime().artifactRoot,
              cwd: worktreePath,
            },
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            repairRunOptions: validationRepairRunOptions(project, signal),
          });
          firstReview = await runBoundedFeedbackReview({
            project,
            card,
            expectedBranch: record.expectedBranch!,
            operationKey: record.operationKey,
            worktreePath,
            taskRecordStore: taskStore,
            planStore,
            git,
            openCode,
            validation: quality.validation,
            coverage: quality.coverage,
            previousFindings: [],
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            runOptions: reviewRunOptions(project, signal),
          });
        }
        const reviewRoundRunner = createReviewRoundRunner(
          firstReview === undefined
            ? undefined
            : {
                review: firstReview.review,
                contentIdentity: firstReview.contentIdentity,
              },
          async (previousFindings) => {
            if (quality === undefined)
              throw new Error(
                "Review repair completed without fresh quality evidence",
              );
            const currentReview = await runBoundedFeedbackReview({
              project,
              card,
              expectedBranch: record.expectedBranch!,
              operationKey: record.operationKey,
              worktreePath,
              taskRecordStore: taskStore,
              planStore,
              git,
              openCode,
              validation: quality.validation,
              coverage: quality.coverage,
              previousFindings,
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
              runOptions: reviewRunOptions(project, signal),
            });
            return {
              review: currentReview.review,
              contentIdentity: currentReview.contentIdentity,
            };
          },
        );
        finalReview = await runTaskSessionReviewWithRepairs({
          maxAttempts: project.opencode.remediation.maxPasses,
          store: taskStore,
          projectId: project.id,
          cardId: card.id,
          operationKey: record.operationKey,
          reviewCycleId: `${record.operationKey}:feedback:${operationId}`,
          expectedPrimarySessionId: record.primarySessionId!,
          buildRepairPrompt: (review, attempt) =>
            buildTaskSessionReviewRepairPrompt({
              projectId: project.id,
              card,
              ...(storedPlan === null ? {} : { approvedPlan: storedPlan.plan }),
              review,
              attempt,
              maxAttempts: project.opencode.remediation.maxPasses,
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
            }),
          runReview: reviewRoundRunner,
          repair: async (
            review,
            attempt,
            primaryOperationId,
            persistedPrompt,
          ) => {
            let latest = taskStore.read(card.id);
            if (latest === null)
              throw new Error(
                "Task state disappeared during feedback review repair",
              );
            if (latest.phase === "review")
              taskStore.compareAndSwap(
                card.id,
                latest.revision,
                transitionTaskExecutionRecord(latest, {
                  type: "review-failed",
                  eventId: `${operationId}:review-failed:${attempt}`,
                  projectId: project.id,
                  cardId: card.id,
                  operationKey: latest.operationKey,
                  occurredAt: new Date(
                    Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
                  ).toISOString(),
                }),
              );
            else if (
              latest.phase !== "implementation" &&
              latest.phase !== "validation"
            )
              throw new Error(
                "Feedback review repair lost its owned execution checkpoint",
              );
            if (
              latest.phase === "validation" &&
              latest.primaryOperations?.[primaryOperationId]?.status !==
                "completed"
            )
              throw new Error(
                "Feedback review validation checkpoint lacks a completed primary operation",
              );
            const prompt =
              persistedPrompt ??
              buildTaskSessionReviewRepairPrompt({
                projectId: project.id,
                card,
                ...(storedPlan === null
                  ? {}
                  : { approvedPlan: storedPlan.plan }),
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
              card.id,
              {
                model: project.opencode.remediation.model,
                variant: project.opencode.remediation.variant,
                timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
                signal,
                cwd: worktreePath,
                prompt,
              },
              {
                inspect: (sessionId) =>
                  inspectPrimaryOpenCodeSession({
                    commands,
                    cwd: worktreePath,
                    sessionId,
                    signal,
                    timeoutMilliseconds: 30_000,
                  }),
              },
              {
                role: "primary",
                operationId: primaryOperationId,
                activity: "feedback-review-repair",
                inspectPending: (entry) =>
                  inspectPrimaryOperationEvidence(
                    taskStore,
                    card.id,
                    entry.id,
                    {
                      trustedRoot:
                        ProjectRunAuthority.current(options.project.id)?.store
                          .storageRoot ?? getProcessRuntime().artifactRoot,
                      cwd: worktreePath,
                    },
                  ),
              },
            );
            if (repaired.exitCode !== 0)
              throw new Error("Primary feedback review repair failed");
            latest = taskStore.read(card.id);
            if (latest === null)
              throw new Error(
                "Task state disappeared after feedback review repair",
              );
            if (latest.phase === "implementation") {
              const validationPhase = transitionTaskExecutionRecord(latest, {
                type: "implementation-completed",
                eventId: `${operationId}:review-implementation-completed:${attempt}`,
                projectId: project.id,
                cardId: card.id,
                operationKey: latest.operationKey,
                occurredAt: new Date(
                  Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
                ).toISOString(),
              });
              taskStore.compareAndSwap(
                card.id,
                latest.revision,
                validationPhase,
              );
            } else if (latest.phase !== "validation") {
              throw new Error(
                "Task phase changed after feedback review repair",
              );
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
          },
          rerunQuality: async () => {
            await setActivity("validating-review-changes");
            quality = await runTaskSessionValidationWithRepairs({
              validation: validationOptions,
              openCode,
              planStore,
              card,
              expectedPrimarySessionId: record.primarySessionId!,
              inspectPrimarySession: (sessionId) =>
                inspectPrimaryOpenCodeSession({
                  commands,
                  cwd: worktreePath,
                  sessionId,
                  signal,
                  timeoutMilliseconds: 30_000,
                }),
              primaryOperationEvidence: {
                trustedRoot:
                  ProjectRunAuthority.current(project.id)?.store.storageRoot ??
                  getProcessRuntime().artifactRoot,
                cwd: worktreePath,
              },
              ...(attachmentContext === undefined ? {} : { attachmentContext }),
              repairRunOptions: validationRepairRunOptions(project, signal),
            });
          },
          getCurrentContentIdentity: () =>
            getTaskSessionSourceSnapshotIdentity(git, worktreePath),
        });
      }
    } catch (error) {
      if (
        !(error instanceof TaskSessionReviewUnavailableError) ||
        signal.aborted ||
        quality === undefined
      )
        throw error;
      const identity = await getTaskSessionSourceSnapshotIdentity(
        git,
        worktreePath,
      );
      if (
        quality.validation.contentIdentity !== identity ||
        quality.coverage.contentIdentity !== identity
      )
        throw error;
      let current = taskStore.read(card.id);
      if (!current)
        throw new Error("Feedback review state disappeared", { cause: error });
      if (current.phase === "validation")
        current = taskStore.compareAndSwap(
          card.id,
          current.revision,
          transitionTaskExecutionRecord(current, {
            type: "validation-reviewed",
            eventId: `${operationId}:validation-reviewed-unavailable`,
            projectId: project.id,
            cardId: card.id,
            operationKey: current.operationKey,
            occurredAt: new Date(
              Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
            ).toISOString(),
          }),
        );
      updateRecord(taskStore, current, {
        reviewUnavailable: {
          contentIdentity: identity,
          diagnostic: error.message.slice(0, 1000),
        },
      });
      finalReview = { review: null };
      cardLog.warn(
        "Independent feedback review unavailable after bounded attempts; publishing available corrections with disclosure",
      );
    }

    const reviewPassed = finalReview.review?.verdict === "pass";
    const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      worktreePath,
    );
    if (quality === undefined)
      throw new Error(
        "Feedback review completed without current quality evidence",
      );
    const qualityEvidence: VerifiedPublicationDecisionInput = {
      currentContentIdentity: currentIdentity,
      ...(project.repository.validationCommand === undefined
        ? {}
        : { validationCommand: project.repository.validationCommand }),
      validation: quality.validation,
      ...(project.repository.coverageCommand === undefined
        ? {}
        : { coverageCommand: project.repository.coverageCommand }),
      coverage: quality.coverage,
      review: finalReview.review,
    };
    const persistVerification = (
      verification: FeedbackVerificationResult,
    ): void => {
      const currentLedger = ledgerStore.read(card.id);
      if (currentLedger === null)
        throw new Error(
          "Feedback ledger disappeared during disposition verification",
        );
      const byId = new Map(
        verification.dispositions.map((item) => [item.feedbackId, item]),
      );
      const entries = currentLedger.entries.map((entry) => {
        const disposition = byId.get(`${entry.kind}:${entry.id}`);
        if (disposition === undefined) return entry;
        return disposition.status === "verified-fixed"
          ? {
              ...entry,
              status: "verified" as const,
              verificationEvidence: disposition.evidence,
              resolution: disposition.status,
              unresolvedReason: undefined,
            }
          : {
              ...entry,
              status: "escalated" as const,
              unresolvedReason: disposition.reason,
              resolution: disposition.status,
            };
      });
      ledgerStore.compareAndSwap(card.id, currentLedger.revision, {
        ...currentLedger,
        revision: currentLedger.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(currentLedger.updatedAt) + 1),
        ).toISOString(),
        entries,
      });
    };
    let verification = await runAdvisoryTaskSessionFeedbackVerification({
      project,
      card,
      expectedBranch: record.expectedBranch!,
      expectedHeadSha: observation.headSha,
      worktreePath,
      ...(storedPlan === null ? {} : { approvedPlan: storedPlan.plan }),
      actionableFeedback,
      qualityEvidence,
      git,
      openCode,
      runOptions: reviewRunOptions(project, signal),
    });
    persistVerification(verification);
    if (!decideHumanReviewPublication(qualityEvidence, undefined).allowed) {
      throw new Error(
        "Feedback publication evidence does not match the current source",
      );
    }
    let commitMessage = "fix(feedback): address requested changes";
    try {
      commitMessage = await runTaskSessionCommitMessage({
        project,
        card,
        operationKey: record.operationKey,
        commitIntentId: operationId,
        operationId: `${operationId}:commit-message`,
        worktreePath,
        taskRecordStore: taskStore,
        git,
        openCode,
        runOptions: {
          model: project.opencode.commit.model,
          variant: project.opencode.commit.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
          sessionLogPath: getSessionLogPath(project.id, card.id),
          sessionLabel: "Task-session feedback commit message",
        },
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
        "Feedback commit-message generation unavailable; using deterministic message",
      );
    }
    let latest = taskStore.read(card.id);
    if (
      latest === null ||
      (latest.phase !== "review" && latest.phase !== "publication")
    )
      throw new Error("Task state changed before feedback publication");
    if (latest.phase === "review")
      latest = taskStore.compareAndSwap(
        card.id,
        latest.revision,
        transitionTaskExecutionRecord(latest, {
          type:
            finalReview.review === null
              ? "review-unavailable"
              : reviewPassed
                ? "review-passed"
                : "review-exhausted",
          eventId: `${operationId}:review-completed`,
          projectId: project.id,
          cardId: card.id,
          operationKey: latest.operationKey,
          occurredAt: new Date(
            Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
          ).toISOString(),
        }),
      );
    let preparedEvidence = qualityEvidence;
    await setActivity("publishing-review-changes");
    const publishedHead = await publishTaskSessionCard({
      trello,
      git,
      github,
      opencode: openCode,
      commands,
      project,
      card,
      worktreePath,
      branch: record.expectedBranch!,
      expectedExistingPullRequestUrl: record.pullRequest!.url,
      commitMessage,
      reviewResult:
        finalReview.review === null
          ? "Unavailable"
          : reviewPassed
            ? "Passed"
            : "Failed",
      remediationResult:
        "Available feedback corrections for human review; remaining issues are disclosed",
      ...(options.emailNotifier === undefined
        ? {}
        : { emailNotifier: options.emailNotifier }),
      claimHumanReviewNotification: (commitSha) =>
        taskStore.claimHumanReviewNotification(card.id, commitSha),
      verifiedDescriptionFacts: () => [
        storedPlan === null
          ? "No usable implementation plan was available; the original task remains the scope."
          : `Advisory implementation plan: ${JSON.stringify(storedPlan.plan)}`,
        `Verified validation result: ${JSON.stringify(preparedEvidence.validation)}`,
        ...(preparedEvidence.coverage === null
          ? []
          : [
              `Verified coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
            ]),
        `Independent review result: ${JSON.stringify(preparedEvidence.review)}`,
        `Feedback dispositions on the published source: ${JSON.stringify(verification.dispositions)}`,
        "Remediation outcome: available corrections delivered to human review; failed/skipped checks and unresolved findings remain disclosed.",
        ...(taskStore.read(card.id)?.reviewUnavailable === undefined
          ? []
          : [
              `Independent review unavailable: ${taskStore.read(card.id)!.reviewUnavailable!.diagnostic}`,
            ]),
      ],
      signal,
      initialEvidence: qualityEvidence,
      beforeHumanReviewTransition: () =>
        prepareFeedbackCardMove(
          cardLocation,
          project.trello.reviewListId,
          `${operationId}:review`,
        ),
      afterHumanReviewTransition: () =>
        reconcilePendingFeedbackCardMove(cardLocation),
      getPreparedReviewPublication: () => {
        const current = taskStore.read(card.id);
        const material =
          preparedEvidence.review !== null &&
          hasUndisposedReviewConcerns(
            preparedEvidence.review,
            current?.reviewRepair?.findings ?? [],
            current?.reviewRepair?.requirementDispositions ?? [],
          );
        return {
          reviewResult:
            preparedEvidence.review === null
              ? "Unavailable"
              : material
                ? "Failed"
                : preparedEvidence.review.verdict === "pass"
                  ? "Passed"
                  : reviewConcernsDismissedAsNonMaterialLabel,
          reviewDisclosure: material ? preparedEvidence.review : null,
          qualityNeedsDraft:
            !decideValidatedHumanReviewPublication(preparedEvidence).allowed,
          readinessEvidence: preparedEvidence,
        };
      },
      verifyPreparedContent: async () => {
        const validation = await runTaskSessionValidation({
          project,
          cardId: card.id,
          expectedBranch: record.expectedBranch!,
          operationKey: record.operationKey,
          worktreePath,
          taskRecordStore: taskStore,
          git,
          commands,
          signal,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        });
        const coverage = await runTaskSessionCoverage({
          project,
          cardId: card.id,
          expectedBranch: record.expectedBranch!,
          operationKey: record.operationKey,
          worktreePath,
          taskRecordStore: taskStore,
          git,
          commands,
          signal,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        });
        const currentRecord = taskStore.read(card.id);
        if (currentRecord === null)
          throw new Error(
            "Task state disappeared during feedback publication gate",
          );
        persistQualityEvidence(
          taskStore,
          currentRecord,
          operationId,
          validation,
          coverage,
        );
        let review: { review: ImplementationReviewResult | null };
        try {
          review = await runBoundedFeedbackReview({
            project,
            card,
            expectedBranch: record.expectedBranch!,
            operationKey: record.operationKey,
            worktreePath,
            taskRecordStore: taskStore,
            planStore,
            git,
            openCode,
            validation,
            coverage,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            runOptions: reviewRunOptions(project, signal),
          });
        } catch (error) {
          if (!(error instanceof TaskSessionReviewUnavailableError))
            throw error;
          const currentSource = await getTaskSessionSourceSnapshotIdentity(
            git,
            worktreePath,
          );
          if (currentSource !== validation.contentIdentity) throw error;
          cardLog.warn(
            "Prepared AI review unavailable; reporting current review uncertainty",
          );
          review = { review: null };
          const latest = taskStore.read(card.id);
          if (latest)
            updateRecord(taskStore, latest, {
              reviewUnavailable: {
                contentIdentity: currentSource,
                diagnostic: error.message.slice(0, 1000),
              },
            });
        }
        const latestIdentity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktreePath,
        );
        const latestQuality: VerifiedPublicationDecisionInput = {
          currentContentIdentity: latestIdentity,
          ...(project.repository.validationCommand === undefined
            ? {}
            : { validationCommand: project.repository.validationCommand }),
          validation,
          ...(project.repository.coverageCommand === undefined
            ? {}
            : { coverageCommand: project.repository.coverageCommand }),
          coverage,
          review: review.review,
        };
        if (!decideHumanReviewPublication(latestQuality, undefined).allowed)
          throw new Error(
            "Prepared feedback publication source evidence changed",
          );
        const preparedHeadSha = await git.getHeadSha(worktreePath);
        const latestVerification =
          await runAdvisoryTaskSessionFeedbackVerification({
            project,
            card,
            expectedBranch: record.expectedBranch!,
            expectedHeadSha: preparedHeadSha,
            worktreePath,
            ...(storedPlan === null ? {} : { approvedPlan: storedPlan.plan }),
            actionableFeedback,
            qualityEvidence: latestQuality,
            git,
            openCode,
            runOptions: reviewRunOptions(project, signal),
          });
        verification = latestVerification;
        persistVerification(latestVerification);
        const afterVerification = taskStore.read(card.id);
        if (afterVerification === null)
          throw new Error(
            "Task record disappeared while storing prepared publication evidence",
          );
        updateRecord(taskStore, afterVerification, {
          publicationQuality: {
            contentIdentity: latestIdentity,
            validation: {
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
            review: review.review,
          },
        });
        preparedEvidence = latestQuality;
        return preparedEvidence;
      },
    });
    const pr = await github.findPullRequestState({
      cwd: project.repository.path,
      repository: project.repository.github,
      headBranch: record.expectedBranch!,
      baseBranch: project.repository.defaultBranch,
      project,
    });
    if (
      pr === null ||
      pr.url !== record.pullRequest?.url ||
      pr.headRefOid !== publishedHead ||
      pr.state !== "OPEN"
    ) {
      throw new Error(
        "Feedback publication did not update the existing pull request on its new head",
      );
    }
    const latestLedger = ledgerStore.read(card.id);
    if (latestLedger === null)
      throw new Error("Feedback ledger disappeared after publication");
    const attemptedKeys = new Set(
      verification.dispositions.map((item) => item.feedbackId),
    );
    ledgerStore.compareAndSwap(card.id, latestLedger.revision, {
      ...latestLedger,
      revision: latestLedger.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(latestLedger.updatedAt) + 1),
      ).toISOString(),
      entries: latestLedger.entries.map((item) =>
        attemptedKeys.has(`${item.kind}:${item.id}`)
          ? {
              ...item,
              remediationCommitSha: publishedHead,
            }
          : item,
      ),
    });
    latest = taskStore.read(card.id);
    if (latest === null || latest.phase !== "publication")
      throw new Error("Task state changed after feedback publication");
    taskStore.compareAndSwap(
      card.id,
      latest.revision,
      transitionTaskExecutionRecord(latest, {
        type: "publication-completed",
        eventId: `${operationId}:publication-completed`,
        projectId: project.id,
        cardId: card.id,
        operationKey: latest.operationKey,
        occurredAt: new Date(
          Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
        ).toISOString(),
        pullRequest: {
          number: record.pullRequest!.number,
          url: pr.url,
          headSha: publishedHead,
        },
      }),
    );
    options.mutationQueue.complete(operationId);
    return "published";
  } catch (error) {
    cardLog.event("Requested-changes workflow failed");
    if (signal.aborted) {
      if (options.mutationQueue.ownsActive(operationId))
        options.mutationQueue.releaseForRecovery(operationId);
      throw error;
    }
    const current = taskStore.read(card.id);
    if (current !== null && options.retryIntervalMs !== undefined) {
      const disposition = persistPrimaryOperationRecovery(
        taskStore,
        current,
        error,
        options.retryIntervalMs,
      );
      if (disposition === "waiting" || disposition === "published-blockage") {
        if (options.mutationQueue.ownsActive(operationId))
          options.mutationQueue.releaseForRecovery(operationId);
        if (
          disposition === "published-blockage" &&
          taskStore.read(card.id)?.primaryOperations?.[operationId]?.status ===
            "exhausted"
        ) {
          await ensureFeedbackCardLocation(
            cardLocation,
            project.trello.reviewListId,
            `${operationId}:review`,
          );
          await setActivity(null);
        } else if (disposition === "waiting") {
          await setActivity("attention-required");
        }
        return "idle";
      }
    }
    if (options.mutationQueue.ownsActive(operationId)) {
      options.mutationQueue.fail(operationId);
    }
    const unknownExecution = Object.values(
      taskStore.read(card.id)?.primaryOperations ?? {},
    ).some((entry) =>
      ["intent", "dispatched", "ambiguous"].includes(entry.status),
    );
    try {
      await setActivity(unknownExecution ? "attention-required" : null);
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        "Feedback operation and managed activity require reconciliation",
        { cause: statusError },
      );
    }
    throw error;
  }
}
