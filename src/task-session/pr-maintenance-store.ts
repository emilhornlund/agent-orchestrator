import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import {
  parsePrMaintenanceOperation,
  localPreparationSchema,
  type LocalPreparationProgress,
  type MaintenanceQualityEvidence,
  type PrMaintenanceOperation,
} from "./pr-maintenance-operation.js";

const storeSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive().safe(),
  operations: z.array(z.unknown()).max(10_000),
});
type StoreRecord = {
  version: 1;
  projectId: string;
  revision: number;
  operations: PrMaintenanceOperation[];
};
const liveOwners = new Set<string>();
const MAX_STORE_BYTES = 1024 * 1024;

export class PrMaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrMaintenanceConflictError";
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function assertComponent(value: string, label: string): void {
  if (
    !value ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      );
    })
  ) {
    throw new Error(`Invalid ${label} for PR maintenance storage: ${value}`);
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function ensureDirectory(directory: string): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of path
    .relative(parsed.root, directory)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    let stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      stats = fs.lstatSync(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(`Unsafe PR maintenance storage directory: ${current}`);
  }
}

export class PrMaintenanceStore {
  private readonly filePath: string;
  private readonly projectId: string;
  private readonly ownerToken = randomUUID();

  constructor(rootDirectory: string, project: ProjectConfig) {
    if (!path.isAbsolute(rootDirectory))
      throw new Error("PR maintenance storage root must be absolute");
    const root = path.resolve(rootDirectory);
    if (
      within(root, path.resolve(project.repository.path)) ||
      within(path.resolve(project.repository.path), root) ||
      within(root, path.resolve(project.repository.worktreeRoot)) ||
      within(path.resolve(project.repository.worktreeRoot), root)
    ) {
      throw new Error(
        "PR maintenance storage root must not overlap the configured repository or worktree root",
      );
    }
    assertComponent(project.id, "project ID");
    this.projectId = project.id;
    this.filePath = path.join(root, "pr-maintenance", `${project.id}.json`);
  }

  inspect(): PrMaintenanceOperation[];
  inspect(operationId: string): PrMaintenanceOperation | null;
  inspect(
    operationId?: string,
  ): PrMaintenanceOperation[] | PrMaintenanceOperation | null {
    const operations = this.read().operations;
    if (operationId === undefined) return operations;
    return (
      operations.find((operation) => operation.operationId === operationId) ??
      null
    );
  }

  requireOwnedActive(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    const operation = this.inspect(operationId);
    if (operation === null)
      throw new PrMaintenanceConflictError(
        `Unknown maintenance operation: ${operationId}`,
      );
    this.assertIdentity(operation, identity);
    if (
      operation.status !== "active" ||
      operation.ownerToken !== this.ownerToken ||
      !liveOwners.has(this.ownerToken)
    ) {
      throw new PrMaintenanceConflictError(
        "Verified exclusive maintenance ownership is required",
      );
    }
    return operation;
  }

  claimForRecovery(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (current.status === "active") {
        if (
          current.ownerToken === this.ownerToken &&
          liveOwners.has(this.ownerToken)
        )
          return record;
        if (
          current.ownerToken !== undefined &&
          (liveOwners.has(current.ownerToken) ||
            isProcessAlive(current.ownerPid!))
        ) {
          throw new PrMaintenanceConflictError(
            "Maintenance operation still has a live owner",
          );
        }
      } else if (current.status !== "uncertain") {
        throw new PrMaintenanceConflictError(
          "Only an interrupted active or uncertain operation can be reclaimed",
        );
      }
      const reclaimed = parsePrMaintenanceOperation({
        ...current,
        status: "active",
        ownerToken: this.ownerToken,
        ownerPid: process.pid,
        updatedAt: new Date().toISOString(),
      });
      liveOwners.add(this.ownerToken);
      const operations = [...record.operations];
      operations[index] = reclaimed;
      return { ...record, operations };
    }, operationId);
  }

  recordLocalPreparation(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
    progress: LocalPreparationProgress,
  ): PrMaintenanceOperation {
    const validated = localPreparationSchema.parse(progress);
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (
        current.status !== "active" ||
        current.ownerToken !== this.ownerToken ||
        !liveOwners.has(this.ownerToken)
      ) {
        throw new PrMaintenanceConflictError(
          "Verified exclusive maintenance ownership is required to record preparation progress",
        );
      }
      const previous = current.localPreparation;
      const allowedNext: Record<
        LocalPreparationProgress["status"],
        LocalPreparationProgress["status"][]
      > = {
        "fetching-base": ["fetching-base", "base-fetched"],
        "base-fetched": ["base-fetched", "backing-up", "prepared"],
        "backing-up": ["backing-up", "rebasing"],
        rebasing: ["rebasing", "conflicted", "prepared"],
        conflicted: ["conflicted", "prepared"],
        prepared: ["prepared"],
      };
      if (
        previous !== undefined &&
        !allowedNext[previous.status].includes(validated.status)
      ) {
        throw new PrMaintenanceConflictError(
          `Invalid preparation progress transition: ${previous.status} -> ${validated.status}`,
        );
      }
      const updated = parsePrMaintenanceOperation({
        ...current,
        localPreparation: validated,
        updatedAt: new Date().toISOString(),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
  }

  recordQualityVerification(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
    evidence: MaintenanceQualityEvidence,
  ): PrMaintenanceOperation {
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (
        current.status !== "active" ||
        current.ownerToken !== this.ownerToken ||
        !liveOwners.has(this.ownerToken)
      ) {
        throw new PrMaintenanceConflictError(
          "Verified exclusive maintenance ownership is required to record quality evidence",
        );
      }
      if (
        current.localPreparation?.status !== "prepared" ||
        current.localPreparation.resultingHead !== evidence.preparedHead
      ) {
        throw new PrMaintenanceConflictError(
          "Quality evidence must match the prepared maintenance head",
        );
      }
      const updated = parsePrMaintenanceOperation({
        ...current,
        qualityVerification: evidence,
        updatedAt: new Date().toISOString(),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
  }

  recordConflictRemediationAttempt(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (
        current.status !== "active" ||
        current.ownerToken !== this.ownerToken ||
        !liveOwners.has(this.ownerToken)
      )
        throw new PrMaintenanceConflictError(
          "Verified exclusive ownership is required to remediate conflicts",
        );
      const updated = parsePrMaintenanceOperation({
        ...current,
        conflictRemediationAttempts:
          (current.conflictRemediationAttempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
  }

  recordPublication(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
    status: "push-intended" | "verified",
    resultingHead: string,
  ): PrMaintenanceOperation {
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (
        current.status !== "active" ||
        current.ownerToken !== this.ownerToken ||
        !liveOwners.has(this.ownerToken) ||
        current.qualityVerification?.status !== "passed" ||
        current.qualityVerification.preparedHead !== resultingHead ||
        current.localPreparation?.resultingHead !== resultingHead
      ) {
        throw new PrMaintenanceConflictError(
          "Verified exclusive ownership and complete quality evidence are required to publish",
        );
      }
      if (
        current.publication?.status === "push-intended" &&
        status === "push-intended"
      ) {
        throw new PrMaintenanceConflictError(
          "Maintenance push was already intended; an ambiguous push must never be repeated",
        );
      }
      if (
        current.publication?.status === "verified" &&
        (current.publication.resultingHead !== resultingHead ||
          status !== "verified")
      ) {
        throw new PrMaintenanceConflictError(
          "Verified maintenance publication cannot be changed or regressed",
        );
      }
      const updated = parsePrMaintenanceOperation({
        ...current,
        publication: {
          status,
          resultingHead,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
  }

  /**
   * Retire a deterministic quality failure without losing the prepared rebase.
   * No push may have been attempted. The caller must preserve the worktree.
   */
  cancelFailedUnpublished(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      this.assertIdentity(current, identity);
      if (current.status === "cancelled") return record;
      if (
        current.status !== "uncertain" ||
        current.ownerToken !== undefined ||
        current.localPreparation?.status !== "prepared" ||
        current.localPreparation.resultingHead === undefined ||
        current.qualityVerification?.status !== "failed" ||
        current.qualityVerification.preparedHead !==
          current.localPreparation.resultingHead ||
        current.publication !== undefined
      )
        throw new PrMaintenanceConflictError(
          "Only an unowned, unpublished, prepared operation with a confirmed quality failure may be cancelled",
        );
      const operations = [...record.operations];
      operations[index] = parsePrMaintenanceOperation({
        ...current,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      });
      return { ...record, operations };
    }, operationId);
  }

  create(
    input: Omit<
      PrMaintenanceOperation,
      "version" | "status" | "ownerToken" | "ownerPid"
    >,
  ): PrMaintenanceOperation {
    const operation = parsePrMaintenanceOperation({
      ...input,
      version: 1,
      status: "prepared",
    });
    if (operation.projectId !== this.projectId)
      throw new PrMaintenanceConflictError(
        "Maintenance operation belongs to another project",
      );
    return this.update((record) => {
      if (
        record.operations.some(
          (item) => item.operationId === operation.operationId,
        )
      )
        throw new PrMaintenanceConflictError(
          `Maintenance operation already exists: ${operation.operationId}`,
        );
      if (
        record.operations.some(
          (item) => item.status !== "completed" && item.status !== "cancelled",
        )
      )
        throw new PrMaintenanceConflictError(
          "An incomplete PR maintenance operation already owns this project",
        );
      return { ...record, operations: [...record.operations, operation] };
    }, operation.operationId);
  }

  advance(
    operationId: string,
    expectedStatus: PrMaintenanceOperation["status"],
    nextStatus: PrMaintenanceOperation["status"],
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    const updated = this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      if (index < 0)
        throw new PrMaintenanceConflictError(
          `Unknown maintenance operation: ${operationId}`,
        );
      const current = record.operations[index]!;
      this.assertIdentity(current, identity);
      if (current.status === "completed" && nextStatus === "completed")
        return record;
      if (current.status !== expectedStatus)
        throw new PrMaintenanceConflictError(
          `Maintenance status conflict: expected ${expectedStatus}, found ${current.status}`,
        );
      const allowed =
        (current.status === "prepared" && nextStatus === "active") ||
        (current.status === "active" &&
          (nextStatus === "uncertain" || nextStatus === "completed"));
      if (!allowed)
        throw new PrMaintenanceConflictError(
          `Invalid maintenance status transition: ${current.status} -> ${nextStatus}`,
        );
      if (
        current.status === "active" &&
        (current.ownerToken !== this.ownerToken ||
          !liveOwners.has(this.ownerToken))
      )
        throw new PrMaintenanceConflictError(
          "Maintenance operation is owned by another process; reconcile it before advancing",
        );
      if (nextStatus === "active") liveOwners.add(this.ownerToken);
      else liveOwners.delete(this.ownerToken);
      const updated = parsePrMaintenanceOperation({
        ...current,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
        ...(nextStatus === "active"
          ? { ownerToken: this.ownerToken, ownerPid: process.pid }
          : { ownerToken: undefined, ownerPid: undefined }),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
    return updated;
  }

  reconcileInterrupted(
    operationId: string,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): PrMaintenanceOperation {
    const found = this.inspect(operationId);
    if (found === null)
      throw new PrMaintenanceConflictError(
        `Unknown maintenance operation: ${operationId}`,
      );
    this.assertIdentity(found, identity);
    if (found.status === "completed" || found.status === "uncertain")
      return found;
    if (found.status !== "active")
      throw new PrMaintenanceConflictError(
        "Only an active interrupted operation can be reconciled",
      );
    if (
      found.ownerToken !== undefined &&
      (liveOwners.has(found.ownerToken) || isProcessAlive(found.ownerPid!))
    )
      throw new PrMaintenanceConflictError(
        "Maintenance operation still has a live owner",
      );
    return this.update((record) => {
      const index = record.operations.findIndex(
        (item) => item.operationId === operationId,
      );
      const current = record.operations[index];
      if (current === undefined)
        throw new PrMaintenanceConflictError(
          "Maintenance operation disappeared during reconciliation",
        );
      this.assertIdentity(current, identity);
      if (current.status === "uncertain") return record;
      if (
        current.status !== "active" ||
        (current.ownerToken !== undefined &&
          (liveOwners.has(current.ownerToken) ||
            isProcessAlive(current.ownerPid!)))
      )
        throw new PrMaintenanceConflictError(
          "Maintenance ownership changed during reconciliation",
        );
      const updated = parsePrMaintenanceOperation({
        ...current,
        status: "uncertain",
        ownerToken: undefined,
        ownerPid: undefined,
        updatedAt: new Date().toISOString(),
      });
      const operations = [...record.operations];
      operations[index] = updated;
      return { ...record, operations };
    }, operationId);
  }

  private assertIdentity(
    operation: PrMaintenanceOperation,
    identity: Pick<
      PrMaintenanceOperation,
      | "projectId"
      | "cardId"
      | "pullRequest"
      | "expectedRemoteHead"
      | "targetBaseHead"
    >,
  ): void {
    if (
      operation.projectId !== identity.projectId ||
      operation.cardId !== identity.cardId ||
      operation.pullRequest.number !== identity.pullRequest.number ||
      operation.pullRequest.url !== identity.pullRequest.url ||
      operation.expectedRemoteHead !== identity.expectedRemoteHead ||
      operation.targetBaseHead !== identity.targetBaseHead
    )
      throw new PrMaintenanceConflictError(
        "Maintenance operation identity does not match project, card, PR, or expected heads",
      );
  }

  private read(): StoreRecord {
    const stats = fs.lstatSync(this.filePath, { throwIfNoEntry: false });
    if (stats === undefined)
      return {
        version: 1,
        projectId: this.projectId,
        revision: 1,
        operations: [],
      };
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new Error("Unsafe PR maintenance store file");
    if (stats.size > MAX_STORE_BYTES)
      throw new Error(
        `PR maintenance store exceeds the ${MAX_STORE_BYTES}-byte limit`,
      );
    const parsed = storeSchema.parse(
      JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown,
    );
    if (parsed.projectId !== this.projectId)
      throw new Error("PR maintenance store owner mismatch");
    const operations = parsed.operations.map(parsePrMaintenanceOperation);
    if (
      operations.some((operation) => operation.projectId !== this.projectId) ||
      new Set(operations.map((operation) => operation.operationId)).size !==
        operations.length ||
      operations.filter((operation) => operation.status !== "completed")
        .length > 1
    )
      throw new Error("Invalid PR maintenance operation ownership or history");
    return { ...parsed, operations };
  }

  private update(
    change: (current: StoreRecord) => StoreRecord,
    operationId?: string,
  ): PrMaintenanceOperation {
    ensureDirectory(path.dirname(this.filePath));
    return this.withLock(() => {
      const current = this.read();
      const changed = change(current);
      if (changed === current) {
        const unchanged = changed.operations.find(
          (item) => item.operationId === operationId,
        );
        if (unchanged === undefined)
          throw new PrMaintenanceConflictError(
            "Maintenance operation disappeared",
          );
        return unchanged;
      }
      const next = { ...changed, revision: current.revision + 1 };
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(temporary);
        throw error;
      }
      fs.closeSync(fd);
      try {
        fs.renameSync(temporary, this.filePath);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      const updated = next.operations.find(
        (item) => item.operationId === operationId,
      );
      if (updated === undefined)
        throw new PrMaintenanceConflictError(
          "Maintenance operation disappeared",
        );
      return updated;
    });
  }

  private withLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new PrMaintenanceConflictError(
          "Another writer owns the PR maintenance store",
        );
      throw error;
    }
    try {
      return operation();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }
  }
}
