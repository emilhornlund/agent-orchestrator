import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { notifyAttentionRequired, type EmailNotifier } from "../notifications/email-notifier.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { isConclusiveOperationResolution } from "../task-session/run-record.js";
import { isRetryableTrelloError, type TrelloCard } from "../trello/trello-client.js";
import { recordRefinementAnalysisFailure } from "./refinement-input.js";
import { refinementMutationSnapshotKey } from "./refinement-mutation-snapshot.js";
import { refinementAnalysisIsStopped } from "./run-refinement.js";
import {
  RefinementInternalRecoveryError,
  RefinementSetupAmbiguousError,
  RefinementSetupFailedError,
  refinementSetupIsStopped,
} from "./run-refinement-setup.js";

export const refinementRecoveryKey = "refinement-recovery-v1";
export const refinementRecoverySchema = z.strictObject({
  internalFailures: z.number().int().min(0).max(3),
  rechecks: z.number().int().min(1),
  reason: z.string(),
  kind: z.enum(["internal", "reconciliation"]),
  nextCheckAt: z.iso.datetime(),
});

export class RefinementRecoveryDeferredError extends RefinementSetupAmbiguousError {}

/** Keep the causal diagnostic, not just the outer generic preservation message. */
export function refinementRecoveryReason(error: unknown): string {
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

export function refinementRecoveryDue(authority: ProjectRunAuthority | undefined): boolean {
  const run = authority?.store.read();
  if (run?.taskKind !== "refinement" || run.lifecycle !== "refinement") return true;
  const recovery = authority!.read(refinementRecoveryKey, refinementRecoverySchema.parse);
  return !recovery || Date.now() >= Date.parse(recovery.nextCheckAt);
}

/** No terminal failure while a child or a card write might still be in flight. */
function canFinalizeInternalFailure(
  authority: ProjectRunAuthority,
  project: ProjectConfig,
  worktreePath: string,
): boolean {
  try {
    const run = authority.store.read()!;
    return (
      run.taskKind === "refinement" &&
      run.lifecycle === "refinement" &&
      run.publicationState === "none" &&
      run.pendingOperations.every(isConclusiveOperationResolution) &&
      authority.read(refinementMutationSnapshotKey, (value) => value) === null &&
      refinementSetupIsStopped(authority, project) &&
      refinementAnalysisIsStopped(authority, project, worktreePath)
    );
  } catch {
    return false; // Unreadable evidence is not proof that execution stopped.
  }
}

export async function withRefinementRecovery(options: {
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  signal: AbortSignal;
  emailNotifier?: EmailNotifier;
  execute: () => Promise<void>;
}): Promise<void> {
  const { project, card, worktreePath, signal } = options;
  const authority = ProjectRunAuthority.current(project.id);
  if (!authority) return options.execute();
  const previous = authority.read(refinementRecoveryKey, refinementRecoverySchema.parse);
  const cardLog = logger.child({ projectId: project.id, cardId: card.id });
  const failIfStopped = (reason: string): void => {
    if (!canFinalizeInternalFailure(authority, project, worktreePath)) return;
    recordRefinementAnalysisFailure(
      authority,
      `Refinement internal recovery exhausted after three bounded attempts: ${reason}`,
    );
    throw new RefinementSetupFailedError(
      "Refinement internal recovery exhausted; preserving work and verifying Failed transition",
    );
  };
  if (previous?.internalFailures === 3) {
    // Exhaustion never authorizes another execution, even after restart. Only
    // read-only stopped-process/effect reconciliation may unblock finalization.
    failIfStopped(previous.reason);
  }
  try {
    if (previous?.internalFailures === 3)
      throw new RefinementSetupAmbiguousError(
        "Internal refinement recovery is exhausted; waiting for verified stopped execution and unambiguous card effects",
        { cause: new Error(previous.reason) },
      );
    await options.execute();
    if (previous && !signal.aborted) authority.remove(refinementRecoveryKey);
  } catch (error) {
    if (signal.aborted || !(error instanceof RefinementSetupAmbiguousError)) throw error;
    const internal =
      error instanceof RefinementInternalRecoveryError && !isRetryableTrelloError(error);
    const internalFailures = Math.min(3, (previous?.internalFailures ?? 0) + (internal ? 1 : 0));
    const reason =
      previous?.internalFailures === 3 ? previous.reason : refinementRecoveryReason(error);
    const rechecks = (previous?.rechecks ?? 0) + 1;
    const value = {
      internalFailures,
      rechecks,
      reason,
      kind: internal ? ("internal" as const) : ("reconciliation" as const),
      nextCheckAt: new Date(
        Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(rechecks - 1, 3)),
      ).toISOString(),
    };
    authority.mutate(
      refinementRecoveryKey,
      value,
      () => ({ value, result: undefined }),
      refinementRecoverySchema.parse,
    );
    if (internalFailures === 3) failIfStopped(reason);
    if (previous?.reason !== reason) {
      cardLog.warn(
        `Refinement recovery pending; next controlled recheck ${value.nextCheckAt}. ${reason}`,
      );
      await notifyAttentionRequired(
        options.emailNotifier,
        {
          project,
          category: "Workflow",
          reason,
          cardIds: [card.id],
          sessionLogPaths: [getSessionLogPath(project.id, card.id)],
        },
        cardLog,
      );
    }
    throw new RefinementRecoveryDeferredError(reason, { cause: error });
  }
}
