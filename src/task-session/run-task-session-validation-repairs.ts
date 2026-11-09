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
import { runTaskSessionCoverage } from "./run-task-session-coverage.js";
import type { TaskPlanStore } from "./task-plan-store.js";
import { runWithPrimaryTaskSession } from "./primary-task-session.js";
import { inspectPrimaryOperationEvidence } from "./inspect-primary-operation.js";
import type { PrimarySessionRecoveryOptions } from "./primary-task-session.js";
import type { PendingPrimaryInspection } from "./run-primary-operation.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { createHash } from "node:crypto";

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
    public readonly coverage?: TaskSessionValidationResult | null,
  ) {
    super(
      `Task-session local quality gates did not pass after ${attempts} repair attempts`,
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
  primaryOperationEvidence?: { trustedRoot: string; cwd?: string };
  inspectPrimaryOperation?: (
    operationId: string,
    entry: NonNullable<
      NonNullable<TaskExecutionRecord["primaryOperations"]>[string]
    >,
  ) => Promise<PendingPrimaryInspection>;
  inspectPrimarySession?: NonNullable<PrimarySessionRecoveryOptions["inspect"]>;
}

export interface TaskSessionValidationRepairResult {
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult;
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

  const status =
    evidence.status ??
    (evidence.exitCode === 0 && evidence.command.trim().length > 0
      ? "passed"
      : "uncertain");
  return {
    ...evidence,
    status,
    timedOut: status === "timed-out",
    aborted: status === "aborted",
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
    plan !== null &&
    (plan.plan.projectId !== project.id || plan.plan.cardId !== cardId)
  )
    throw new TaskSessionValidationRepairError(
      "Validation repair plan identity does not match the owned task",
      record.retryCounters.validation,
    );

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
    // Recovery may observe failed quality again, but must not invoke AI
    // remediation beyond the durable limit.
    return {
      validation: await runTaskSessionValidation(validation),
      coverage: await runTaskSessionCoverage(validation),
      attempts: currentRecord.retryCounters.validation,
      record: currentRecord,
    };
  }

  if (repairState?.status === "passed") {
    await assertValidationPrerequisites(options, currentRecord);
    const evidence = validationResultFromEvidence(repairState.evidence);
    const coverageCommand = project.repository.coverageCommand;
    const coverageEvidence = repairState.coverageEvidence;
    const coverageIsCurrent =
      coverageCommand === undefined ||
      (coverageEvidence !== undefined &&
        coverageEvidence.command === coverageCommand);

    if (!coverageIsCurrent) {
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: { cycleId, status: "active" },
      });
    } else {
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        validation.git,
        worktreePath,
      );

      if (
        currentIdentity !== evidence.contentIdentity ||
        (coverageEvidence !== undefined &&
          currentIdentity !== coverageEvidence.contentIdentity)
      ) {
        throw new StaleTaskSessionValidationEvidenceError(
          coverageEvidence !== undefined &&
            currentIdentity !== coverageEvidence.contentIdentity
            ? coverageEvidence.contentIdentity
            : evidence.contentIdentity,
          currentIdentity,
        );
      }

      return {
        validation: evidence,
        coverage:
          coverageEvidence === undefined
            ? await runTaskSessionCoverage(validation)
            : validationResultFromEvidence(coverageEvidence),
        attempts: currentRecord.retryCounters.validation,
        record: currentRecord,
      };
    }
  }

  while (true) {
    const reservedOperation =
      currentRecord.validationRepair?.activePrimaryOperation;
    if (reservedOperation !== undefined) {
      if (reservedOperation.promptArtifact === undefined)
        throw new TaskSessionValidationRepairError(
          "Reserved validation repair lacks its persisted prompt; preserving the reservation",
          reservedOperation.pass,
        );
      const promptArtifact: unknown =
        validation.taskRecordStore.readPrimaryResultArtifact({
          reference: reservedOperation.promptArtifact
            .reference as `sha256:${string}`,
          bytes: reservedOperation.promptArtifact.bytes,
          ...(reservedOperation.promptArtifact.path === undefined
            ? {}
            : { path: reservedOperation.promptArtifact.path }),
        });
      if (
        typeof promptArtifact !== "object" ||
        promptArtifact === null ||
        !("prompt" in promptArtifact) ||
        typeof promptArtifact.prompt !== "string"
      )
        throw new TaskSessionValidationRepairError(
          "Persisted validation repair prompt artifact is invalid",
          reservedOperation.pass,
        );
      const repairRecord = loadOwnedTaskExecutionRecord(
        validation.taskRecordStore,
        { projectId: project.id, cardId, expectedBranch, operationKey },
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
            prompt: promptArtifact.prompt,
          },
          options.inspectPrimarySession === undefined
            ? {}
            : { inspect: options.inspectPrimarySession },
          {
            role: "primary",
            operationId: reservedOperation.operationId,
            activity: `validation-repair-pass-${reservedOperation.pass}`,
            inspectPending: (entry) => {
              if (options.inspectPrimaryOperation !== undefined)
                return options.inspectPrimaryOperation(
                  reservedOperation.operationId,
                  entry,
                );
              if (options.primaryOperationEvidence === undefined)
                return Promise.resolve({ status: "unknown" });
              return inspectPrimaryOperationEvidence(
                validation.taskRecordStore,
                cardId,
                reservedOperation.operationId,
                {
                  trustedRoot: options.primaryOperationEvidence.trustedRoot,
                  cwd: options.primaryOperationEvidence.cwd ?? worktreePath,
                },
              );
            },
          },
        );
      } catch (error) {
        throw new TaskSessionValidationRepairError(
          `Reserved validation repair pass ${reservedOperation.pass} did not complete; reservation is preserved`,
          reservedOperation.pass,
          { cause: error },
        );
      }
      currentRecord = validation.taskRecordStore.read(cardId) ?? currentRecord;
      await assertValidationPrerequisites(options, currentRecord);
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: { cycleId, status: "active" },
      });
      continue;
    }
    const validationResult = await runTaskSessionValidation(validation);
    const coverageResult = await runTaskSessionCoverage(validation);
    if (
      validationResult.status === "skipped" &&
      coverageResult.status === "skipped"
    ) {
      const latestRecord = validation.taskRecordStore.read(cardId);
      if (
        latestRecord === null ||
        latestRecord.revision !== currentRecord.revision
      )
        throw new TaskSessionValidationRepairError(
          "Task ownership changed before skipped quality evidence could be persisted",
          currentRecord.retryCounters.validation,
        );
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: {
          cycleId,
          status: "skipped",
          evidence: {
            command: "",
            startedAt: validationResult.startedAt,
            completedAt: validationResult.completedAt,
            exitCode: null,
            status: "skipped",
            diagnostic: validationResult.diagnostic,
            contentIdentity: validationResult.contentIdentity,
          },
          coverageEvidence: {
            command: "",
            startedAt: coverageResult.startedAt,
            completedAt: coverageResult.completedAt,
            exitCode: null,
            status: "skipped",
            diagnostic: coverageResult.diagnostic,
            contentIdentity: coverageResult.contentIdentity,
          },
        },
      });
      return {
        validation: validationResult,
        coverage: coverageResult,
        attempts: currentRecord.retryCounters.validation,
        record: currentRecord,
      };
    }
    const allQualityGatesPassed =
      (validationResult.status === "passed" ||
        validationResult.status === "skipped") &&
      (coverageResult.status === "passed" ||
        coverageResult.status === "skipped");

    if (allQualityGatesPassed) {
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        validation.git,
        worktreePath,
      );

      if (
        currentIdentity !== validationResult.contentIdentity ||
        (coverageResult !== null &&
          currentIdentity !== coverageResult.contentIdentity)
      ) {
        throw new StaleTaskSessionValidationEvidenceError(
          coverageResult !== null &&
            currentIdentity !== coverageResult.contentIdentity
            ? coverageResult.contentIdentity
            : validationResult.contentIdentity,
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
            exitCode: validationResult.exitCode,
            status: validationResult.status,
            diagnostic: validationResult.diagnostic,
            contentIdentity: validationResult.contentIdentity,
          },
          coverageEvidence: {
            command: coverageResult.command,
            startedAt: coverageResult.startedAt,
            completedAt: coverageResult.completedAt,
            exitCode: coverageResult.exitCode,
            status: coverageResult.status,
            diagnostic: coverageResult.diagnostic,
            contentIdentity: coverageResult.contentIdentity,
          },
        },
      });

      return {
        validation: validationResult,
        coverage: coverageResult,
        attempts: currentRecord.retryCounters.validation,
        record: currentRecord,
      };
    }

    const attempts = currentRecord.retryCounters.validation;

    if (attempts >= MAX_VALIDATION_REPAIR_ATTEMPTS) {
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: { cycleId, status: "exhausted" },
      });
      return {
        validation: validationResult,
        coverage: coverageResult,
        attempts: currentRecord.retryCounters.validation,
        record: currentRecord,
      };
    }

    const prompt = buildTaskSessionValidationRepairPrompt({
      projectId: project.id,
      card,
      ...(plan === null ? {} : { approvedPlan: plan.plan }),
      validation: validationResult,
      coverage: coverageResult,
      attempt: attempts + 1,
      maxAttempts: MAX_VALIDATION_REPAIR_ATTEMPTS,
      ...(options.attachmentContext === undefined
        ? {}
        : { attachmentContext: options.attachmentContext }),
    });

    const repairAttempt = attempts + 1;
    const repairOperationId = `${operationKey}:validation:${cycleId}:pass:${repairAttempt}`;
    {
      const diagnosticResult = {
        ...validationResult,
        diagnostic: validationResult.diagnostic.slice(0, 8_000),
      };
      const promptArtifact =
        validation.taskRecordStore.writePrimaryResultArtifact(
          `${repairOperationId}:prompt`,
          { prompt },
        );
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        retryCounters: {
          ...currentRecord.retryCounters,
          validation: repairAttempt,
        },
        validationRepair: {
          cycleId,
          status: "active",
          activePrimaryOperation: {
            operationId: repairOperationId,
            pass: repairAttempt,
            validationResult: diagnosticResult,
            promptContext: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
            promptArtifact,
          },
        },
      });
    }

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
        options.inspectPrimarySession === undefined
          ? {}
          : { inspect: options.inspectPrimarySession },
        {
          role: "primary",
          operationId: repairOperationId,
          activity: `validation-repair-pass-${repairAttempt}`,
          inspectPending: (entry) => {
            if (options.inspectPrimaryOperation !== undefined) {
              return options.inspectPrimaryOperation(repairOperationId, entry);
            }
            if (options.primaryOperationEvidence === undefined) {
              return Promise.resolve({ status: "unknown" });
            }
            return inspectPrimaryOperationEvidence(
              validation.taskRecordStore,
              cardId,
              repairOperationId,
              {
                trustedRoot: options.primaryOperationEvidence.trustedRoot,
                cwd: options.primaryOperationEvidence.cwd ?? worktreePath,
              },
            );
          },
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
    if (
      currentRecord.validationRepair?.activePrimaryOperation?.operationId ===
      repairOperationId
    ) {
      currentRecord = updateRecord(validation.taskRecordStore, currentRecord, {
        validationRepair: { cycleId, status: "active" },
      });
    }
  }
}
