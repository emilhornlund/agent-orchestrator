import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import {
  CommandRunAbortedError,
  CommandRunner,
  CommandTimeoutError,
} from "../process/command-runner.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import type { ImplementationReviewResult } from "./implementation-review-result.js";
import type { PrMaintenanceOperation } from "./pr-maintenance-operation.js";
import { PrMaintenanceStore } from "./pr-maintenance-store.js";
import type { TaskSessionValidationResult } from "./run-task-session-validation.js";

type Identity = Pick<
  PrMaintenanceOperation,
  | "projectId"
  | "cardId"
  | "pullRequest"
  | "expectedRemoteHead"
  | "targetBaseHead"
>;

export interface VerifyPreparedPrMaintenanceOptions {
  project: ProjectConfig;
  operation: PrMaintenanceOperation;
  worktreePath: string;
  maintenanceStore: PrMaintenanceStore;
  git: Pick<
    GitClient,
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
  >;
  commands: CommandRunner;
  signal: AbortSignal;
  timeoutMilliseconds: number;
  requirementIds: readonly string[];
  review: (input: {
    contentIdentity: string;
    preparedHead: string;
    requirementIds: readonly string[];
    signal: AbortSignal;
  }) => Promise<ImplementationReviewResult>;
  secretValues?: readonly string[];
  sessionLogPath?: string;
}

export interface PreparedPrMaintenanceQualityEvidence {
  preparedHead: string;
  contentIdentity: string;
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult | null;
  review: ImplementationReviewResult;
  startedAt: string;
  completedAt: string;
}

export async function verifyPreparedPrMaintenance(
  options: VerifyPreparedPrMaintenanceOptions,
): Promise<PreparedPrMaintenanceQualityEvidence> {
  const { operation, project, worktreePath, maintenanceStore } = options;
  const identity: Identity = {
    projectId: operation.projectId,
    cardId: operation.cardId,
    pullRequest: operation.pullRequest,
    expectedRemoteHead: operation.expectedRemoteHead,
    targetBaseHead: operation.targetBaseHead,
  };
  const preparedHead = operation.localPreparation?.resultingHead;
  if (
    operation.projectId !== project.id ||
    operation.localPreparation?.status !== "prepared" ||
    preparedHead === undefined
  ) {
    throw new Error(
      "Quality verification requires a prepared maintenance operation with a resulting commit",
    );
  }
  maintenanceStore.requireOwnedActive(operation.operationId, identity);
  if ((await options.git.getHeadSha(worktreePath)) !== preparedHead)
    throw new Error(
      "Prepared maintenance worktree head changed before verification",
    );
  if (
    options.requirementIds.length === 0 ||
    new Set(options.requirementIds).size !== options.requirementIds.length
  )
    throw new Error(
      "Approved maintenance requirements must be unique and nonempty",
    );
  if (
    !Number.isSafeInteger(options.timeoutMilliseconds) ||
    options.timeoutMilliseconds < 1
  )
    throw new Error("Verification timeout must be positive");

  const startedAt = new Date().toISOString();
  let contentIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    worktreePath,
  );
  maintenanceStore.recordQualityVerification(operation.operationId, identity, {
    status: "running",
    preparedHead,
    contentIdentity,
    startedAt,
  });
  const runGate = async (
    command: string,
    label: string,
  ): Promise<TaskSessionValidationResult> => {
    const gateStartedAt = new Date().toISOString();
    const result = await options.commands.run({
      cwd: worktreePath,
      command,
      signal: options.signal,
      timeoutMilliseconds: options.timeoutMilliseconds,
      captureOutput: true,
      ...(options.secretValues === undefined
        ? {}
        : { secretValues: options.secretValues }),
      sessionLabel: label,
      ...(options.sessionLogPath === undefined
        ? {}
        : { sessionLogPath: options.sessionLogPath }),
    });
    return {
      command,
      startedAt: gateStartedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? "passed" : "failed",
      timedOut: false,
      aborted: false,
      diagnostic: presentExternalDiagnostic(
        [result.output, result.errorOutput].filter(Boolean).join("\n"),
        options.secretValues,
      ),
      contentIdentity,
    };
  };
  let validation: TaskSessionValidationResult | undefined;
  let coverage: TaskSessionValidationResult | null = null;
  try {
    if (
      project.repository.validationCommand === undefined ||
      project.repository.validationCommand.trim() === ""
    )
      throw new Error(
        "Prepared maintenance requires a configured validation command",
      );
    validation = await runGate(
      project.repository.validationCommand,
      "PR maintenance validation",
    );
    if (validation.status !== "passed")
      throw new Error(`Validation failed: ${validation.diagnostic}`);
    if (project.repository.coverageCommand !== undefined) {
      coverage = await runGate(
        project.repository.coverageCommand,
        "PR maintenance coverage",
      );
      if (coverage.status !== "passed")
        throw new Error(`Coverage failed: ${coverage.diagnostic}`);
    }
    const review = await options.review({
      contentIdentity,
      preparedHead,
      requirementIds: options.requirementIds,
      signal: options.signal,
    });
    const assessed = new Map(
      review.requirementAssessments.map((item) => [item.requirementId, item]),
    );
    if (
      review.verdict !== "pass" ||
      review.reviewedContentIdentity !== contentIdentity ||
      options.requirementIds.some(
        (id) => assessed.get(id)?.status !== "satisfied",
      ) ||
      assessed.size !== options.requirementIds.length ||
      review.blockingFindings.length > 0
    )
      throw new Error(
        "Independent implementation review failed or did not verify every approved requirement",
      );
    if (
      (await getTaskSessionSourceSnapshotIdentity(
        options.git,
        worktreePath,
      )) !== contentIdentity ||
      (await options.git.getHeadSha(worktreePath)) !== preparedHead
    )
      throw new Error(
        "Prepared source identity changed during quality verification",
      );
    const evidence = {
      preparedHead,
      contentIdentity,
      validation,
      coverage,
      review,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    maintenanceStore.recordQualityVerification(
      operation.operationId,
      identity,
      {
        status: "passed",
        preparedHead,
        contentIdentity,
        startedAt,
        completedAt: evidence.completedAt,
        validation,
        coverage,
        review,
      },
    );
    return evidence;
  } catch (error) {
    const diagnostic = presentExternalDiagnostic(
      error instanceof Error ? error.message : String(error),
      options.secretValues,
    );
    let status: "failed" | "uncertain" =
      options.signal.aborted ||
      error instanceof CommandRunAbortedError ||
      error instanceof CommandTimeoutError
        ? "uncertain"
        : "failed";
    try {
      const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
        options.git,
        worktreePath,
      );
      if (currentIdentity !== contentIdentity) status = "uncertain";
      contentIdentity = currentIdentity;
    } catch {
      status = "uncertain";
    }
    maintenanceStore.recordQualityVerification(
      operation.operationId,
      identity,
      {
        status,
        preparedHead,
        contentIdentity,
        startedAt,
        completedAt: new Date().toISOString(),
        ...(validation === undefined ? {} : { validation }),
        coverage,
        diagnostic,
      },
    );
    throw error;
  }
}
