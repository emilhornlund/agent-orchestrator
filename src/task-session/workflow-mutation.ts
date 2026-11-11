import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { runTaskResources } from "./task-resources.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import type { MutationEvent, MutationIntent } from "./durable-mutation.js";
import { mutationProvenNotDelivered } from "./durable-mutation.js";
import type { RunRecord } from "./run-record.js";
import {
  terminalPrFenceFromRun,
  terminalMutationAllowed,
  ObservedPrTerminalError,
  readTerminalPrFence,
} from "./terminal-pr-fence.js";

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

// Only a reconciler that already owns a durable dispatch may bypass a client
// adapter. In particular, T2 owns its own intents; transport nesting is not a
// second operation and must not acquire a second journal identity.
interface DispatchCapability {
  authority: ProjectRunAuthority;
  operationId: string;
  dispatchGeneration: number;
  expected: WorkflowMutationRequest;
  consumed: boolean;
  transported: boolean;
  active: boolean;
}
const dispatchContext = new AsyncLocalStorage<DispatchCapability>();
// One activation per dispatch in this process, even if an authority wrapper is
// reconstructed. A production restart takes a new owner generation, which
// cannot activate the old owner's dispatch. This is capability anti-reuse, not
// provider-outcome evidence or a second persisted mutation authority.
const issuedDispatches = new Set<string>();
const reconciliationContext = new AsyncLocalStorage<string>();
export function withMutationReconciliation<T>(
  id: string,
  operation: () => T,
): T {
  return reconciliationContext.run(id, operation);
}
export async function withJournaledDispatch<T>(
  authority: ProjectRunAuthority,
  operationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (dispatchContext.getStore())
    throw new Error("Nested journal dispatch capability is forbidden");
  if (ProjectRunAuthority.current(authority.projectId) !== authority)
    throw new Error("Journal dispatch requires its current authority");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (["done", "refined", "failed", "cancelled"].includes(run.lifecycle))
    throw new Error("Terminal attempt cannot activate a dispatch capability");
  const entry = run.pendingOperations.find((entry) => entry.id === operationId);
  const dispatch = entry?.mutation?.dispatches.at(-1);
  if (
    !entry?.mutation ||
    entry.status !== "ambiguous" ||
    !dispatch ||
    dispatch.response ||
    dispatch.ownerGeneration !== authority.ownerGeneration ||
    entry.mutation.executionFence.id !== run.operation.id ||
    entry.mutation.executionFence.generation !== run.operation.generation
  )
    throw new Error(
      "Journal dispatch has no current unresponded durable dispatch",
    );
  const reference = run.artifacts.find(
    (item) => item.id === entry.mutation!.intent.payloadId,
  )!;
  const payload: unknown = JSON.parse(fs.readFileSync(reference.path, "utf8"));
  // T3 payloads already enumerate concrete client routes. T2's original payloads
  // are translated from their persisted fields, never from caller-supplied scope
  // options. Incompatible historical payloads fail closed rather than gain power.
  let expected: WorkflowMutationRequest;
  if (operationId.startsWith("workflow:"))
    expected = payload as WorkflowMutationRequest;
  else {
    const value = payload as Record<string, unknown>;
    const cwd = runTaskResources(run).path;
    switch (entry.mutation.intent.kind) {
      case "trello-move":
        expected = {
          route: "trello-move",
          args: { cardId: run.cardId, listId: value.listId, options: {} },
        };
        break;
      case "trello-comment":
        expected = {
          route: "trello-comment",
          args: { cardId: run.cardId, text: value.text },
        };
        break;
      case "github-pr-create":
        expected = {
          route: "github-pr-create",
          args: {
            cwd,
            repository: run.pinned.repository,
            baseBranch: value.base,
            headBranch: value.head,
            title: value.title,
            body: value.body,
            draft: value.draft,
          },
        };
        break;
      case "git-commit":
        if (!value.identity || value.cleanup !== "verbatim")
          throw new Error(
            "Commit dispatch lacks durable identity/cleanup proof",
          );
        expected = {
          route: "git-commit",
          args: {
            cwd,
            branch: runTaskResources(run).branch,
            parent: value.parent,
            tree: value.tree,
            message: value.message,
            identity: value.identity,
            cleanup: "verbatim",
          },
        };
        break;
      case "git-push":
        expected = {
          route: "git-push",
          args: {
            cwd,
            branch: value.branch,
            sha: value.sha,
            destination: (value.destinations as { push: string }).push,
            fetch: (value.destinations as { fetch: string }).fetch,
          },
        };
        break;
      default:
        throw new Error("Unsupported publication dispatch capability");
    }
  }
  const args = expected.args as Record<string, unknown>;
  const kinds: Record<string, MutationIntent["kind"]> = {
    "trello-move": "trello-move",
    "trello-comment": "trello-comment",
    "trello-content": "trello-content",
    "trello-labels": "trello-labels",
    "github-pr-create": "github-pr-create",
    "github-pr-body": "github-pr-body",
    "github-pr-draft": "github-pr-draft",
    "github-pr-ready": "github-pr-draft",
    "github-thread-reply": "github-reply",
    "github-conversation-reply": "github-reply",
    "git-worktree": "git-worktree",
    "git-commit": "git-commit",
    "git-push": "git-push",
    "git-cleanup": "git-cleanup",
  };
  if (kinds[expected.route] !== entry.kind)
    throw new Error("Dispatch route differs from durable mutation kind");
  const initial = operationId.startsWith("initial:");
  let target: string;
  if (expected.route.startsWith("trello-")) {
    if (args.cardId !== run.cardId)
      throw new Error("Dispatch card differs from attempt");
    if (
      expected.route === "trello-move" &&
      (!Object.values(run.pinned.lists).includes(String(args.listId)) ||
        args.listId === run.pinned.lists.ready ||
        (args.listId === run.pinned.lists.failed &&
          run.publicationState !== "none"))
    )
      throw new Error("Forbidden dispatch destination");
    if (
      ["trello-content", "trello-labels"].includes(expected.route) &&
      run.taskKind !== "refinement"
    )
      throw new Error("Dispatch content is not owned refinement");
    target = initial
      ? run.cardId
      : `trello:${run.pinned.boardId}:${run.cardId}${expected.route === "trello-labels" ? `:${String(args.labelId)}` : ""}`;
  } else if (expected.route.startsWith("github-")) {
    if (args.repository !== run.pinned.repository)
      throw new Error("Dispatch repository differs from attempt");
    if (expected.route === "github-pr-create") {
      if (!initial || args.headBranch !== runTaskResources(run).branch)
        throw new Error("PR creation requires its original publication intent");
      target = run.pinned.repository;
    } else {
      if (
        !run.resources.some(
          (resource) =>
            resource.kind === "pull-request" &&
            resource.path === args.pullRequestUrl,
        )
      )
        throw new Error("Dispatch PR is not owned by attempt");
      target = `${String(args.pullRequestUrl)}${expected.route === "github-thread-reply" ? `:${String(args.threadId)}` : ""}`;
    }
  } else {
    const { branch, path: cwd } = runTaskResources(run);
    if (expected.route === "git-cleanup") {
      if (
        args.cwd !== run.pinned.repositoryPath ||
        !run.resources.some(
          (resource) =>
            resource.kind ===
              (args.kind === "worktree" ? "worktree" : "branch") &&
            resource.path ===
              (args.kind === "worktree"
                ? args.resource
                : `refs/heads/${String(args.resource)}`),
        )
      )
        throw new Error("Dispatch cleanup resource is not owned");
      target = `git:${String(args.kind)}:${encodeURIComponent(String(args.resource))}`;
    } else if (expected.route === "git-worktree") {
      if (
        args.cwd !== run.pinned.repositoryPath ||
        args.worktree !== cwd ||
        args.branch !== branch
      )
        throw new Error("Dispatch worktree differs from attempt");
      target = `git:worktree:${encodeURIComponent(cwd)}`;
    } else {
      if (args.cwd !== cwd || args.branch !== branch)
        throw new Error("Dispatch branch differs from attempt");
      target =
        expected.route === "git-commit"
          ? initial
            ? `refs/heads/${branch}`
            : `git:${branch}`
          : initial
            ? `${String(args.destination)}#refs/heads/${branch}`
            : `git:${String(args.destination)}:${branch}`;
    }
  }
  if (entry.mutation.intent.target !== target)
    throw new Error("Dispatch target differs from durable mutation target");
  const activation = JSON.stringify([
    authority.store.storageRoot,
    run.attemptId,
    run.owner.instanceId,
    run.owner.token,
    run.owner.generation,
    operationId,
    dispatch.generation,
  ]);
  if (issuedDispatches.has(activation))
    throw new Error("Journal dispatch capability was already issued");
  const terminal = terminalPrFenceFromRun(run);
  if (terminal && !terminalMutationAllowed(run, expected))
    throw new ObservedPrTerminalError(terminal, true, {
      operationId,
      generation: dispatch.generation,
    });
  issuedDispatches.add(activation);
  const capability: DispatchCapability = {
    authority,
    operationId,
    dispatchGeneration: dispatch.generation,
    expected,
    consumed: false,
    transported: false,
    active: true,
  };
  try {
    return await dispatchContext.run(capability, operation);
  } finally {
    capability.active = false;
  }
}

/** Match exactly one concrete mutation. Authority checks are never bypassed,
 * including after consumption or in asynchronous descendants of a closed scope. */
export function consumeJournaledDispatch(
  authority: ProjectRunAuthority | undefined,
  request: WorkflowMutationRequest,
): boolean {
  const capability = dispatchContext.getStore();
  if (!capability) return false;
  if (
    !authority ||
    authority !== capability.authority ||
    ProjectRunAuthority.current(authority.projectId) !== authority ||
    !capability.active ||
    capability.consumed
  )
    throw new Error("Invalid or consumed journal dispatch capability");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (["done", "refined", "failed", "cancelled"].includes(run.lifecycle))
    throw new Error("Terminal attempt cannot consume a dispatch capability");
  const entry = run.pendingOperations.find(
    (entry) => entry.id === capability.operationId,
  );
  const dispatch = entry?.mutation?.dispatches.at(-1);
  if (
    entry?.status !== "ambiguous" ||
    dispatch?.generation !== capability.dispatchGeneration ||
    dispatch.ownerGeneration !== authority.ownerGeneration ||
    dispatch.response ||
    entry.mutation?.executionFence.id !== run.operation.id ||
    entry.mutation.executionFence.generation !== run.operation.generation
  )
    throw new Error("Stale journal dispatch capability");
  let expected = capability.expected;
  if (
    capability.operationId.startsWith("workflow:") &&
    expected.route === "git-commit"
  )
    expected = {
      ...expected,
      args: {
        ...(expected.args as Record<string, unknown>),
        cleanup: "verbatim",
      },
    };
  if (
    capability.operationId.startsWith("workflow:") &&
    [
      "trello-comment",
      "github-conversation-reply",
      "github-thread-reply",
    ].includes(expected.route)
  ) {
    const args = expected.args as Record<string, unknown>;
    const field = expected.route === "trello-comment" ? "text" : "body";
    expected = {
      ...expected,
      args: {
        ...args,
        [field]: `${String(args[field])}\n\n<!-- agent-orchestrator-mutation:${entry.mutation!.intent.correlationId} -->`,
      },
    };
  }
  // Key order is not part of a transport's semantics; extra/missing fields are.
  if (canonicalJson(request) !== canonicalJson(expected))
    throw new Error(
      "Concrete mutation differs from journal dispatch capability",
    );
  capability.consumed = true;
  return true;
}

export function rejectJournaledDispatch(): void {
  if (dispatchContext.getStore())
    throw new Error(
      "Unjournaled mutation inside journal dispatch scope is forbidden",
    );
}

/** Recheck at the private transport boundary, after asynchronous credentials or
 * validation reads. Consuming a method must not let an unawaited invocation send
 * after scope exit, terminal observation, or a response/owner fence change. */
export function assertJournaledTransport(): void {
  const capability = dispatchContext.getStore();
  if (!capability) {
    const projectId = ProjectRunAuthority.currentProjectId();
    const fence = readTerminalPrFence(
      projectId === undefined
        ? undefined
        : ProjectRunAuthority.current(projectId),
    );
    if (fence) throw new ObservedPrTerminalError(fence, true);
    return;
  }
  const { authority } = capability;
  if (
    !capability.active ||
    !capability.consumed ||
    capability.transported ||
    ProjectRunAuthority.current(authority.projectId) !== authority
  )
    throw new Error("Invalid journal transport capability");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  const entry = run.pendingOperations.find(
    (entry) => entry.id === capability.operationId,
  );
  const dispatch = entry?.mutation?.dispatches.at(-1);
  if (
    ["done", "refined", "failed", "cancelled"].includes(run.lifecycle) ||
    entry?.status !== "ambiguous" ||
    dispatch?.generation !== capability.dispatchGeneration ||
    dispatch.ownerGeneration !== authority.ownerGeneration ||
    dispatch.response ||
    entry.mutation?.executionFence.id !== run.operation.id ||
    entry.mutation.executionFence.generation !== run.operation.generation
  )
    throw new Error("Stale journal transport capability");
  const fence = terminalPrFenceFromRun(run);
  if (fence && !terminalMutationAllowed(run, capability.expected))
    throw new ObservedPrTerminalError(fence, true, {
      operationId: capability.operationId,
      generation: capability.dispatchGeneration,
    });
  capability.transported = true;
}

export class WorkflowMutationWaitingError extends Error {
  constructor() {
    super("Workflow mutation awaits paced authoritative reconciliation");
  }
}

export function throwIfWorkflowMutationPending(projectId: string): void {
  if (
    ProjectRunAuthority.current(projectId)
      ?.store.read()
      ?.pendingOperations.some(
        (entry) =>
          entry.id.startsWith("workflow:") &&
          !["completed", "cancelled"].includes(entry.status),
      )
  )
    throw new WorkflowMutationWaitingError();
}

export function mutationAuthority(
  projectId: string | undefined,
): ProjectRunAuthority | undefined {
  const id = projectId ?? ProjectRunAuthority.currentProjectId();
  if (!id) {
    if (ProjectRunAuthority.hasProjectLeaseScope())
      throw new Error(
        "Workflow mutation has no unambiguous project attempt authority",
      );
    return undefined;
  }
  const authority = ProjectRunAuthority.current(id);
  if (!authority && ProjectRunAuthority.isProjectLeaseScoped(id))
    throw new Error("Workflow mutation requires durable attempt authority");
  return authority;
}

export interface WorkflowMutationRequest {
  route: string;
  args: unknown;
}

export class WorkflowMutationPreconditionChangedError extends Error {
  constructor(readonly observed: unknown) {
    super(
      "External fields changed before dispatch; preserve current human content and refresh the intended update",
    );
    this.name = "WorkflowMutationPreconditionChangedError";
  }
}

/** Deterministic identity used both by dispatch and by pre-dispatch event obligations. */
export function workflowMutationIdentity(
  run: RunRecord,
  kind: MutationIntent["kind"],
  target: string,
  request: WorkflowMutationRequest,
  observedStateChanged = false,
): string {
  const hash = createHash("sha256")
    .update(sanitizeControlledText(JSON.stringify(request)))
    .digest("hex");
  const prefix = `workflow:${run.operation.generation}:${kind}:${hash}`;
  const previous = run.pendingOperations
    .filter(
      (entry) =>
        entry.id.startsWith("workflow:") &&
        entry.kind === kind &&
        entry.mutation?.intent.target === target &&
        entry.mutation.executionFence.generation === run.operation.generation,
    )
    .at(-1);
  return previous?.id.startsWith(`${prefix}:`) &&
    previous.status !== "cancelled" &&
    !(observedStateChanged && previous.status === "completed")
    ? previous.id
    : `${prefix}:${run.pendingOperations.length}`;
}

/** Small journal protocol shared by concrete client reconcilers, not a replay
 * engine. Only the concrete adapter supplies destination validation/readback. */
export async function workflowMutation<T>(options: {
  authority: ProjectRunAuthority;
  kind: MutationIntent["kind"];
  target: string;
  request: WorkflowMutationRequest;
  /** Repeatable field-setting only: a fresh read established that an earlier
   * completed intent no longer describes the provider's current fields. */
  observedStateChanged?: boolean;
  send: (marker: string) => Promise<unknown>;
  preflight?: () => Promise<void>;
  rejected?: (
    error: unknown,
  ) => { status: number; operation: string } | undefined;
  observe: (
    marker: string,
  ) => Promise<{ id: string; fields: unknown; result: T } | null>;
}): Promise<T> {
  const { authority } = options;
  if (options.observedStateChanged && options.kind !== "github-pr-body")
    throw new Error(
      "Observed body drift cannot authorize repeating a non-idempotent mutation",
    );
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  const id =
    reconciliationContext.getStore() ??
    workflowMutationIdentity(
      run,
      options.kind,
      options.target,
      options.request,
      options.observedStateChanged,
    );
  const existing = run.pendingOperations.find((entry) => entry.id === id);
  const terminal = terminalPrFenceFromRun(run);
  const permitted = terminalMutationAllowed(run, options.request);
  if (terminal && !permitted && !existing)
    throw new ObservedPrTerminalError(terminal, true);
  if (
    !reconciliationContext.getStore() &&
    run.pendingOperations.some(
      (entry) =>
        entry.id !== id &&
        !["completed", "cancelled", "failed"].includes(entry.status),
    )
  )
    throw new WorkflowMutationWaitingError();
  const correlationId =
    existing?.mutation?.intent.correlationId ?? `${run.attemptId}:${id}`;
  const marker = `<!-- agent-orchestrator-mutation:${correlationId} -->`;
  const now = () => new Date().toISOString();
  const next = () => new Date(Date.now() + 15_000).toISOString();
  const artifact = (value: unknown) => {
    const reference = authority.store.writeArtifact(
      Buffer.from(sanitizeControlledText(JSON.stringify(value))),
      "application/json",
    );
    authority.store.referenceMutationArtifact(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      reference,
    );
    return reference.id;
  };
  const entry = () =>
    authority.store.read()!.pendingOperations.find((entry) => entry.id === id)!;
  const event = (value: MutationEvent) =>
    authority.store.recordMutationEvent(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      id,
      entry().generation,
      value,
      now(),
    );
  const evidence = (fields: unknown) => ({
    observationId: `${id}:${authority.store.read()!.revision}`,
    observedAt: now(),
    artifactId: artifact(fields),
  });
  if (existing) {
    const reference = run.artifacts.find(
      (item) => item.id === existing.mutation?.intent.payloadId,
    );
    const persisted: unknown = reference
      ? JSON.parse(fs.readFileSync(reference.path, "utf8"))
      : null;
    if (
      !existing.mutation ||
      canonicalJson(persisted) !==
        canonicalJson(
          JSON.parse(sanitizeControlledText(JSON.stringify(options.request))),
        ) ||
      existing.mutation.intent.kind !== options.kind ||
      existing.mutation.intent.target !== options.target
    )
      throw new Error(
        "Reconciliation request differs from immutable mutation intent",
      );
  } else {
    const payloadId = artifact(options.request);
    authority.store.persistMutationIntent(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      id,
      {
        kind: options.kind,
        target: options.target,
        correlationId,
        payloadId,
      },
      now(),
    );
  }
  const operation = entry();
  if (
    terminal &&
    !permitted &&
    (operation.mutation!.dispatches.length === 0 ||
      mutationProvenNotDelivered(operation.mutation!))
  ) {
    if (operation.mutation!.dispatches.length === 0)
      event({
        type: "cancel",
        reason: "terminal-observed",
        evidence: evidence({ terminal }),
      });
    throw new ObservedPrTerminalError(terminal, true);
  }
  if (operation.status === "cancelled")
    throw new WorkflowMutationWaitingError();
  if (operation.status === "completed") {
    // The adapter result is a projection of immutable independent evidence, not
    // a fresh write or a mutable response cached in a second authority.
    const observation = operation.mutation!.observations.at(-1)!;
    const reference = authority.store
      .read()!
      .artifacts.find((item) => item.id === observation.evidence.artifactId)!;
    const stored = JSON.parse(fs.readFileSync(reference.path, "utf8")) as {
      result: T;
    };
    return stored.result;
  }
  if (
    operation.mutation!.nextRecheckAt &&
    Date.now() < Date.parse(operation.mutation!.nextRecheckAt)
  )
    throw new WorkflowMutationWaitingError();
  if (
    !operation.mutation!.dispatches.length ||
    mutationProvenNotDelivered(operation.mutation!)
  ) {
    try {
      await options.preflight?.();
    } catch (error) {
      if (
        error instanceof WorkflowMutationPreconditionChangedError &&
        !operation.mutation!.dispatches.length
      )
        event({
          type: "cancel",
          reason: "precondition-changed",
          evidence: evidence({ observed: error.observed }),
        });
      throw error;
    }
    event({ type: "dispatch", nextRecheckAt: next() });
    try {
      await authority.dispatch(() =>
        withJournaledDispatch(authority, id, () => options.send(marker)),
      );
      event({
        type: "response",
        outcome: "accepted",
        evidence: evidence({
          response: "accepted; independent readback required",
        }),
      });
    } catch (error) {
      authority.assertHeld();
      const rejection = options.rejected?.(error);
      const notSent =
        error instanceof ObservedPrTerminalError &&
        error.transport?.operationId === id &&
        error.transport.generation ===
          entry().mutation!.dispatches.at(-1)?.generation;
      event({
        type: "response",
        outcome: rejection || notSent ? "not-delivered" : "unknown",
        evidence: {
          ...evidence({
            response: "unknown; process diagnostics retained separately",
            ...(rejection ? { rejection } : {}),
          }),
          ...(notSent
            ? { nonDeliveryProof: "transport-proven-not-sent" as const }
            : {}),
          ...(rejection
            ? {
                nonDeliveryProof:
                  "provider-rejected-before-acceptance" as const,
              }
            : {}),
        },
      });
    }
    if (entry().mutation!.dispatches.at(-1)?.response?.outcome === "accepted") {
      // One immediate positive readback after an acknowledged write. Failure or
      // a negative read retains the already scheduled 15-second obligation.
      let actual: Awaited<ReturnType<typeof options.observe>> = null;
      try {
        actual = await options.observe(marker);
      } catch {
        authority.assertHeld();
      }
      if (actual) {
        event({
          type: "observe",
          outcome: "verified",
          evidence: evidence(actual),
          resourceId: actual.id,
          attentionRequired: false,
        });
        return actual.result;
      }
    }
    throw new WorkflowMutationWaitingError();
  }
  try {
    const actual = await options.observe(marker);
    event({
      type: "observe",
      outcome: actual ? "verified" : "absent",
      evidence: evidence(
        actual ?? { observed: "not verified; absence is not non-delivery" },
      ),
      ...(actual ? { resourceId: actual.id } : { nextRecheckAt: next() }),
      attentionRequired: !actual,
    });
    if (actual) return actual.result;
  } catch (error) {
    if (error instanceof WorkflowMutationWaitingError) throw error;
    authority.assertHeld();
    event({
      type: "observe",
      outcome: "uncertain",
      evidence: evidence({ observed: "unavailable or conflicting" }),
      nextRecheckAt: next(),
      attentionRequired: true,
    });
  }
  throw new WorkflowMutationWaitingError();
}
