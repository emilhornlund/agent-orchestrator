import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import type {
  OpenCodeClient,
  OpenCodeRunOptions,
  OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import { buildTaskSessionFeedbackRemediationPrompt } from "../opencode/build-task-session-feedback-remediation-prompt.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { TaskPlanStore } from "./task-plan-store.js";
import { FeedbackLedgerStore } from "./feedback-ledger-store.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { runWithPrimaryTaskSession } from "./primary-task-session.js";
import { inspectPrimaryOperationEvidence } from "./inspect-primary-operation.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import type { PrimarySessionRecoveryOptions } from "./primary-task-session.js";
import { findPrimaryRecoveryError } from "./persist-primary-operation-recovery.js";

export class TaskSessionFeedbackRemediationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskSessionFeedbackRemediationError";
  }
}

export interface RunTaskSessionFeedbackRemediationOptions {
  project: import("../config/config.js").ProjectConfig;
  card: TrelloCard;
  expectedBranch: string;
  operationKey: string;
  operationId: string;
  expectedPrimarySessionId: string;
  inspectPrimarySession?: NonNullable<PrimarySessionRecoveryOptions["inspect"]>;
  expectedPullRequestHeadSha: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  planStore: TaskPlanStore;
  feedbackLedgerStore: FeedbackLedgerStore;
  git: Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
  >;
  openCode: OpenCodeClient;
  attachmentContext?: CardAttachmentPromptContext;
  runOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId"
  >;
}

export interface TaskSessionFeedbackRemediationResult {
  status: "changed" | "no-op";
  feedbackChangedDuringRun: boolean;
  remainingActionableFeedback: number;
  ledgerRevision: number;
  runResult: OpenCodeRunResult;
  record: TaskExecutionRecord;
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
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
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

export async function runTaskSessionFeedbackRemediation(
  options: RunTaskSessionFeedbackRemediationOptions,
): Promise<TaskSessionFeedbackRemediationResult> {
  assertOwnedTaskWorktreePath(options.project, options.worktreePath);
  const record = loadOwnedTaskExecutionRecord(options.taskRecordStore, {
    projectId: options.project.id,
    cardId: options.card.id,
    expectedBranch: options.expectedBranch,
    operationKey: options.operationKey,
  });
  if (
    record.phase !== "human-feedback" ||
    record.primarySessionId !== options.expectedPrimarySessionId ||
    record.pullRequest?.headSha !== options.expectedPullRequestHeadSha
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation phase, primary session, or PR head does not match the task record",
    );
  }
  const priorFeedback = record.feedbackRemediation;
  if (
    priorFeedback?.operationId === options.operationId &&
    (priorFeedback.status !== "active" ||
      record.primaryOperations?.[options.operationId]?.activity !==
        "feedback-remediation")
  ) {
    throw new TaskSessionFeedbackRemediationError(
      `Feedback remediation operation ${options.operationId} is not authorized for exact primary-ledger continuation`,
    );
  }
  if (
    priorFeedback?.status === "active" &&
    priorFeedback.operationId !== options.operationId
  )
    throw new TaskSessionFeedbackRemediationError(
      `Active feedback remediation operation ${priorFeedback.operationId} cannot be replaced`,
    );
  if (
    (await options.git.getCurrentBranch(options.worktreePath)) !==
    options.expectedBranch
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation worktree branch does not match the owned task branch",
    );
  }
  const plan = options.planStore.read(options.card.id);
  if (
    plan !== null &&
    (plan.plan.projectId !== options.project.id ||
      plan.plan.cardId !== options.card.id)
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation task plan identity does not match task ownership",
    );
  }
  const ledger = options.feedbackLedgerStore.read(options.card.id);
  if (
    ledger === null ||
    ledger.projectId !== options.project.id ||
    ledger.cardId !== options.card.id
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation requires the owned feedback ledger",
    );
  }
  const pending = ledger.entries.filter(
    (entry) =>
      entry.actionability === "actionable" && entry.status === "pending",
  );
  if (pending.length === 0) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation requires pending actionable feedback",
    );
  }
  const beforeIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  updateRecord(options.taskRecordStore, record, {
    feedbackRemediation: {
      operationId: options.operationId,
      status: "active",
      headSha: options.expectedPullRequestHeadSha,
      ledgerRevision: ledger.revision,
    },
  });
  const prompt = buildTaskSessionFeedbackRemediationPrompt({
    projectId: options.project.id,
    card: options.card,
    ...(plan === null ? {} : { approvedPlan: plan.plan }),
    currentHeadSha: options.expectedPullRequestHeadSha,
    operationId: options.operationId,
    actionableFeedback: pending,
    ...(options.attachmentContext === undefined
      ? {}
      : { attachmentContext: options.attachmentContext }),
  });
  let runResult: OpenCodeRunResult;
  try {
    runResult = await runWithPrimaryTaskSession(
      options.taskRecordStore,
      options.openCode,
      options.project.id,
      options.card.id,
      { ...options.runOptions, cwd: options.worktreePath, prompt },
      options.inspectPrimarySession === undefined
        ? {}
        : { inspect: options.inspectPrimarySession },
      {
        role: "primary",
        operationId: options.operationId,
        activity: "feedback-remediation",
        inspectPending: (entry) =>
          inspectPrimaryOperationEvidence(
            options.taskRecordStore,
            options.card.id,
            entry.id,
            {
              trustedRoot:
                ProjectRunAuthority.current(options.project.id)?.store
                  .storageRoot ?? getProcessRuntime().artifactRoot,
              cwd: options.worktreePath,
            },
          ),
      },
    );
    if (runResult.exitCode !== 0)
      throw new Error(
        `Primary session feedback remediation exited with code ${runResult.exitCode}`,
      );
  } catch (error) {
    const current = options.taskRecordStore.read(options.card.id);
    const primaryRecovery = findPrimaryRecoveryError(error);
    if (
      primaryRecovery === undefined &&
      current !== null &&
      current.feedbackRemediation?.operationId === options.operationId
    ) {
      updateRecord(options.taskRecordStore, current, {
        feedbackRemediation: {
          ...current.feedbackRemediation,
          status: "failed",
        },
      });
    }
    throw new TaskSessionFeedbackRemediationError(
      "Primary-session feedback remediation failed; changes and ledger state are preserved",
      { cause: error },
    );
  }
  const current = loadOwnedTaskExecutionRecord(options.taskRecordStore, {
    projectId: options.project.id,
    cardId: options.card.id,
    expectedBranch: options.expectedBranch,
    operationKey: options.operationKey,
  });
  if (
    current.phase !== "human-feedback" ||
    current.primarySessionId !== options.expectedPrimarySessionId ||
    current.feedbackRemediation?.operationId !== options.operationId
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Task ownership changed before feedback remediation completion was recorded",
    );
  }
  const afterIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  const latestLedger = options.feedbackLedgerStore.read(options.card.id);
  if (latestLedger === null)
    throw new TaskSessionFeedbackRemediationError(
      "Feedback ledger disappeared during remediation",
    );
  const updatedRecord = updateRecord(options.taskRecordStore, current, {
    feedbackRemediation: {
      operationId: options.operationId,
      status: beforeIdentity === afterIdentity ? "no-op" : "changed",
      headSha: options.expectedPullRequestHeadSha,
      ledgerRevision: latestLedger.revision,
    },
  });
  return {
    status: beforeIdentity === afterIdentity ? "no-op" : "changed",
    feedbackChangedDuringRun: latestLedger.revision !== ledger.revision,
    remainingActionableFeedback: latestLedger.entries.filter(
      (entry) =>
        entry.actionability === "actionable" && entry.status === "pending",
    ).length,
    ledgerRevision: latestLedger.revision,
    runResult,
    record: updatedRecord,
  };
}
