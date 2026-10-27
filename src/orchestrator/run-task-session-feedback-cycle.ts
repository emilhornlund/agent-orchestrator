import { createHash } from "node:crypto";
import type { ProjectConfig } from "../config/config.js";
import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { buildCommitPrompt } from "../opencode/build-commit-prompt.js";
import {
  captureRepositorySnapshot,
  clearCommitResult,
  readCommitResult,
  repositorySnapshotsEqual,
} from "../opencode/commit-result.js";
import { buildTaskSessionReviewRepairPrompt } from "../opencode/build-task-session-review-repair-prompt.js";
import type { CommandRunner } from "../process/command-runner.js";
import type { TrelloCard, TrelloClient } from "../trello/trello-client.js";
import type { ObservedTaskSessionReviewCard } from "./observe-task-session-review-cards.js";
import { runTaskSessionFeedbackRemediation } from "../task-session/run-task-session-feedback-remediation.js";
import { runAdvisoryTaskSessionFeedbackVerification } from "../task-session/run-task-session-feedback-verification.js";
import { publishVerifiedFeedbackReplies } from "../task-session/publish-verified-feedback-replies.js";
import type { FeedbackVerificationResult } from "../task-session/feedback-verification.js";
import { reconcileFeedbackRound } from "../task-session/reconcile-feedback-round.js";
import {
  selectActionableFeedback,
  type ConversationClassification,
} from "../task-session/select-actionable-feedback.js";
import { FeedbackLedgerStore } from "../task-session/feedback-ledger-store.js";
import type { FeedbackLedgerEntry } from "../task-session/feedback-ledger.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import { TaskPlanStore } from "../task-session/task-plan-store.js";
import { transitionTaskExecutionRecord } from "../task-session/task-execution-transition.js";
import { runWithPrimaryTaskSession } from "../task-session/primary-task-session.js";
import { runTaskSessionValidationWithRepairs } from "../task-session/run-task-session-validation-repairs.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import { runTaskSessionValidation } from "../task-session/run-task-session-validation.js";
import { runTaskSessionCoverage } from "../task-session/run-task-session-coverage.js";
import {
  runTaskSessionReview,
  TaskSessionReviewUnavailableError,
} from "../task-session/run-task-session-review.js";
import { runTaskSessionReviewWithRepairs } from "../task-session/run-task-session-review-repairs.js";
import {
  decideValidatedHumanReviewPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import { getTaskSessionSourceSnapshotIdentity } from "../task-session/source-snapshot.js";
import { publishTaskSessionCard } from "./publish-task-session-card.js";

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

function toFeedbackEntries(
  observation: ObservedTaskSessionReviewCard,
): FeedbackLedgerEntry[] {
  const entries: FeedbackLedgerEntry[] = [];
  for (const review of observation.requestedChanges?.feedback.reviews ?? []) {
    if (review.body !== null && review.body.trim().length > 0) {
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
        actionability:
          review.source === "carried-forward" ? "not-actionable" : "actionable",
        status: "pending",
        verificationEvidence: [],
      });
    }
    for (const comment of review.inlineComments) {
      if (comment.id === undefined) continue;
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
            : "actionable",
        status: "pending",
        verificationEvidence: [],
      });
    }
  }
  for (const comment of observation.conversationComments) {
    if (comment.body.includes("<!-- agent-orchestrator-feedback:")) continue;
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
  if (
    record === null ||
    (record.phase !== "human-feedback" && record.phase !== "review") ||
    record.pullRequest?.headSha !== observation.headSha
  ) {
    throw new Error(
      "Feedback round task record does not match the current owned PR head",
    );
  }
  const recoveringReview = record.phase === "review";
  if (
    recoveringReview &&
    (record.reviewRepair?.status !== "exhausted" ||
      record.reviewRepair.finalReview?.verdict !== "fail")
  )
    throw new Error(
      "Feedback review checkpoint is not eligible for exhausted-review recovery",
    );
  const storedPlan = planStore.read(card.id);
  if (storedPlan === null || storedPlan.verification?.verdict !== "pass")
    throw new Error(
      "Feedback remediation requires an independently verified plan",
    );
  const ledgerBeforeSync = ledgerStore.read(card.id);
  const checksReady = observation.ciEvaluation.status === "passed";
  if (
    checksReady &&
    ledgerBeforeSync !== null &&
    record.publicationQuality !== undefined
  ) {
    const replyOperationFeedbackIds = ledgerBeforeSync.entries
      .filter(
        (entry) =>
          entry.actionability === "actionable" &&
          (entry.status === "verified" || entry.status === "published") &&
          entry.remediationCommitSha === observation.headSha,
      )
      .map((entry) => `${entry.kind}:${entry.id}`)
      .sort();
    const verifiedFeedbackIds = ledgerBeforeSync.entries
      .filter(
        (entry) =>
          entry.actionability === "actionable" &&
          entry.status === "verified" &&
          entry.remediationCommitSha === observation.headSha,
      )
      .map((entry) => `${entry.kind}:${entry.id}`)
      .sort();
    const replyOperationId = `feedback-replies:${observation.headSha}:${createHash("sha256").update(replyOperationFeedbackIds.join("\n")).digest("hex").slice(0, 16)}`;
    if (verifiedFeedbackIds.length > 0) {
      options.mutationQueue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: replyOperationId,
        operationKey: replyOperationId,
        kind: "feedback",
        enqueuedAt: record.createdAt,
      });
      const owner = options.mutationQueue.claimForRecovery(replyOperationId);
      if (owner === null || owner.eventId !== replyOperationId) return "idle";
    }
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
          .filter((entry) => entry.actionability === "actionable")
          .map((entry) => {
            const feedbackId = `${entry.kind}:${entry.id}`;
            if (
              (entry.status === "verified" || entry.status === "published") &&
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
              status: "unresolved" as const,
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
          if (entry.kind === "conversation-comment") {
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
          return {
            status: "unknown" as const,
            reason:
              "No contextual reply operation exists for this feedback kind",
          };
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
          if (entry.kind === "conversation-comment") {
            const reply = await github.replyToConversationComment({
              cwd: project.repository.path,
              repository: project.repository.github,
              pullRequestUrl: record.pullRequest!.url,
              body,
              project,
            });
            return reply.id;
          }
          throw new Error(
            "No contextual reply operation exists for this feedback kind",
          );
        },
      });
      const cannotReply = replyResult.unresolvedFeedbackIds.find((id) =>
        verifiedFeedbackIds.includes(id),
      );
      if (cannotReply !== undefined) {
        const latest = taskStore.read(card.id);
        if (latest !== null && latest.phase === "human-feedback") {
          taskStore.compareAndSwap(
            card.id,
            latest.revision,
            transitionTaskExecutionRecord(latest, {
              type: "attention-required",
              eventId: `${replyOperationId}:unreplyable`,
              projectId: project.id,
              cardId: card.id,
              operationKey: latest.operationKey,
              occurredAt: new Date(
                Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
              ).toISOString(),
            }),
          );
        }
        if (verifiedFeedbackIds.length > 0)
          options.mutationQueue.fail(replyOperationId);
        return "attention-required";
      }
      if (verifiedFeedbackIds.length > 0)
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
      if (
        verifiedFeedbackIds.length > 0 &&
        options.mutationQueue.ownsActive(replyOperationId)
      ) {
        options.mutationQueue.fail(replyOperationId);
      }
      throw error;
    }
  }
  const previousHead = record.pullRequest.headSha;
  const incoming = toFeedbackEntries(observation);
  const reconciliation =
    ledgerStore.read(card.id) === null
      ? null
      : reconcileFeedbackRound({
          store: ledgerStore,
          projectId: project.id,
          cardId: card.id,
          previousHeadSha: previousHead,
          observedHeadSha: observation.headSha,
          newlyObservedFeedback: incoming,
        });
  if (reconciliation === null) ledgerStore.create(card.id, incoming);
  const ledger = ledgerStore.read(card.id);
  if (ledger === null)
    throw new Error("Feedback ledger could not be loaded after observation");
  const classifications = Object.fromEntries(
    ledger.entries
      .filter(
        (item) =>
          item.kind === "conversation-comment" &&
          (item.actionability === "actionable" ||
            item.actionability === "discussion" ||
            item.actionability === "not-actionable"),
      )
      .map((item) => [
        `conversation-comment:${item.id}`,
        item.actionability as ConversationClassification,
      ]),
  ) as Readonly<Record<string, ConversationClassification>>;
  const externalComments = observation.conversationComments.filter(
    (comment) => !comment.body.includes("<!-- agent-orchestrator-feedback:"),
  );
  const selection = selectActionableFeedback({
    currentHeadSha: observation.headSha,
    botAuthor: "__automation_replies_are_filtered_by_marker__",
    reviews: observation.requestedChanges?.feedback.reviews ?? [],
    conversationComments: externalComments,
    conversationClassifications: classifications,
  });
  if (selection.attentionNeeded.length > 0) {
    const latest = taskStore.read(card.id);
    if (latest !== null && latest.phase === "human-feedback") {
      taskStore.compareAndSwap(
        card.id,
        latest.revision,
        transitionTaskExecutionRecord(latest, {
          type: "attention-required",
          eventId: `${latest.operationKey}:feedback-ambiguous:${ledger.revision}`,
          projectId: project.id,
          cardId: card.id,
          operationKey: latest.operationKey,
          occurredAt: new Date(
            Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
          ).toISOString(),
        }),
      );
    }
    return "attention-required";
  }
  const pendingIds = new Set(selection.actionable.map((item) => item.key));
  const actionableFeedback = ledger.entries.filter(
    (item) =>
      pendingIds.has(`${item.kind}:${item.id}`) &&
      item.status === "pending" &&
      item.actionability === "actionable",
  );
  if (actionableFeedback.length === 0) return "idle";
  cardLog.event(
    `Requested-changes remediation started (${actionableFeedback.length} actionable item(s))`,
  );
  const operationId = `feedback:${observation.headSha}:${createHash("sha256")
    .update(
      actionableFeedback
        .map((item) => `${item.kind}:${item.id}:${item.body}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16)}`;
  if (
    !recoveringReview &&
    record.feedbackRemediation?.operationId === operationId
  ) {
    if (record.feedbackRemediation.status === "active") {
      throw new Error(
        "Feedback remediation outcome is active and ambiguous; refusing duplicate execution",
      );
    }
    return "idle";
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
  try {
    const attachmentContext =
      options.prepareAttachmentContext === undefined
        ? options.attachmentContext
        : await options.prepareAttachmentContext();
    let quality: {
      validation: TaskSessionValidationResult;
      coverage: TaskSessionValidationResult | null;
    };
    let finalReview: { review: ImplementationReviewResult };
    if (recoveringReview) {
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
      const remediation = await runTaskSessionFeedbackRemediation({
        project,
        card,
        expectedBranch: record.expectedBranch!,
        operationKey: record.operationKey,
        operationId,
        expectedPrimarySessionId: record.primarySessionId!,
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
        options.mutationQueue.complete(operationId);
        return "remediated";
      }
      let current = taskStore.read(card.id);
      if (current === null)
        throw new Error("Task record disappeared after feedback remediation");
      current = updateRecord(taskStore, current, {
        ciRepair: undefined,
        reviewObservation: undefined,
        publicationQuality: undefined,
        reviewRepair: undefined,
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
      const implementationCompleted = transitionTaskExecutionRecord(current, {
        type: "implementation-completed",
        eventId: `${operationId}:implementation-completed`,
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
        implementationCompleted,
      );
      current = taskStore.compareAndSwap(card.id, current.revision, {
        ...current,
        validationRepair: { cycleId: operationId, status: "active" },
        retryCounters: { ...current.retryCounters, validation: 0 },
        revision: current.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
        ).toISOString(),
      });
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
      quality = await runTaskSessionValidationWithRepairs({
        validation: validationOptions,
        openCode,
        planStore,
        card,
        expectedPrimarySessionId: record.primarySessionId!,
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        repairRunOptions: validationRepairRunOptions(project, signal),
      });
      let firstReview = await runTaskSessionReview({
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
        ...(attachmentContext === undefined ? {} : { attachmentContext }),
        runOptions: reviewRunOptions(project, signal),
      });
      let roundIndex = 0;
      finalReview = await runTaskSessionReviewWithRepairs({
        maxAttempts: project.opencode.remediation.maxPasses,
        store: taskStore,
        projectId: project.id,
        cardId: card.id,
        operationKey: record.operationKey,
        expectedPrimarySessionId: record.primarySessionId!,
        runReview: async () => {
          if (roundIndex++ === 0)
            return {
              review: firstReview.review,
              contentIdentity: firstReview.contentIdentity,
            };
          firstReview = await runTaskSessionReview({
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
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            runOptions: reviewRunOptions(project, signal),
          });
          return {
            review: firstReview.review,
            contentIdentity: firstReview.contentIdentity,
          };
        },
        repair: async (review, attempt) => {
          let latest = taskStore.read(card.id);
          if (latest === null)
            throw new Error(
              "Task state disappeared during feedback review repair",
            );
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
          const prompt = buildTaskSessionReviewRepairPrompt({
            projectId: project.id,
            card,
            approvedPlan: storedPlan.plan,
            review,
            attempt,
            maxAttempts: project.opencode.remediation.maxPasses,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
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
            throw new Error("Primary feedback review repair failed");
          latest = taskStore.read(card.id);
          if (latest === null)
            throw new Error(
              "Task state disappeared after feedback review repair",
            );
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
          latest = taskStore.compareAndSwap(
            card.id,
            latest.revision,
            validationPhase,
          );
          taskStore.compareAndSwap(card.id, latest.revision, {
            ...latest,
            validationRepair: { cycleId: operationId, status: "active" },
            retryCounters: { ...latest.retryCounters, validation: 0 },
            revision: latest.revision + 1,
            updatedAt: new Date(
              Math.max(Date.now(), Date.parse(latest.updatedAt) + 1),
            ).toISOString(),
          });
        },
        rerunQuality: async () => {
          quality = await runTaskSessionValidationWithRepairs({
            validation: validationOptions,
            openCode,
            planStore,
            card,
            expectedPrimarySessionId: record.primarySessionId!,
            ...(attachmentContext === undefined ? {} : { attachmentContext }),
            repairRunOptions: validationRepairRunOptions(project, signal),
          });
        },
        getCurrentContentIdentity: () =>
          getTaskSessionSourceSnapshotIdentity(git, worktreePath),
      });
    }

    const reviewPassed = finalReview.review.verdict === "pass";
    const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      worktreePath,
    );
    const qualityEvidence: VerifiedPublicationDecisionInput = {
      currentContentIdentity: currentIdentity,
      validationCommand: project.repository.validationCommand!,
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
              unresolvedReason: undefined,
            }
          : {
              ...entry,
              status: "escalated" as const,
              unresolvedReason: disposition.reason,
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
      approvedPlan: storedPlan.plan,
      actionableFeedback,
      qualityEvidence,
      git,
      openCode,
      runOptions: reviewRunOptions(project, signal),
    });
    persistVerification(verification);
    if (!decideValidatedHumanReviewPublication(qualityEvidence).allowed) {
      throw new Error(
        "Feedback remediation has not passed current local quality and review gates",
      );
    }
    const snapshotBeforeCommitMessage = await captureRepositorySnapshot(
      git,
      worktreePath,
    );
    clearCommitResult(worktreePath);
    let commitMessage = "fix(feedback): address requested changes";
    try {
      const commitResult = await runWithPrimaryTaskSession(
        taskStore,
        openCode,
        project.id,
        card.id,
        {
          model: project.opencode.commit.model,
          variant: project.opencode.commit.variant,
          timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
          signal,
          sessionLogPath: getSessionLogPath(project.id, card.id),
          sessionLabel: "Task-session feedback commit message",
          cwd: worktreePath,
          prompt: buildCommitPrompt(card),
        },
      );
      if (commitResult.exitCode === 0) {
        commitMessage = readCommitResult(worktreePath).message;
      } else {
        cardLog.warn(
          "Feedback commit-message agent unavailable; using deterministic message",
        );
      }
    } catch (error) {
      if (signal.aborted) throw error;
      cardLog.warn(
        "Feedback commit-message generation unavailable; using deterministic message",
      );
    } finally {
      clearCommitResult(worktreePath);
    }
    if (
      !repositorySnapshotsEqual(
        snapshotBeforeCommitMessage,
        await captureRepositorySnapshot(git, worktreePath),
      )
    ) {
      throw new Error("Feedback commit-message session modified source files");
    }
    let latest = taskStore.read(card.id);
    if (latest === null || latest.phase !== "review")
      throw new Error("Task state changed before feedback publication");
    latest = taskStore.compareAndSwap(
      card.id,
      latest.revision,
      transitionTaskExecutionRecord(latest, {
        type: reviewPassed ? "review-passed" : "review-exhausted",
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
    const publishedHead = await publishTaskSessionCard({
      trello,
      git,
      github,
      opencode: openCode,
      commands,
      project: { ...project, autoMerge: false },
      card,
      worktreePath,
      branch: record.expectedBranch!,
      expectedExistingPullRequestUrl: record.pullRequest!.url,
      commitMessage,
      reviewResult: reviewPassed ? "Passed" : "Failed",
      remediationResult: "Validated feedback corrections for human review",
      ...(options.emailNotifier === undefined
        ? {}
        : { emailNotifier: options.emailNotifier }),
      claimHumanReviewNotification: (commitSha) =>
        taskStore.claimHumanReviewNotification(card.id, commitSha),
      verifiedDescriptionFacts: () => [
        `Approved implementation plan: ${JSON.stringify(storedPlan.plan)}`,
        `Verified validation result: ${JSON.stringify(preparedEvidence.validation)}`,
        ...(preparedEvidence.coverage === null
          ? []
          : [
              `Verified coverage result: ${JSON.stringify(preparedEvidence.coverage)}`,
            ]),
        `Independent review result: ${JSON.stringify(preparedEvidence.review)}`,
        "Remediation outcome: validated corrections delivered to human review; unresolved findings remain disclosed.",
      ],
      signal,
      initialEvidence: qualityEvidence,
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
        if (
          validation.status !== "passed" ||
          (coverage !== null && coverage.status !== "passed")
        ) {
          throw new Error("Prepared feedback publication quality gates failed");
        }
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
        let review: { review: ImplementationReviewResult } = {
          review: finalReview.review,
        };
        try {
          review = await runTaskSessionReview({
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
            "Prepared AI review unavailable; retaining advisory review findings",
          );
        }
        const latestIdentity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktreePath,
        );
        const latestQuality: VerifiedPublicationDecisionInput = {
          currentContentIdentity: latestIdentity,
          validationCommand: project.repository.validationCommand!,
          validation,
          ...(project.repository.coverageCommand === undefined
            ? {}
            : { coverageCommand: project.repository.coverageCommand }),
          coverage,
          review: review.review,
        };
        if (!decideValidatedHumanReviewPublication(latestQuality).allowed)
          throw new Error("Prepared feedback publication review failed");
        const preparedHeadSha = await git.getHeadSha(worktreePath);
        const latestVerification =
          await runAdvisoryTaskSessionFeedbackVerification({
            project,
            card,
            expectedBranch: record.expectedBranch!,
            expectedHeadSha: preparedHeadSha,
            worktreePath,
            approvedPlan: storedPlan.plan,
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
                    exitCode: 0,
                    diagnostic: coverage.diagnostic,
                    contentIdentity: coverage.contentIdentity,
                  },
                }),
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
    const verifiedKeys = new Set(
      verification.dispositions
        .filter((item) => item.status === "verified-fixed")
        .map((item) => item.feedbackId),
    );
    ledgerStore.compareAndSwap(card.id, latestLedger.revision, {
      ...latestLedger,
      revision: latestLedger.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(latestLedger.updatedAt) + 1),
      ).toISOString(),
      entries: latestLedger.entries.map((item) =>
        verifiedKeys.has(`${item.kind}:${item.id}`)
          ? {
              ...item,
              status: "verified" as const,
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
    if (options.mutationQueue.ownsActive(operationId)) {
      options.mutationQueue.fail(operationId);
    }
    throw error;
  }
}
