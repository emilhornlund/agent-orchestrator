import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { CiCheckEvaluation } from "../github/evaluate-ci-checks.js";
import type { GitClient } from "../git/git-client.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type {
  TaskExecutionRecord,
  TaskExecutionPhase,
} from "./task-execution-record.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import { loadOwnedTaskExecutionRecord } from "./task-execution-ownership.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { isRetryableGitHubError } from "../github/github-client.js";
import { isRetryableTrelloError } from "../trello/trello-client.js";
import {
  assertSetupInventoryIdentity,
  captureSetupEffects,
} from "../process/run-setup.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";
import {
  isSameProcessInstance,
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";

export interface TaskSessionRecoverySnapshot {
  primarySessionAccessible:
    "reachable" | "confirmed-absent" | "conflict" | "unknown" | boolean | null;
  worktreeExists: boolean;
  worktreeBranch: string | null;
  worktreeHeadSha: string | null;
  worktreeRebaseActive: boolean;
  trustedCommitSha: string | null;
  verifiedUncommittedPublication?: boolean;
  remoteBranchHeadSha: string | null;
  trelloListId: string;
  pullRequest: {
    number: number;
    url: string;
    headSha: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  } | null;
  ciEvaluation: CiCheckEvaluation | null;
  feedbackHeadSha: string | null;
  uncertainReplyIds: readonly string[];
  reconciledReplyIds: readonly string[];
}

export interface ReconcileTaskSessionOptions {
  project: ProjectConfig;
  cardId: string;
  expectedBranch: string;
  operationKey: string;
  worktreePath: string;
  taskRecordStore: TaskExecutionStore;
  setupGit?: GitClient;
  signal?: AbortSignal;
  retryIntervalMs?: number;
  now?: () => number;
  readTerminalPullRequest?: (record: TaskExecutionRecord) => Promise<{
    number: number;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
  } | null>;
  readAuthoritativeSnapshot: (
    record: TaskExecutionRecord,
  ) => Promise<TaskSessionRecoverySnapshot>;
}

export type TaskSessionRecoveryResult =
  | { status: "resume"; phase: TaskExecutionPhase; record: TaskExecutionRecord }
  | { status: "reconstruction-required"; record: TaskExecutionRecord }
  | {
      status: "waiting";
      checkpoint: TaskExecutionPhase;
      reason: string;
      record: TaskExecutionRecord;
    }
  | {
      status: "attention-required";
      reason: string;
      record: TaskExecutionRecord;
    }
  | { status: "terminal-observed"; record: TaskExecutionRecord }
  | { status: "complete"; record: TaskExecutionRecord };

function bumpTimestamp(record: TaskExecutionRecord): string {
  return new Date(
    Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
  ).toISOString();
}

function preserveAttention(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  reason: string,
): TaskSessionRecoveryResult {
  if (record.phase === "attention-required") {
    return { status: "attention-required", reason, record };
  }
  if (record.phase === "done") {
    return { status: "attention-required", reason, record };
  }
  const next = transitionTaskExecutionRecord(record, {
    type: "attention-required",
    eventId: `${record.operationKey}:recovery-attention:${record.revision}`,
    projectId: record.projectId,
    cardId: record.cardId,
    operationKey: record.operationKey,
    occurredAt: bumpTimestamp(record),
  });
  const persisted = store.compareAndSwap(record.cardId, record.revision, {
    ...next,
    recoveryWait: undefined,
  });
  return { status: "attention-required", reason, record: persisted };
}

function persistWait(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  options: ReconcileTaskSessionOptions,
  reason: string,
  kind: "dependency" | "manual-move" = "dependency",
  patch: Partial<TaskExecutionRecord> = {},
): TaskSessionRecoveryResult {
  const interval = options.retryIntervalMs;
  if (interval === undefined || !Number.isSafeInteger(interval) || interval < 1)
    throw new Error("Recovery wait requires the configured retry interval");
  const now = options.now?.() ?? Date.now();
  const since = record.recoveryWait?.since ?? new Date(now).toISOString();
  const retryAt = new Date(now + interval).toISOString();
  const notificationId = `${record.projectId}/${record.cardId}/${record.operationKey}/${kind}`;
  const next: TaskExecutionRecord = {
    ...record,
    ...patch,
    recoveryWait: {
      kind,
      reason,
      resumePhase:
        record.recoveryWait?.resumePhase ??
        (record.phase as Exclude<
          TaskExecutionPhase,
          "done" | "attention-required"
        >),
      since,
      retryAt,
      attempts: (record.recoveryWait?.attempts ?? 0) + 1,
      notificationId,
    },
    revision: record.revision + 1,
    updatedAt: new Date(now).toISOString(),
  };
  const persisted = store.compareAndSwap(record.cardId, record.revision, next);
  return {
    status: "waiting",
    checkpoint: next.recoveryWait!.resumePhase,
    reason,
    record: persisted,
  };
}

export function persistTaskSessionContextWait(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  options: ReconcileTaskSessionOptions,
  reason: string,
): TaskSessionRecoveryResult {
  return persistWait(store, record, options, reason, "dependency", {
    sessionRecovery: {
      ...(record.sessionRecovery ?? {
        originalSessionId: record.primarySessionId ?? "unknown-session",
        status: "inspection-pending" as const,
      }),
      contextAvailability: "unavailable",
      contextAvailabilityReason: reason.slice(0, 1_000),
    },
  });
}

function clearWaitAndResume(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
): TaskSessionRecoveryResult {
  const recovered = record.recoveryWait
    ? store.compareAndSwap(record.cardId, record.revision, {
        ...record,
        recoveryWait: undefined,
        revision: record.revision + 1,
        updatedAt: bumpTimestamp(record),
      })
    : record;
  return { status: "resume", phase: recovered.phase, record: recovered };
}

function expectedTrelloList(
  project: ProjectConfig,
  record: TaskExecutionRecord,
): string {
  const { phase } = record;
  // A feedback-remediation checkpoint has durable ownership evidence that it
  // belongs to an already-published PR. Its phase can temporarily move back
  // through implementation/validation/review/publication while the card
  // intentionally remains in Human Review. PR identity alone is insufficient:
  // other workflow checkpoints may legitimately still own a Working card.
  if (
    record.pullRequest !== undefined &&
    record.feedbackRemediation !== undefined &&
    phase !== "done"
  )
    return project.trello.reviewListId;
  if (phase === "human-feedback" || phase === "ci")
    return project.trello.reviewListId;
  if (phase === "done") return project.trello.doneListId;
  return project.trello.workingListId;
}

function requiresWorktree(phase: TaskExecutionPhase): boolean {
  return phase !== "attention-required" && phase !== "done";
}

function requiresPullRequest(phase: TaskExecutionPhase): boolean {
  return phase === "ci" || phase === "human-feedback" || phase === "done";
}

function readSetupInventory(
  store: TaskExecutionStore,
  reference: string | undefined,
  worktreePath: string,
  branch: string,
): void {
  if (reference === undefined)
    throw new Error("Setup inventory evidence is missing");
  const inventory = store.readPrimaryResultArtifact(reference);
  assertSetupInventoryIdentity(inventory, worktreePath, branch);
}

function readSetupExecution(
  store: TaskExecutionStore,
  cardId: string,
  executionId: string | undefined,
  command: string | null,
  worktreePath: string,
): Record<string, unknown> | null {
  if (!executionId || command === null) return null;
  const raw = store.readProcessExecution(cardId, executionId);
  if (typeof raw !== "object" || raw === null) return null;
  const evidence = raw as Record<string, unknown>;
  const matches =
    evidence.executionId === executionId &&
    evidence.command === command &&
    typeof evidence.cwd === "string" &&
    path.resolve(evidence.cwd) === path.resolve(worktreePath);
  return matches ? evidence : null;
}

async function hasVerifiedSetupExhaustion(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  const setup = record.setup;
  if (
    !setup ||
    setup.attempts !== OPERATION_RECOVERY_MAX_EXECUTIONS ||
    setup.history?.length !== OPERATION_RECOVERY_MAX_EXECUTIONS
  )
    return false;
  try {
    for (const attempt of setup.history) {
      if (attempt.outcome !== "failed") return false;
      readSetupInventory(store, attempt.before, worktreePath, branch);
      readSetupInventory(store, attempt.after, worktreePath, branch);
      const execution = readSetupExecution(
        store,
        record.cardId,
        attempt.executionId,
        attempt.command,
        worktreePath,
      );
      if (
        !execution ||
        !attempt.executionId ||
        !isVerifiedStoppedExecution(execution, {
          executionId: attempt.executionId,
          command: attempt.command,
          cwd: worktreePath,
        })
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function checkObservationIsStale(
  snapshot: TaskSessionRecoverySnapshot,
  expectedHead: string,
): boolean {
  return (
    snapshot.ciEvaluation !== null &&
    snapshot.ciEvaluation.expectedHeadSha !== expectedHead
  );
}

export async function reconcileTaskSession(
  options: ReconcileTaskSessionOptions,
): Promise<TaskSessionRecoveryResult> {
  const { project, cardId, expectedBranch, operationKey, taskRecordStore } =
    options;
  let record = loadOwnedTaskExecutionRecord(taskRecordStore, {
    projectId: project.id,
    cardId,
    expectedBranch,
    operationKey,
  });
  if (record.setup?.status === "active" && record.setup.executionId) {
    try {
      readSetupInventory(
        taskRecordStore,
        record.setup.before,
        options.worktreePath,
        expectedBranch,
      );
    } catch (error) {
      return preserveAttention(
        taskRecordStore,
        record,
        `Setup baseline evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const execution = taskRecordStore.readProcessExecution(
      record.cardId,
      record.setup.executionId,
    );
    const evidence = execution as {
      executionId?: unknown;
      command?: unknown;
      cwd?: unknown;
      status?: unknown;
      exitCode?: unknown;
      treeStopped?: unknown;
      dispatchState?: unknown;
      pid?: unknown;
      pidStartIdentity?: unknown;
    } | null;
    if (
      evidence?.executionId === record.setup.executionId &&
      evidence.command === record.setup.command &&
      typeof evidence.cwd === "string" &&
      path.resolve(evidence.cwd) === path.resolve(options.worktreePath) &&
      evidence.status === "running"
    ) {
      const pid = evidence.pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          const sameInstance = isSameProcessInstance(
            pid,
            evidence.pidStartIdentity,
          );
          if (sameInstance === false)
            return preserveAttention(
              taskRecordStore,
              record,
              "Setup process identity was reused; preserving ambiguous execution without replay",
            );
          return persistWait(
            taskRecordStore,
            record,
            options,
            sameInstance === true
              ? "Repository setup process is still running; waiting without replay"
              : "Repository setup process identity cannot be verified; waiting without replay",
          );
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            return persistWait(
              taskRecordStore,
              record,
              options,
              "Repository setup process liveness is unavailable; waiting without replay",
            );
        }
      }
    }
    const expectedSetupExecution =
      record.setup.command === null
        ? undefined
        : {
            executionId: record.setup.executionId,
            command: record.setup.command,
            cwd: options.worktreePath,
          };
    if (
      expectedSetupExecution !== undefined &&
      isVerifiedSuccessfulExecution(evidence, expectedSetupExecution)
    ) {
      if (!options.setupGit)
        return preserveAttention(
          taskRecordStore,
          record,
          "Cannot capture recovered setup effects without the bounded Git client",
        );
      const after = taskRecordStore.writePrimaryResultArtifact(
        `setup-recovered-after-${record.cardId}-${record.revision}`,
        JSON.parse(
          (
            await captureSetupEffects(
              options.setupGit,
              options.worktreePath,
              options.signal,
              true,
            )
          ).toString("utf8"),
        ) as unknown,
      );
      record = taskRecordStore.compareAndSwap(record.cardId, record.revision, {
        ...record,
        setup: {
          ...record.setup,
          status: "passed",
          after: after.reference,
          exitCode: 0,
          history: [
            ...(record.setup.history ?? []),
            {
              command: record.setup.command!,
              worktreePath: options.worktreePath,
              before: record.setup.before!,
              after: after.reference,
              executionId: record.setup.executionId,
              exitCode: 0,
              outcome: "passed" as const,
            },
          ],
        },
        revision: record.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
        ).toISOString(),
      });
    } else if (
      expectedSetupExecution !== undefined &&
      isVerifiedStoppedExecution(evidence, expectedSetupExecution)
    ) {
      if (!options.setupGit)
        return preserveAttention(
          taskRecordStore,
          record,
          "Cannot capture setup effects without the bounded Git client",
        );
      const after = await captureSetupEffects(
        options.setupGit,
        options.worktreePath,
        options.signal,
        true,
      );
      const artifact = taskRecordStore.writePrimaryResultArtifact(
        `setup-recovered-failed-${record.cardId}-${record.revision}`,
        JSON.parse(after.toString("utf8")) as unknown,
      );
      const attempts = record.setup.attempts ?? 1;
      const retryAllowed = attempts < OPERATION_RECOVERY_MAX_EXECUTIONS;
      record = taskRecordStore.compareAndSwap(record.cardId, record.revision, {
        ...record,
        setup: {
          ...record.setup,
          status: retryAllowed ? "pending" : "failed",
          after: artifact.reference,
          exitCode:
            typeof evidence.exitCode === "number" ? evidence.exitCode : null,
          diagnostic: `Setup process ended with ${String(evidence.status)}`,
          history: [
            ...(record.setup.history ?? []),
            {
              command: record.setup.command!,
              worktreePath: options.worktreePath,
              before: record.setup.before!,
              after: artifact.reference,
              executionId: record.setup.executionId,
              exitCode:
                typeof evidence.exitCode === "number"
                  ? evidence.exitCode
                  : null,
              outcome: "failed" as const,
            },
          ],
        },
        revision: record.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
        ).toISOString(),
      });
    }
  }
  if (
    options.readTerminalPullRequest &&
    record.phase !== "done" &&
    record.pullRequest !== undefined
  ) {
    const terminal = await options.readTerminalPullRequest(record);
    if (
      terminal !== null &&
      terminal.number === record.pullRequest.number &&
      terminal.url === record.pullRequest.url &&
      (terminal.state === "MERGED" || terminal.state === "CLOSED")
    ) {
      // This is only a handoff hint. The existing terminal observer must still
      // verify PR ownership/head continuity and perform the external terminal
      // workflow; local session/worktree checks are not allowed to hide it.
      return { status: "terminal-observed", record };
    }
  }
  if (record.phase === "attention-required") {
    return {
      status: "attention-required",
      reason: "Task was already escalated",
      record,
    };
  }
  if (record.setup?.status === "passed") {
    try {
      readSetupInventory(
        taskRecordStore,
        record.setup.before,
        options.worktreePath,
        expectedBranch,
      );
      readSetupInventory(
        taskRecordStore,
        record.setup.after,
        options.worktreePath,
        expectedBranch,
      );
      const evidence = readSetupExecution(
        taskRecordStore,
        record.cardId,
        record.setup.executionId,
        record.setup.command,
        options.worktreePath,
      );
      if (
        !evidence ||
        evidence.status !== "success" ||
        evidence.exitCode !== 0 ||
        evidence.treeStopped !== true ||
        record.setup.exitCode !== 0 ||
        !record.setup.history?.some(
          (attempt) =>
            attempt.executionId === record.setup!.executionId &&
            attempt.outcome === "passed" &&
            attempt.before === record.setup!.before &&
            attempt.after === record.setup!.after,
        )
      )
        throw new Error(
          "Setup process result does not bind the stored effects",
        );
    } catch (error) {
      return preserveAttention(
        taskRecordStore,
        record,
        `Completed setup evidence could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (
    record.recoveryWait &&
    (options.now?.() ?? Date.now()) < Date.parse(record.recoveryWait.retryAt)
  )
    return {
      status: "waiting",
      checkpoint: record.recoveryWait.resumePhase,
      reason: record.recoveryWait.reason,
      record,
    };
  let snapshot: TaskSessionRecoverySnapshot;
  try {
    snapshot = await options.readAuthoritativeSnapshot(record);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const reason = `Authoritative recovery snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`;
    // Only recognized transient provider failures are waits. Git/worktree,
    // malformed response, ancestry and safety failures must not be relabeled
    // as outages; they remain attention checkpoints and fail closed.
    if (isRetryableGitHubError(error) || isRetryableTrelloError(error))
      return persistWait(taskRecordStore, record, options, reason);
    return preserveAttention(taskRecordStore, record, reason);
  }
  const expectedTerminalPr = record.pullRequest;
  if (
    record.phase !== "done" &&
    expectedTerminalPr !== undefined &&
    snapshot.pullRequest !== null &&
    snapshot.pullRequest.number === expectedTerminalPr.number &&
    snapshot.pullRequest.url === expectedTerminalPr.url &&
    (snapshot.pullRequest.state === "MERGED" ||
      snapshot.pullRequest.state === "CLOSED")
  )
    return { status: "terminal-observed", record };
  if (
    record.sessionCreationStatus === "creating" ||
    record.sessionCreationStatus === "ambiguous" ||
    (record.primarySessionId === undefined && record.phase !== "planning")
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Primary session identity is missing or ambiguous",
    );
  }
  if (
    record.setup?.status === "active" ||
    (project.repository.setupCommand !== undefined &&
      record.setup === undefined) ||
    (record.setup !== undefined &&
      record.setup.command !== (project.repository.setupCommand ?? null)) ||
    (record.setup?.status === "passed" &&
      record.setup.worktreePath !== options.worktreePath) ||
    record.setup?.status === "ambiguous" ||
    record.setup?.status === "failed"
  ) {
    if (
      record.setup?.status === "failed" &&
      record.pullRequest === undefined &&
      (await hasVerifiedSetupExhaustion(
        taskRecordStore,
        record,
        options.worktreePath,
        expectedBranch,
      ))
    ) {
      const reason =
        record.setup.diagnostic ??
        "Repository setup exhausted safe recovery attempts before implementation";
      const next = transitionTaskExecutionRecord(record, {
        type: "attention-required",
        eventId: `${record.operationKey}:setup-failed:${record.revision}`,
        projectId: record.projectId,
        cardId: record.cardId,
        operationKey: record.operationKey,
        occurredAt: bumpTimestamp(record),
      });
      const persisted = taskRecordStore.compareAndSwap(
        record.cardId,
        record.revision,
        {
          ...next,
          recoveryWait: undefined,
          terminalFailure: {
            kind: "implementation",
            reason: reason.slice(0, 4_000),
            outcome: "pending",
          },
        },
      );
      return { status: "attention-required", reason, record: persisted };
    }
    return preserveAttention(
      taskRecordStore,
      record,
      "Repository setup state is missing, changed, or has an uncertain outcome",
    );
  }
  if (snapshot.trelloListId !== expectedTrelloList(project, record)) {
    if (record.phase === "done")
      return preserveAttention(
        taskRecordStore,
        record,
        `Trello card is in unexpected list ${snapshot.trelloListId} for phase ${record.phase}`,
      );
    return persistWait(
      taskRecordStore,
      record,
      options,
      `Trello card is in unexpected list ${snapshot.trelloListId} for phase ${record.phase}`,
      "manual-move",
    );
  }
  if (requiresWorktree(record.phase)) {
    try {
      assertOwnedTaskWorktreePath(project, options.worktreePath);
    } catch (error) {
      return preserveAttention(
        taskRecordStore,
        record,
        `Owned worktree is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !snapshot.worktreeExists ||
      snapshot.worktreeBranch !== expectedBranch ||
      snapshot.worktreeRebaseActive
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Owned worktree is missing, on the wrong branch, or has an active rebase",
      );
    }
  }
  if (
    snapshot.trustedCommitSha !== null &&
    snapshot.worktreeHeadSha !== snapshot.trustedCommitSha
  ) {
    return preserveAttention(
      taskRecordStore,
      record,
      "Worktree HEAD does not match the persisted trusted commit",
    );
  }
  if (record.phase === "publication") {
    if (snapshot.pullRequest !== null && record.pullRequest === undefined) {
      return preserveAttention(
        taskRecordStore,
        record,
        "A pull request exists but its identity was not persisted; refusing to guess publication ownership",
      );
    }
    if (
      record.pullRequest !== undefined &&
      (snapshot.pullRequest === null ||
        snapshot.pullRequest.number !== record.pullRequest.number ||
        snapshot.pullRequest.url !== record.pullRequest.url ||
        snapshot.pullRequest.headSha !== record.pullRequest.headSha)
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Partially published pull request does not match the persisted identity",
      );
    }
    const uncommitted =
      (record.validationRepair?.status === "exhausted" ||
        record.reviewUnavailable !== undefined) &&
      record.reviewRepair?.finalReview === undefined &&
      snapshot.verifiedUncommittedPublication === true &&
      snapshot.trustedCommitSha === null &&
      snapshot.remoteBranchHeadSha === null &&
      snapshot.pullRequest === null &&
      record.pullRequest === undefined;
    if (
      (!uncommitted && snapshot.trustedCommitSha === null) ||
      (!uncommitted &&
        snapshot.worktreeHeadSha !== snapshot.trustedCommitSha) ||
      (snapshot.remoteBranchHeadSha !== null &&
        snapshot.remoteBranchHeadSha !== snapshot.trustedCommitSha)
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Partially published task has no unambiguous trusted commit/remote state",
      );
    }
    // Publication verification is one checkpoint, not an escape hatch from
    // the common primary-session recovery gate below.
  }
  if (requiresPullRequest(record.phase)) {
    const expectedPr = record.pullRequest;
    const actualPr = snapshot.pullRequest;
    if (
      expectedPr === undefined ||
      actualPr === null ||
      expectedPr.number !== actualPr.number ||
      expectedPr.url !== actualPr.url ||
      expectedPr.headSha === undefined ||
      expectedPr.headSha !== actualPr.headSha
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Persisted and authoritative pull request identity/head are ambiguous",
      );
    }
    if (snapshot.trustedCommitSha !== expectedPr.headSha) {
      return preserveAttention(
        taskRecordStore,
        record,
        "PR head is not backed by matching trusted commit state",
      );
    }
    if (record.phase === "done" && actualPr.state !== "MERGED") {
      return preserveAttention(
        taskRecordStore,
        record,
        "Done task does not have an authoritatively merged pull request",
      );
    }
    if (
      (record.phase === "ci" || record.phase === "human-feedback") &&
      actualPr.state !== "OPEN"
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Active pull request is not open",
      );
    }
    if (
      record.phase === "ci" &&
      (snapshot.ciEvaluation === null ||
        checkObservationIsStale(snapshot, expectedPr.headSha))
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "CI snapshot is missing or belongs to a different PR head",
      );
    }
    if (
      record.phase === "human-feedback" &&
      snapshot.feedbackHeadSha !== expectedPr.headSha
    ) {
      return preserveAttention(
        taskRecordStore,
        record,
        "Feedback snapshot is missing or belongs to a different PR head",
      );
    }
  }
  const uncertainReplies = new Set(snapshot.uncertainReplyIds);
  for (const replyId of snapshot.reconciledReplyIds)
    uncertainReplies.delete(replyId);
  if (uncertainReplies.size > 0) {
    return preserveAttention(
      taskRecordStore,
      record,
      `Feedback reply outcome remains ambiguous: ${[...uncertainReplies].join(", ")}`,
    );
  }
  if (record.phase === "done") return { status: "complete", record };
  if (record.sessionRecovery?.status === "reconstruction-blocked")
    return preserveAttention(
      taskRecordStore,
      record,
      "Primary session reconstruction failed its read-only verification; manual recovery is required",
    );
  if (record.sessionRecovery?.status === "reconstruction-process-failed")
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary reconstruction process failed after binding; awaiting approved retry policy",
    );
  if (
    snapshot.primarySessionAccessible === "conflict" ||
    snapshot.primarySessionAccessible === false
  )
    return preserveAttention(
      taskRecordStore,
      record,
      "Bound primary session identity conflicts with the task worktree",
    );
  if (
    snapshot.primarySessionAccessible === null ||
    snapshot.primarySessionAccessible === "unknown"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Bound primary session accessibility is unknown",
    );
  if (
    record.sessionRecovery?.status === "replacement-creating" ||
    record.sessionRecovery?.status === "replacement-ambiguous"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary replacement creation outcome is ambiguous; refusing another dispatch",
    );
  if (record.sessionRecovery?.contextAvailability === "unavailable")
    return { status: "reconstruction-required", record };
  if (
    snapshot.primarySessionAccessible === "confirmed-absent" ||
    record.sessionRecovery?.status === "replacement-bound"
  )
    return { status: "reconstruction-required", record };
  if (
    record.sessionRecovery !== undefined &&
    record.sessionRecovery.status !== "reconstruction-verified"
  )
    return persistWait(
      taskRecordStore,
      record,
      options,
      "Primary session reconstruction is pending verification",
    );
  return clearWaitAndResume(taskRecordStore, record);
}
