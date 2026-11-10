import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  RunRegistry,
  RunStore,
  RunStoreConflictError,
  type RunStoreLease,
} from "./run-store.js";
import type { RunEventType, RunRecord } from "./run-record.js";
import { isConclusiveOperationResolution } from "./run-record.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import type { TaskExecutionEvent } from "./task-execution-transition.js";
import type { ProjectOwnershipLease } from "../coordination/project-ownership.js";
import {
  prepareProjectAttempt,
  updateProjectActiveAttempt,
} from "../coordination/project-registry.js";
import {
  withProcessGroupAmbiguityHandler,
  withTaskProcessArtifacts,
} from "../process/process-runtime.js";

const authorityContext = new AsyncLocalStorage<ProjectRunAuthority>();
interface ProjectLeaseCapability {
  assertHeld: () => void;
  markTerminationAmbiguous: (pid: number | undefined) => void;
}
const projectLeaseContext = new AsyncLocalStorage<
  ReadonlyMap<string, ProjectLeaseCapability>
>();

/** Lease-bound projection controller. A project queue must bind to a durable
 * preparing/active attempt before any external task effects are dispatched. */
export class ProjectRunAuthority {
  constructor(
    readonly projectId: string,
    readonly store: RunStore,
    readonly ownerGeneration: number,
    private readonly releaseAttempt?: () => Promise<void>,
    private readonly markTerminationAmbiguous?: (
      pid: number | undefined,
    ) => void,
    readonly cardId?: string,
  ) {
    if (
      !projectId ||
      !Number.isSafeInteger(ownerGeneration) ||
      ownerGeneration < 1
    )
      throw new Error("Invalid project run authority identity");
  }

  static async resumeAttempt(options: {
    projectId: string;
    attemptId: string;
    pinned: RunRecord["pinned"];
    projectLease: ProjectOwnershipLease;
    coordinationRoot: string;
  }): Promise<ProjectRunAuthority> {
    const integrationId = JSON.stringify({
      trelloBoardId: options.projectLease.identity.trelloBoardId,
      githubRepository: options.projectLease.identity.githubRepository,
    });
    if (integrationId !== options.pinned.integrationId)
      throw new RunStoreConflictError(
        "Attempt pins do not match canonical project lease identity",
      );
    const lease: RunStoreLease = {
      integrationId,
      instanceId: options.projectLease.instanceId,
      token: options.projectLease.token,
      assertHeld: () => options.projectLease.assertHeld(),
    };
    const registry = new RunRegistry(
      options.pinned.storageRoot,
      integrationId,
      lease,
    );
    const pointer = registry.reconcile();
    if (!pointer || pointer.attemptId !== options.attemptId)
      throw new RunStoreConflictError(
        "Attempt is not the reconciled canonical registry owner",
      );
    const store = new RunStore(
      options.pinned.storageRoot,
      options.attemptId,
      options.pinned,
      lease,
    );
    let record = store.read();
    if (!record || record.projectId !== options.projectId)
      throw new RunStoreConflictError(
        "Canonical attempt record identity mismatch",
      );
    if (
      record.owner.instanceId !== lease.instanceId ||
      record.owner.token !== lease.token
    ) {
      record = store.takeOwnership(
        record.revision,
        record.owner.generation,
        lease.token,
      );
    }
    await updateProjectActiveAttempt(
      options.coordinationRoot,
      options.projectId,
      options.projectLease,
      { attemptId: record.attemptId, storageRoot: options.pinned.storageRoot },
    );
    return new ProjectRunAuthority(
      options.projectId,
      store,
      record.owner.generation,
      () =>
        updateProjectActiveAttempt(
          options.coordinationRoot,
          options.projectId,
          options.projectLease,
          null,
        ),
      (pid) => options.projectLease.markProcessGroupAmbiguous(pid),
      record.cardId,
    );
  }

  /**
   * Durably creates a preparing attempt and publishes its canonical pointer
   * before callers may move a card, create a worktree, or dispatch an agent.
   * The supplied lease must be the live canonical integration lease.
   */
  static async createPreparingAttempt(options: {
    projectId: string;
    cardId: string;
    taskKind: "implementation" | "refinement";
    pinned: RunRecord["pinned"];
    projectLease: ProjectOwnershipLease;
    coordinationRoot: string;
    budgets?: RunRecord["budgets"];
    resources?: RunRecord["resources"];
    sessions?: RunRecord["sessions"];
    attemptId?: string;
  }): Promise<ProjectRunAuthority> {
    const attemptId = options.attemptId ?? randomUUID();
    const integrationId = JSON.stringify({
      trelloBoardId: options.projectLease.identity.trelloBoardId,
      githubRepository: options.projectLease.identity.githubRepository,
    });
    if (integrationId !== options.pinned.integrationId)
      throw new RunStoreConflictError(
        "Attempt pins do not match canonical project lease identity",
      );
    const lease: RunStoreLease = {
      integrationId,
      instanceId: options.projectLease.instanceId,
      token: options.projectLease.token,
      assertHeld: () => options.projectLease.assertHeld(),
    };
    const store = new RunStore(
      options.pinned.storageRoot,
      attemptId,
      options.pinned,
      lease,
    );
    const registry = new RunRegistry(
      options.pinned.storageRoot,
      options.pinned.integrationId,
      lease,
    );
    const prior = registry.reconcile();
    if (prior) {
      const previousStore = RunStore.openWithPersistedIdentity(
        options.pinned.storageRoot,
        prior.attemptId,
        lease,
      );
      if (!previousStore)
        throw new RunStoreConflictError("Prior registry attempt is missing");
      const previous = previousStore.read();
      if (
        !previous ||
        !["done", "refined", "failed", "cancelled"].includes(
          previous.lifecycle,
        ) ||
        previous.terminalSync !== "verified" ||
        !previous.pendingOperations.every(isConclusiveOperationResolution)
      )
        throw new RunStoreConflictError(
          "A project attempt is still occupying the canonical registry",
        );
    }
    await prepareProjectAttempt(
      options.coordinationRoot,
      options.projectId,
      options.projectLease,
      { attemptId, storageRoot: options.pinned.storageRoot },
    );
    const worktreePath = `${options.pinned.worktreeRoot}/${options.cardId}`;
    const record: RunRecord = {
      version: 1,
      revision: 1,
      projectId: options.projectId,
      cardId: options.cardId,
      attemptId,
      taskKind: options.taskKind,
      pinned: options.pinned,
      lifecycle: "preparing",
      checkpoint: "preparing",
      publicationState: "none",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [
        {
          kind: "worktree",
          id: options.cardId,
          path: worktreePath,
          provenance: "attempt-planned",
        },
        {
          kind: "branch",
          id: options.cardId,
          path: `refs/heads/agent/${options.cardId}`,
          provenance: "attempt-planned",
        },
        ...(options.resources ?? []),
      ],
      pendingOperations: [],
      queue: [],
      budgets: options.budgets ?? {},
      sessions: options.sessions ?? {},
      artifacts: [],
      expectedTrelloListId: null,
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    };
    store.create(record);
    registry.handoff(store, prior, prior ? prior.generation + 1 : 1);
    options.projectLease.assertHeld();
    await updateProjectActiveAttempt(
      options.coordinationRoot,
      options.projectId,
      options.projectLease,
      { attemptId, storageRoot: options.pinned.storageRoot },
    );
    return new ProjectRunAuthority(
      options.projectId,
      store,
      1,
      () =>
        updateProjectActiveAttempt(
          options.coordinationRoot,
          options.projectId,
          options.projectLease,
          null,
        ),
      (pid) => options.projectLease.markProcessGroupAmbiguous(pid),
      options.cardId,
    );
  }

  claim(): RunRecord {
    const current = this.store.read();
    if (!current || current.lifecycle !== "preparing")
      throw new RunStoreConflictError(
        "Only a preparing attempt can be claimed",
      );
    const event =
      current.taskKind === "refinement"
        ? "refinement-claimed"
        : "implementation-claimed";
    const lifecycle =
      current.taskKind === "refinement" ? "refinement" : "planning";
    const completed = this.store.transition(
      current.revision,
      this.ownerGeneration,
      null,
      event,
      "preparing",
      lifecycle,
      (snapshot) => snapshot,
    );
    return completed;
  }

  async completeRefinement(evidence: {
    observationId: string;
    observedAt: string;
    trelloObservationId: string;
    trelloVerifiedAt: string;
  }): Promise<RunRecord> {
    const current = this.store.read();
    if (
      !current ||
      current.taskKind !== "refinement" ||
      current.lifecycle !== "refinement"
    )
      throw new RunStoreConflictError(
        "Only an active refinement attempt can complete as refined",
      );
    const completed = this.store.transition(
      current.revision,
      this.ownerGeneration,
      null,
      "refinement-completed",
      "refinement",
      "refined",
      (snapshot) => snapshot,
      {
        prOutcome: "refinement-completed",
        prObservationId: evidence.observationId,
        prVerifiedAt: evidence.observedAt,
        trelloListId: current.pinned.lists.backlog,
        trelloObservationId: evidence.trelloObservationId,
        trelloVerifiedAt: evidence.trelloVerifiedAt,
      },
    );
    await this.releaseVerifiedTerminal();
    return completed;
  }

  async failRefinement(evidence: {
    observationId: string;
    observedAt: string;
    trelloObservationId: string;
    trelloVerifiedAt: string;
  }): Promise<RunRecord> {
    const current = this.store.read();
    if (
      !current ||
      current.taskKind !== "refinement" ||
      current.lifecycle !== "refinement" ||
      current.publicationState !== "none"
    )
      throw new RunStoreConflictError(
        "Only an unpublished active refinement attempt can fail terminally",
      );
    return this.store.transition(
      current.revision,
      this.ownerGeneration,
      null,
      "failed",
      "refinement",
      "failed",
      (snapshot) => snapshot,
      {
        prOutcome: "no-pr-failure",
        prObservationId: evidence.observationId,
        prVerifiedAt: evidence.observedAt,
        trelloListId: current.pinned.lists.failed,
        trelloObservationId: evidence.trelloObservationId,
        trelloVerifiedAt: evidence.trelloVerifiedAt,
      },
    );
  }

  async releaseVerifiedTerminal(): Promise<void> {
    const current = this.store.assertCurrentLease(this.ownerGeneration);
    if (
      !current ||
      !["done", "refined", "failed", "cancelled"].includes(current.lifecycle) ||
      current.terminalSync !== "verified" ||
      current.terminalEvidence === null ||
      !current.pendingOperations.every(isConclusiveOperationResolution)
    )
      throw new RunStoreConflictError(
        "Attempt release requires verified terminal synchronization",
      );
    await this.releaseAttempt?.();
  }

  read<T>(key: string, validate: (value: unknown) => T): T | null {
    const envelope = this.store.read();
    if (!envelope)
      throw new RunStoreConflictError(
        "Project has no preparing attempt envelope; no legacy fallback is allowed",
      );
    if (envelope.projectId !== this.projectId)
      throw new RunStoreConflictError(
        "Project authority is bound to another project",
      );
    return this.store.readCompatibility(this.ownerGeneration, key, validate);
  }

  list<T>(
    prefix: string,
    validate: (value: unknown) => T,
  ): readonly { key: string; value: T }[] {
    return this.store.listCompatibility(this.ownerGeneration, prefix, validate);
  }

  remove(key: string): boolean {
    const envelope = this.store.read();
    if (!envelope)
      throw new RunStoreConflictError(
        "Project has no preparing attempt envelope; no legacy fallback is allowed",
      );
    if (envelope.projectId !== this.projectId)
      throw new RunStoreConflictError(
        "Project authority is bound to another project",
      );
    return this.store.removeCompatibility(
      envelope.revision,
      this.ownerGeneration,
      key,
    );
  }

  run<T>(operation: () => T): T {
    return authorityContext.run(this, () =>
      withTaskProcessArtifacts(
        {
          root: this.store.storageRoot,
          projectId: this.projectId,
          cardId: this.cardId ?? "task",
          attemptId: this.store.attemptId,
          recordEvent: (event) => {
            const recordPath = path.join(
              this.store.storageRoot,
              "history",
              encodeURIComponent(this.projectId),
              encodeURIComponent(this.cardId ?? "task"),
              encodeURIComponent(this.store.attemptId),
              "events.jsonl",
            );
            fs.mkdirSync(path.dirname(recordPath), {
              recursive: true,
              mode: 0o700,
            });
            fs.appendFileSync(
              recordPath,
              `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          },
        },
        operation,
      ),
    );
  }

  assertHeld(): void {
    this.store.assertCurrentLease(this.ownerGeneration);
  }

  async dispatch<T>(operation: () => Promise<T>): Promise<T> {
    this.assertHeld();
    const result = await withProcessGroupAmbiguityHandler(
      (pid) => this.markTerminationAmbiguous?.(pid),
      operation,
    );
    this.assertHeld();
    return result;
  }

  static dispatch<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const authority = ProjectRunAuthority.current(projectId);
    if (authority) return authority.dispatch(operation);
    const leases = projectLeaseContext.getStore();
    // No lease means this is an explicitly unowned utility operation: there is
    // no project resource whose future reacquisition can be fenced. Project
    // startup/task work must always enter through one of the scoped lease APIs.
    if (!leases) return operation();
    const capability = leases.get(projectId);
    if (!capability)
      throw new RunStoreConflictError("Scoped project lease mismatch");
    capability.assertHeld();
    return withProcessGroupAmbiguityHandler(
      capability.markTerminationAmbiguous,
      () =>
        operation().then((result) => {
          capability.assertHeld();
          return result;
        }),
    );
  }

  static withProjectLease<T>(
    projectId: string,
    assertHeld: () => void,
    markTerminationAmbiguous: (pid: number | undefined) => void,
    operation: () => T,
  ): T {
    return projectLeaseContext.run(
      new Map([[projectId, { assertHeld, markTerminationAmbiguous }]]),
      operation,
    );
  }

  static withProjectLeases<T>(
    leases: readonly {
      projectId: string;
      assertHeld: () => void;
      markTerminationAmbiguous: (pid: number | undefined) => void;
    }[],
    operation: () => T,
  ): T {
    const capabilities = new Map(
      leases.map((capability) => [capability.projectId, capability]),
    );
    return projectLeaseContext.run(capabilities, operation);
  }

  static current(projectId: string): ProjectRunAuthority | undefined {
    const authority = authorityContext.getStore();
    if (authority && authority.projectId !== projectId)
      throw new RunStoreConflictError("Scoped project authority mismatch");
    return authority;
  }

  static currentProjectId(): string | undefined {
    return (
      authorityContext.getStore()?.projectId ??
      (projectLeaseContext.getStore()?.size === 1
        ? projectLeaseContext.getStore()?.keys().next().value
        : undefined)
    );
  }

  static hasProjectLeaseScope(): boolean {
    return projectLeaseContext.getStore() !== undefined;
  }

  /** Distinguishes unowned utility calls from production lease scopes, also
   * when one runtime context contains several independent project leases. */
  static isProjectLeaseScoped(projectId: string): boolean {
    const leases = projectLeaseContext.getStore();
    if (leases && !leases.has(projectId))
      throw new RunStoreConflictError("Scoped project lease mismatch");
    return leases !== undefined;
  }

  mutate<T>(
    key: string,
    initial: unknown,
    operation: (current: unknown) => { value: unknown; result: T },
    validate: (value: unknown) => unknown,
  ): T {
    const envelope = this.store.read();
    if (!envelope)
      throw new RunStoreConflictError(
        "Project has no preparing attempt envelope; no legacy fallback is allowed",
      );
    if (envelope.projectId !== this.projectId)
      throw new RunStoreConflictError(
        "Project authority is bound to another project",
      );
    return this.store.mutateCompatibility({
      expectedRevision: envelope.revision,
      expectedOwnerGeneration: this.ownerGeneration,
      key,
      current: (value) => operation(value ?? initial),
      validate,
    });
  }

  mutateTaskExecution<T>(options: {
    key: string;
    initial: unknown;
    operation: (current: unknown) => { value: unknown; result: T };
    validate: (value: unknown) => TaskExecutionRecord;
    terminal?: {
      event: "merged" | "closed-unmerged" | "failed";
      evidence: NonNullable<RunRecord["terminalEvidence"]>;
    };
  }): T {
    const envelope = this.store.read();
    if (!envelope || envelope.projectId !== this.projectId)
      throw new RunStoreConflictError(
        "Task projection has no matching attempt authority",
      );
    const lifecycleForPhase = (
      phase: TaskExecutionRecord["phase"],
    ): RunRecord["lifecycle"] | undefined => {
      switch (phase) {
        case "planning":
          return "planning";
        case "implementation":
          return "implementation";
        case "validation":
          return "validation";
        case "review":
          return "review";
        case "publication":
          return "publication";
        case "ci":
          return "ci";
        case "human-feedback":
          return "human-review";
        case "done":
          return undefined;
        case "attention-required":
          return "waiting";
      }
    };
    const eventForTaskTransition: Partial<
      Record<
        TaskExecutionEvent["type"],
        { event: RunEventType; to: RunRecord["lifecycle"] }
      >
    > = {
      "plan-approved": { event: "plan-approved", to: "implementation" },
      "implementation-completed": {
        event: "implementation-completed",
        to: "validation",
      },
      "validation-passed": { event: "validation-passed", to: "review" },
      "validation-reviewed": { event: "validation-reviewed", to: "review" },
      "validation-exhausted": { event: "validation-failed", to: "publication" },
      "validation-failed": {
        event: "implementation-correction",
        to: "implementation",
      },
      "review-passed": { event: "review-completed", to: "publication" },
      "review-exhausted": { event: "review-completed", to: "publication" },
      "review-unavailable": { event: "review-completed", to: "publication" },
      "review-failed": {
        event: "implementation-correction",
        to: "implementation",
      },
      "publication-completed": { event: "publication-completed", to: "ci" },
      "ci-passed-awaiting-human": { event: "ci-observed", to: "human-review" },
      "human-feedback-pending": { event: "ci-observed", to: "human-review" },
      "ci-failed": { event: "implementation-correction", to: "implementation" },
      "feedback-received": { event: "feedback-received", to: "implementation" },
      "feedback-ci-failed": { event: "feedback-ci-failed", to: "ci" },
      "feedback-replies-published": {
        event: "feedback-replies-published",
        to: "ci",
      },
      "attention-required": { event: "wait-entered", to: "waiting" },
    };
    return this.store.mutateCompatibility({
      expectedRevision: envelope.revision,
      expectedOwnerGeneration: this.ownerGeneration,
      key: options.key,
      current: (value) => {
        const outcome = options.operation(value ?? options.initial);
        const validated = options.validate(outcome.value);
        if (
          options.terminal?.event === "merged" &&
          (validated.phase !== "done" || validated.pullRequest === undefined)
        )
          throw new RunStoreConflictError(
            "Merged terminal projection requires a completed task record with PR identity",
          );
        if (
          options.terminal?.event === "closed-unmerged" &&
          validated.pullRequest === undefined
        )
          throw new RunStoreConflictError(
            "Closed terminal projection requires the observed task PR identity",
          );
        if (
          options.terminal?.event === "failed" &&
          ((validated.terminalFailure?.kind !== "implementation" &&
            validated.terminalFailure?.kind !== "clarification") ||
            validated.terminalFailure.outcome !== "confirmed" ||
            validated.pullRequest !== undefined ||
            validated.externalRecovery !== undefined)
        )
          throw new RunStoreConflictError(
            "Failed terminal projection requires confirmed no-PR implementation failure",
          );
        if (
          options.terminal &&
          options.terminal.event !== "failed" &&
          !options.terminal.evidence.prObservationId.includes(
            String(validated.pullRequest?.number),
          )
        )
          throw new RunStoreConflictError(
            "Terminal evidence does not identify the task projection PR",
          );
        return { ...outcome, value: validated };
      },
      validate: options.validate,
      deriveRunState: (current, rawProjection) => {
        const projection = options.validate(rawProjection);
        if (
          projection.recoveryWait &&
          projection.phase === "attention-required"
        )
          throw new RunStoreConflictError(
            "Attention-required task state cannot retain a recoverable wait authorization",
          );
        const target = projection.recoveryWait
          ? "waiting"
          : lifecycleForPhase(projection.phase);
        let lifecycleTransition:
          { event: RunEventType; to: RunRecord["lifecycle"] } | undefined;
        if (target !== undefined && target !== current.lifecycle) {
          if (current.lifecycle === "waiting" && target !== "waiting") {
            lifecycleTransition = { event: "wait-resumed", to: target };
          } else {
            const mapped = projection.recoveryWait
              ? { event: "wait-entered" as const, to: "waiting" as const }
              : projection.lastEvent
                ? eventForTaskTransition[
                    projection.lastEvent.type as TaskExecutionEvent["type"]
                  ]
                : undefined;
            if (mapped === undefined || mapped.to !== target)
              throw new RunStoreConflictError(
                `Task phase ${projection.phase} has no authorized RunRecord transition from ${current.lifecycle}`,
              );
            lifecycleTransition = mapped;
          }
        }
        const projectedBudgets = Object.fromEntries(
          Object.entries(current.budgets).map(([name, budget]) => {
            const counterName =
              name === "human-feedback" ? "humanFeedback" : name;
            const used =
              projection.retryCounters[
                counterName as keyof TaskExecutionRecord["retryCounters"]
              ];
            if (name === "review" && projection.reviewRepair !== undefined) {
              // Select the review cycle's durable bound in the same fenced
              // mutation that publishes reviewRepair. The task-session
              // bound counts repairs; the canonical budget also includes
              // its initial read-only review pass.
              const maxAttempts =
                projection.reviewRepair.maxAttempts ??
                projection.retryCounters.review;
              const limit = maxAttempts + 1;
              const sameCycle =
                budget.episodeId === projection.reviewRepair.cycleId;
              const nextUsed = sameCycle
                ? Math.max(budget.used, used ?? 0)
                : (used ?? budget.used);
              return [
                name,
                {
                  ...budget,
                  limit: sameCycle
                    ? Math.max(budget.limit, limit, nextUsed)
                    : Math.max(limit, nextUsed),
                  used: nextUsed,
                  episodeId: projection.reviewRepair.cycleId,
                },
              ];
            }
            return [name, used === undefined ? budget : { ...budget, used }];
          }),
        );
        const validationRepair = projection.validationRepair;
        if (validationRepair?.maxAttempts !== undefined) {
          const previous = current.budgets.validation;
          const firstLegacyEpisode = `${projection.cardId}:initial-validation`;
          const sameCycle = previous?.episodeId === validationRepair.cycleId;
          const importingLegacyBudget =
            previous?.episodeId === firstLegacyEpisode;
          const used =
            previous === undefined
              ? projection.retryCounters.validation
              : sameCycle || importingLegacyBudget
                ? Math.max(previous.used, projection.retryCounters.validation)
                : projection.retryCounters.validation;
          projectedBudgets.validation = {
            // A persisted canonical usage count is authoritative even if an
            // older configured limit is lower than the incoming projection.
            // Never lower the limit below already charged work.
            limit: Math.max(validationRepair.maxAttempts, used),
            used,
            episodeId: validationRepair.cycleId,
            trigger: previous?.trigger ?? "initial-implementation",
          };
        }
        return {
          ...(lifecycleTransition === undefined ? {} : { lifecycleTransition }),
          runState: {
            publicationState:
              projection.pullRequest === undefined
                ? current.publicationState
                : current.publicationState === "merged" ||
                    current.publicationState === "closed-unmerged"
                  ? current.publicationState
                  : "open",
            ...(projection.primarySessionId === undefined
              ? {}
              : {
                  sessions: {
                    ...current.sessions,
                    primary: projection.primarySessionId,
                  },
                }),
            budgets: projectedBudgets,
            operation: {
              id: projection.operationKey,
              kind: projection.phase,
              generation:
                current.operation.id === projection.operationKey &&
                current.operation.kind === projection.phase
                  ? current.operation.generation
                  : current.operation.generation + 1,
            },
            expectedTrelloListId:
              projection.phase === "ci" || projection.phase === "human-feedback"
                ? current.pinned.lists.review
                : projection.phase === "done"
                  ? current.pinned.lists.done
                  : current.pinned.lists.working,
            ...(projection.recoveryWait
              ? {
                  wait: {
                    reason: projection.recoveryWait.reason,
                    dependency:
                      projection.recoveryWait.notificationId
                        .split("/")
                        .at(-1) ?? "task-session",
                    since: projection.recoveryWait.since,
                    retryAt: projection.recoveryWait.retryAt,
                  },
                }
              : projection.phase === "attention-required"
                ? {
                    wait: {
                      reason: "task-attention-required",
                      dependency: "operator",
                      since: projection.updatedAt,
                      retryAt: null,
                    },
                  }
                : {}),
            ...(projection.pullRequest === undefined
              ? {}
              : {
                  resources: [
                    ...current.resources.filter(
                      (resource) =>
                        !(
                          resource.kind === "pull-request" &&
                          resource.id === String(projection.pullRequest!.number)
                        ),
                    ),
                    {
                      kind: "pull-request",
                      id: String(projection.pullRequest.number),
                      path: projection.pullRequest.url,
                      provenance: "task-execution-projection",
                    },
                  ],
                }),
          },
        };
      },
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    });
  }

  static queueKey(projectId: string): string {
    return `project-queue-${projectId}`;
  }
  static mutationBlocksKey(projectId: string): string {
    return `project-mutation-blocks-${projectId}`;
  }
  static reconciliationBlockKey(projectId: string): string {
    return `reconciliation-block-${projectId}`;
  }
  static commitKey(
    kind: "trusted-commit" | "pending-commit" | "rejected-commit",
    cardId: string,
  ): string {
    return `${kind}-${cardId}`;
  }
  static taskKey(
    kind: "task-plan" | "feedback-ledger" | "maintenance",
    cardId: string,
  ): string {
    return `${kind}-${cardId}`;
  }
}

export interface ProjectRunWorkerContext {
  readonly authority?: ProjectRunAuthority;
  readonly blockedReason?: string;
  readonly newClaimsBlockedReason?: string;
  readonly projectLease?: ProjectOwnershipLease;
  readonly pinned?: RunRecord["pinned"];
  readonly coordinationRoot?: string;
}
