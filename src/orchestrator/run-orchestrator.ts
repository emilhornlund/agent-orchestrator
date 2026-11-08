import { DEFAULT_CONTEXT_ROOT, type Config } from "../config/config.js";
import {
  cleanupCardContextRetention,
  contextRetentionIntervalMilliseconds,
} from "../context/card-context-retention.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { withGitHubOperationProject } from "../github/github-operation-context.js";
import {
  cleanupLogRetention,
  logRetentionIntervalMilliseconds,
} from "../logging/log-retention.js";
import { logger, shouldWriteConsole } from "../logging/logger.js";
import {
  notifyAttentionRequired,
  type EmailNotifier,
} from "../notifications/email-notifier.js";
import {
  OpenCodeRunAbortedError,
  type OpenCodeClient,
} from "../opencode/opencode-client.js";
import {
  CommandRunAbortedError,
  type CommandRunner,
} from "../process/command-runner.js";
import { ProcessExecutionError } from "../process/process-runtime.js";
import {
  TrelloRequestAbortedError,
  getTrelloRequestOperation,
  isRetryableTrelloError,
  type TrelloClient,
} from "../trello/trello-client.js";
import type { validateProjectTrello } from "../trello/validate-project-trello.js";

import {
  annotateFailure,
  describeFailure,
  formatFailureDiagnostic,
  getFailureContext,
} from "./failure-diagnostic.js";
import {
  MAX_GITHUB_RECONCILIATION_ATTEMPTS,
  RetryableGitHubReconciliationError,
} from "./github-reconciliation-error.js";
import { pollProject, type PollingProject } from "./poll-project.js";
import {
  MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS,
  PreparedConflictRemediationError,
} from "./remediate-prepared-conflict.js";
import {
  MAX_TRELLO_RECONCILIATION_ATTEMPTS,
  RetryableTrelloReconciliationError,
} from "./trello-reconciliation-error.js";
import { TrelloListDiscoveryError } from "./trello-list-discovery.js";
import { getRetryBackoffDelayMilliseconds } from "./retry-backoff.js";
import {
  loadReconciliationBlock,
  removeReconciliationBlock,
  type PersistedReconciliationBlock,
  type ReconciliationBlockOperation,
  type ReconciliationRecoveryCondition,
  writeReconciliationBlock,
} from "./reconciliation-block-storage.js";
import { WorkflowError } from "./workflow-error.js";
import type { ProjectRunWorkerContext } from "../task-session/project-run-authority.js";
import {
  NotificationOutbox,
  drainNotifications,
  notificationTriggerObserver,
  NotificationPreparationError,
  deferNotificationPreparation,
} from "../notifications/notification-outbox.js";
import { prepareAttentionNotification } from "../notifications/email-notifier.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { resumeInitialPublication } from "./initial-publication.js";
import { reconcileWorkflowMutations } from "./reconcile-workflow-mutations.js";
import { parseTaskExecutionRecord } from "../task-session/task-execution-record.js";
import { isConclusiveOperationResolution } from "../task-session/run-record.js";
import { isRetryableGitHubError } from "../github/github-client.js";

export function hasDueTaskSessionRecoveryWait(
  authorityRecord: import("../task-session/run-record.js").RunRecord | null,
  now = Date.now(),
): boolean {
  if (!authorityRecord || authorityRecord.lifecycle !== "waiting") return false;
  const projection =
    authorityRecord.compatibility[`task-execution-${authorityRecord.cardId}`];
  if (projection === undefined) return false;
  const taskProjection = parseTaskExecutionRecord(projection);
  const recoveryWait = taskProjection.recoveryWait;
  return (
    taskProjection.phase !== "attention-required" &&
    recoveryWait !== undefined &&
    now >= Date.parse(recoveryWait.retryAt)
  );
}

export function persistEssentialDependencyWait(
  authority: ProjectRunAuthority | undefined,
  cardId: string | undefined,
  retryIntervalMs: number,
  dependency: string,
): string | undefined {
  const ownedCardId = cardId ?? authority?.cardId;
  if (!authority || !ownedCardId || authority.cardId !== ownedCardId)
    return undefined;
  const run = authority.store.read();
  if (
    !run ||
    run.cardId !== ownedCardId ||
    run.pendingOperations.some(
      (operation) => !isConclusiveOperationResolution(operation),
    )
  )
    return undefined;
  const key = `task-execution-${ownedCardId}`;
  const current = run.compatibility[key];
  if (current === undefined) return undefined;
  const task = parseTaskExecutionRecord(current);
  if (["attention-required", "done"].includes(task.phase)) return undefined;
  const now = new Date();
  const since = task.recoveryWait?.since ?? now.toISOString();
  const notificationId = `${task.projectId}/${task.cardId}/${task.operationKey}/dependency`;
  authority.mutateTaskExecution({
    key,
    initial: null,
    operation: (raw) => {
      const latest = parseTaskExecutionRecord(raw);
      if (latest.revision !== task.revision || latest.phase !== task.phase)
        throw new Error(
          "Task checkpoint changed while scheduling dependency recovery",
        );
      return {
        value: {
          ...latest,
          recoveryWait: {
            kind: "dependency",
            reason: `Essential dependency unavailable: ${dependency}`,
            resumePhase: latest.recoveryWait?.resumePhase ?? latest.phase,
            since,
            retryAt: new Date(now.getTime() + retryIntervalMs).toISOString(),
            attempts: (latest.recoveryWait?.attempts ?? 0) + 1,
            notificationId,
          },
          revision: latest.revision + 1,
          updatedAt: new Date(
            Math.max(now.getTime(), Date.parse(latest.updatedAt) + 1),
          ).toISOString(),
        },
        result: undefined,
      };
    },
    validate: parseTaskExecutionRecord,
  });
  return notificationId;
}
import { getCardsForDiscovery } from "./trello-list-discovery.js";
import { getWorkflowKind } from "./workflow-kind.js";
import { isCardStartDateReached } from "./card-start-eligibility.js";
import { MAX_VALIDATION_REPAIR_ATTEMPTS } from "../task-session/run-task-session-validation-repairs.js";

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);

    function handleAbort(): void {
      clearTimeout(timeout);
      resolve();
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function isShutdownCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);

    if (
      current instanceof OpenCodeRunAbortedError ||
      current instanceof CommandRunAbortedError ||
      current instanceof TrelloRequestAbortedError
    ) {
      return true;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

function failureNotificationIdentity(
  projectId: string,
  reconciliationOperation: string | undefined,
  category: string,
  reason: string,
  cardIds: string[],
  handlingOutcome: string | undefined,
): string {
  return JSON.stringify({
    projectId,
    reconciliationOperation: reconciliationOperation ?? null,
    cardIds: [...new Set(cardIds)].sort(),
    category,
    reason: reason.replace(/\s+/g, " ").trim() || "No reason provided",
    handlingOutcome: handlingOutcome ?? null,
  });
}

function humanReviewCardKey(cardIds: string[]): string {
  return JSON.stringify([...new Set(cardIds)].sort());
}

function getHumanReviewCardIds(key: string): string[] {
  const value: unknown = JSON.parse(key);

  return Array.isArray(value) &&
    value.every((cardId): cardId is string => typeof cardId === "string")
    ? value
    : [];
}

function clearHumanReviewFailureForMissingCards(
  identities: Map<string, string>,
  cardIds: string[],
): void {
  const observedCardIds = new Set(cardIds);

  for (const key of identities.keys()) {
    if (
      getHumanReviewCardIds(key).some((cardId) => !observedCardIds.has(cardId))
    ) {
      identities.delete(key);
    }
  }
}

function clearHumanReviewFailureForCard(
  identities: Map<string, string>,
  cardId: string,
): void {
  for (const key of identities.keys()) {
    if (getHumanReviewCardIds(key).includes(cardId)) {
      identities.delete(key);
    }
  }
}

interface BlockedPreparedConflict {
  cardId: string | undefined;
  recoveryCheckFailed: boolean;
}

interface BlockedReconciliation {
  attemptKey: string;
  operation: ReconciliationBlockOperation;
  cardId: string | undefined;
  reconciliationListId: string | undefined;
  failure: Error;
  recoveryCheckFailed: boolean;
  recoveryCondition: ReconciliationRecoveryCondition;
  notificationIdentity: string | undefined;
  failureIdentity: string | undefined;
  restored: boolean;
  malformed: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getProcessExecutionError(
  error: unknown,
): { executionId: string; artifactReference: string } | undefined {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProcessExecutionError)
      return {
        executionId: current.executionId,
        artifactReference: `process-executions/${current.executionId}/stderr.txt`,
      };
    if (
      current instanceof Error &&
      "executionId" in current &&
      typeof current.executionId === "string" &&
      /^[0-9a-f-]{36}$/iu.test(current.executionId) &&
      "stdoutArtifactReference" in current &&
      current.stdoutArtifactReference ===
        `process-executions/${current.executionId}/stdout.txt`
    )
      return {
        executionId: current.executionId,
        artifactReference: current.stdoutArtifactReference,
      };
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined)
      pending.push(current.cause);
  }
  return undefined;
}

function runBestEffortRetention(operation: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    try {
      logger.warn(
        `Scheduled housekeeping cleanup warning during ${operation}: ${getErrorMessage(error)}`,
      );
    } catch {
      // A cleanup or logging failure must not stop the worker timer.
    }
  }
}

async function hasReconciliationRecovery(
  trello: TrelloClient,
  project: PollingProject,
  blocked: BlockedReconciliation,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    signal.aborted ||
    blocked.cardId === undefined ||
    blocked.recoveryCondition !== "card-moved-to-ready" ||
    (blocked.reconciliationListId === undefined &&
      !blocked.operation.startsWith("GitHub "))
  ) {
    return false;
  }

  const recoveryListIds =
    blocked.reconciliationListId === project.trello.readyListId
      ? [
          project.trello.workingListId,
          project.trello.reviewListId,
          project.trello.backlogListId,
          project.trello.failedListId,
          project.trello.doneListId,
        ]
      : [project.trello.readyListId];
  let recoveryCheckError: unknown;

  for (const listId of new Set(recoveryListIds)) {
    try {
      const cards = await trello.getCards(listId);

      if (cards.some((card) => card.id === blocked.cardId)) {
        return true;
      }
    } catch (error) {
      recoveryCheckError ??= error;
    }
  }

  if (recoveryCheckError !== undefined && !blocked.recoveryCheckFailed) {
    blocked.recoveryCheckFailed = true;
    logger
      .child({
        projectId: project.id,
        cardId: blocked.cardId,
      })
      .warn(
        `Could not check the explicit recovery state for blocked ${blocked.operation} reconciliation: ${getErrorMessage(recoveryCheckError)}; retaining the original failure context: ${blocked.failure.message}`,
      );
  }

  return false;
}

function restoreReconciliationFailure(
  block: PersistedReconciliationBlock,
): Error {
  const failure = new Error(block.failureReason);

  annotateFailure(
    failure,
    {
      projectId: block.projectId,
      ...(block.cardId === undefined ? {} : { cardId: block.cardId }),
      reconciliationOperation: block.operation,
      ...(block.reconciliationListId === undefined
        ? {}
        : { reconciliationListId: block.reconciliationListId }),
      ...(block.handlingOutcome === undefined
        ? {}
        : { handlingOutcome: block.handlingOutcome }),
      ...(block.sessionLogPaths === undefined
        ? {}
        : { sessionLogPaths: block.sessionLogPaths }),
    },
    {
      category: block.failureCategory,
      reason: block.failureReason,
    },
  );

  return failure;
}

function createPersistedReconciliationBlock(
  project: PollingProject,
  blocked: BlockedReconciliation,
  failureContext: ReturnType<typeof getFailureContext>,
  sessionLogPaths: string[],
  failureCategory: PersistedReconciliationBlock["failureCategory"],
  failureReason: string,
  notificationIdentity: string,
  failureIdentity: string,
): PersistedReconciliationBlock {
  return {
    version: 1,
    projectId: project.id,
    attemptKey: blocked.attemptKey,
    attempt: 3,
    operation: blocked.operation,
    ...(blocked.cardId === undefined ? {} : { cardId: blocked.cardId }),
    ...(blocked.reconciliationListId === undefined
      ? {}
      : { reconciliationListId: blocked.reconciliationListId }),
    failureCategory,
    failureReason,
    recoveryCondition: blocked.recoveryCondition,
    notificationIdentity,
    failureIdentity,
    ...(failureContext?.handlingOutcome === undefined
      ? {}
      : { handlingOutcome: failureContext.handlingOutcome }),
    ...(sessionLogPaths.length === 0 ? {} : { sessionLogPaths }),
  };
}

async function hasPreparedConflictRecovery(
  _git: GitClient,
  _project: PollingProject,
  _blocked: BlockedPreparedConflict,
  _signal: AbortSignal,
): Promise<boolean> {
  void _git;
  void _project;
  void _blocked;
  void _signal;
  // P1 deliberately offers no automatic recovery path: neither apparent local
  // completion nor remote-branch absence proves a rebase was unpublished.
  // Preserve blockage and artifacts for explicit operator reconciliation.
  return false;
}

async function runProjectWorkerInner(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: PollingProject,
  pollIntervalMilliseconds: number,
  signal: AbortSignal,
  emailNotifier?: EmailNotifier,
  deferredTrelloValidation?: typeof validateProjectTrello,
  runContext?: ProjectRunWorkerContext,
): Promise<"authority-released" | undefined> {
  const githubReconciliationAttempts = new Map<string, number>();
  const githubReadAttempts = new Map<string, number>();
  const trelloTransientAttempts = new Map<string, number>();
  const preparedConflictAttempts = new Map<string, number>();
  const blockedPreparedConflicts = new Map<string, BlockedPreparedConflict>();
  const blockedReconciliations = new Map<string, BlockedReconciliation>();
  const activeHumanReviewFailureIdentities = new Map<string, string>();
  const onHumanReviewCardsObserved = (cardIds: string[]): void => {
    clearHumanReviewFailureForMissingCards(
      activeHumanReviewFailureIdentities,
      cardIds,
    );
  };
  const onHumanReviewCardLeft = (cardId: string): void => {
    clearHumanReviewFailureForCard(activeHumanReviewFailureIdentities, cardId);
  };
  let suppressedFailureIdentity: string | undefined;
  let restoredFailureIdentity: string | undefined;
  let pendingTrelloValidation = deferredTrelloValidation;
  const runtimeStorageRoot = project.contextRoot ?? DEFAULT_CONTEXT_ROOT;

  if (runContext?.blockedReason) {
    logger
      .child({ projectId: project.id })
      .error(
        `Project attempt authority is blocked; this project will remain isolated: ${runContext.blockedReason}`,
      );
    while (!signal.aborted) {
      drainNotifications(project.id, emailNotifier, (message) =>
        logger.child({ projectId: project.id }).warn(message),
      );
      await sleep(pollIntervalMilliseconds, signal);
    }
    return;
  }

  const persistedBlock = loadReconciliationBlock(
    runtimeStorageRoot,
    project.id,
  );

  if (persistedBlock.status === "loaded") {
    const block = persistedBlock.block;
    const failure = restoreReconciliationFailure(block);

    blockedReconciliations.set(block.attemptKey, {
      attemptKey: block.attemptKey,
      operation: block.operation,
      cardId: block.cardId,
      reconciliationListId: block.reconciliationListId,
      failure,
      recoveryCheckFailed: false,
      recoveryCondition: block.recoveryCondition,
      notificationIdentity: block.notificationIdentity,
      failureIdentity: block.failureIdentity,
      restored: true,
      malformed: false,
    });
    suppressedFailureIdentity = block.notificationIdentity;
    restoredFailureIdentity = block.failureIdentity;

    logger
      .child({
        projectId: project.id,
        ...(block.cardId === undefined ? {} : { cardId: block.cardId }),
      })
      .event(
        `Restored blocked ${block.operation} reconciliation from runtime storage; waiting for ${block.recoveryCondition === "card-moved-to-ready" ? "the affected card to move from its recorded reconciliation list to Ready for Agent" : "explicit operator recovery and worker restart"}`,
      );
    logger
      .child({
        projectId: project.id,
        ...(block.cardId === undefined ? {} : { cardId: block.cardId }),
      })
      .diagnostic({
        code: "recovery-deferred",
        classification: "workflow-recovery",
        recovery: "state-preserved",
      });
  } else if (persistedBlock.status === "malformed") {
    const failure = new WorkflowError(
      "Workflow",
      `Persisted reconciliation block is malformed and was retained for investigation: ${persistedBlock.error.message}`,
      { cause: persistedBlock.error },
    );
    const failureDescription = describeFailure(failure);
    const failureIdentity = failureNotificationIdentity(
      project.id,
      undefined,
      failureDescription.category,
      failureDescription.reason,
      [],
      undefined,
    );

    annotateFailure(failure, { projectId: project.id }, failureDescription);
    blockedReconciliations.set(`malformed:${project.id}`, {
      attemptKey: `malformed:${project.id}`,
      operation: "Trello card operation",
      cardId: undefined,
      reconciliationListId: undefined,
      failure,
      recoveryCheckFailed: true,
      recoveryCondition: "worker-restart",
      notificationIdentity: failureIdentity,
      failureIdentity,
      restored: true,
      malformed: true,
    });

    const projectLog = logger.child({ projectId: project.id });
    projectLog.error(formatFailureDiagnostic(failure));
    await notifyAttentionRequired(
      emailNotifier,
      {
        project,
        category: failureDescription.category,
        reason: failureDescription.reason,
      },
      projectLog,
    );
  }

  while (!signal.aborted) {
    const blockedPreparedConflict = blockedPreparedConflicts.get(project.id);
    drainNotifications(project.id, emailNotifier, (message) =>
      logger.child({ projectId: project.id }).warn(message),
    );

    if (blockedPreparedConflict !== undefined) {
      const recovered = await hasPreparedConflictRecovery(
        git,
        project,
        blockedPreparedConflict,
        signal,
      );

      if (signal.aborted || !recovered) {
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }

      blockedPreparedConflicts.delete(project.id);
      preparedConflictAttempts.clear();
      suppressedFailureIdentity = undefined;
      logger
        .child({
          projectId: project.id,
          ...(blockedPreparedConflict.cardId === undefined
            ? {}
            : { cardId: blockedPreparedConflict.cardId }),
        })
        .event(
          "Recovered blocked prepared-conflict state after local rebase completion; preserving the handoff for publication remediation",
        );

      if (signal.aborted) {
        continue;
      }
    }

    const blockedReconciliation = blockedReconciliations.values().next().value;

    if (blockedReconciliation !== undefined) {
      if (blockedReconciliation.malformed) {
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }

      if (
        blockedReconciliation.restored &&
        blockedReconciliation.recoveryCondition === "worker-restart"
      ) {
        try {
          removeReconciliationBlock(runtimeStorageRoot, project.id);
        } catch (error) {
          logger
            .child({ projectId: project.id })
            .error(
              `Could not complete explicit operator recovery for the restored ${blockedReconciliation.operation} block; retaining the persisted block: ${getErrorMessage(error)}`,
            );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        blockedReconciliations.delete(blockedReconciliation.attemptKey);
        githubReconciliationAttempts.delete(blockedReconciliation.attemptKey);
        trelloTransientAttempts.delete(blockedReconciliation.attemptKey);
        logger
          .child({ projectId: project.id })
          .event(
            `Recovered blocked ${blockedReconciliation.operation} reconciliation after explicit worker restart; resuming normal processing`,
          );
        logger
          .child({
            projectId: project.id,
            ...(blockedReconciliation.cardId === undefined
              ? {}
              : { cardId: blockedReconciliation.cardId }),
          })
          .diagnostic({
            code: "recovery-deferred",
            classification: "workflow-recovery",
            recovery: "none",
          });
      } else {
        const recovered = await hasReconciliationRecovery(
          trello,
          project,
          blockedReconciliation,
          signal,
        );

        if (signal.aborted || !recovered) {
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        try {
          removeReconciliationBlock(runtimeStorageRoot, project.id);
        } catch (error) {
          logger
            .child({ projectId: project.id })
            .error(
              `Could not remove the recovered ${blockedReconciliation.operation} block; retaining the project block and persisted state: ${getErrorMessage(error)}`,
            );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        blockedReconciliations.delete(blockedReconciliation.attemptKey);
        githubReconciliationAttempts.delete(blockedReconciliation.attemptKey);
        trelloTransientAttempts.delete(blockedReconciliation.attemptKey);
        logger
          .child({
            projectId: project.id,
            ...(blockedReconciliation.cardId === undefined
              ? {}
              : { cardId: blockedReconciliation.cardId }),
          })
          .event(
            `Recovered blocked ${blockedReconciliation.operation} reconciliation after the affected card returned to Ready for Agent; resuming normal processing`,
          );
        logger
          .child({
            projectId: project.id,
            ...(blockedReconciliation.cardId === undefined
              ? {}
              : { cardId: blockedReconciliation.cardId }),
          })
          .diagnostic({
            code: "recovery-deferred",
            classification: "workflow-recovery",
            recovery: "none",
          });
      }
    }

    try {
      if (runContext && !runContext.authority) {
        if (runContext.newClaimsBlockedReason) {
          logger
            .child({ projectId: project.id })
            .warn(runContext.newClaimsBlockedReason);
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }
        if (
          runContext.projectLease === undefined ||
          runContext.pinned === undefined ||
          runContext.coordinationRoot === undefined
        ) {
          throw new Error(
            "Project has no lease-bound attempt creation context",
          );
        }
        if (pendingTrelloValidation !== undefined) {
          await pendingTrelloValidation(trello, project);
          pendingTrelloValidation = undefined;
        }
        const readyCards = await getCardsForDiscovery(
          trello,
          project.id,
          project.trello.readyListId,
          "Could not inspect Ready cards before canonical attempt selection",
          signal,
        );
        const selected = readyCards.find(
          (card) =>
            isCardStartDateReached(card, Date.now()) &&
            getWorkflowKind(card, project) !== null,
        );
        if (selected === undefined) {
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }
        const taskKind = getWorkflowKind(selected, project);
        if (taskKind === null) continue;
        runContext.projectLease.assertHeld();
        const authority = await ProjectRunAuthority.createPreparingAttempt({
          projectId: project.id,
          cardId: selected.id,
          taskKind,
          pinned: runContext.pinned,
          projectLease: runContext.projectLease,
          coordinationRoot: runContext.coordinationRoot,
          ...(taskKind === "implementation"
            ? {
                budgets: {
                  validation: {
                    limit: MAX_VALIDATION_REPAIR_ATTEMPTS,
                    used: 0,
                    episodeId: `${selected.id}:initial-validation`,
                    trigger: "initial-implementation",
                  },
                  review: {
                    limit: project.opencode.remediation.maxPasses + 1,
                    used: 0,
                    episodeId: `${selected.id}:initial-review`,
                    trigger: "initial-implementation",
                  },
                  ci: {
                    limit: 2,
                    used: 0,
                    episodeId: `${selected.id}:initial-ci`,
                    trigger: "initial-publication",
                  },
                },
              }
            : {}),
        });
        authority.claim();
        runContext = { ...runContext, authority };
        return await authority.run(() =>
          runProjectWorkerInner(
            trello,
            git,
            github,
            opencode,
            commands,
            project,
            pollIntervalMilliseconds,
            signal,
            emailNotifier,
            deferredTrelloValidation,
            runContext,
          ),
        );
      }
      if (
        runContext?.authority &&
        (await reconcileWorkflowMutations({ project, trello, github, git }))
      ) {
        await sleep(Math.max(pollIntervalMilliseconds, 15_000), signal);
        continue;
      }
      const authorityRecord = runContext?.authority?.store.read();
      const recoverableTaskWaitDue = hasDueTaskSessionRecoveryWait(
        authorityRecord ?? null,
      );
      const resumableLegacyAttempt =
        authorityRecord?.lifecycle === "waiting" &&
        authorityRecord.legacy.recoveryDisposition === "task-session-reconcile";
      if (
        runContext?.authority &&
        (!authorityRecord ||
          (authorityRecord.lifecycle === "waiting" &&
            !resumableLegacyAttempt &&
            !recoverableTaskWaitDue))
      ) {
        logger
          .child({ projectId: project.id })
          .info(
            `Canonical attempt is waiting (${authorityRecord?.wait.reason ?? "checkpoint unavailable"}); no workflow mutations will be dispatched`,
          );
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }
      // An already-pinned publication has its own paced service readback.
      // Re-running deferred startup resource validation here would funnel a
      // Trello outage into the legacy exhausted/manual-restart block instead
      // of resuming this same checkpoint when the service recovers.
      if (
        runContext?.authority &&
        (await resumeInitialPublication({
          project,
          trello,
          git,
          github,
          signal,
          opencode,
          ...(emailNotifier === undefined ? {} : { emailNotifier }),
        }))
      ) {
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }
      if (pendingTrelloValidation !== undefined) {
        await pendingTrelloValidation(trello, project);
        pendingTrelloValidation = undefined;
      }

      const preparingAuthority = runContext?.authority;
      const preparingAttempt = preparingAuthority?.store.read();
      if (preparingAttempt?.lifecycle === "preparing") {
        const readyCards = await getCardsForDiscovery(
          trello,
          project.id,
          project.trello.readyListId,
          "Could not revalidate the preparing attempt in Ready for Agent",
          signal,
        );
        const card = readyCards.find(
          (candidate) => candidate.id === preparingAttempt.cardId,
        );
        if (
          !card ||
          !isCardStartDateReached(card, Date.now()) ||
          getWorkflowKind(card, project) !== preparingAttempt.taskKind
        ) {
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }
        preparingAuthority!.assertHeld();
        preparingAuthority!.claim();
      }

      if (emailNotifier === undefined) {
        await withGitHubOperationProject(project, () =>
          pollProject(
            trello,
            git,
            github,
            opencode,
            commands,
            project,
            signal,
            undefined,
            onHumanReviewCardsObserved,
            onHumanReviewCardLeft,
            runContext?.authority,
            pollIntervalMilliseconds,
          ),
        );
      } else {
        await withGitHubOperationProject(project, () =>
          pollProject(
            trello,
            git,
            github,
            opencode,
            commands,
            project,
            signal,
            emailNotifier,
            onHumanReviewCardsObserved,
            onHumanReviewCardLeft,
            runContext?.authority,
            pollIntervalMilliseconds,
          ),
        );
      }

      const completedAttempt = runContext?.authority?.store.read();
      if (
        completedAttempt &&
        ["done", "refined", "failed", "cancelled"].includes(
          completedAttempt.lifecycle,
        ) &&
        completedAttempt.terminalSync === "verified"
      ) {
        await runContext!.authority!.releaseVerifiedTerminal();
        const { authority: _releasedAuthority, ...releasedContext } =
          runContext!;
        void _releasedAuthority;
        runContext = releasedContext;
      }

      githubReconciliationAttempts.clear();
      trelloTransientAttempts.clear();
      preparedConflictAttempts.clear();
      suppressedFailureIdentity = undefined;
      restoredFailureIdentity = undefined;
      activeHumanReviewFailureIdentities.clear();
      if (completedAttempt && runContext && !runContext.authority)
        return "authority-released";
    } catch (error) {
      if (error instanceof NotificationPreparationError) throw error;
      if (
        isShutdownCancellation(error, signal) ||
        (signal.aborted && signal.reason === "fatal")
      ) {
        const processFailure = getProcessExecutionError(error);
        if (processFailure) {
          logger
            .child({
              projectId: project.id,
              ...(getFailureContext(error)?.cardId === undefined
                ? {}
                : { cardId: getFailureContext(error)!.cardId }),
            })
            .diagnostic({
              code: "process-failed",
              classification: "process",
              recovery: "state-preserved",
              artifactReferences: [processFailure.artifactReference],
            });
        }
        return;
      }

      const pendingMutations = runContext?.authority?.store
        .read()
        ?.pendingOperations.some(
          (entry) =>
            entry.id.startsWith("workflow:") &&
            !["completed", "cancelled"].includes(entry.status),
        );
      if (pendingMutations) {
        logger
          .child({ projectId: project.id })
          .info(
            "Workflow mutation pending; ownership and completed effects retained for paced readback",
          );
        await sleep(Math.max(pollIntervalMilliseconds, 15_000), signal);
        continue;
      }
      const alreadyTerminal = runContext?.authority?.store.read();
      if (
        runContext?.authority &&
        alreadyTerminal &&
        ["done", "refined", "failed", "cancelled"].includes(
          alreadyTerminal.lifecycle,
        ) &&
        alreadyTerminal.terminalSync === "verified"
      ) {
        logger
          .child({ projectId: project.id, cardId: alreadyTerminal.cardId })
          .warn(
            `Workflow returned an error after authoritative terminal completion; preserving the verified outcome: ${getErrorMessage(error)}`,
          );
        await runContext.authority.releaseVerifiedTerminal();
        const { authority: _completedAuthority, ...releasedContext } =
          runContext;
        void _completedAuthority;
        runContext = releasedContext;
        return "authority-released";
      }

      if (runContext && !runContext.authority) {
        logger
          .child({ projectId: project.id })
          .warn(
            `Project has no canonical active attempt; retaining transient failure without legacy-state writes: ${getErrorMessage(error)}`,
          );
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }

      if (error instanceof TrelloListDiscoveryError) {
        const authority = runContext?.authority;
        const run = authority?.store.read();
        const taskValue = run?.compatibility[`task-execution-${run.cardId}`];
        const priorWait =
          taskValue === undefined
            ? undefined
            : parseTaskExecutionRecord(taskValue).recoveryWait?.notificationId;
        const waitId = persistEssentialDependencyWait(
          authority,
          authority?.cardId,
          pollIntervalMilliseconds,
          "trello:list-discovery",
        );
        if (waitId !== undefined) {
          if (waitId !== priorWait)
            logger
              .child({
                projectId: project.id,
                ...(authority?.cardId ? { cardId: authority.cardId } : {}),
              })
              .warn(
                `Essential dependency wait ${waitId} scheduled after ${error.attempts} bounded Trello list-read attempts`,
              );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }
        logger
          .child({ projectId: project.id })
          .warn(
            `${error.message}; card-list discovery remains retryable and the project will be retried on the next polling cycle`,
          );
        await sleep(pollIntervalMilliseconds, signal);
        continue;
      }

      if (
        !(error instanceof RetryableGitHubReconciliationError) &&
        isRetryableGitHubError(error) &&
        runContext?.authority?.cardId
      ) {
        const cardId = runContext.authority.cardId;
        const attemptKey = `${cardId}:github-essential-read`;
        const attempt = (githubReadAttempts.get(attemptKey) ?? 0) + 1;
        githubReadAttempts.set(attemptKey, attempt);
        if (attempt < MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
          await sleep(getRetryBackoffDelayMilliseconds(attempt), signal);
          continue;
        }
        const run = runContext.authority.store.read();
        const taskValue = run?.compatibility[`task-execution-${cardId}`];
        const priorWait =
          taskValue === undefined
            ? undefined
            : parseTaskExecutionRecord(taskValue).recoveryWait?.notificationId;
        const waitId = persistEssentialDependencyWait(
          runContext.authority,
          cardId,
          pollIntervalMilliseconds,
          "github:essential-read",
        );
        if (waitId !== undefined) {
          if (waitId !== priorWait)
            logger
              .child({ projectId: project.id, cardId })
              .warn(
                `Essential dependency wait ${waitId} scheduled after ${attempt} bounded GitHub read attempts`,
              );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }
      }

      let failureContext = getFailureContext(error);
      let newlyBlockedReconciliation: BlockedReconciliation | undefined;

      if (error instanceof PreparedConflictRemediationError) {
        const cardId = failureContext?.cardId;
        const attemptKey = `${cardId ?? "project"}:prepared-conflict`;
        const attempt = (preparedConflictAttempts.get(attemptKey) ?? 0) + 1;

        preparedConflictAttempts.set(attemptKey, attempt);

        const projectLog = logger.child({
          projectId: project.id,
          ...(cardId === undefined ? {} : { cardId }),
        });

        projectLog.warn(
          `Prepared conflict remediation attempt ${attempt}/${MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS} failed: ${error.message}`,
        );
        projectLog.diagnostic({
          code: "recovery-deferred",
          classification: "workflow-recovery",
          recovery:
            attempt < MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS
              ? "retry-scheduled"
              : "state-preserved",
          attempt,
          maximumAttempts: MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS,
        });

        if (attempt < MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        blockedPreparedConflicts.set(project.id, {
          cardId,
          recoveryCheckFailed: false,
        });
        projectLog.error(
          `Prepared-conflict recovery is safely deferred for ${cardId ?? "unknown card"}: automatic rebase continuation is disabled and local/remote state cannot establish unpublished provenance. Handoff and worktree are preserved; no branch writer or new claim will run until additive recovery is available or an operator reconciles the state.`,
        );
      }

      if (error instanceof RetryableGitHubReconciliationError) {
        const attemptKey = `${error.cardId}:${error.operation}`;
        const attempt = (githubReconciliationAttempts.get(attemptKey) ?? 0) + 1;

        githubReconciliationAttempts.set(attemptKey, attempt);

        const projectLog = logger.child({
          projectId: project.id,
          cardId: error.cardId,
        });
        const causeMessage =
          error.cause instanceof Error
            ? error.cause.message
            : String(error.cause);

        projectLog.warn(
          `Retryable GitHub reconciliation attempt ${attempt}/${MAX_GITHUB_RECONCILIATION_ATTEMPTS} failed for ${error.operation}: ${causeMessage}`,
        );
        projectLog.diagnostic({
          code: "recovery-deferred",
          classification: "external-operation",
          recovery:
            attempt < MAX_GITHUB_RECONCILIATION_ATTEMPTS
              ? "retry-scheduled"
              : "state-preserved",
          attempt,
          maximumAttempts: MAX_GITHUB_RECONCILIATION_ATTEMPTS,
        });

        if (attempt < MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
          await sleep(getRetryBackoffDelayMilliseconds(attempt), signal);
          continue;
        }

        const activeRun = runContext?.authority?.store.read();
        const activeTaskValue =
          activeRun?.compatibility[`task-execution-${error.cardId}`];
        const previousWaitId =
          activeTaskValue === undefined
            ? undefined
            : parseTaskExecutionRecord(activeTaskValue).recoveryWait
                ?.notificationId;
        const waitId = persistEssentialDependencyWait(
          runContext?.authority,
          error.cardId,
          pollIntervalMilliseconds,
          `github:${error.operation}`,
        );
        if (waitId !== undefined) {
          if (waitId !== previousWaitId)
            projectLog.warn(
              `Essential dependency wait ${waitId} scheduled after bounded GitHub read retries; verified ${activeRun?.checkpoint} checkpoint retained`,
            );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        const handlingOutcome = `blocked ${error.operation} reconciliation after ${attempt} failed attempts; resolve the failure and move card ${error.cardId} from its reconciliation list to Ready for Agent to resume`;

        blockedReconciliations.set(attemptKey, {
          attemptKey,
          operation: `GitHub ${error.operation}`,
          cardId: error.cardId,
          reconciliationListId:
            error.reconciliationListId ?? failureContext?.reconciliationListId,
          failure: error,
          recoveryCheckFailed: false,
          recoveryCondition: "card-moved-to-ready",
          notificationIdentity: undefined,
          failureIdentity: undefined,
          restored: false,
          malformed: false,
        });
        newlyBlockedReconciliation = blockedReconciliations.get(attemptKey);
        annotateFailure(error, {
          projectId: project.id,
          cardId: error.cardId,
          handlingOutcome,
        });
        failureContext = getFailureContext(error);
        projectLog.error(
          `GitHub reconciliation retry threshold exhausted for ${error.operation}; ${handlingOutcome}`,
        );
      }

      if (isRetryableTrelloError(error)) {
        const operation = getTrelloRequestOperation(error) ?? "card operation";
        const cardId = failureContext?.cardId;
        const attemptKey = `${cardId ?? "project"}:${operation}`;
        const attempt = (trelloTransientAttempts.get(attemptKey) ?? 0) + 1;

        trelloTransientAttempts.set(attemptKey, attempt);

        const projectLog = logger.child({
          projectId: project.id,
          ...(cardId === undefined ? {} : { cardId }),
        });

        projectLog.warn(
          `Retryable Trello operation attempt ${attempt}/${MAX_TRELLO_RECONCILIATION_ATTEMPTS} failed for ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        );
        projectLog.diagnostic({
          code: "trello-retry-deferred",
          classification: "external-operation",
          recovery:
            attempt < MAX_TRELLO_RECONCILIATION_ATTEMPTS
              ? "retry-scheduled"
              : "state-preserved",
          attempt,
          maximumAttempts: MAX_TRELLO_RECONCILIATION_ATTEMPTS,
        });

        if (attempt < MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
          await sleep(getRetryBackoffDelayMilliseconds(attempt), signal);
          continue;
        }

        const activeRun = runContext?.authority?.store.read();
        const recoveryCardId = cardId ?? runContext?.authority?.cardId;
        const activeTaskValue = recoveryCardId
          ? activeRun?.compatibility[`task-execution-${recoveryCardId}`]
          : undefined;
        const previousWaitId =
          activeTaskValue === undefined
            ? undefined
            : parseTaskExecutionRecord(activeTaskValue).recoveryWait
                ?.notificationId;
        const retryableRead = [
          "board lookup",
          "list lookup",
          "card lookup",
          "card action lookup",
          "transition history",
        ].includes(operation);
        const waitId = retryableRead
          ? persistEssentialDependencyWait(
              runContext?.authority,
              recoveryCardId,
              pollIntervalMilliseconds,
              `trello:${operation}`,
            )
          : undefined;
        if (waitId !== undefined && retryableRead) {
          if (waitId !== previousWaitId)
            projectLog.warn(
              `Essential dependency wait ${waitId} scheduled after bounded Trello read retries; verified ${activeRun?.checkpoint} checkpoint retained`,
            );
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        const handlingOutcome =
          cardId === undefined
            ? `blocked Trello ${operation} reconciliation after ${attempt} failed attempts; resolve the failure before restarting the worker`
            : `blocked Trello ${operation} reconciliation after ${attempt} failed attempts; resolve the failure and move card ${cardId} from its reconciliation list to Ready for Agent to resume`;
        const reconciliationListId =
          error instanceof RetryableTrelloReconciliationError
            ? error.reconciliationListId
            : undefined;

        blockedReconciliations.set(attemptKey, {
          attemptKey,
          operation: `Trello ${operation}`,
          cardId,
          reconciliationListId:
            reconciliationListId ?? failureContext?.reconciliationListId,
          failure: error instanceof Error ? error : new Error(String(error)),
          recoveryCheckFailed: false,
          recoveryCondition:
            cardId === undefined ? "worker-restart" : "card-moved-to-ready",
          notificationIdentity: undefined,
          failureIdentity: undefined,
          restored: false,
          malformed: false,
        });
        newlyBlockedReconciliation = blockedReconciliations.get(attemptKey);
        if (error instanceof Error) {
          annotateFailure(error, {
            projectId: project.id,
            ...(cardId === undefined ? {} : { cardId }),
            handlingOutcome,
          });
          failureContext = getFailureContext(error);
        }
        projectLog.error(
          `Trello retry threshold exhausted for ${operation}; ${handlingOutcome}`,
        );
      }

      const projectLog = logger.child({
        projectId: project.id,
        ...(failureContext?.cardId === undefined
          ? {}
          : { cardId: failureContext.cardId }),
      });

      const cardIds = [
        ...(failureContext?.cardIds ?? []),
        ...(failureContext?.cardId === undefined
          ? []
          : [failureContext.cardId]),
      ].filter((cardId, index, ids) => ids.indexOf(cardId) === index);
      const sessionLogPaths = [
        ...(failureContext?.sessionLogPaths ?? []),
        ...(failureContext?.sessionLogPath === undefined
          ? []
          : [failureContext.sessionLogPath]),
      ].filter(
        (sessionLogPath, index, paths) =>
          paths.indexOf(sessionLogPath) === index,
      );
      const handlingOutcome = failureContext?.handlingOutcome;

      const cardFailureHandled =
        failureContext?.cardId !== undefined &&
        failureContext.cardFailureHandled === true;

      const failureDescription = describeFailure(error);
      const processFailure = getProcessExecutionError(error);
      projectLog.diagnostic({
        code: processFailure ? "process-failed" : "task-failure",
        classification: processFailure
          ? "process"
          : error instanceof WorkflowError
            ? "internal-workflow"
            : "external-operation",
        recovery: newlyBlockedReconciliation
          ? "state-preserved"
          : "manual-review",
        ...(processFailure
          ? {
              artifactReferences: [processFailure.artifactReference],
            }
          : {}),
      });
      const currentFailureIdentity = failureNotificationIdentity(
        project.id,
        failureContext?.reconciliationOperation,
        failureDescription.category,
        failureDescription.reason,
        cardIds,
        handlingOutcome,
      );
      const currentFailureBaseIdentity = failureNotificationIdentity(
        project.id,
        failureContext?.reconciliationOperation,
        failureDescription.category,
        failureDescription.reason,
        cardIds,
        undefined,
      );

      const suppressUnchangedHumanReviewFailure =
        failureContext?.reconciliationListId === project.trello.reviewListId &&
        failureContext?.reconciliationOperation !== undefined &&
        cardIds.length > 0 &&
        !cardFailureHandled &&
        activeHumanReviewFailureIdentities.get(humanReviewCardKey(cardIds)) ===
          currentFailureBaseIdentity;

      const humanReviewFailureKey =
        failureContext?.reconciliationListId === project.trello.reviewListId &&
        failureContext?.reconciliationOperation !== undefined &&
        cardIds.length > 0
          ? humanReviewCardKey(cardIds)
          : undefined;

      if (suppressUnchangedHumanReviewFailure) {
        projectLog.info(
          "Human Review reconciliation failure diagnostic suppressed for unchanged failure",
        );
      } else {
        projectLog.error(
          formatFailureDiagnostic(
            error,
            failureContext === undefined
              ? {}
              : {
                  ...(failureContext.sessionLogPath === undefined
                    ? {}
                    : { sessionLogPath: failureContext.sessionLogPath }),
                  ...(failureContext.handlingOutcome === undefined
                    ? {}
                    : { handlingOutcome: failureContext.handlingOutcome }),
                },
          ),
        );
      }

      if (newlyBlockedReconciliation !== undefined) {
        if (!cardFailureHandled)
          prepareAttentionNotification(emailNotifier, {
            project,
            category: failureDescription.category,
            reason: failureDescription.reason,
            ...(cardIds.length ? { cardIds } : {}),
            ...(sessionLogPaths.length ? { sessionLogPaths } : {}),
            ...(handlingOutcome === undefined ? {} : { handlingOutcome }),
          });
        newlyBlockedReconciliation.notificationIdentity =
          currentFailureIdentity;
        newlyBlockedReconciliation.failureIdentity = currentFailureBaseIdentity;

        try {
          writeReconciliationBlock(
            runtimeStorageRoot,
            createPersistedReconciliationBlock(
              project,
              newlyBlockedReconciliation,
              failureContext,
              sessionLogPaths,
              failureDescription.category,
              failureDescription.reason,
              currentFailureIdentity,
              currentFailureBaseIdentity,
            ),
          );
        } catch (storageError) {
          projectLog.error(
            `Could not persist exhausted reconciliation block; the project remains blocked in memory until restart, but runtime state may require operator investigation: ${getErrorMessage(storageError)}`,
          );
        }
      }

      if (cardFailureHandled) {
        if (humanReviewFailureKey !== undefined) {
          activeHumanReviewFailureIdentities.delete(humanReviewFailureKey);
        }
        suppressedFailureIdentity = undefined;
        restoredFailureIdentity = undefined;
      } else if (
        humanReviewFailureKey !== undefined
          ? suppressUnchangedHumanReviewFailure
          : currentFailureIdentity === suppressedFailureIdentity ||
            currentFailureBaseIdentity === restoredFailureIdentity
      ) {
        projectLog.info(
          "Attention-required notification suppressed for unchanged unresolved failure",
        );
      } else {
        if (humanReviewFailureKey !== undefined) {
          activeHumanReviewFailureIdentities.set(
            humanReviewFailureKey,
            currentFailureBaseIdentity,
          );
        }
        suppressedFailureIdentity = currentFailureIdentity;
        restoredFailureIdentity = undefined;

        await notifyAttentionRequired(
          emailNotifier,
          {
            project,
            category: failureDescription.category,
            reason: failureDescription.reason,
            ...(cardIds.length === 0 ? {} : { cardIds }),
            ...(sessionLogPaths.length === 0 ? {} : { sessionLogPaths }),
            ...(handlingOutcome === undefined ? {} : { handlingOutcome }),
          },
          projectLog,
        );
      }
    }

    await sleep(pollIntervalMilliseconds, signal);
  }
}

async function runProjectWorker(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  project: PollingProject,
  pollIntervalMilliseconds: number,
  signal: AbortSignal,
  emailNotifier?: EmailNotifier,
  deferredTrelloValidation?: typeof validateProjectTrello,
  runContext?: ProjectRunWorkerContext,
): Promise<void> {
  let currentContext = runContext;
  const outbox = runContext?.projectLease
    ? new NotificationOutbox(
        runContext.pinned?.storageRoot ??
          project.contextRoot ??
          DEFAULT_CONTEXT_ROOT,
        project.id,
        () => runContext.projectLease!.assertHeld(),
        Date.now,
        notificationTriggerObserver(
          runContext.pinned?.storageRoot ??
            project.contextRoot ??
            DEFAULT_CONTEXT_ROOT,
          project.id,
          () => runContext.projectLease!.assertHeld(),
        ),
      )
    : undefined;
  while (!signal.aborted) {
    const execute = () =>
      runProjectWorkerInner(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        pollIntervalMilliseconds,
        signal,
        emailNotifier,
        deferredTrelloValidation,
        currentContext,
      );
    const owned = () =>
      currentContext?.authority
        ? currentContext.authority.run(execute)
        : execute();
    let outcome: "authority-released" | undefined;
    try {
      outcome = outbox ? await outbox.run(owned) : await owned();
    } catch (error) {
      if (!(error instanceof NotificationPreparationError)) throw error;
      const defer = () =>
        deferNotificationPreparation(project.id, (message) =>
          logger.child({ projectId: project.id }).warn(message),
        );
      if (currentContext?.authority) currentContext.authority.run(defer);
      else defer();
      await sleep(Math.max(pollIntervalMilliseconds, 15_000), signal);
      continue;
    }
    if (outcome !== "authority-released") return;
    if (currentContext) {
      const { authority: _releasedAuthority, ...releasedContext } =
        currentContext;
      void _releasedAuthority;
      currentContext = releasedContext;
    }
  }
}

export async function runOrchestrator(
  trello: TrelloClient,
  git: GitClient,
  github: GitHubClient,
  opencode: OpenCodeClient,
  commands: CommandRunner,
  config: Config,
  signal: AbortSignal,
  emailNotifier?: EmailNotifier,
  deferredTrelloValidation?: typeof validateProjectTrello,
  projectRunContexts?: ReadonlyMap<string, ProjectRunWorkerContext>,
): Promise<void> {
  const pollIntervalMilliseconds = config.workflow.pollIntervalSeconds * 1000;
  const retentionTimer = setInterval(
    () => {
      if (signal.aborted) {
        return;
      }

      runBestEffortRetention("log retention", () =>
        cleanupLogRetention(
          config.workflow.logRetentionDays,
          new Date(),
          [
            ...new Set([
              config.workflow.contextRoot,
              ...(projectRunContexts
                ? [...projectRunContexts.values()].flatMap((context) =>
                    context.pinned ? [context.pinned.storageRoot] : [],
                  )
                : []),
            ]),
          ],
          projectRunContexts
            ? [...projectRunContexts.values()].flatMap(
                (context) => context.authority?.store.read()?.attemptId ?? [],
              )
            : [],
        ),
      );
      runBestEffortRetention("card context retention", () =>
        cleanupCardContextRetention(
          config.workflow.contextRoot,
          config.workflow.contextRetentionDays,
          new Date(),
          config.projects.map((project) => project.id),
        ),
      );
    },
    Math.max(
      logRetentionIntervalMilliseconds,
      contextRetentionIntervalMilliseconds,
    ),
  );

  if (shouldWriteConsole()) {
    console.log("");
  }

  logger.event(
    `Polling every ${config.workflow.pollIntervalSeconds} seconds...`,
  );

  try {
    await Promise.all(
      config.projects.map((project) =>
        runProjectWorker(
          trello,
          git,
          github,
          opencode,
          commands,
          {
            ...project,
            contextRoot:
              projectRunContexts?.get(project.id)?.pinned?.storageRoot ??
              config.workflow.contextRoot,
            ...(config.workflow.maxAttachmentBytes === undefined
              ? {}
              : { maxAttachmentBytes: config.workflow.maxAttachmentBytes }),
            ...(config.workflow.maxTotalAttachmentBytes === undefined
              ? {}
              : {
                  maxTotalAttachmentBytes:
                    config.workflow.maxTotalAttachmentBytes,
                }),
          } satisfies PollingProject,
          pollIntervalMilliseconds,
          signal,
          emailNotifier,
          deferredTrelloValidation,
          projectRunContexts?.get(project.id),
        ),
      ),
    );
  } finally {
    clearInterval(retentionTimer);
  }
}
