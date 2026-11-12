import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  isConclusiveOperationResolution,
  parseRunRecord,
  pinnedIdentitySchema,
  runTransitionMatrix,
  type RunEventType,
  type RunRecord,
  type RunLifecycleState,
  terminalEvidenceSchema,
} from "./run-record.js";
import { taskExecutionEventTypes } from "./task-execution-record.js";
import { terminalPrFenceFromRun } from "./terminal-pr-fence.js";
import {
  applyMutationEvent,
  mutationEventSchema,
  mutationIntentSchema,
  mutationPolicies,
  mutationProvenNotDelivered,
  type MutationIntent,
} from "./durable-mutation.js";

export class RunStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreConflictError";
  }
}
export class RunStoreUnsupportedVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreUnsupportedVersionError";
  }
}
export interface RunStoreLease {
  readonly integrationId: string;
  readonly instanceId: string;
  readonly token: string;
  assertHeld(): void;
}
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
function assertNoSymlinkPath(directory: string): void {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`Unsafe run storage path component: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Canonical attempt pointer. Candidate record is durable before pointer handoff. */
export class RunRegistry {
  private readonly pointerPath: string;
  constructor(
    private readonly root: string,
    private readonly integrationId: string,
    private readonly lease: RunStoreLease,
  ) {
    if (!path.isAbsolute(root) || !integrationId || lease.integrationId !== integrationId)
      throw new Error("Run registry identity and lease must match");
    this.pointerPath = path.join(
      path.resolve(root),
      "registry",
      `${createHash("sha256").update(integrationId).digest("hex")}.json`,
    );
  }
  read(): {
    version: 1;
    integrationId: string;
    attemptId: string;
    generation: number;
  } | null {
    const value = safeRead(this.pointerPath);
    if (value === null) return null;
    if (typeof value !== "object" || !value || (value as { version?: unknown }).version !== 1)
      throw new RunStoreUnsupportedVersionError("Unsupported registry pointer; preserved");
    const record = value as {
      version: 1;
      integrationId: string;
      attemptId: string;
      generation: number;
    };
    if (
      record.integrationId !== this.integrationId ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1 ||
      !record.attemptId ||
      record.attemptId === "." ||
      record.attemptId === ".." ||
      record.attemptId.includes("/") ||
      record.attemptId.includes("\\")
    )
      throw new Error("Malformed registry pointer preserved");
    return record;
  }
  handoff(
    candidate: RunStore,
    expectedPrior: {
      version: 1;
      integrationId: string;
      attemptId: string;
      generation: number;
    } | null,
    generation: number,
  ): void {
    this.lease.assertHeld();
    const durable = candidate.durableIdentity();
    if (
      !durable ||
      durable.integrationId !== this.integrationId ||
      durable.attemptId === "" ||
      path.resolve(durable.storageRoot) !== path.resolve(this.root) ||
      durable.ownerInstanceId !== this.lease.instanceId ||
      durable.ownerToken !== this.lease.token
    )
      throw new Error("Cannot publish pointer before matching durable candidate attempt");
    const prior = this.read();
    if (!sameRegistryPointer(prior, expectedPrior))
      throw new RunStoreConflictError("Registry pointer compare-and-swap conflict");
    if (prior) {
      if (generation !== prior.generation + 1)
        throw new RunStoreConflictError("Registry pointer handoff requires exact next generation");
      const priorPath = path.join(path.resolve(this.root), "attempts", `${prior.attemptId}.json`);
      const oldValue = safeRead(priorPath);
      if (!oldValue)
        throw new RunStoreConflictError(
          "Prior registry pointer is dangling; preserve and reconcile",
        );
      const old = parseRunRecord(oldValue);
      if (old.attemptId !== prior.attemptId || old.pinned.integrationId !== this.integrationId)
        throw new RunStoreConflictError("Prior pointer identity mismatch; preserve and reconcile");
      if (prior.attemptId === durable.attemptId)
        throw new RunStoreConflictError(
          "Registry already points to this attempt; ownership takeover does not require pointer replacement",
        );
      if (
        prior.attemptId !== durable.attemptId &&
        !(
          ["done", "refined", "failed", "cancelled"].includes(old.lifecycle) &&
          old.terminalSync === "verified" &&
          old.pendingOperations.every(isConclusiveOperationResolution)
        )
      )
        throw new RunStoreConflictError(
          "Cannot replace an active attempt before verified terminal release",
        );
    } else if (generation !== 1) {
      throw new RunStoreConflictError("Initial registry generation must be 1");
    }
    this.assertNoConflictingOrphans(durable.attemptId, prior?.attemptId ?? null);
    atomicJson(this.pointerPath, {
      version: 1,
      integrationId: this.integrationId,
      attemptId: durable.attemptId,
      generation,
    });
  }
  reconcile(): {
    version: 1;
    integrationId: string;
    attemptId: string;
    generation: number;
  } | null {
    const pointer = this.read();
    if (!pointer) {
      const attemptsDirectory = path.join(path.resolve(this.root), "attempts");
      assertNoSymlinkPath(attemptsDirectory);
      if (
        fs.existsSync(attemptsDirectory) &&
        fs.readdirSync(attemptsDirectory).some((entry) => {
          if (!entry.endsWith(".json")) return false;
          const candidate = this.readInventoryAttempt(entry);
          return candidate?.pinned.integrationId === this.integrationId;
        })
      )
        throw new RunStoreConflictError(
          "Durable attempt exists without registry pointer; reconcile handoff before any new claim",
        );
      return null;
    }
    const attemptPath = path.join(path.resolve(this.root), "attempts", `${pointer.attemptId}.json`);
    const record = safeRead(attemptPath);
    if (!record)
      throw new RunStoreConflictError(
        "Registry pointer references a missing attempt; block new claims",
      );
    const run = parseRunRecord(record);
    if (run.attemptId !== pointer.attemptId || run.pinned.integrationId !== this.integrationId)
      throw new RunStoreConflictError(
        "Registry pointer candidate identity mismatch; preserve and reconcile",
      );
    this.assertNoConflictingOrphans(pointer.attemptId, pointer.attemptId);
    return pointer;
  }
  private assertNoConflictingOrphans(
    candidateAttemptId: string,
    pointedAttemptId: string | null,
  ): void {
    const attemptsDirectory = path.join(path.resolve(this.root), "attempts");
    assertNoSymlinkPath(attemptsDirectory);
    if (!fs.existsSync(attemptsDirectory)) return;
    const records = fs.readdirSync(attemptsDirectory).filter((entry) => entry.endsWith(".json"));
    const conflicts: string[] = [];
    for (const entry of records) {
      if (entry === `${candidateAttemptId}.json` || entry === `${pointedAttemptId}.json`) continue;
      const run = this.readInventoryAttempt(entry);
      if (!run) continue;
      if (run.pinned.integrationId !== this.integrationId) continue;
      if (!(
        ["done", "refined", "failed", "cancelled"].includes(run.lifecycle) &&
        run.terminalSync === "verified" &&
        run.pendingOperations.every(isConclusiveOperationResolution)
      ))
        conflicts.push(entry);
    }
    if (conflicts.length > 0)
      throw new RunStoreConflictError(
        `Conflicting unpointed attempts exist: ${conflicts.join(", ")}; registry handoff is ambiguous`,
      );
  }

  private readInventoryAttempt(entry: string): RunRecord | null {
    try {
      return parseRunRecord(safeRead(path.join(path.resolve(this.root), "attempts", entry)));
    } catch (error) {
      // An unreadable envelope cannot identify its own project. A separately
      // validated canonical pointer can still attribute it to another owner.
      // Unpointed or multiply attributed state remains an unknown-writer fence.
      const registryDirectory = path.join(path.resolve(this.root), "registry");
      assertNoSymlinkPath(registryDirectory);
      const owners: string[] = [];
      if (fs.existsSync(registryDirectory)) {
        for (const name of fs.readdirSync(registryDirectory)) {
          if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
          let value: unknown;
          try {
            value = safeRead(path.join(registryDirectory, name));
          } catch {
            continue;
          }
          if (typeof value !== "object" || !value || Array.isArray(value)) continue;
          const pointer = value as Record<string, unknown>;
          if (
            pointer.version === 1 &&
            typeof pointer.integrationId === "string" &&
            pointer.integrationId.length > 0 &&
            typeof pointer.attemptId === "string" &&
            !/[\\/]/u.test(pointer.attemptId) &&
            `${pointer.attemptId}.json` === entry &&
            Number.isSafeInteger(pointer.generation) &&
            (pointer.generation as number) >= 1 &&
            name === `${createHash("sha256").update(pointer.integrationId).digest("hex")}.json`
          )
            owners.push(pointer.integrationId);
        }
      }
      if (owners.length === 1 && owners[0] !== this.integrationId) return null;
      throw error;
    }
  }
}

export class RunStore {
  private readonly recordPath: string;
  private readonly artifactDirectory: string;
  private readonly identity: ReturnType<typeof pinnedIdentitySchema.parse>;
  readonly storageRoot: string;
  readonly attemptId: string;

  /** Intent shares the existing operation ledger and atomic authority. */
  persistMutationIntent(
    expectedRevision: number,
    ownerGeneration: number,
    operationId: string,
    rawIntent: MutationIntent,
    now: string,
  ): RunRecord {
    const current = this.assertCurrentLease(ownerGeneration);
    if (current.revision !== expectedRevision)
      throw new RunStoreConflictError("Stale mutation intent revision");
    if (["done", "refined", "failed", "cancelled"].includes(current.lifecycle))
      throw new RunStoreConflictError("Cannot add workflow mutations to terminal attempt");
    const intent = mutationIntentSchema.parse(rawIntent);
    const existing = current.pendingOperations.find((entry) => entry.id === operationId);
    if (existing) {
      if (
        existing.mutation?.cancellation ||
        (existing.mutation &&
          (existing.mutation.executionFence.id !== current.operation.id ||
            existing.mutation.executionFence.generation !== current.operation.generation))
      )
        throw new RunStoreConflictError(
          "Cannot rebind a superseded or cancelled mutation identity; retain its history",
        );
      if (JSON.stringify(existing.mutation?.intent) !== JSON.stringify(intent))
        throw new RunStoreConflictError(
          "Mutation identity cannot be reused with a different payload or target",
        );
      return current;
    }
    if (!current.artifacts.some((artifact) => artifact.id === intent.payloadId))
      throw new Error("Mutation payload must be a referenced durable artifact");
    const next = parseRunRecord({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      pendingOperations: [
        ...current.pendingOperations,
        {
          id: operationId,
          kind: intent.kind,
          status: "pending",
          generation: 1,
          expectedRevision: current.revision,
          prerequisites: [],
          intent,
          mutation: {
            version: 1,
            intent,
            policy: mutationPolicies[intent.kind],
            createdAt: now,
            executionFence: {
              id: current.operation.id,
              generation: current.operation.generation,
            },
            dispatches: [],
            observations: [],
            nextRecheckAt: null,
            attentionRequired: false,
          },
        },
      ],
    });
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "mutation-intent");
    return next;
  }

  /** Persist dispatch BEFORE the remote request. A crash afterward is uncertain.
   * Discovery uses the new owner fence after restart; old worker responses do not.
   * This method never dispatches or retries an external call itself. */
  recordMutationEvent(
    expectedRevision: number,
    ownerGeneration: number,
    operationId: string,
    operationGeneration: number,
    rawEvent: unknown,
    now: string,
  ): RunRecord {
    const current = this.assertCurrentLease(ownerGeneration);
    const entry = current.pendingOperations.find((operation) => operation.id === operationId);
    if (
      current.revision !== expectedRevision ||
      !entry?.mutation ||
      entry.generation !== operationGeneration
    )
      throw new RunStoreConflictError("Stale mutation revision or operation generation");
    const event = mutationEventSchema.parse(rawEvent);
    if (
      event.type !== "observe" &&
      event.type !== "cancel" &&
      (entry.mutation.executionFence.id !== current.operation.id ||
        entry.mutation.executionFence.generation !== current.operation.generation)
    )
      throw new RunStoreConflictError(
        "Superseded execution cannot dispatch or complete a mutation; reconcile its effect",
      );
    if (event.type === "cancel") {
      const terminal =
        ["done", "refined", "failed", "cancelled"].includes(current.lifecycle) ||
        terminalPrFenceFromRun(current) !== null;
      const superseded =
        entry.mutation.executionFence.id !== current.operation.id ||
        entry.mutation.executionFence.generation !== current.operation.generation;
      if (
        (event.reason === "terminal-observed" && !terminal) ||
        (event.reason === "execution-superseded" && !superseded)
      )
        throw new RunStoreConflictError(
          "Cancellation requires an authoritative terminal observation or superseding execution fence",
        );
    }
    if (
      event.type === "dispatch" &&
      ["done", "refined", "failed", "cancelled"].includes(current.lifecycle)
    )
      throw new RunStoreConflictError("Terminal attempt cannot dispatch workflow effects");
    if (
      event.type !== "dispatch" &&
      !current.artifacts.some((artifact) => artifact.id === event.evidence.artifactId)
    )
      throw new Error("Mutation evidence must reference a durable artifact");
    const mutation = applyMutationEvent(entry.mutation, event, ownerGeneration, now, {
      id: current.operation.id,
      generation: current.operation.generation,
    });
    const verification = mutation.observations.find(
      (observation) => observation.outcome === "verified",
    );
    const status = mutation.cancellation
      ? "cancelled"
      : verification
        ? "completed"
        : mutationProvenNotDelivered(mutation)
          ? "failed"
          : mutation.dispatches.length
            ? "ambiguous"
            : "pending";
    const next = parseRunRecord({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      pendingOperations: current.pendingOperations.map((operation) =>
        operation.id === operationId
          ? {
              ...operation,
              mutation,
              status,
              generation: Math.max(1, mutation.dispatches.length),
              ...(verification ? { completionEvidence: verification.evidence.observationId } : {}),
            }
          : operation,
      ),
    });
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, `mutation-${event.type}`);
    return next;
  }

  /** Attach a durable payload/evidence artifact without changing workflow state. */
  referenceMutationArtifact(
    expectedRevision: number,
    ownerGeneration: number,
    artifact: RunRecord["artifacts"][number],
  ): RunRecord {
    const current = this.assertCurrentLease(ownerGeneration);
    if (current.revision !== expectedRevision)
      throw new RunStoreConflictError("Stale artifact revision");
    const next = parseRunRecord({
      ...current,
      revision: current.revision + 1,
      artifacts: current.artifacts.some((entry) => entry.id === artifact.id)
        ? current.artifacts
        : [...current.artifacts, artifact],
      updatedAt: new Date().toISOString(),
    });
    this.validateArtifacts(next);
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "mutation-artifact");
    return next;
  }

  private appendTimeline(
    prior: RunRecord | null,
    next: RunRecord,
    kind: string,
    transition?: RunEventType,
  ): void {
    const timelinePath = path.join(
      this.identity.storageRoot,
      "history",
      encodeURIComponent(next.projectId),
      encodeURIComponent(next.cardId),
      encodeURIComponent(next.attemptId),
      "events.jsonl",
    );
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true, mode: 0o700 });
    let startedAt = next.updatedAt;
    try {
      const firstLine = fs
        .readFileSync(timelinePath, "utf8")
        .split("\n")
        .find((line) => line.length > 0);
      if (firstLine) {
        const first = JSON.parse(firstLine) as { startedAt?: unknown };
        if (typeof first.startedAt === "string") startedAt = first.startedAt;
      }
    } catch {
      // A new timeline starts at this durable state transition. Existing
      // malformed evidence is never overwritten; append a fresh safe entry.
    }
    const event = {
      type: "attempt-state",
      kind,
      ...(transition === undefined ? {} : { transition }),
      timestamp: next.updatedAt,
      startedAt,
      elapsedMilliseconds: Math.max(0, Date.parse(next.updatedAt) - Date.parse(startedAt)),
      projectId: next.projectId,
      cardId: next.cardId,
      attemptId: next.attemptId,
      revision: next.revision,
      ownerGeneration: next.owner.generation,
      before: prior
        ? {
            lifecycle: prior.lifecycle,
            checkpoint: prior.checkpoint,
            operation: prior.operation,
            publicationState: prior.publicationState,
            terminalSync: prior.terminalSync,
            wait: prior.wait,
          }
        : null,
      after: {
        lifecycle: next.lifecycle,
        checkpoint: next.checkpoint,
        operation: next.operation,
        publicationState: next.publicationState,
        terminalSync: next.terminalSync,
        terminalOutcome: next.terminalEvidence?.prOutcome ?? null,
        pendingOperations: next.pendingOperations.map((operation) => ({
          kind: operation.kind,
          status: operation.status,
          generation: operation.generation,
          resolution: operation.resolutionEvidence?.disposition ?? null,
        })),
        wait: next.wait,
        budgets: next.budgets,
        taskProjections: Object.values(next.compatibility).flatMap((raw) => {
          if (typeof raw !== "object" || raw === null) return [];
          const projection = raw as Record<string, unknown>;
          const result: Record<string, unknown> = {};
          const phases = [
            "planning",
            "implementation",
            "validation",
            "review",
            "publication",
            "ci",
            "human-feedback",
            "done",
            "attention-required",
          ];
          if (typeof projection.phase === "string" && phases.includes(projection.phase))
            result.phase = projection.phase;
          const lastEvent = projection.lastEvent;
          if (
            typeof lastEvent === "object" &&
            lastEvent !== null &&
            "type" in lastEvent &&
            typeof lastEvent.type === "string" &&
            taskExecutionEventTypes.includes(
              lastEvent.type as (typeof taskExecutionEventTypes)[number],
            )
          )
            result.lastEvent = lastEvent.type;
          const counters = projection.retryCounters;
          if (typeof counters === "object" && counters !== null)
            result.retryCounters = Object.fromEntries(
              Object.entries(counters).filter(
                (entry): entry is [string, number] =>
                  typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
              ),
            );
          for (const qualityKey of ["validation", "coverage", "review"]) {
            const quality = projection[qualityKey];
            if (
              typeof quality === "object" &&
              quality !== null &&
              "status" in quality &&
              typeof quality.status === "string" &&
              [
                "passed",
                "failed",
                "timed-out",
                "aborted",
                "uncertain",
                "skipped",
                "unavailable",
              ].includes(quality.status)
            )
              result[`${qualityKey}Status`] = quality.status;
          }
          return Object.keys(result).length ? [result] : [];
        }),
        artifacts: next.artifacts.map((artifact) => artifact.path),
      },
    };
    fs.appendFileSync(timelinePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  constructor(
    directory: string,
    attemptId: string,
    identity: unknown,
    private readonly lease: RunStoreLease,
  ) {
    if (
      !path.isAbsolute(directory) ||
      !attemptId ||
      attemptId.includes("/") ||
      attemptId.includes("\\") ||
      Array.from(attemptId).some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
      }) ||
      lease.integrationId !== (identity as { integrationId?: string })?.integrationId
    )
      throw new Error("Invalid attempt path or mismatched canonical lease");
    this.identity = pinnedIdentitySchema.parse(identity);
    const resolved = path.resolve(directory);
    this.storageRoot = resolved;
    this.attemptId = attemptId;
    if (resolved !== path.resolve(this.identity.storageRoot))
      throw new Error("Run storage path differs from pinned storage identity");
    const repo = path.resolve(this.identity.repositoryPath);
    const worktree = path.resolve(this.identity.worktreeRoot);
    const within = (a: string, b: string) => {
      const r = path.relative(a, b);
      return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r));
    };
    if (
      within(repo, worktree) ||
      within(worktree, repo) ||
      within(repo, resolved) ||
      within(worktree, resolved) ||
      within(resolved, repo) ||
      within(resolved, worktree)
    )
      throw new Error("Run storage, repository, and worktree paths must be disjoint");
    this.recordPath = path.join(resolved, "attempts", `${attemptId}.json`);
    this.artifactDirectory = path.join(resolved, "artifacts", attemptId);
  }
  /** Open a predecessor using its persisted pins, never a caller's newer pins. */
  static openWithPersistedIdentity(
    directory: string,
    attemptId: string,
    lease: RunStoreLease,
  ): RunStore | null {
    if (
      !path.isAbsolute(directory) ||
      !attemptId ||
      attemptId.includes("/") ||
      attemptId.includes("\\")
    )
      throw new Error("Invalid predecessor attempt location");
    const record = safeRead(path.join(path.resolve(directory), "attempts", `${attemptId}.json`));
    if (record === null) return null;
    const parsed = parseRunRecord(record);
    if (
      parsed.attemptId !== attemptId ||
      parsed.pinned.integrationId !== lease.integrationId ||
      path.resolve(parsed.pinned.storageRoot) !== path.resolve(directory)
    )
      throw new RunStoreConflictError(
        "Persisted predecessor identity does not match the canonical integration/storage root",
      );
    return new RunStore(directory, attemptId, parsed.pinned, lease);
  }
  read(): RunRecord | null {
    this.lease.assertHeld();
    const value = safeRead(this.recordPath);
    if (value === null) return null;
    if (
      typeof value === "object" &&
      value &&
      "version" in value &&
      (value as { version: unknown }).version !== 1
    )
      throw new RunStoreUnsupportedVersionError("Unsupported attempt version; original preserved");
    const run = parseRunRecord(value);
    if (
      run.attemptId !== path.basename(this.recordPath, ".json") ||
      JSON.stringify(run.pinned) !== JSON.stringify(this.identity)
    )
      throw new Error("Attempt identity/pins do not match storage location; original preserved");
    this.validateArtifacts(run);
    return run;
  }
  assertCurrentLease(expectedOwnerGeneration?: number): RunRecord {
    this.lease.assertHeld();
    const current = this.read();
    if (!current) throw new RunStoreConflictError("Canonical attempt is missing");
    this.assertLease(current);
    if (
      expectedOwnerGeneration !== undefined &&
      current.owner.generation !== expectedOwnerGeneration
    )
      throw new RunStoreConflictError("Stale canonical attempt owner generation");
    return current;
  }
  readCompatibility<T>(
    expectedOwnerGeneration: number,
    key: string,
    validate: (value: unknown) => T,
  ): T | null {
    const current = this.read();
    if (!current) return null;
    this.assertLease(current);
    if (current.owner.generation !== expectedOwnerGeneration)
      throw new RunStoreConflictError("Stale compatibility projection owner fence");
    const value = current.compatibility[key];
    return value === undefined ? null : validate(structuredClone(value));
  }

  listCompatibility<T>(
    expectedOwnerGeneration: number,
    prefix: string,
    validate: (value: unknown) => T,
  ): readonly { key: string; value: T }[] {
    const current = this.read();
    if (!current) return [];
    this.assertLease(current);
    if (current.owner.generation !== expectedOwnerGeneration)
      throw new RunStoreConflictError("Stale compatibility projection owner fence");
    return Object.entries(current.compatibility)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        key,
        value: validate(structuredClone(value)),
      }));
  }

  removeCompatibility(
    expectedRevision: number,
    expectedOwnerGeneration: number,
    key: string,
  ): boolean {
    this.lease.assertHeld();
    const current = this.read();
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.owner.generation !== expectedOwnerGeneration
    )
      throw new RunStoreConflictError("Stale compatibility projection revision or owner fence");
    if (!(key in current.compatibility)) return false;
    const compatibility = { ...current.compatibility };
    delete compatibility[key];
    const next = parseRunRecord({
      ...current,
      compatibility,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "compatibility-removed");
    return true;
  }

  /**
   * Revision/fence checked mutation for a concrete legacy-store projection.
   * The adapter must validate its domain schema before returning a value.
   * Lifecycle changes are accepted only with an enumerated transition event;
   * task projection and its core RunRecord state remain one atomic write.
   */
  mutateCompatibility<T>(options: {
    expectedRevision: number;
    expectedOwnerGeneration: number;
    key: string;
    current: (value: unknown | null) => { value: unknown; result: T };
    validate: (value: unknown) => unknown;
    lifecycleTransition?: {
      event: RunEventType;
      to: RunLifecycleState;
    };
    runState?: Partial<
      Pick<
        RunRecord,
        | "publicationState"
        | "sessions"
        | "budgets"
        | "operation"
        | "resources"
        | "expectedTrelloListId"
        | "wait"
      >
    >;
    deriveRunState?: (
      current: RunRecord,
      validatedProjection: unknown,
    ) => {
      lifecycleTransition?: { event: RunEventType; to: RunLifecycleState };
      runState?: Partial<
        Pick<
          RunRecord,
          | "publicationState"
          | "sessions"
          | "budgets"
          | "operation"
          | "resources"
          | "expectedTrelloListId"
          | "wait"
        >
      >;
    };
    terminal?: {
      event: "merged" | "closed-unmerged" | "failed";
      evidence: NonNullable<RunRecord["terminalEvidence"]>;
    };
  }): T {
    if (!options.key || options.key.trim() !== options.key)
      throw new Error("Compatibility projection key must be a nonblank identifier");
    this.lease.assertHeld();
    const current = this.read();
    if (
      !current ||
      current.revision !== options.expectedRevision ||
      current.owner.generation !== options.expectedOwnerGeneration
    )
      throw new RunStoreConflictError("Stale compatibility projection revision or owner fence");
    const before = structuredClone(current);
    const input = current.compatibility[options.key] ?? null;
    const output = options.current(structuredClone(input));
    if (JSON.stringify(current) !== JSON.stringify(before))
      throw new Error("Compatibility projection callback mutated the attempt snapshot");
    const validated = options.validate(output.value);
    const derived = options.deriveRunState?.(current, validated) ?? {};
    const lifecycleTransition = derived.lifecycleTransition ?? options.lifecycleTransition;
    let lifecycle = current.lifecycle;
    const effectiveTransition = options.terminal
      ? {
          event: options.terminal.event,
          to:
            options.terminal.event === "merged"
              ? ("done" as const)
              : options.terminal.event === "closed-unmerged"
                ? ("cancelled" as const)
                : ("failed" as const),
        }
      : lifecycleTransition;
    if (effectiveTransition) {
      const { event, to } = effectiveTransition;
      if (
        to !== "waiting" &&
        !options.terminal &&
        current.pendingOperations.some(
          (entry) => entry.mutation && !isConclusiveOperationResolution(entry),
        )
      )
        throw new RunStoreConflictError(
          "Reconcile pending workflow mutations before advancing lifecycle",
        );
      const allowed = runTransitionMatrix[event]?.[current.lifecycle];
      if (
        allowed === undefined ||
        (Array.isArray(allowed) ? !allowed.includes(to) : allowed !== to)
      )
        throw new RunStoreConflictError(
          `Illegal authoritative projection transition ${event}: ${current.lifecycle} -> ${to}`,
        );
      lifecycle = to;
    }
    if (options.terminal) {
      const evidence = terminalEvidenceSchema.parse(options.terminal.evidence);
      const expectedOutcome =
        options.terminal.event === "merged"
          ? "merged"
          : options.terminal.event === "closed-unmerged"
            ? "closed-unmerged"
            : "no-pr-failure";
      const expectedList =
        options.terminal.event === "merged"
          ? current.pinned.lists.done
          : options.terminal.event === "closed-unmerged"
            ? current.pinned.lists.backlog
            : current.pinned.lists.failed;
      if (
        evidence.prOutcome !== expectedOutcome ||
        evidence.trelloListId !== expectedList ||
        current.taskKind !== "implementation" ||
        (options.terminal.event === "failed" && current.publicationState !== "none") ||
        !current.pendingOperations.every(isConclusiveOperationResolution)
      )
        throw new RunStoreConflictError(
          "Terminal projection requires independently verified PR/Trello evidence and conclusive operations",
        );
    }
    const next = parseRunRecord({
      ...current,
      ...derived.runState,
      ...options.runState,
      lifecycle,
      checkpoint:
        lifecycle === current.lifecycle
          ? current.checkpoint
          : lifecycle === "waiting"
            ? current.lifecycle
            : lifecycle,
      wait:
        options.terminal !== undefined
          ? { reason: null, dependency: null, since: null, retryAt: null }
          : (derived.runState?.wait ??
            options.runState?.wait ??
            (lifecycle === "waiting"
              ? current.wait
              : {
                  reason: null,
                  dependency: null,
                  since: null,
                  retryAt: null,
                })),
      compatibility: { ...current.compatibility, [options.key]: validated },
      ...(options.terminal === undefined
        ? {}
        : {
            publicationState:
              options.terminal.event === "merged"
                ? "merged"
                : options.terminal.event === "closed-unmerged"
                  ? "closed-unmerged"
                  : "none",
            expectedTrelloListId: options.terminal.evidence.trelloListId,
            terminalSync: "verified",
            terminalEvidence: options.terminal.evidence,
          }),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "compatibility-updated");
    return output.result;
  }
  create(record: RunRecord): RunRecord {
    const parsed = parseRunRecord(record);
    this.assertLease(parsed);
    if (
      parsed.revision !== 1 ||
      parsed.attemptId !== path.basename(this.recordPath, ".json") ||
      JSON.stringify(parsed.pinned) !== JSON.stringify(this.identity)
    )
      throw new Error("New run attempt must match path, pinned identity and revision 1");
    provisionDirectory(path.dirname(this.recordPath));
    if (fs.existsSync(this.recordPath)) throw new RunStoreConflictError("Run already exists");
    this.validateArtifacts(parsed);
    atomicJson(this.recordPath, parsed, true);
    this.appendTimeline(null, parsed, "attempt-created");
    return parsed;
  }
  /** Import a validated legacy snapshot under the canonical lease. Artifacts are
   * durable before the candidate record; an orphan after interruption is safe. */
  importSnapshot(
    record: RunRecord,
    artifacts: readonly { content: Uint8Array; mediaType?: string }[],
  ): RunRecord {
    const parsed = parseRunRecord(record);
    this.assertLease(parsed);
    if (
      parsed.revision !== 1 ||
      parsed.attemptId !== path.basename(this.recordPath, ".json") ||
      JSON.stringify(parsed.pinned) !== JSON.stringify(this.identity) ||
      parsed.artifacts.length !== artifacts.length
    )
      throw new Error("Imported run must match candidate identity and artifact count");
    provisionDirectory(path.dirname(this.recordPath));
    if (fs.existsSync(this.recordPath)) throw new RunStoreConflictError("Run already exists");
    const refs = artifacts.map(({ content, mediaType }) =>
      this.persistArtifact(content, mediaType),
    );
    if (JSON.stringify(refs) !== JSON.stringify(parsed.artifacts))
      throw new Error("Imported artifact references do not match validated content");
    this.validateArtifacts(parsed);
    this.assertLease(parsed);
    atomicJson(this.recordPath, parsed, true);
    this.appendTimeline(null, parsed, "attempt-imported");
    return parsed;
  }
  /** Persist content-addressed import snapshots before recording the handoff marker. */
  stageImportArtifacts(
    artifacts: readonly { content: Uint8Array; mediaType?: string }[],
  ): RunRecord["artifacts"] {
    this.lease.assertHeld();
    return artifacts.map(({ content, mediaType }) => this.persistArtifact(content, mediaType));
  }
  /** All state mutations require the event/source/destination tuple; no public raw CAS. */
  transition(
    expectedRevision: number,
    expectedOwnerGeneration: number,
    expectedOperation: { id: string; generation: number } | null,
    event: RunEventType,
    from: RunLifecycleState,
    to: RunLifecycleState,
    update: (current: RunRecord) => RunRecord,
    evidence?: string | RunRecord["terminalEvidence"],
  ): RunRecord {
    const current = this.read();
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.owner.generation !== expectedOwnerGeneration ||
      current.lifecycle !== from
    )
      throw new RunStoreConflictError("Stale completion rejected by attempt/revision/owner fence");
    if (event === "failed" && current.publicationState !== "none")
      throw new RunStoreConflictError(
        "An open or uncertain PR cannot be terminally failed; preserve as operational blockage",
      );
    const matrixTarget = runTransitionMatrix[event]?.[from];
    if (matrixTarget === undefined)
      throw new Error(`Forbidden transition event/source pair: ${event} from ${from}`);
    const terminalObservation = [
      "refinement-completed",
      "merged",
      "closed-unmerged",
      "failed",
      "cancelled",
    ].includes(event);
    if (
      !terminalObservation &&
      event !== "wait-entered" &&
      current.pendingOperations.some(
        (entry) => entry.mutation && !isConclusiveOperationResolution(entry),
      )
    )
      throw new RunStoreConflictError(
        "Reconcile pending workflow mutations before advancing lifecycle",
      );
    if (
      event !== "claim" &&
      event !== "implementation-claimed" &&
      event !== "refinement-claimed" &&
      event !== "implementation-correction" &&
      event !== "feedback-ci-failed" &&
      event !== "feedback-replies-published" &&
      !terminalObservation &&
      event !== "wait-resumed" &&
      (!expectedOperation ||
        current.operation.id !== expectedOperation.id ||
        current.operation.generation !== expectedOperation.generation ||
        !current.pendingOperations.some(
          (operation) =>
            operation.id === expectedOperation.id &&
            operation.generation === expectedOperation.generation &&
            operation.status === "running",
        ))
    )
      throw new RunStoreConflictError(
        "Operation completion requires a matching running operation ID and generation",
      );
    if (
      event === "wait-resumed" &&
      current.pendingOperations.some((operation) =>
        ["pending", "running", "ambiguous"].includes(operation.status),
      )
    )
      throw new RunStoreConflictError(
        "Cannot resume while an operation outcome is unresolved; discover its effect first",
      );
    if (
      event === "wait-resumed" &&
      expectedOperation &&
      (current.operation.id !== expectedOperation.id ||
        current.operation.generation !== expectedOperation.generation)
    )
      throw new RunStoreConflictError("Stale wait-resume operation fence");
    const actualTarget = event === "wait-resumed" ? current.checkpoint : matrixTarget;
    const declaredTargetAllowed = Array.isArray(matrixTarget)
      ? matrixTarget.includes(to)
      : matrixTarget === to;
    const targetAllowed =
      declaredTargetAllowed &&
      (Array.isArray(actualTarget) ? actualTarget.includes(to) : actualTarget === to);
    if (!targetAllowed) throw new Error(`Forbidden transition ${event}: ${from} -> ${to}`);
    if (event === "failed" && current.publicationState !== "none")
      throw new RunStoreConflictError(
        "An open or uncertain PR cannot be terminally failed; preserve as operational blockage",
      );
    const terminalEvent = terminalObservation;
    if (terminalEvent) {
      const parsedEvidence = terminalEvidenceSchema.parse(evidence);
      const expectedOutcome =
        event === "merged"
          ? "merged"
          : event === "refinement-completed"
            ? "refinement-completed"
            : event === "failed"
              ? "no-pr-failure"
              : "closed-unmerged";
      const expectedList =
        event === "merged"
          ? current.pinned.lists.done
          : event === "failed"
            ? current.pinned.lists.failed
            : current.pinned.lists.backlog;
      if (
        parsedEvidence.prOutcome !== expectedOutcome ||
        parsedEvidence.trelloListId !== expectedList
      )
        throw new Error(
          "Terminal evidence does not verify the required PR outcome and Trello destination",
        );
    }
    this.assertLease(current);
    const before = structuredClone(current);
    const callbackInput = deepFreeze(structuredClone(current));
    const changed = update(callbackInput);
    if (
      JSON.stringify(changed.pendingOperations.filter((entry) => entry.mutation)) !==
      JSON.stringify(current.pendingOperations.filter((entry) => entry.mutation))
    )
      throw new RunStoreConflictError(
        "Workflow transitions cannot rewrite the durable mutation journal",
      );
    if (JSON.stringify(current) !== JSON.stringify(before))
      throw new Error("Transition callback mutated the authoritative snapshot");
    if (
      !sameIdentity(current, changed) ||
      changed.owner.generation !== current.owner.generation ||
      changed.owner.instanceId !== current.owner.instanceId ||
      changed.owner.token !== current.owner.token ||
      changed.lifecycle !== current.lifecycle ||
      changed.checkpoint !== current.checkpoint ||
      changed.revision !== current.revision
    )
      throw new Error("Transition cannot modify pinned identity, ownership, or revision directly");
    if (terminalObservation && JSON.stringify(changed) !== JSON.stringify(current))
      throw new Error(
        "Terminal observation cannot mutate attempt effects; preserve the reconciled operation ledger",
      );
    const next = parseRunRecord({
      ...changed,
      lifecycle: to,
      checkpoint:
        to === "waiting"
          ? from
          : event === "wait-resumed"
            ? to
            : ["done", "failed", "cancelled"].includes(to)
              ? changed.checkpoint
              : to,
      wait:
        to === "waiting"
          ? changed.wait
          : { reason: null, dependency: null, since: null, retryAt: null },
      pendingOperations:
        event === "wait-entered" || terminalObservation
          ? changed.pendingOperations.map((operation) =>
              operation.id === current.operation.id &&
              operation.generation === current.operation.generation &&
              operation.status === "running"
                ? { ...operation, status: "ambiguous" as const }
                : operation,
            )
          : changed.pendingOperations,
      publicationState:
        event === "merged"
          ? "merged"
          : event === "refinement-completed"
            ? changed.publicationState
            : event === "closed-unmerged" || event === "cancelled"
              ? "closed-unmerged"
              : changed.publicationState,
      expectedTrelloListId: terminalEvent
        ? (evidence as NonNullable<RunRecord["terminalEvidence"]>).trelloListId
        : changed.expectedTrelloListId,
      terminalSync: ["done", "refined", "failed", "cancelled"].includes(to)
        ? "verified"
        : changed.terminalSync,
      terminalEvidence: ["done", "refined", "failed", "cancelled"].includes(to)
        ? (evidence as RunRecord["terminalEvidence"])
        : changed.terminalEvidence,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    if (
      terminalObservation &&
      JSON.stringify(changed.pendingOperations) !== JSON.stringify(current.pendingOperations)
    )
      throw new Error(
        "Terminal observation must preserve dispatched and pending operation records",
      );
    if (
      event !== "claim" &&
      event !== "implementation-claimed" &&
      event !== "refinement-claimed" &&
      event !== "wait-entered" &&
      event !== "wait-resumed" &&
      event !== "implementation-correction" &&
      event !== "feedback-ci-failed" &&
      event !== "feedback-replies-published" &&
      !terminalObservation
    ) {
      const completed = next.pendingOperations.find(
        (operation) =>
          operation.id === expectedOperation?.id &&
          operation.generation === expectedOperation.generation,
      );
      if (
        typeof evidence !== "string" ||
        completed?.status !== "completed" ||
        completed.completionEvidence !== evidence
      )
        throw new Error(
          "Operation transition requires persisted completion evidence for the fenced operation",
        );
    }
    this.validateArtifacts(next);
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "workflow-transition", event);
    return next;
  }
  durableIdentity(): {
    integrationId: string;
    attemptId: string;
    storageRoot: string;
    ownerGeneration: number;
    ownerInstanceId: string;
    ownerToken: string;
  } | null {
    const record = this.read();
    return record
      ? {
          integrationId: record.pinned.integrationId,
          attemptId: record.attemptId,
          storageRoot: record.pinned.storageRoot,
          ownerGeneration: record.owner.generation,
          ownerInstanceId: record.owner.instanceId,
          ownerToken: record.owner.token,
        }
      : null;
  }
  /** Assert the current lease and the durable record's current owner fence. */
  assertLeaseForImport(): RunRecord {
    const record = this.read();
    if (!record) throw new RunStoreConflictError("Imported attempt is missing");
    this.lease.assertHeld();
    if (
      record.pinned.integrationId !== this.lease.integrationId ||
      record.owner.instanceId !== this.lease.instanceId ||
      record.owner.token !== this.lease.token
    )
      throw new RunStoreConflictError("Import lease is not the current durable attempt owner");
    return record;
  }
  /** Record authoritative discovery of an ambiguous effect without dispatching or reopening workflow state. */
  recordDiscoveredOperationOutcome(
    expectedRevision: number,
    expectedOwnerGeneration: number,
    operationId: string,
    operationGeneration: number,
    evidence: NonNullable<RunRecord["pendingOperations"][number]["resolutionEvidence"]>,
  ): RunRecord {
    this.lease.assertHeld();
    const current = this.read();
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.owner.generation !== expectedOwnerGeneration
    )
      throw new RunStoreConflictError("Stale operation discovery revision or owner generation");
    if (
      current.lifecycle !== "waiting" &&
      !["done", "failed", "cancelled"].includes(current.lifecycle)
    )
      throw new RunStoreConflictError(
        "Operation discovery is limited to recovery waits and terminal reconciliation",
      );
    const entry = current.pendingOperations.find(
      (operation) => operation.id === operationId && operation.generation === operationGeneration,
    );
    if (!entry || entry.mutation || !["pending", "ambiguous"].includes(entry.status))
      throw new RunStoreConflictError("Operation is not awaiting authoritative outcome discovery");
    const resolvedStatus =
      evidence.disposition === "accepted"
        ? "completed"
        : evidence.disposition === "conclusively-not-accepted"
          ? "failed"
          : "ambiguous";
    this.assertLease(current);
    const next = parseRunRecord({
      ...current,
      revision: current.revision + 1,
      pendingOperations: current.pendingOperations.map((operation) =>
        operation.id === operationId && operation.generation === operationGeneration
          ? {
              ...operation,
              status: resolvedStatus,
              completionEvidence: evidence.observationId,
              resolutionEvidence: evidence,
            }
          : operation,
      ),
      updatedAt: new Date().toISOString(),
    });
    this.assertLease(current);
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "operation-outcome-discovered");
    return next;
  }
  /** Takeover is only performed under the matching new canonical lease and increments durable fencing generation. */
  takeOwnership(expectedRevision: number, priorGeneration: number, nextToken: string): RunRecord {
    this.lease.assertHeld();
    const current = this.read();
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.owner.generation !== priorGeneration ||
      !nextToken ||
      this.lease.token !== nextToken
    )
      throw new RunStoreConflictError("Invalid ownership takeover fence");
    const next = parseRunRecord({
      ...current,
      revision: current.revision + 1,
      owner: {
        instanceId: this.lease.instanceId,
        token: this.lease.token,
        generation: priorGeneration + 1,
      },
      updatedAt: new Date().toISOString(),
    });
    atomicJson(this.recordPath, next);
    this.appendTimeline(current, next, "ownership-resumed");
    return next;
  }
  writeArtifact(content: Uint8Array, mediaType?: string): RunRecord["artifacts"][number] {
    this.lease.assertHeld();
    const run = this.read();
    if (!run) throw new Error("Attempt must exist before artifact publication");
    return this.persistArtifact(content, mediaType);
  }
  readArtifact(reference: string): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("Invalid artifact reference");
    const digest = reference.slice(7);
    const expected = path.join(this.artifactDirectory, `sha256-${digest}`);
    if (
      path.resolve(expected) !==
      path.join(path.resolve(this.storageRoot), "artifacts", this.attemptId, `sha256-${digest}`)
    )
      throw new Error("Artifact path identity mismatch");
    assertNoSymlinkPath(this.artifactDirectory);
    const fd = fs.openSync(expected, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Unsafe artifact file");
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const count = fs.readSync(fd, content, offset, content.length - offset, offset);
        if (count === 0) throw new Error("Artifact changed while reading");
        offset += count;
      }
      if (createHash("sha256").update(content).digest("hex") !== digest)
        throw new Error("Artifact digest mismatch");
      return content;
    } finally {
      fs.closeSync(fd);
    }
  }
  private persistArtifact(content: Uint8Array, mediaType?: string): RunRecord["artifacts"][number] {
    provisionDirectory(this.artifactDirectory);
    const digest = createHash("sha256").update(content).digest("hex");
    const name = `sha256-${digest}`;
    const target = path.join(this.artifactDirectory, name);
    if (fs.existsSync(target)) {
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink())
        throw new Error("Existing artifact path is not a regular owned file");
      const existing = fs.readFileSync(target);
      if (createHash("sha256").update(existing).digest("hex") !== digest)
        throw new Error("Existing content-addressed artifact is corrupt");
    } else {
      const temporary = path.join(this.artifactDirectory, `.${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
      fsyncDirectory(this.artifactDirectory);
    }
    return {
      id: `sha256:${digest}`,
      path: target,
      bytes: content.byteLength,
      ...(mediaType ? { mediaType } : {}),
    };
  }
  private validateArtifacts(run: RunRecord): void {
    const ids = new Set<string>();
    for (const artifact of run.artifacts) {
      if (
        ids.has(artifact.id) ||
        path.resolve(artifact.path) !==
          path.join(this.artifactDirectory, `sha256-${artifact.id.slice(7)}`)
      )
        throw new Error(
          "Artifact reference is duplicate or outside attempt-owned artifact directory",
        );
      ids.add(artifact.id);
      assertNoSymlinkPath(path.dirname(artifact.path));
      const stat = fs.lstatSync(artifact.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== artifact.bytes ||
        createHash("sha256").update(fs.readFileSync(artifact.path)).digest("hex") !==
          artifact.id.slice(7)
      )
        throw new Error("Missing or modified artifact; reference preserved");
    }
  }
  private assertLease(run: RunRecord): void {
    this.lease.assertHeld();
    if (
      this.lease.integrationId !== run.pinned.integrationId ||
      this.lease.instanceId !== run.owner.instanceId ||
      this.lease.token !== run.owner.token
    )
      throw new RunStoreConflictError("Canonical ownership lease does not match attempt owner");
  }
}

function sameIdentity(a: RunRecord, b: RunRecord): boolean {
  return (
    a.projectId === b.projectId &&
    a.cardId === b.cardId &&
    a.attemptId === b.attemptId &&
    JSON.stringify(a.pinned) === JSON.stringify(b.pinned)
  );
}
function sameRegistryPointer(
  a: {
    version: 1;
    integrationId: string;
    attemptId: string;
    generation: number;
  } | null,
  b: {
    version: 1;
    integrationId: string;
    attemptId: string;
    generation: number;
  } | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.version === b.version &&
        a.integrationId === b.integrationId &&
        a.attemptId === b.attemptId &&
        a.generation === b.generation;
}
function safeRead(file: string): unknown | null {
  try {
    assertNoSymlinkPath(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES)
      throw new Error(`Unsafe or oversized state file preserved: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function atomicJson(file: string, value: unknown, exclusive = false): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES)
    throw new Error(
      `Serialized state exceeds ${MAX_RECORD_BYTES} byte limit; existing state preserved`,
    );
  provisionDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function provisionDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  assertNoSymlinkPath(absolute);
  const missing: string[] = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    missing.push(current);
    current = path.dirname(current);
  }
  for (const candidate of missing.reverse()) {
    fs.mkdirSync(candidate, { mode: 0o700 });
    fsyncDirectory(path.dirname(candidate));
  }
  assertNoSymlinkPath(absolute);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
