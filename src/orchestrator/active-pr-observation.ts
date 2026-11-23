import { ciRepairEventId } from "../task-session/ci-repair-event-id.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import {
  withTrackedGitHubReads,
  type GitHubClient,
  type PullRequestState,
} from "../github/github-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { evaluateCiChecks } from "../github/evaluate-ci-checks.js";
import { establishCiCheckExpectations } from "../github/ci-check-expectations.js";
import { readTerminalPrFence, recordTerminalPrFence } from "../task-session/terminal-pr-fence.js";
import {
  ProcessExecutionError,
  withProcessCancellationSignal,
} from "../process/process-runtime.js";
import { logger } from "../logging/logger.js";
import { notifyAttentionRequired, type EmailNotifier } from "../notifications/email-notifier.js";

const arrivalSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  cardId: z.string().min(1),
  pullRequestUrl: z.url(),
  headSha: z.string().min(1),
  observedAt: z.string().datetime(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  artifactId: z.string().min(1),
});
const inboxSchema = z.strictObject({
  version: z.literal(1),
  arrivals: z.array(arrivalSchema),
});
export type ActivePrArrival = z.infer<typeof arrivalSchema>;
const inboxKey = "active-pr-observations";

export function readActivePrArrivals(authority: ProjectRunAuthority): readonly ActivePrArrival[] {
  return authority.read(inboxKey, (value) => inboxSchema.parse(value))?.arrivals ?? [];
}

/** Observation has its own projection: it never advances the writer's checkpoint,
 * acquires its queue, or touches the task worktree. Artifacts retain arrivals even
 * when a later refresh edits/deletes feedback before the writer is free. */
interface ActivePrObservationOptions {
  project: ProjectConfig & { contextRoot?: string };
  github: GitHubClient;
  authority: ProjectRunAuthority;
  terminalOnly?: boolean;
  signal?: AbortSignal;
}

export async function observeActivePullRequest(
  options: ActivePrObservationOptions,
): Promise<void | "superseded"> {
  const id = options.authority.attemptScopeKey;
  if (inFlight.has(id)) return "superseded";
  inFlight.add(id);
  try {
    return await readActivePullRequest(options);
  } finally {
    inFlight.delete(id);
  }
}

async function readActivePullRequest(
  options: ActivePrObservationOptions,
): Promise<void | "superseded"> {
  const { project, github, authority } = options;
  authority.assertHeld();
  if (!authority.cardId || !project.contextRoot) return;
  const tasks = new TaskExecutionStore(project.contextRoot, project, authority);
  const task = tasks.read(authority.cardId);
  if (!task?.pullRequest || task.phase === "done") return "superseded";
  options.signal?.throwIfAborted();
  const lookup = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: task.expectedBranch ?? `agent/${task.cardId}`,
    baseBranch: project.repository.defaultBranch,
    project,
  };
  const readPr = () =>
    options.terminalOnly
      ? github.findPullRequestState(lookup)
      : github.getPullRequestStateByNumber({
          ...lookup,
          pullRequestNumber: task.pullRequest!.number,
        });
  let pr = await readPr();
  options.signal?.throwIfAborted();
  if (!pr || pr.url !== task.pullRequest.url || !pr.headRefOid)
    throw new Error("Active PR observation could not verify the owned PR identity");
  const [owner, repository] = project.repository.github.split("/");
  const matchesRepository = (actual: PullRequestState) =>
    actual.headRefName === lookup.headBranch &&
    actual.baseRefName === lookup.baseBranch &&
    actual.headRepositoryOwner?.login.toLowerCase() === owner?.toLowerCase() &&
    actual.headRepository?.name.toLowerCase() === repository?.toLowerCase() &&
    (actual.state === "MERGED") === (actual.mergedAt !== null);
  if (!matchesRepository(pr))
    throw new Error("Active PR observation has ambiguous repository or terminal identity");
  if (options.terminalOnly && pr.state === "OPEN") return;
  let current =
    pr.state === "OPEN"
      ? {
          feedback: await github.findChangesRequestedPullRequest(lookup, true),
          comments: await github.getPullRequestConversationComments({
            ...lookup,
            pullRequestUrl: pr.url,
          }),
          ci: await github.getCiObservations({
            ...lookup,
            defaultBranch: project.repository.defaultBranch,
            headSha: pr.headRefOid,
            pullRequestNumber: task.pullRequest.number,
            requireAvailableReads: true,
          }),
        }
      : null;
  let baseRelation =
    current !== null && project.maintenance?.enabled !== false
      ? await github.comparePullRequestHeadToBase({
          ...lookup,
          baseBranch: project.repository.defaultBranch,
          headSha: pr.headRefOid,
          requireAvailableReads: true,
        })
      : "uncertain";
  if (current !== null) {
    const confirmed = await readPr();
    if (
      confirmed &&
      confirmed.url === pr.url &&
      confirmed.state !== "OPEN" &&
      confirmed.headRefOid &&
      matchesRepository(confirmed)
    ) {
      pr = confirmed;
      current = null;
      baseRelation = "uncertain";
    } else if (
      confirmed?.url !== pr.url ||
      confirmed.state !== pr.state ||
      confirmed.headRefOid !== pr.headRefOid ||
      !matchesRepository(confirmed) ||
      (current.feedback !== null &&
        (current.feedback.headSha !== pr.headRefOid || current.feedback.url !== pr.url)) ||
      current.ci.headSha !== pr.headRefOid
    ) {
      if (tasks.read(task.cardId)?.pullRequest?.headSha !== task.pullRequest.headSha)
        return "superseded";
      throw new Error("Active PR observation changed or was incomplete during readback");
    }
  }
  const latest = tasks.read(task.cardId);
  // A writer may have published during these reads. Discard this mixed snapshot,
  // not the writer's completion; the next paced observation reads the new head.
  if (
    latest?.pullRequest?.url !== task.pullRequest.url ||
    (current !== null && latest.pullRequest.headSha !== task.pullRequest.headSha)
  )
    return "superseded";
  authority.assertHeld();
  options.signal?.throwIfAborted();
  if (current !== null && pr.headRefOid !== task.pullRequest.headSha)
    throw new Error("Active PR observation head does not match the retained publication");
  if (pr.state !== "OPEN") {
    const active = new TaskMutationQueue(project.contextRoot, project, authority).getActive();
    recordTerminalPrFence(
      authority,
      latest,
      pr,
      active !== null && active.kind !== "terminal-pr",
      project.repository.defaultBranch,
    );
  }
  const content = sanitizeControlledText(
    JSON.stringify({ pullRequest: pr, current, baseRelation }),
  );
  const id = createHash("sha256").update(content).digest("hex");
  const existing = readActivePrArrivals(authority).find((arrival) => arrival.id === id);
  const artifactId =
    existing?.artifactId ??
    authority.store.writeArtifact(Buffer.from(content), "application/json").id;
  authority.mutate(
    inboxKey,
    { version: 1, arrivals: [] },
    (raw) => {
      const inbox = inboxSchema.parse(raw);
      if (inbox.arrivals.some((arrival) => arrival.id === id))
        return { value: inbox, result: undefined };
      return {
        value: inboxSchema.parse({
          ...inbox,
          arrivals: [
            ...inbox.arrivals,
            {
              id,
              cardId: task.cardId,
              pullRequestUrl: pr.url,
              headSha: pr.headRefOid,
              state: pr.state,
              observedAt: new Date().toISOString(),
              artifactId,
            },
          ],
        }),
        result: undefined,
      };
    },
    (value) => inboxSchema.parse(value),
  );
  if (current === null) {
    const queue = new TaskMutationQueue(project.contextRoot, project, authority);
    const eventId = `terminal-pr:${task.cardId}:${pr.state}:${pr.headRefOid}`;
    queue.enqueue({
      projectId: project.id,
      cardId: task.cardId,
      eventId,
      operationKey: `${task.operationKey}:${pr.state}:${pr.headRefOid}`,
      kind: "terminal-pr",
      enqueuedAt: existing?.observedAt ?? new Date().toISOString(),
    });
  } else {
    const queue = new TaskMutationQueue(project.contextRoot, project, authority);
    const observedAt = existing?.observedAt ?? new Date().toISOString();
    if (current.feedback !== null || current.comments.length > 0) {
      // Semantic classification is performed by the serialized scheduler, never
      // concurrently against its ledger. This arrival cannot dispatch a writer.
      queue.enqueue({
        projectId: project.id,
        cardId: task.cardId,
        eventId: `observed-feedback:${id}`,
        operationKey: `observed-feedback:${id}`,
        kind: "feedback",
        enqueuedAt: observedAt,
        dispatchReady: false,
        observationArtifactId: artifactId,
      });
    }
    const ci = evaluateCiChecks({
      expectedHeadSha: pr.headRefOid!,
      observedHeadSha: current.ci.headSha,
      expectations: establishCiCheckExpectations(current.ci.expectationSources),
      checks: current.ci.checks,
    });
    if (
      ci.status === "failed" &&
      !["exhausted", "stopped"].includes(task.ciRepair?.status ?? "") &&
      !queue.get(ciRepairEventId(task, pr.headRefOid!))
    )
      queue.enqueue({
        projectId: project.id,
        cardId: task.cardId,
        eventId: ciRepairEventId(task, pr.headRefOid!),
        operationKey: `${task.operationKey}:ci:${pr.headRefOid}`,
        kind: "ci-repair",
        enqueuedAt: observedAt,
      });
    if (baseRelation === "behind" || baseRelation === "diverged") {
      const eventId = `pr-maintenance:${task.cardId}:${pr.headRefOid}`;
      queue.enqueue({
        projectId: project.id,
        cardId: task.cardId,
        eventId,
        operationKey: eventId,
        kind: "pr-maintenance",
        enqueuedAt: observedAt,
      });
    }
  }
}

const healthKey = "active-pr-observation-health-v1";
const healthSchema = z.strictObject({
  status: z.enum(["healthy", "degraded", "recovering"]),
  failures: z.number().int().min(0).max(16),
  retryAt: z.string().datetime().nullable(),
  identity: z.string().optional(),
  diagnosticReference: z.string().optional(),
  since: z.string().datetime().optional(),
  recoveredAt: z.string().datetime().optional(),
});
export function readActivePrObservationHealth(authority: ProjectRunAuthority) {
  return authority.read(healthKey, healthSchema.parse);
}

/** Observe alongside the writer using a separate cancellation scope and a durable circuit breaker. */
export async function withActivePrObservation<T>(
  options: {
    project: ProjectConfig & { contextRoot?: string };
    github: GitHubClient;
    authority: ProjectRunAuthority;
    intervalMs: number;
    signal: AbortSignal;
    timeoutMs?: number;
    emailNotifier?: EmailNotifier;
    onError: (error: unknown, diagnosticReference?: string) => void;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const id = options.authority.attemptScopeKey;
  if (observing.has(id)) return operation();
  observing.add(id);
  const control = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const save = (health: z.infer<typeof healthSchema>) =>
    options.authority.mutate(
      healthKey,
      health,
      () => ({ value: health, result: undefined }),
      healthSchema.parse,
    );
  const schedule = () => {
    if (stopped || options.signal.aborted || readTerminalPrFence(options.authority)) return;
    const health = readActivePrObservationHealth(options.authority);
    timer = setTimeout(
      () => {
        if (inFlight.has(id)) {
          scheduleSafely();
          return;
        }
        pending = options.authority
          .run(async () => {
            const controller = new AbortController();
            const signal = AbortSignal.any([options.signal, control.signal, controller.signal]);
            const deadline = setTimeout(
              () => controller.abort(new Error("Active PR observation deadline exceeded")),
              options.timeoutMs ?? 90_000,
            );
            try {
              if (health?.status === "degraded") save({ ...health, status: "recovering" });
              const transports = new Set<Promise<unknown>>();
              const task = withTrackedGitHubReads(transports, () =>
                withProcessCancellationSignal(signal, () =>
                  observeActivePullRequest({ ...options, signal }),
                ),
              );
              let abort: () => void = () => undefined;
              const cancelled = new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason as unknown);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
              });
              const result = await Promise.race([task, cancelled]).finally(async () => {
                signal.removeEventListener("abort", abort);
                // Abort siblings from failed aggregate reads before releasing
                // the lease, and await their bounded stop/evidence handling.
                if (transports.size) {
                  controller.abort();
                  await Promise.allSettled(transports);
                }
              });
              if (result === "superseded") return;
              if (health?.failures) {
                save({
                  status: "healthy",
                  failures: 0,
                  retryAt: null,
                  recoveredAt: new Date().toISOString(),
                });
                logger
                  .child({
                    projectId: options.project.id,
                    ...(options.authority.cardId ? { cardId: options.authority.cardId } : {}),
                  })
                  .event(
                    `Active PR observation recovered; attempt ${options.authority.store.attemptId}`,
                  );
              }
            } catch (error) {
              if (control.signal.aborted || options.signal.aborted) return;
              try {
                const failures = Math.min((health?.failures ?? 0) + 1, 16);
                const message = sanitizeControlledText(
                  error instanceof Error ? error.message : "Unknown observation failure",
                ).slice(0, 2000);
                const identity =
                  error instanceof ProcessExecutionError
                    ? error.classification
                    : controller.signal.aborted
                      ? "timeout"
                      : message;
                const changed = health?.identity !== identity;
                const diagnostic = changed
                  ? options.authority.store.writeArtifact(
                      Buffer.from(
                        sanitizeControlledText(
                          JSON.stringify({
                            kind: "active-pr-observation-failure",
                            name: error instanceof Error ? error.name : "UnknownError",
                            message,
                          }),
                        ),
                      ),
                      "application/json",
                    ).id
                  : health?.diagnosticReference;
                const since = health?.since ?? new Date().toISOString();
                save({
                  status: failures >= 2 ? "degraded" : "healthy",
                  failures,
                  identity,
                  since,
                  ...(diagnostic === undefined ? {} : { diagnosticReference: diagnostic }),
                  retryAt: new Date(
                    Date.now() + Math.min(300_000, options.intervalMs * 2 ** Math.min(failures, 8)),
                  ).toISOString(),
                });
                if (changed) options.onError(error, diagnostic);
                if (failures >= 2 && options.emailNotifier && options.authority.cardId) {
                  const cardId = options.authority.cardId;
                  const owned = options.authority.store.read();
                  const pr = owned?.resources.find(
                    (resource) => resource.kind === "pull-request",
                  )?.path;
                  await notifyAttentionRequired(
                    options.emailNotifier,
                    {
                      project: options.project,
                      cardIds: [cardId],
                      category: "active-pr-observation",
                      reason: `${pr ?? "Owned pull request"}; attempt ${options.authority.store.attemptId}; ${message}${diagnostic ? `; diagnostics: ${diagnostic}` : ""}`,
                      handlingOutcome:
                        "Monitoring degraded; automatic recovery probes continue with the original task and observations retained",
                      eventId: `active-pr-observation:${options.authority.store.attemptId}:${since}`,
                    },
                    logger.child({ projectId: options.project.id, cardId }),
                  );
                }
              } catch {
                // Diagnostics must not replace a writer's successful completion.
              }
            } finally {
              clearTimeout(deadline);
              scheduleSafely();
            }
          })
          .catch(() => undefined);
      },
      Math.max(options.intervalMs, (health?.retryAt ? Date.parse(health.retryAt) : 0) - Date.now()),
    );
  };
  const scheduleSafely = () => {
    try {
      schedule();
    } catch {
      /* An unreadable observer projection must not fail the writer. */
    }
  };
  scheduleSafely();
  try {
    return await operation();
  } finally {
    stopped = true;
    control.abort();
    clearTimeout(timer);
    try {
      await pending;
    } finally {
      observing.delete(id);
    }
  }
}
const observing = new Set<string>();
const inFlight = new Set<string>();
