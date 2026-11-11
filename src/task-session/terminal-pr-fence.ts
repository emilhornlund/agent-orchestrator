import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { ProjectRunAuthority } from "./project-run-authority.js";
import type { RunRecord } from "./run-record.js";
import type { PullRequestState } from "../github/github-client.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { withProcessCancellationSignal } from "../process/process-runtime.js";
import { reconcileManagedPullRequestStatus } from "../github/pull-request-status.js";

export const terminalPrFenceKey = "terminal-pr-observation";
const schema = z.strictObject({
  version: z.literal(1),
  cardId: z.string().min(1),
  url: z.url(),
  state: z.enum(["MERGED", "CLOSED"]),
  headSha: z.string().min(1),
  observedAt: z.string().datetime(),
  preserveArtifacts: z.boolean(),
  stoppedAt: z.string().datetime().optional(),
  proofArtifact: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
});
export type TerminalPrFence = z.infer<typeof schema>;
export function terminalPrFenceFromRun(run: RunRecord): TerminalPrFence | null {
  const raw = run.compatibility[terminalPrFenceKey];
  if (raw === undefined) return null;
  const fence = schema.parse(raw);
  if (fence.cardId !== run.cardId)
    throw new Error("Terminal PR fence belongs to another task");
  if (
    (fence.stoppedAt !== undefined) !== (fence.proofArtifact !== undefined) ||
    (fence.proofArtifact &&
      !run.artifacts.some((artifact) => artifact.id === fence.proofArtifact))
  )
    throw new Error(
      "Terminal stop proof is missing or inconsistent; preserve ownership",
    );
  return fence;
}
export function readTerminalPrFence(
  authority: ProjectRunAuthority | undefined,
): TerminalPrFence | null {
  return authority
    ? terminalPrFenceFromRun(
        authority.store.assertCurrentLease(authority.ownerGeneration),
      )
    : null;
}
export class ObservedPrTerminalError extends Error {
  constructor(
    readonly fence: TerminalPrFence,
    readonly beforeTransport = false,
    readonly transport?: { operationId: string; generation: number },
  ) {
    super(
      `Human PR ${fence.state.toLowerCase()} outcome supersedes automated work`,
    );
    this.name = "ObservedPrTerminalError";
  }
}
export function isTerminalPrInterruption(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof ObservedPrTerminalError) return true;
    if (value instanceof AggregateError) pending.push(...value.errors);
    if (value instanceof Error && value.cause !== undefined)
      pending.push(value.cause);
  }
  return false;
}
export function assertNoTerminalPr(
  authority: ProjectRunAuthority | undefined,
  beforeTransport = false,
): void {
  const fence = readTerminalPrFence(authority);
  if (fence) throw new ObservedPrTerminalError(fence, beforeTransport);
}

const writerContext = new AsyncLocalStorage<symbol | undefined>();
const writers = new Map<string, Map<symbol, AbortController>>();
const activeExecutions = new Map<string, number>();
export function otherTaskWriterIsActive(
  authority: ProjectRunAuthority,
): boolean {
  return (
    [...(writers.get(authority.attemptScopeKey)?.keys() ?? [])].some(
      (token) => token !== writerContext.getStore(),
    ) || (activeExecutions.get(authority.attemptScopeKey) ?? 0) > 0
  );
}
export async function withTerminalWriterCancellation<T>(
  authority: ProjectRunAuthority,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (readTerminalPrFence(authority))
    return writerContext.run(undefined, () =>
      withProcessCancellationSignal(signal, () => operation(signal)),
    );
  const token = Symbol("task-writer");
  const controller = new AbortController();
  const active =
    writers.get(authority.attemptScopeKey) ??
    new Map<symbol, AbortController>();
  active.set(token, controller);
  writers.set(authority.attemptScopeKey, active);
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    return await writerContext.run(token, () =>
      withProcessCancellationSignal(combined, () => operation(combined)),
    );
  } finally {
    active.delete(token);
    if (active.size === 0) writers.delete(authority.attemptScopeKey);
  }
}
export async function withTaskExecutionActivity<T>(
  authority: ProjectRunAuthority | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!authority) return operation();
  const id = authority.attemptScopeKey;
  activeExecutions.set(id, (activeExecutions.get(id) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (activeExecutions.get(id) ?? 1) - 1;
    if (remaining === 0) activeExecutions.delete(id);
    else activeExecutions.set(id, remaining);
  }
}

/** External PR outcome is independent of execution phase. Keep the active
 * checkpoint intact while fencing mutations; Trello synchronization is separate. */
export function recordTerminalPrFence(
  authority: ProjectRunAuthority,
  task: TaskExecutionRecord,
  pr: PullRequestState,
  preserveArtifacts: boolean,
  baseBranch: string,
): TerminalPrFence {
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (
    pr.state === "OPEN" ||
    !pr.headRefOid ||
    task.cardId !== run.cardId ||
    task.pullRequest?.url !== pr.url
  )
    throw new Error("Terminal PR observation does not match the owned task");
  const [owner, repository] = run.pinned.repository.split("/");
  if (
    pr.headRefName !== task.expectedBranch ||
    pr.baseRefName !== baseBranch ||
    pr.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase() ||
    pr.headRepository?.name.toLowerCase() !== repository?.toLowerCase() ||
    (pr.state === "MERGED") !== (pr.mergedAt !== null)
  )
    throw new Error("Terminal PR metadata is ambiguous");
  const existing = terminalPrFenceFromRun(run);
  const fence = schema.parse({
    ...existing,
    version: 1,
    cardId: run.cardId,
    url: pr.url,
    state: pr.state,
    headSha: pr.headRefOid,
    observedAt: new Date().toISOString(),
    preserveArtifacts:
      existing?.preserveArtifacts === true ||
      preserveArtifacts ||
      (activeExecutions.get(authority.attemptScopeKey) ?? 0) > 0 ||
      pr.headRefOid !== task.pullRequest.headSha,
  });
  authority.store.mutateCompatibility({
    expectedRevision: run.revision,
    expectedOwnerGeneration: authority.ownerGeneration,
    key: terminalPrFenceKey,
    current: () => ({ value: fence, result: undefined }),
    validate: (value) => schema.parse(value),
    runState: {
      publicationState: pr.state === "MERGED" ? "merged" : "closed-unmerged",
    },
  });
  for (const [token, controller] of writers.get(authority.attemptScopeKey) ??
    []) {
    if (
      token !== writerContext.getStore() ||
      preserveArtifacts ||
      (activeExecutions.get(authority.attemptScopeKey) ?? 0) > 0
    )
      controller.abort(new ObservedPrTerminalError(fence));
  }
  return fence;
}

export function closedPrComment(url: string): string {
  return [
    "Pull request was closed without being merged.",
    "",
    `Pull request: ${url}`,
  ].join("\n");
}
export function terminalMutationAllowed(
  run: RunRecord,
  request: { route: string; args: unknown },
): boolean {
  const fence = terminalPrFenceFromRun(run);
  if (!fence) return true;
  if (!fence.stoppedAt || !fence.proofArtifact) return false;
  const args = request.args;
  if (!args || typeof args !== "object") return false;
  const fields = args as Record<string, unknown>;
  if (
    request.route === "github-pr-body" &&
    fields.pullRequestUrl === fence.url &&
    typeof fields.expectedBody === "string" &&
    typeof fields.body === "string" &&
    fields.body !== fields.expectedBody
  ) {
    try {
      return (
        fields.body ===
        reconcileManagedPullRequestStatus(fields.expectedBody, null, "main")
      );
    } catch {
      return false;
    }
  }
  if (request.route === "git-cleanup") return !fence.preserveArtifacts;
  if (fields.cardId !== run.cardId) return false;
  if (request.route === "trello-move")
    return (
      fields.listId ===
      (fence.state === "MERGED"
        ? run.pinned.lists.done
        : run.pinned.lists.backlog)
    );
  return (
    request.route === "trello-comment" &&
    fence.state === "CLOSED" &&
    fields.text === closedPrComment(fence.url)
  );
}
export function markTerminalWritersStopped(
  authority: ProjectRunAuthority,
  proofArtifact: string,
  preserveArtifacts?: boolean,
): void {
  const fence = readTerminalPrFence(authority);
  if (!fence || otherTaskWriterIsActive(authority))
    throw new Error("Terminal writer release lacks stopped-execution proof");
  const proof = z
    .object({ kind: z.literal("task-processes-stopped"), cardId: z.string() })
    .parse(
      JSON.parse(authority.store.readArtifact(proofArtifact).toString("utf8")),
    );
  if (proof.cardId !== fence.cardId)
    throw new Error("Terminal stop proof belongs to another task");
  authority.mutate(
    terminalPrFenceKey,
    fence,
    () => ({
      value: {
        ...fence,
        stoppedAt: new Date().toISOString(),
        proofArtifact,
        preserveArtifacts: preserveArtifacts ?? fence.preserveArtifacts,
      },
      result: undefined,
    }),
    (value) => schema.parse(value),
  );
}
export function terminalStopProofValid(
  authority: ProjectRunAuthority,
): boolean {
  const fence = readTerminalPrFence(authority);
  if (!fence?.stoppedAt || !fence.proofArtifact) return false;
  try {
    const proof = z
      .object({ kind: z.literal("task-processes-stopped"), cardId: z.string() })
      .parse(
        JSON.parse(
          authority.store.readArtifact(fence.proofArtifact).toString("utf8"),
        ),
      );
    return proof.cardId === fence.cardId;
  } catch {
    return false;
  }
}
