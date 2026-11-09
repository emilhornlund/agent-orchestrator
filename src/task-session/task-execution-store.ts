import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

import type { ProjectConfig } from "../config/config.js";
import {
  parseTaskExecutionRecord,
  type TaskExecutionRecord,
} from "./task-execution-record.js";
import { ProjectRunAuthority } from "./project-run-authority.js";
import {
  PROCESS_CAPTURE_MAX_BYTES,
  getProcessRuntime,
} from "../process/process-runtime.js";
import { redactSecrets } from "../security/redact-secrets.js";

export interface PrimaryResultArtifactReference {
  reference: `sha256:${string}`;
  path?: string;
  bytes: number;
}

function validatePrimaryResultId(id: string): void {
  assertSafePathComponent(id, "primary result ID");
  if (Buffer.byteLength(id, "utf8") > 1024)
    throw new Error("Primary result ID exceeds 1024 bytes");
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function redactStructured(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactStructured(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactSecrets(key, secrets),
        redactStructured(item, secrets),
      ]),
    );
  }
  return value;
}

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
        fs.mkdirSync(currentPath, { mode: 0o700 });
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
      const parentDescriptor = fs.openSync(path.dirname(currentPath), "r");
      try {
        fs.fsyncSync(parentDescriptor);
      } finally {
        fs.closeSync(parentDescriptor);
      }
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
  private readonly authority: ProjectRunAuthority | undefined;
  private readonly primaryResultDirectory: string;

  constructor(
    rootDirectory: string,
    project: ProjectConfig,
    authority?: ProjectRunAuthority,
  ) {
    const root = assertStorageRoot(rootDirectory, project);
    this.directoryPath = path.join(root, "task-executions", project.id);
    this.primaryResultDirectory = path.join(
      this.directoryPath,
      "primary-results",
    );
    this.authority = authority ?? ProjectRunAuthority.current(project.id);
  }

  private getRecordPath(cardId: string): string {
    assertSafePathComponent(cardId, "card ID");
    return path.join(this.directoryPath, `${cardId}.json`);
  }

  read(cardId: string): TaskExecutionRecord | null {
    if (this.authority !== undefined) {
      const value = this.authority.read(
        `task-execution-${cardId}`,
        parseTaskExecutionRecord,
      );
      if (
        value &&
        (value.projectId !== this.projectId || value.cardId !== cardId)
      )
        throw new Error("Task execution projection identity mismatch");
      return value;
    }
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

    if (this.authority !== undefined) {
      return this.authority.mutateTaskExecution({
        key: `task-execution-${record.cardId}`,
        initial: null,
        operation: (value) => {
          if (value !== null)
            throw new TaskExecutionRecordConflictError(
              "Run already contains task execution projection",
            );
          return { value: record, result: record };
        },
        validate: parseTaskExecutionRecord,
      });
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
    terminal?: {
      event: "merged" | "closed-unmerged" | "failed";
      evidence: NonNullable<
        import("./run-record.js").RunRecord["terminalEvidence"]
      >;
    },
  ): TaskExecutionRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error(
        "Expected task execution record revision must be positive",
      );
    }

    const nextRecord = parseTaskExecutionRecord(nextRecordInput);

    if (this.authority !== undefined) {
      return this.authority.mutateTaskExecution({
        key: `task-execution-${cardId}`,
        initial: null,
        operation: (value) => {
          const current =
            value === null ? null : parseTaskExecutionRecord(value);
          if (current === null || current.revision !== expectedRevision)
            throw new TaskExecutionRecordConflictError(
              "Task execution projection revision conflict",
            );
          if (
            nextRecord.projectId !== current.projectId ||
            nextRecord.cardId !== cardId ||
            nextRecord.revision !== expectedRevision + 1
          )
            throw new Error(
              "Updated task execution projection must preserve identity and increment revision exactly once",
            );
          return { value: nextRecord, result: nextRecord };
        },
        validate: parseTaskExecutionRecord,
        ...(terminal === undefined ? {} : { terminal }),
      });
    }

    if (terminal !== undefined)
      throw new Error(
        "Verified terminal transitions require canonical RunStore authority",
      );

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

  writePrimaryResultArtifact(
    id: string,
    result: unknown,
  ): PrimaryResultArtifactReference {
    validatePrimaryResultId(id);
    const bytes = Buffer.from(
      JSON.stringify(
        redactStructured(result, getProcessRuntime().secretValues),
      ),
      "utf8",
    );
    if (bytes.byteLength > PROCESS_CAPTURE_MAX_BYTES)
      throw new Error(
        `Primary result exceeds ${PROCESS_CAPTURE_MAX_BYTES}-byte limit`,
      );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (this.authority) {
      const artifact = this.authority.store.writeArtifact(
        bytes,
        "application/json",
      );
      return {
        reference: artifact.id as `sha256:${string}`,
        path: artifact.path,
        bytes: artifact.bytes,
      };
    }
    assertDirectoryPath(this.primaryResultDirectory, true);
    const directoryStat = fs.lstatSync(this.primaryResultDirectory);
    if (
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      (directoryStat.mode & 0o077) !== 0
    )
      throw new Error("Unsafe primary result artifact directory");
    const target = path.join(this.primaryResultDirectory, `sha256-${digest}`);
    if (!fs.existsSync(target)) {
      const temp = path.join(
        this.primaryResultDirectory,
        `.${randomUUID()}.tmp`,
      );
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(temp, target);
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      } finally {
        fs.unlinkSync(temp);
      }
      fsyncDirectory(this.primaryResultDirectory);
    }
    this.validateFallbackArtifact(target, digest, bytes.byteLength);
    return {
      reference: `sha256:${digest}`,
      path: `primary-results/sha256-${digest}`,
      bytes: bytes.byteLength,
    };
  }

  readPrimaryResultArtifact(
    ref: PrimaryResultArtifactReference | string,
  ): unknown {
    const reference = typeof ref === "string" ? ref : ref.reference;
    if (!/^sha256:[a-f0-9]{64}$/.test(reference))
      throw new Error("Invalid primary result artifact reference");
    const digest = reference.slice(7);
    let filePath: string;
    if (this.authority)
      return redactStructured(
        JSON.parse(
          this.authority.store.readArtifact(reference).toString("utf8"),
        ) as unknown,
        getProcessRuntime().secretValues,
      );
    else {
      filePath = path.join(this.primaryResultDirectory, `sha256-${digest}`);
      if (!assertDirectoryPath(this.primaryResultDirectory, false))
        throw new Error("Primary result artifact is missing");
    }
    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const size = fs.fstatSync(fd).size;
      if (size > PROCESS_CAPTURE_MAX_BYTES)
        throw new Error("Unsafe primary result artifact");
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = fs.readSync(fd, bytes, offset, size - offset, offset);
        if (!count) throw new Error("Artifact changed while reading");
        offset += count;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("Primary result artifact digest mismatch");
      return redactStructured(
        JSON.parse(bytes.toString("utf8")) as unknown,
        getProcessRuntime().secretValues,
      );
    } finally {
      fs.closeSync(fd);
    }
  }

  readProcessExecution(cardId: string, executionId: string): unknown | null {
    assertSafePathComponent(executionId, "process execution ID");
    if (this.authority === undefined) return null;
    const run = this.authority.store.read();
    if (
      !run ||
      run.cardId !== cardId ||
      run.pinned.projectId !== this.projectId
    )
      return null;
    const directory = path.join(
      run.pinned.storageRoot,
      "artifacts",
      encodeURIComponent(run.pinned.projectId),
      encodeURIComponent(run.cardId),
      encodeURIComponent(run.attemptId),
      executionId,
    );
    const metadataPath = path.join(directory, "execution.json");
    let parent = path.parse(metadataPath).root;
    for (const component of path
      .relative(parent, path.dirname(metadataPath))
      .split(path.sep)
      .filter(Boolean)) {
      parent = path.join(parent, component);
      const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (parentStat === undefined) return null;
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
        throw new Error("Unsafe process execution artifact path");
    }
    const stat = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024)
      throw new Error("Unsafe process execution metadata");
    return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
  }

  processExecutionDirectory(cardId: string): string | undefined {
    if (this.authority === undefined) return undefined;
    const run = this.authority.store.read();
    if (
      !run ||
      run.cardId !== cardId ||
      run.pinned.projectId !== this.projectId
    )
      return undefined;
    return path.join(
      run.pinned.storageRoot,
      "artifacts",
      encodeURIComponent(run.pinned.projectId),
      encodeURIComponent(run.cardId),
      encodeURIComponent(run.attemptId),
    );
  }

  private validateFallbackArtifact(
    filePath: string,
    digest: string,
    expectedBytes: number,
  ): void {
    const stats = fs.lstatSync(filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size !== expectedBytes ||
      (stats.mode & 0o077) !== 0
    )
      throw new Error("Unsafe existing primary result artifact");
    const current = fs.readFileSync(filePath);
    if (createHash("sha256").update(current).digest("hex") !== digest)
      throw new Error("Existing primary result artifact is corrupt");
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
