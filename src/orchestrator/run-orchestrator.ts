import type { Config } from "../config/config.js";
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
import { logger } from "../logging/logger.js";
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
  category: string,
  reason: string,
  cardIds: string[],
  handlingOutcome: string | undefined,
): string {
  return JSON.stringify({
    projectId,
    cardIds: [...new Set(cardIds)].sort(),
    category,
    reason,
    handlingOutcome: handlingOutcome ?? null,
  });
}

interface BlockedReconciliation {
  attemptKey: string;
  operation: string;
  cardId: string | undefined;
  reconciliationListId: string | undefined;
  failure: Error;
  recoveryCheckFailed: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): Promise<void> {
  const githubReconciliationAttempts = new Map<string, number>();
  const trelloTransientAttempts = new Map<string, number>();
  const preparedConflictAttempts = new Map<string, number>();
  const blockedPreparedConflicts = new Set<string>();
  const blockedReconciliations = new Map<string, BlockedReconciliation>();
  let suppressedFailureIdentity: string | undefined;
  let pendingTrelloValidation = deferredTrelloValidation;

  while (!signal.aborted) {
    if (blockedPreparedConflicts.has(project.id)) {
      await sleep(pollIntervalMilliseconds, signal);
      continue;
    }

    const blockedReconciliation = blockedReconciliations.values().next().value;

    if (blockedReconciliation !== undefined) {
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
    }

    try {
      if (pendingTrelloValidation !== undefined) {
        await pendingTrelloValidation(trello, project);
        pendingTrelloValidation = undefined;
      }

      if (emailNotifier === undefined) {
        await withGitHubOperationProject(project, () =>
          pollProject(trello, git, github, opencode, commands, project, signal),
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
          ),
        );
      }

      githubReconciliationAttempts.clear();
      trelloTransientAttempts.clear();
      preparedConflictAttempts.clear();
      suppressedFailureIdentity = undefined;
    } catch (error) {
      if (
        isShutdownCancellation(error, signal) ||
        (signal.aborted && signal.reason === "fatal")
      ) {
        return;
      }

      let failureContext = getFailureContext(error);

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

        if (attempt < MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
          await sleep(pollIntervalMilliseconds, signal);
          continue;
        }

        blockedPreparedConflicts.add(project.id);
        projectLog.error(
          "Prepared conflict remediation retry threshold exhausted; blocking this project until the handoff is resolved and the worker is restarted",
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

        if (attempt < MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
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
        });
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

        if (attempt < MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
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
        });
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
      const currentFailureIdentity = failureNotificationIdentity(
        project.id,
        failureDescription.category,
        failureDescription.reason,
        cardIds,
        handlingOutcome,
      );

      if (cardFailureHandled) {
        suppressedFailureIdentity = undefined;
      } else if (currentFailureIdentity === suppressedFailureIdentity) {
        projectLog.info(
          "Attention-required notification suppressed for unchanged unresolved failure",
        );
      } else {
        suppressedFailureIdentity = currentFailureIdentity;

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
): Promise<void> {
  const pollIntervalMilliseconds = config.workflow.pollIntervalSeconds * 1000;
  const retentionTimer = setInterval(
    () => {
      if (signal.aborted) {
        return;
      }

      cleanupLogRetention(config.workflow.logRetentionDays);
      cleanupCardContextRetention(
        config.workflow.contextRoot,
        config.workflow.contextRetentionDays,
        new Date(),
        config.projects.map((project) => project.id),
      );
    },
    Math.max(
      logRetentionIntervalMilliseconds,
      contextRetentionIntervalMilliseconds,
    ),
  );

  console.log("");

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
            contextRoot: config.workflow.contextRoot,
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
        ),
      ),
    );
  } finally {
    clearInterval(retentionTimer);
  }
}
