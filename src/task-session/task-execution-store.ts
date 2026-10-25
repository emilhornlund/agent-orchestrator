import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ProjectConfig } from "../config/config.js";
import {
  parseTaskExecutionRecord,
  type TaskExecutionRecord,
} from "./task-execution-record.js";

export const MAX_TASK_EXECUTION_RECORD_BYTES = 1024 * 1024;

export class TaskExecutionRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionRecordConflictError";
  }
}

export class TaskExecutionStoreBusyError extends Error {
  constructor(filePath: string) {
    super(
      `Task execution record is being updated by another writer: ${filePath}`,
    );
    this.name = "TaskExecutionStoreBusyError";
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function assertSafePathComponent(value: string, label: string): void {
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
    throw new Error(`Invalid ${label} for task execution storage: ${value}`);
  }
}

function assertStorageRoot(
  rootDirectory: string,
  project: ProjectConfig,
): string {
  if (!path.isAbsolute(rootDirectory)) {
    throw new Error("Task execution storage root must be an absolute path");
  }

  const resolvedRoot = path.resolve(rootDirectory);
  const repositoryPath = path.resolve(project.repository.path);
  const worktreeRoot = path.resolve(project.repository.worktreeRoot);

  if (
    pathsOverlap(resolvedRoot, repositoryPath) ||
    pathsOverlap(resolvedRoot, worktreeRoot)
  ) {
    throw new Error(
      "Task execution storage root must not overlap the configured repository or worktree root",
    );
  }

  assertSafePathComponent(project.id, "project ID");

  return resolvedRoot;
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
      throw new Error(
        `Unsafe task execution storage directory: ${currentPath}`,
      );
    }
  }

  return true;
}

function readRecordFile(
  filePath: string,
  projectId: string,
  cardId: string,
): TaskExecutionRecord | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });

  if (stats === undefined) {
    return null;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Unsafe task execution record file: ${filePath}`);
  }

  if (stats.size > MAX_TASK_EXECUTION_RECORD_BYTES) {
    throw new Error(
      `Task execution record exceeds the ${MAX_TASK_EXECUTION_RECORD_BYTES}-byte limit: ${filePath}`,
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not parse task execution record: ${filePath}`, {
      cause: error,
    });
  }

  const record = parseTaskExecutionRecord(value);

  if (record.projectId !== projectId || record.cardId !== cardId) {
    throw new Error(
      `Task execution record ownership does not match ${projectId}/${cardId}: ${filePath}`,
    );
  }

  return record;
}

function serializeRecord(record: TaskExecutionRecord): string {
  const serialized = `${JSON.stringify(parseTaskExecutionRecord(record), null, 2)}\n`;

  if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_EXECUTION_RECORD_BYTES) {
    throw new Error(
      `Task execution record exceeds the ${MAX_TASK_EXECUTION_RECORD_BYTES}-byte limit`,
    );
  }

  return serialized;
}

export class TaskExecutionStore {
  private readonly directoryPath: string;

  constructor(rootDirectory: string, project: ProjectConfig) {
    const root = assertStorageRoot(rootDirectory, project);
    this.directoryPath = path.join(root, "task-executions", project.id);
  }

  private getRecordPath(cardId: string): string {
    assertSafePathComponent(cardId, "card ID");
    return path.join(this.directoryPath, `${cardId}.json`);
  }

  read(cardId: string): TaskExecutionRecord | null {
    const filePath = this.getRecordPath(cardId);

    if (!assertDirectoryPath(this.directoryPath, false)) {
      return null;
    }

    return readRecordFile(filePath, this.projectId, cardId);
  }

  create(recordInput: TaskExecutionRecord): TaskExecutionRecord {
    const record = parseTaskExecutionRecord(recordInput);

    if (record.projectId !== this.projectId || record.revision !== 1) {
      throw new Error(
        "A new task execution record must belong to this project and start at revision 1",
      );
    }

    const filePath = this.getRecordPath(record.cardId);
    assertDirectoryPath(this.directoryPath, true);

    return this.withLock(filePath, () => {
      if (readRecordFile(filePath, record.projectId, record.cardId) !== null) {
        throw new TaskExecutionRecordConflictError(
          `Task execution record already exists: ${filePath}`,
        );
      }

      const temporaryPath = this.writeTemporaryRecord(filePath, record);

      try {
        fs.linkSync(temporaryPath, filePath);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new TaskExecutionRecordConflictError(
            `Task execution record already exists: ${filePath}`,
          );
        }

        throw error;
      } finally {
        fs.unlinkSync(temporaryPath);
      }

      return record;
    });
  }

  compareAndSwap(
    cardId: string,
    expectedRevision: number,
    nextRecordInput: TaskExecutionRecord,
  ): TaskExecutionRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error(
        "Expected task execution record revision must be positive",
      );
    }

    const nextRecord = parseTaskExecutionRecord(nextRecordInput);
    const filePath = this.getRecordPath(cardId);

    if (!assertDirectoryPath(this.directoryPath, false)) {
      throw new TaskExecutionRecordConflictError(
        `Task execution record does not exist: ${filePath}`,
      );
    }

    if (
      nextRecord.projectId !== this.projectId ||
      nextRecord.cardId !== cardId ||
      nextRecord.revision !== expectedRevision + 1
    ) {
      throw new Error(
        "Updated task execution record must preserve ownership and increment the revision exactly once",
      );
    }

    return this.withLock(filePath, () => {
      if (!assertDirectoryPath(this.directoryPath, false)) {
        throw new TaskExecutionRecordConflictError(
          `Task execution record does not exist: ${filePath}`,
        );
      }

      const currentRecord = readRecordFile(filePath, this.projectId, cardId);

      if (
        currentRecord === null ||
        currentRecord.revision !== expectedRevision
      ) {
        throw new TaskExecutionRecordConflictError(
          `Task execution record revision conflict for ${filePath}: expected ${expectedRevision}, found ${currentRecord?.revision ?? "missing"}`,
        );
      }

      const temporaryPath = this.writeTemporaryRecord(filePath, nextRecord);

      try {
        fs.renameSync(temporaryPath, filePath);
      } finally {
        if (fs.existsSync(temporaryPath)) {
          fs.unlinkSync(temporaryPath);
        }
      }

      return nextRecord;
    });
  }

  claimHumanReviewNotification(cardId: string, commitSha: string): boolean {
    const current = this.read(cardId);
    if (current === null) {
      throw new TaskExecutionRecordConflictError(
        `Task execution record does not exist for Human Review notification: ${cardId}`,
      );
    }
    const notifiedCommitShas = current.humanReviewNotificationCommitShas ?? [];
    if (notifiedCommitShas.includes(commitSha)) return false;
    this.compareAndSwap(cardId, current.revision, {
      ...current,
      humanReviewNotificationCommitShas: [...notifiedCommitShas, commitSha],
      revision: current.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString(),
    });
    return true;
  }

  private get projectId(): string {
    return path.basename(this.directoryPath);
  }

  private withLock<T>(filePath: string, operation: () => T): T {
    const lockPath = `${filePath}.lock`;
    let lockDescriptor: number;

    try {
      lockDescriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new TaskExecutionStoreBusyError(filePath);
      }

      throw error;
    }

    try {
      return operation();
    } finally {
      fs.closeSync(lockDescriptor);
      fs.unlinkSync(lockPath);
    }
  }

  private writeTemporaryRecord(
    filePath: string,
    record: TaskExecutionRecord,
  ): string {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);

    try {
      fs.writeFileSync(descriptor, serializeRecord(record), "utf8");
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
