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
  if (options.project.executionMode !== "task-session") {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation requires task-session mode",
    );
  }
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
  if (record.feedbackRemediation?.status === "active") {
    throw new TaskSessionFeedbackRemediationError(
      `Feedback remediation operation ${record.feedbackRemediation.operationId} has an ambiguous active outcome; refusing to start another operation`,
    );
  }
  if (record.feedbackRemediation?.operationId === options.operationId) {
    throw new TaskSessionFeedbackRemediationError(
      `Feedback remediation operation ID was already recorded: ${options.operationId}`,
    );
  }
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
    plan === null ||
    plan.plan.projectId !== options.project.id ||
    plan.plan.cardId !== options.card.id ||
    plan.verification?.verdict !== "pass"
  ) {
    throw new TaskSessionFeedbackRemediationError(
      "Feedback remediation requires an approved, independently verified plan",
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
    approvedPlan: plan.plan,
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
    );
    if (runResult.exitCode !== 0)
      throw new Error(
        `Primary session feedback remediation exited with code ${runResult.exitCode}`,
      );
  } catch (error) {
    const current = options.taskRecordStore.read(options.card.id);
    if (
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
