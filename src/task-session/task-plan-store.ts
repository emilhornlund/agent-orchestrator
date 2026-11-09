import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
import {
  parsePlanVerificationResult,
  type PlanVerificationResult,
} from "./plan-verification.js";
import { parseTaskPlan, type TaskPlan } from "./task-plan.js";
import { ProjectRunAuthority } from "./project-run-authority.js";

export const MAX_TASK_PLAN_BYTES = 1024 * 1024;

const storedTaskPlanEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  planRevision: z.number().int().positive().safe(),
  taskRecordRevision: z.number().int().positive().safe(),
  taskOperationKey: z.string().min(1).optional(),
  plan: z.unknown(),
  verification: z.unknown().optional(),
});

export interface StoredTaskPlan {
  version: 1;
  planRevision: number;
  taskRecordRevision: number;
  taskOperationKey?: string;
  plan: TaskPlan;
  verification?: PlanVerificationResult;
}

export class TaskPlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPlanConflictError";
  }
}

export class TaskPlanStoreBusyError extends Error {
  constructor(filePath: string) {
    super(`Task plan is being updated by another writer: ${filePath}`);
    this.name = "TaskPlanStoreBusyError";
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function assertSafeComponent(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);

      return (
        code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      );
    })
  ) {
    throw new Error(`Invalid ${label} for task plan storage: ${value}`);
  }
}

function resolveStorageRoot(
  rootDirectory: string,
  project: ProjectConfig,
): string {
  if (!path.isAbsolute(rootDirectory)) {
    throw new Error("Task plan storage root must be an absolute path");
  }

  assertSafeComponent(project.id, "project ID");
  const root = path.resolve(rootDirectory);
  const repositoryPath = path.resolve(project.repository.path);
  const worktreeRoot = path.resolve(project.repository.worktreeRoot);

  if (pathsOverlap(root, repositoryPath) || pathsOverlap(root, worktreeRoot)) {
    throw new Error(
      "Task plan storage root must not overlap the configured repository or worktree root",
    );
  }

  return root;
}

function assertDirectoryPath(directoryPath: string, create: boolean): boolean {
  const parsedPath = path.parse(directoryPath);
  let currentPath = parsedPath.root;

  for (const component of path
    .relative(parsedPath.root, directoryPath)
    .split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);
    let stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });

    if (stats === undefined) {
      if (!create) {
        return false;
      }

      try {
        fs.mkdirSync(currentPath);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }

      stats = fs.lstatSync(currentPath);
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Unsafe task plan storage directory: ${currentPath}`);
    }
  }

  return true;
}

export function parseStoredTaskPlan(value: unknown): StoredTaskPlan {
  const envelope = storedTaskPlanEnvelopeSchema.parse(value);
  const plan = parseTaskPlan(envelope.plan);
  const verification =
    envelope.verification === undefined
      ? undefined
      : parsePlanVerificationResult(envelope.verification);

  if (
    verification !== undefined &&
    (verification.projectId !== plan.projectId ||
      verification.cardId !== plan.cardId ||
      verification.planRevision !== envelope.planRevision)
  ) {
    throw new Error("Task plan verification identity does not match its plan");
  }

  return {
    version: envelope.version,
    planRevision: envelope.planRevision,
    taskRecordRevision: envelope.taskRecordRevision,
    ...(envelope.taskOperationKey === undefined
      ? {}
      : { taskOperationKey: envelope.taskOperationKey }),
    plan,
    ...(verification === undefined ? {} : { verification }),
  };
}

function readTaskPlanFile(
  filePath: string,
  projectId: string,
  cardId: string,
): StoredTaskPlan | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });

  if (stats === undefined) {
    return null;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Unsafe task plan file: ${filePath}`);
  }

  if (stats.size > MAX_TASK_PLAN_BYTES) {
    throw new Error(
      `Task plan exceeds the ${MAX_TASK_PLAN_BYTES}-byte limit: ${filePath}`,
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not parse task plan: ${filePath}`, { cause: error });
  }

  const stored = parseStoredTaskPlan(value);

  if (stored.plan.projectId !== projectId || stored.plan.cardId !== cardId) {
    throw new Error(
      `Task plan identity does not match ${projectId}/${cardId}: ${filePath}`,
    );
  }

  return stored;
}

function serializeTaskPlan(stored: StoredTaskPlan): string {
  const serialized = `${JSON.stringify(parseStoredTaskPlan(stored), null, 2)}\n`;

  if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_PLAN_BYTES) {
    throw new Error(`Task plan exceeds the ${MAX_TASK_PLAN_BYTES}-byte limit`);
  }

  return serialized;
}

export class TaskPlanStore {
  private readonly projectId: string;
  private readonly directoryPath: string;
  private readonly authority: ProjectRunAuthority | undefined;

  constructor(
    rootDirectory: string,
    project: ProjectConfig,
    authority?: ProjectRunAuthority,
  ) {
    const root = resolveStorageRoot(rootDirectory, project);
    this.projectId = project.id;
    this.authority = authority ?? ProjectRunAuthority.current(project.id);
    if (authority && authority.projectId !== project.id)
      throw new Error("Task plan authority project mismatch");
    this.directoryPath = path.join(root, "task-plans", project.id);
  }

  private getPlanPath(cardId: string): string {
    assertSafeComponent(cardId, "card ID");
    return path.join(this.directoryPath, `${cardId}.json`);
  }

  read(
    cardId: string,
    expectedTaskRecordRevision?: number,
    expectedTaskOperationKey?: string,
  ): StoredTaskPlan | null {
    if (this.authority !== undefined) {
      const stored = this.authority.read(
        ProjectRunAuthority.taskKey("task-plan", cardId),
        parseStoredTaskPlan,
      );
      if (
        stored &&
        (stored.plan.projectId !== this.projectId ||
          stored.plan.cardId !== cardId)
      )
        throw new TaskPlanConflictError(
          "Task plan projection identity mismatch",
        );
      if (
        stored &&
        expectedTaskOperationKey !== undefined &&
        stored.taskOperationKey !== undefined &&
        stored.taskOperationKey !== expectedTaskOperationKey
      )
        throw new TaskPlanConflictError(
          "Projected task plan belongs to a different task operation",
        );
      if (
        stored &&
        expectedTaskRecordRevision !== undefined &&
        (expectedTaskOperationKey === undefined ||
          stored.taskOperationKey === undefined) &&
        stored.taskRecordRevision !== expectedTaskRecordRevision
      )
        throw new TaskPlanConflictError(
          "Projected task plan is associated with a different task revision",
        );
      return stored;
    }
    const filePath = this.getPlanPath(cardId);

    if (!assertDirectoryPath(this.directoryPath, false)) {
      return null;
    }

    const stored = readTaskPlanFile(filePath, this.projectId, cardId);

    if (
      stored !== null &&
      expectedTaskOperationKey !== undefined &&
      stored.taskOperationKey !== undefined &&
      stored.taskOperationKey !== expectedTaskOperationKey
    ) {
      throw new TaskPlanConflictError(
        `Task plan belongs to operation ${stored.taskOperationKey}, not ${expectedTaskOperationKey}`,
      );
    }

    if (
      stored !== null &&
      expectedTaskRecordRevision !== undefined &&
      (expectedTaskOperationKey === undefined ||
        stored.taskOperationKey === undefined) &&
      stored.taskRecordRevision !== expectedTaskRecordRevision
    ) {
      throw new TaskPlanConflictError(
        `Task plan is associated with task record revision ${stored.taskRecordRevision}, not ${expectedTaskRecordRevision}`,
      );
    }

    return stored;
  }

  create(
    planInput: TaskPlan,
    taskRecordRevision: number,
    taskOperationKey?: string,
  ): StoredTaskPlan {
    const plan = parseTaskPlan(planInput);
    this.assertPlanOwner(plan);
    this.assertTaskRecordRevision(taskRecordRevision);

    const stored: StoredTaskPlan = {
      version: 1,
      planRevision: 1,
      taskRecordRevision,
      ...(taskOperationKey === undefined ? {} : { taskOperationKey }),
      plan,
    };
    if (this.authority !== undefined)
      return this.authority.mutate(
        ProjectRunAuthority.taskKey("task-plan", plan.cardId),
        null,
        (value) => {
          if (value !== null)
            throw new TaskPlanConflictError("Task plan already exists");
          return { value: stored, result: stored };
        },
        parseStoredTaskPlan,
      );
    const filePath = this.getPlanPath(plan.cardId);
    assertDirectoryPath(this.directoryPath, true);

    return this.withLock(filePath, () => {
      if (readTaskPlanFile(filePath, this.projectId, plan.cardId) !== null) {
        throw new TaskPlanConflictError(
          `Task plan already exists: ${filePath}`,
        );
      }

      const temporaryPath = this.writeTemporaryPlan(filePath, stored);

      try {
        fs.linkSync(temporaryPath, filePath);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new TaskPlanConflictError(
            `Task plan already exists: ${filePath}`,
          );
        }

        throw error;
      } finally {
        fs.unlinkSync(temporaryPath);
      }

      return stored;
    });
  }

  compareAndSwap(
    cardId: string,
    expectedPlanRevision: number,
    planInput: TaskPlan,
    taskRecordRevision: number,
  ): StoredTaskPlan {
    if (
      !Number.isSafeInteger(expectedPlanRevision) ||
      expectedPlanRevision < 1
    ) {
      throw new Error("Expected task plan revision must be positive");
    }

    const plan = parseTaskPlan(planInput);
    this.assertPlanOwner(plan);
    this.assertTaskRecordRevision(taskRecordRevision);

    if (plan.cardId !== cardId) {
      throw new Error("Updated task plan must preserve the requested card ID");
    }

    if (this.authority !== undefined)
      return this.authority.mutate(
        ProjectRunAuthority.taskKey("task-plan", cardId),
        null,
        (value) => {
          const current = value === null ? null : parseStoredTaskPlan(value);
          if (current === null || current.planRevision !== expectedPlanRevision)
            throw new TaskPlanConflictError(
              "Task plan projection revision conflict",
            );
          const updated: StoredTaskPlan = {
            version: 1,
            planRevision: expectedPlanRevision + 1,
            taskRecordRevision,
            ...(current.taskOperationKey === undefined
              ? {}
              : { taskOperationKey: current.taskOperationKey }),
            plan,
          };
          return { value: updated, result: updated };
        },
        parseStoredTaskPlan,
      );

    const filePath = this.getPlanPath(cardId);

    if (!assertDirectoryPath(this.directoryPath, false)) {
      throw new TaskPlanConflictError(`Task plan does not exist: ${filePath}`);
    }

    return this.withLock(filePath, () => {
      const current = readTaskPlanFile(filePath, this.projectId, cardId);

      if (current === null || current.planRevision !== expectedPlanRevision) {
        throw new TaskPlanConflictError(
          `Task plan revision conflict for ${filePath}: expected ${expectedPlanRevision}, found ${current?.planRevision ?? "missing"}`,
        );
      }

      const updated: StoredTaskPlan = {
        version: 1,
        planRevision: expectedPlanRevision + 1,
        taskRecordRevision,
        ...(current.taskOperationKey === undefined
          ? {}
          : { taskOperationKey: current.taskOperationKey }),
        plan,
      };
      const temporaryPath = this.writeTemporaryPlan(filePath, updated);

      try {
        fs.renameSync(temporaryPath, filePath);
      } finally {
        if (fs.existsSync(temporaryPath)) {
          fs.unlinkSync(temporaryPath);
        }
      }

      return updated;
    });
  }

  storeVerification(
    cardId: string,
    expectedPlanRevision: number,
    verificationInput: PlanVerificationResult,
  ): StoredTaskPlan {
    if (
      !Number.isSafeInteger(expectedPlanRevision) ||
      expectedPlanRevision < 1
    ) {
      throw new Error("Expected task plan revision must be positive");
    }

    const verification = parsePlanVerificationResult(verificationInput);

    if (
      verification.projectId !== this.projectId ||
      verification.cardId !== cardId ||
      verification.planRevision !== expectedPlanRevision
    ) {
      throw new Error(
        "Plan verification identity must match the requested task and plan revision",
      );
    }

    const filePath = this.getPlanPath(cardId);

    if (this.authority !== undefined)
      return this.authority.mutate(
        ProjectRunAuthority.taskKey("task-plan", cardId),
        null,
        (value) => {
          const current = value === null ? null : parseStoredTaskPlan(value);
          if (current === null || current.planRevision !== expectedPlanRevision)
            throw new TaskPlanConflictError(
              "Task plan projection revision conflict",
            );
          const updated = parseStoredTaskPlan({ ...current, verification });
          return { value: updated, result: updated };
        },
        parseStoredTaskPlan,
      );

    return this.withLock(filePath, () => {
      const current = readTaskPlanFile(filePath, this.projectId, cardId);

      if (current === null || current.planRevision !== expectedPlanRevision) {
        throw new TaskPlanConflictError(
          `Task plan revision conflict for ${filePath}: expected ${expectedPlanRevision}, found ${current?.planRevision ?? "missing"}`,
        );
      }

      const updated: StoredTaskPlan = { ...current, verification };
      const temporaryPath = this.writeTemporaryPlan(filePath, updated);

      try {
        fs.renameSync(temporaryPath, filePath);
      } finally {
        if (fs.existsSync(temporaryPath)) {
          fs.unlinkSync(temporaryPath);
        }
      }

      return updated;
    });
  }

  private assertPlanOwner(plan: TaskPlan): void {
    if (plan.projectId !== this.projectId) {
      throw new Error(
        `Task plan project ID does not match configured project ${this.projectId}`,
      );
    }
  }

  private assertTaskRecordRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Associated task record revision must be positive");
    }
  }

  private withLock<T>(filePath: string, operation: () => T): T {
    const lockPath = `${filePath}.lock`;
    let descriptor: number;

    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new TaskPlanStoreBusyError(filePath);
      }

      throw error;
    }

    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
    }
  }

  private writeTemporaryPlan(filePath: string, stored: StoredTaskPlan): string {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);

    try {
      fs.writeFileSync(descriptor, serializeTaskPlan(stored), "utf8");
      fs.fsyncSync(descriptor);
    } catch (error) {
      fs.closeSync(descriptor);
      fs.unlinkSync(temporaryPath);
      throw error;
    }

    fs.closeSync(descriptor);
    return temporaryPath;
  }
}
