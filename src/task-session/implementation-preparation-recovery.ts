import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import { isRetryableGitHubError, type GitHubClient } from "../github/github-client.js";
import { isRetryableTrelloError } from "../trello/trello-client.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { notifyAttentionRequired, type EmailNotifier } from "../notifications/email-notifier.js";
import { NotificationPreparationError } from "../notifications/notification-outbox.js";
import {
  ProcessExecutionError,
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { WorkflowMutationWaitingError } from "./workflow-mutation.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import { isConclusiveOperationResolution } from "./run-record.js";
import { runTaskResources } from "./task-resources.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { transitionTaskExecutionRecord } from "./task-execution-transition.js";
import { OPERATION_RECOVERY_MAX_EXECUTIONS } from "./operation-recovery-policy.js";

export const preparationRecoveryKey = "implementation-preparation-recovery-v1";
export const preparationRecoverySchema = z.strictObject({
  internalFailures: z.number().int().min(0).max(OPERATION_RECOVERY_MAX_EXECUTIONS),
  rechecks: z.number().int().positive().safe(),
  reason: z.string(),
  kind: z.enum(["internal", "dependency", "safety", "terminal"]),
  nextCheckAt: z.iso.datetime(),
});

function recoveryReason(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current) && messages.length < 5) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message || current.name : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return presentExternalDiagnostic(sanitizeControlledText(messages.join("; Cause: ")));
}

function recoveryKind(error: unknown): "internal" | "dependency" | "safety" {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    if (cause instanceof WorkflowMutationWaitingError) return "safety";
    seen.add(cause);
    cause = cause.cause;
  }
  return isRetryableGitHubError(error) || isRetryableTrelloError(error) ? "dependency" : "internal";
}

/** This boundary ends before the first AI dispatch; quality failures must still publish drafts. */
export function isImplementationPreparation(
  record: TaskExecutionRecord | null,
): record is TaskExecutionRecord {
  return (
    record !== null &&
    record.phase === "planning" &&
    record.primarySessionId === undefined &&
    record.sessionCreationStatus === undefined &&
    record.sessionCreationExecutionId === undefined &&
    record.sessionCreationResult === undefined &&
    record.sessionRecovery === undefined &&
    Object.keys(record.primaryOperations ?? {}).length === 0 &&
    record.pullRequest === undefined &&
    record.externalRecovery === undefined &&
    record.terminalFailure === undefined
  );
}

function canFailPreparation(authority: ProjectRunAuthority, project: ProjectConfig): boolean {
  try {
    const run = authority.store.read();
    if (
      !run ||
      run.taskKind !== "implementation" ||
      run.lifecycle !== "planning" ||
      run.publicationState !== "none" ||
      Object.keys(run.sessions).length !== 0 ||
      !run.pendingOperations.every(isConclusiveOperationResolution)
    )
      return false;
    const store = new TaskExecutionStore(run.pinned.storageRoot, project, authority);
    const record = store.read(run.cardId);
    if (!isImplementationPreparation(record)) return false;
    const resources = runTaskResources(run);
    if (record.expectedBranch !== resources.branch) return false;
    const setup = record.setup;
    if (!setup || setup.command !== (project.repository.setupCommand ?? null)) return false;
    if (
      ["pending", "not-required"].includes(setup.status) &&
      setup.attempts === 0 &&
      setup.executionId === undefined &&
      (setup.history?.length ?? 0) === 0
    )
      return true; // Durable pre-dispatch checkpoint, not a negative liveness guess.
    if (!setup.executionId || setup.command === null || setup.worktreePath !== resources.path)
      return false;
    for (const execution of [
      { executionId: setup.executionId, command: setup.command, worktreePath: resources.path },
      ...(setup.history ?? []),
    ]) {
      if (!execution.executionId || execution.worktreePath !== resources.path) return false;
      const evidence = store.readProcessExecution(run.cardId, execution.executionId);
      const expected = {
        executionId: execution.executionId,
        command: execution.command,
        cwd: resources.path,
      };
      if (
        !isVerifiedStoppedExecution(evidence, expected) &&
        !isVerifiedSuccessfulExecution(evidence, expected)
      )
        return false;
    }
    return true;
  } catch {
    return false; // Missing/corrupt process evidence never authorizes terminalization.
  }
}

/** Covers both fresh preparation and reconciliation, which runs before normal task dispatch. */
export async function withImplementationPreparationRecovery(options: {
  project: ProjectConfig;
  github: GitHubClient;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  execute: () => Promise<void>;
}): Promise<void> {
  const { project, signal } = options;
  const authority = ProjectRunAuthority.current(project.id);
  const run = authority?.store.read();
  if (!authority || !run || run.taskKind !== "implementation") return options.execute();
  let previous = authority.read(preparationRecoveryKey, preparationRecoverySchema.parse);
  if (previous && Date.now() < Date.parse(previous.nextCheckAt)) return;
  const store = new TaskExecutionStore(authority.store.storageRoot, project, authority);
  const cardId = run.cardId;
  const cardLog = logger.child({ projectId: project.id, cardId });
  const defer = async (
    error: unknown,
    kind: z.infer<typeof preparationRecoverySchema>["kind"],
  ): Promise<void> => {
    if (signal.aborted) return;
    const diagnostic = recoveryReason(error);
    const reason =
      kind === "safety" || kind === "terminal" ? (previous?.reason ?? diagnostic) : diagnostic;
    const value = {
      internalFailures: Math.min(
        OPERATION_RECOVERY_MAX_EXECUTIONS,
        (previous?.internalFailures ?? 0) + (kind === "internal" ? 1 : 0),
      ),
      rechecks: (previous?.rechecks ?? 0) + 1,
      reason,
      kind,
      nextCheckAt: new Date(
        Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(previous?.rechecks ?? 0, 3)),
      ).toISOString(),
    };
    authority.mutate(
      preparationRecoveryKey,
      value,
      () => ({ value, result: undefined }),
      preparationRecoverySchema.parse,
    );
    const notify = !previous;
    previous = value;
    cardLog.warn(
      `Implementation preparation ${kind} recovery pending (${value.internalFailures}/${OPERATION_RECOVERY_MAX_EXECUTIONS} internal failures); next controlled recheck ${value.nextCheckAt}. ${diagnostic}`,
    );
    if (notify)
      await notifyAttentionRequired(
        options.emailNotifier,
        {
          project,
          category: "Workflow",
          reason,
          cardIds: [cardId],
          sessionLogPaths: [getSessionLogPath(project.id, cardId)],
        },
        cardLog,
      );
  };
  if (signal.aborted) return;
  if (
    previous?.internalFailures === OPERATION_RECOVERY_MAX_EXECUTIONS &&
    store.read(cardId)?.terminalFailure === undefined
  ) {
    // Exhaustion forbids another inventory capture or setup/agent execution. Only
    // authoritative stopped-process reconciliation may authorize the existing Failed protocol.
    if (!canFailPreparation(authority, project)) {
      await defer(
        new Error(
          "Preparation recovery exhausted; waiting for verified stopped execution and no publication effects",
          { cause: new Error(previous.reason) },
        ),
        "safety",
      );
      return;
    }
    // A human may have opened a PR for this branch. Never infer its absence
    // solely from local publication state, or fail through a GitHub outage.
    try {
      const resources = runTaskResources(authority.store.read()!);
      const pr = await options.github.findPullRequestState({
        cwd: resources.path,
        repository: run.pinned.repository,
        headBranch: resources.branch,
        project,
      });
      if (pr !== null) {
        await defer(
          new Error("Preparation recovery requires reconciliation of an existing pull request"),
          "safety",
        );
        return;
      }
    } catch (error) {
      await defer(error, "dependency");
      return;
    }
    if (signal.aborted) return;
    const current = store.read(cardId)!;
    const terminal = transitionTaskExecutionRecord(current, {
      type: "attention-required",
      eventId: `${current.operationKey}:preparation-exhausted`,
      projectId: project.id,
      cardId,
      operationKey: current.operationKey,
      occurredAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
    });
    store.compareAndSwap(cardId, current.revision, {
      ...terminal,
      recoveryWait: undefined,
      terminalFailure: {
        kind: "implementation",
        outcome: "pending",
        reason:
          `Implementation preparation failed after ${OPERATION_RECOVERY_MAX_EXECUTIONS} bounded internal attempts: ${previous.reason}`.slice(
            0,
            4_000,
          ),
      },
    });
  }
  try {
    await options.execute();
    const current = store.read(cardId);
    if (
      previous &&
      !signal.aborted &&
      current &&
      current.phase !== "planning" &&
      current.phase !== "attention-required"
    )
      authority.remove(preparationRecoveryKey);
  } catch (error) {
    if (signal.aborted || error instanceof NotificationPreparationError) throw error;
    const current = store.read(cardId);
    const terminalPending =
      previous?.internalFailures === OPERATION_RECOVERY_MAX_EXECUTIONS &&
      current?.terminalFailure?.outcome === "pending";
    const preparing = authority.store.read();
    const beforeClaim =
      current === null &&
      preparing !== null &&
      ["preparing", "planning"].includes(preparing.lifecycle) &&
      preparing.publicationState === "none" &&
      Object.keys(preparing.sessions).length === 0;
    // A source fetch happens before the task checkpoint exists. Its verified
    // failure is an unavailable Git prerequisite, not an implementation crash.
    // Keep the same attempt and use the persisted paced wait across restarts.
    const process =
      beforeClaim && error instanceof ProcessExecutionError
        ? store.readProcessExecution(cardId, error.executionId)
        : null;
    const fetchUnavailable =
      process !== null &&
      typeof process === "object" &&
      "command" in process &&
      typeof process.command === "string" &&
      /^git (?:-c credential\.helper= )?fetch origin /u.test(process.command) &&
      error instanceof ProcessExecutionError &&
      isVerifiedStoppedExecution(process, {
        executionId: error.executionId,
        command: process.command,
        cwd: project.repository.path,
      });
    if (!isImplementationPreparation(current) && !terminalPending && !fetchUnavailable) throw error;
    await defer(
      error,
      terminalPending ? "terminal" : fetchUnavailable ? "dependency" : recoveryKind(error),
    );
  }
}
