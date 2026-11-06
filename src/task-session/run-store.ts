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
  for (const segment of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
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
    if (
      !path.isAbsolute(root) ||
      !integrationId ||
      lease.integrationId !== integrationId
    )
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
    if (
      typeof value !== "object" ||
      !value ||
      (value as { version?: unknown }).version !== 1
    )
      throw new RunStoreUnsupportedVersionError(
        "Unsupported registry pointer; preserved",
      );
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
      throw new Error(
        "Cannot publish pointer before matching durable candidate attempt",
      );
    const prior = this.read();
    if (!sameRegistryPointer(prior, expectedPrior))
      throw new RunStoreConflictError(
        "Registry pointer compare-and-swap conflict",
      );
    if (prior) {
      if (generation !== prior.generation + 1)
        throw new RunStoreConflictError(
          "Registry pointer handoff requires exact next generation",
        );
      const priorPath = path.join(
        path.resolve(this.root),
        "attempts",
        `${prior.attemptId}.json`,
      );
      const oldValue = safeRead(priorPath);
      if (!oldValue)
        throw new RunStoreConflictError(
          "Prior registry pointer is dangling; preserve and reconcile",
        );
      const old = parseRunRecord(oldValue);
      if (
        old.attemptId !== prior.attemptId ||
        old.pinned.integrationId !== this.integrationId
      )
        throw new RunStoreConflictError(
          "Prior pointer identity mismatch; preserve and reconcile",
        );
      if (prior.attemptId === durable.attemptId)
        throw new RunStoreConflictError(
          "Registry already points to this attempt; ownership takeover does not require pointer replacement",
        );
      if (
        prior.attemptId !== durable.attemptId &&
        !(
          ["done", "failed", "cancelled"].includes(old.lifecycle) &&
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
    this.assertNoConflictingOrphans(
      durable.attemptId,
      prior?.attemptId ?? null,
    );
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
        fs
          .readdirSync(attemptsDirectory)
          .some((entry) => entry.endsWith(".json"))
      )
        throw new RunStoreConflictError(
          "Durable attempt exists without registry pointer; reconcile handoff before any new claim",
        );
      return null;
    }
    const attemptPath = path.join(
      path.resolve(this.root),
      "attempts",
      `${pointer.attemptId}.json`,
    );
    const record = safeRead(attemptPath);
    if (!record)
      throw new RunStoreConflictError(
        "Registry pointer references a missing attempt; block new claims",
      );
    const run = parseRunRecord(record);
    if (
      run.attemptId !== pointer.attemptId ||
      run.pinned.integrationId !== this.integrationId
    )
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
    const records = fs
      .readdirSync(attemptsDirectory)
      .filter((entry) => entry.endsWith(".json"));
    const conflicts: string[] = [];
    for (const entry of records) {
      if (
        entry === `${candidateAttemptId}.json` ||
        entry === `${pointedAttemptId}.json`
      )
        continue;
      const run = parseRunRecord(safeRead(path.join(attemptsDirectory, entry)));
      if (!(
        ["done", "failed", "cancelled"].includes(run.lifecycle) &&
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
}

export class RunStore {
  private readonly recordPath: string;
  private readonly artifactDirectory: string;
  private readonly identity: ReturnType<typeof pinnedIdentitySchema.parse>;
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
        return (
          code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
        );
      }) ||
      lease.integrationId !==
        (identity as { integrationId?: string })?.integrationId
    )
      throw new Error("Invalid attempt path or mismatched canonical lease");
    this.identity = pinnedIdentitySchema.parse(identity);
    const resolved = path.resolve(directory);
    if (resolved !== path.resolve(this.identity.storageRoot))
      throw new Error("Run storage path differs from pinned storage identity");
    const repo = path.resolve(this.identity.repositoryPath);
    const worktree = path.resolve(this.identity.worktreeRoot);
    const within = (a: string, b: string) => {
      const r = path.relative(a, b);
      return (
        r === "" ||
        (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r))
      );
    };
    if (
      within(repo, worktree) ||
      within(worktree, repo) ||
      within(repo, resolved) ||
      within(worktree, resolved) ||
      within(resolved, repo) ||
      within(resolved, worktree)
    )
      throw new Error(
        "Run storage, repository, and worktree paths must be disjoint",
      );
    this.recordPath = path.join(resolved, "attempts", `${attemptId}.json`);
    this.artifactDirectory = path.join(resolved, "artifacts", attemptId);
  }
  read(): RunRecord | null {
    const value = safeRead(this.recordPath);
    if (value === null) return null;
    if (
      typeof value === "object" &&
      value &&
      "version" in value &&
      (value as { version: unknown }).version !== 1
    )
      throw new RunStoreUnsupportedVersionError(
        "Unsupported attempt version; original preserved",
      );
    const run = parseRunRecord(value);
    if (
      run.attemptId !== path.basename(this.recordPath, ".json") ||
      JSON.stringify(run.pinned) !== JSON.stringify(this.identity)
    )
      throw new Error(
        "Attempt identity/pins do not match storage location; original preserved",
      );
    this.validateArtifacts(run);
    return run;
  }
  create(record: RunRecord): RunRecord {
    const parsed = parseRunRecord(record);
    this.assertLease(parsed);
    if (
      parsed.revision !== 1 ||
      parsed.attemptId !== path.basename(this.recordPath, ".json") ||
      JSON.stringify(parsed.pinned) !== JSON.stringify(this.identity)
    )
      throw new Error(
        "New run attempt must match path, pinned identity and revision 1",
      );
    provisionDirectory(path.dirname(this.recordPath));
    if (fs.existsSync(this.recordPath))
      throw new RunStoreConflictError("Run already exists");
    this.validateArtifacts(parsed);
    atomicJson(this.recordPath, parsed, true);
    return parsed;
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
      throw new RunStoreConflictError(
        "Stale completion rejected by attempt/revision/owner fence",
      );
    if (event === "failed" && current.publicationState !== "none")
      throw new RunStoreConflictError(
        "An open or uncertain PR cannot be terminally failed; preserve as operational blockage",
      );
    const matrixTarget = runTransitionMatrix[event]?.[from];
    if (matrixTarget === undefined)
      throw new Error(
        `Forbidden transition event/source pair: ${event} from ${from}`,
      );
    const terminalObservation = [
      "merged",
      "closed-unmerged",
      "failed",
      "cancelled",
    ].includes(event);
    if (
      event !== "claim" &&
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
    const actualTarget =
      event === "wait-resumed" ? current.checkpoint : matrixTarget;
    const declaredTargetAllowed = Array.isArray(matrixTarget)
      ? matrixTarget.includes(to)
      : matrixTarget === to;
    const targetAllowed =
      declaredTargetAllowed &&
      (Array.isArray(actualTarget)
        ? actualTarget.includes(to)
        : actualTarget === to);
    if (!targetAllowed)
      throw new Error(`Forbidden transition ${event}: ${from} -> ${to}`);
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
      throw new Error(
        "Transition cannot modify pinned identity, ownership, or revision directly",
      );
    if (
      terminalObservation &&
      JSON.stringify(changed) !== JSON.stringify(current)
    )
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
          : event === "closed-unmerged" || event === "cancelled"
            ? "closed-unmerged"
            : changed.publicationState,
      expectedTrelloListId: terminalEvent
        ? (evidence as NonNullable<RunRecord["terminalEvidence"]>).trelloListId
        : changed.expectedTrelloListId,
      terminalSync: ["done", "failed", "cancelled"].includes(to)
        ? "verified"
        : changed.terminalSync,
      terminalEvidence: ["done", "failed", "cancelled"].includes(to)
        ? (evidence as RunRecord["terminalEvidence"])
        : changed.terminalEvidence,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    if (
      terminalObservation &&
      JSON.stringify(changed.pendingOperations) !==
        JSON.stringify(current.pendingOperations)
    )
      throw new Error(
        "Terminal observation must preserve dispatched and pending operation records",
      );
    if (
      event !== "claim" &&
      event !== "wait-entered" &&
      event !== "wait-resumed" &&
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
  /** Record authoritative discovery of an ambiguous effect without dispatching or reopening workflow state. */
  recordDiscoveredOperationOutcome(
    expectedRevision: number,
    expectedOwnerGeneration: number,
    operationId: string,
    operationGeneration: number,
    evidence: NonNullable<
      RunRecord["pendingOperations"][number]["resolutionEvidence"]
    >,
  ): RunRecord {
    this.lease.assertHeld();
    const current = this.read();
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.owner.generation !== expectedOwnerGeneration
    )
      throw new RunStoreConflictError(
        "Stale operation discovery revision or owner generation",
      );
    if (
      current.lifecycle !== "waiting" &&
      !["done", "failed", "cancelled"].includes(current.lifecycle)
    )
      throw new RunStoreConflictError(
        "Operation discovery is limited to recovery waits and terminal reconciliation",
      );
    const entry = current.pendingOperations.find(
      (operation) =>
        operation.id === operationId &&
        operation.generation === operationGeneration,
    );
    if (!entry || !["pending", "ambiguous"].includes(entry.status))
      throw new RunStoreConflictError(
        "Operation is not awaiting authoritative outcome discovery",
      );
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
        operation.id === operationId &&
        operation.generation === operationGeneration
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
    return next;
  }
  /** Takeover is only performed under the matching new canonical lease and increments durable fencing generation. */
  takeOwnership(
    expectedRevision: number,
    priorGeneration: number,
    nextToken: string,
  ): RunRecord {
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
    return next;
  }
  writeArtifact(
    content: Uint8Array,
    mediaType?: string,
  ): RunRecord["artifacts"][number] {
    this.lease.assertHeld();
    const run = this.read();
    if (!run) throw new Error("Attempt must exist before artifact publication");
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
      const temporary = path.join(
        this.artifactDirectory,
        `.${randomUUID()}.tmp`,
      );
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
        createHash("sha256")
          .update(fs.readFileSync(artifact.path))
          .digest("hex") !== artifact.id.slice(7)
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
      throw new RunStoreConflictError(
        "Canonical ownership lease does not match attempt owner",
      );
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
