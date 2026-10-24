import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import type {
  OpenCodeClient,
  OpenCodeRunOptions,
} from "../opencode/opencode-client.js";
import { buildTaskSessionValidationRepairPrompt } from "../opencode/build-task-session-validation-repair-prompt.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import {
  runTaskSessionValidation,
  type RunTaskSessionValidationOptions,
  type TaskSessionValidationResult,
} from "./run-task-session-validation.js";
import type { TaskPlanStore } from "./task-plan-store.js";
import { runWithPrimaryTaskSession } from "./primary-task-session.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";

export const MAX_VALIDATION_REPAIR_ATTEMPTS = 2;

export class StaleTaskSessionValidationEvidenceError extends Error {
  constructor(
    public readonly evidenceIdentity: string,
    public readonly currentIdentity: string,
  ) {
    super(
      `Task-session validation evidence is stale: evidence ${evidenceIdentity}, current source ${currentIdentity}`,
    );
    this.name = "StaleTaskSessionValidationEvidenceError";
  }
}

export class TaskSessionValidationRepairExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly validation?: TaskSessionValidationResult,
  ) {
    super(
      `Task-session validation did not pass after ${attempts} repair attempts`,
    );
    this.name = "TaskSessionValidationRepairExhaustedError";
  }
}

export class TaskSessionValidationRepairError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskSessionValidationRepairError";
  }
}

export interface RunTaskSessionValidationRepairsOptions {
  validation: RunTaskSessionValidationOptions;
  openCode: OpenCodeClient;
  planStore: TaskPlanStore;
  card: TrelloCard;
  expectedPrimarySessionId: string;
  attachmentContext?: CardAttachmentPromptContext;
  repairRunOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId"
  >;
}

export interface TaskSessionValidationRepairResult {
  validation: TaskSessionValidationResult;
  attempts: number;
  record: TaskExecutionRecord;
}

function nextTimestamp(previousTimestamp: string): string {
  return new Date(
    Math.max(Date.now(), Date.parse(previousTimestamp) + 1),
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
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

function validationResultFromEvidence(
  evidence: NonNullable<TaskExecutionRecord["validationRepair"]>["evidence"],
): TaskSessionValidationResult {
  if (evidence === undefined) {
    throw new Error("Passing validation repair state has no evidence");
  }

  return {
    ...evidence,
    status: "passed",
    timedOut: false,
    aborted: false,
  };
}

async function assertValidationPrerequisites(
  options: RunTaskSessionValidationRepairsOptions,
  record: TaskExecutionRecord,
): Promise<void> {
  const { validation, expectedPrimarySessionId, card } = options;

  if (record.phase !== "validation") {
    throw new TaskSessionValidationRepairError(
      `Validation repair requires the validation phase, found ${record.phase}`,
      record.retryCounters.validation,
    );
  }

  if (
    record.primarySessionId === undefined ||
    record.primarySessionId !== expectedPrimarySessionId
  ) {
    throw new TaskSessionValidationRepairError(
      "Refusing validation repair with a mismatched primary session",
      record.retryCounters.validation,
    );
  }

  if (
    record.projectId !== validation.project.id ||
    record.cardId !== card.id ||
    record.operationKey !== validation.operationKey
  ) {
    throw new TaskSessionValidationRepairError(
      "Validation repair task ownership or operation identity does not match",
      record.retryCounters.validation,
    );
  }

  const actualBranch = await validation.git.getCurrentBranch(
    validation.worktreePath,
  );

  if (actualBranch !== validation.expectedBranch) {
    throw new TaskSessionValidationRepairError(
      `Validation repair worktree branch mismatch: expected ${validation.expectedBranch}, found ${actualBranch}`,
      record.retryCounters.validation,
    );
  }
}

export async function runTaskSessionValidationWithRepairs(
  options: RunTaskSessionValidationRepairsOptions,
): Promise<TaskSessionValidationRepairResult> {
  const { validation, openCode, planStore, card, expectedPrimarySessionId } =
    options;
  const { project, cardId, expectedBranch, operationKey, worktreePath } =
    validation;

  if (project.executionMode !== "task-session") {
    throw new TaskSessionValidationRepairError(
      "Validation repair requires task-session mode",
      0,
    );
  }

  if (
    project.repository.validationCommand === undefined ||
    project.repository.validationCommand.trim().length === 0
  ) {
    throw new TaskSessionValidationRepairError(
      "Validation repair requires a nonempty repository.validationCommand",
      0,
    );
  }

  if (
    !Number.isSafeInteger(validation.timeoutMilliseconds) ||
    validation.timeoutMilliseconds < 1
  ) {
    throw new TaskSessionValidationRepairError(
      "Validation repair timeout must be positive",
      0,
    );
  }

  if (card.id !== cardId) {
    throw new TaskSessionValidationRepairError(
      "Validation repair card identity does not match task configuration",
      0,
    );
  }

  assertOwnedTaskWorktreePath(project, worktreePath);

  const record = loadOwnedTaskExecutionRecord(validation.taskRecordStore, {
    projectId: project.id,
    cardId,
    expectedBranch,
    operationKey,
  });
  await assertValidationPrerequisites(options, record);

  const plan = planStore.read(cardId);

  if (
    plan === null ||
    plan.plan.projectId !== project.id ||
    plan.plan.cardId !== cardId ||
    plan.verification?.verdict !== "pass"
  ) {
    throw new TaskSessionValidationRepairError(
      "Validation repair requires the persisted plan to have passed independent verification",
      record.retryCounters.validation,
    );
  }

  const cycleId = operationKey;
  let currentRecord = record;
  let repairState = currentRecord.validationRepair;

  if (repairState?.cycleId !== cycleId) {
    currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
      retryCounters: {
        ...currentRecord.retryCounters,
        validation: 0,
      },
      validationRepair: { cycleId, status: "active" },
    });
    repairState = currentRecord.validationRepair;
  }

  if (repairState?.status === "exhausted") {
    throw new TaskSessionValidationRepairExhaustedError(
      currentRecord.retryCounters.validation,
    );
  }

  if (repairState?.status === "passed") {
    await assertValidationPrerequisites(options, currentRecord);
    const evidence = validationResultFromEvidence(repairState.evidence);
    const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
      validation.git,
      worktreePath,
    );

    if (currentIdentity !== evidence.contentIdentity) {
      throw new StaleTaskSessionValidationEvidenceError(
        evidence.contentIdentity,
        currentIdentity,
      );
    }

    return {
      validation: evidence,
      attempts: currentRecord.retryCounters.validation,
      record: currentRecord,
    };
  }

  while (true) {
    const validationResult = await runTaskSessionValidation(validation);

    if (validationResult.status === "passed") {
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        validation.git,
        worktreePath,
      );

      if (currentIdentity !== validationResult.contentIdentity) {
        throw new StaleTaskSessionValidationEvidenceError(
          validationResult.contentIdentity,
          currentIdentity,
        );
      }

      const latestRecord = validation.taskRecordStore.read(cardId);

      if (
        latestRecord === null ||
        latestRecord.revision !== currentRecord.revision ||
        latestRecord.operationKey !== operationKey ||
        latestRecord.primarySessionId !== expectedPrimarySessionId
      ) {
        throw new TaskSessionValidationRepairError(
          "Task ownership changed before passing validation evidence could be persisted",
          currentRecord.retryCounters.validation,
        );
      }

      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: {
          cycleId,
          status: "passed",
          evidence: {
            command: validationResult.command,
            startedAt: validationResult.startedAt,
            completedAt: validationResult.completedAt,
            exitCode: 0,
            diagnostic: validationResult.diagnostic,
            contentIdentity: validationResult.contentIdentity,
          },
        },
      });

      return {
        validation: validationResult,
        attempts: currentRecord.retryCounters.validation,
        record: currentRecord,
      };
    }

    const attempts = currentRecord.retryCounters.validation;

    if (attempts >= MAX_VALIDATION_REPAIR_ATTEMPTS) {
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: { cycleId, status: "exhausted" },
      });
      throw new TaskSessionValidationRepairExhaustedError(
        currentRecord.retryCounters.validation,
        validationResult,
      );
    }

    currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
      retryCounters: {
        ...currentRecord.retryCounters,
        validation: attempts + 1,
      },
      validationRepair: { cycleId, status: "active" },
    });

    const prompt = buildTaskSessionValidationRepairPrompt({
      projectId: project.id,
      card,
      approvedPlan: plan.plan,
      validation: validationResult,
      attempt: attempts + 1,
      maxAttempts: MAX_VALIDATION_REPAIR_ATTEMPTS,
      ...(options.attachmentContext === undefined
        ? {}
        : { attachmentContext: options.attachmentContext }),
    });

    const repairRecord = loadOwnedTaskExecutionRecord(
      validation.taskRecordStore,
      {
        projectId: project.id,
        cardId,
        expectedBranch,
        operationKey,
      },
    );
    await assertValidationPrerequisites(options, repairRecord);

    try {
      await runWithPrimaryTaskSession(
        validation.taskRecordStore,
        openCode,
        project.id,
        cardId,
        {
          ...options.repairRunOptions,
          cwd: worktreePath,
          prompt,
        },
      );
    } catch (error) {
      throw new TaskSessionValidationRepairError(
        `Primary-session validation repair attempt ${attempts + 1} did not complete; work and attempt state are preserved`,
        attempts + 1,
        { cause: error },
      );
    }

    currentRecord = validation.taskRecordStore.read(cardId) ?? currentRecord;
    await assertValidationPrerequisites(options, currentRecord);
  }
}
