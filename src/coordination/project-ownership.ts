import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { canonicalizeGitHubRepository } from "../config/config.js";

export interface ProjectIntegrationIdentity {
  trelloBoardId: string;
  githubRepository: string;
}

interface OwnerRecord {
  version: 1;
  identity: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  device: number;
  inode: number;
  namespaceId: string;
}

interface NamespaceMarker {
  version: 1;
  namespaceId: string;
}

export interface ProjectOwnershipLease {
  readonly identity: ProjectIntegrationIdentity;
  assertHeld(): void;
  release(): Promise<void>;
}

export class ProjectOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectOwnershipError";
  }
}

function assertSafeDirectory(root: string): void {
  if (!path.isAbsolute(root)) {
    throw new ProjectOwnershipError("Coordination root must be absolute");
  }
  const normalized = path.resolve(root);
  const parsed = path.parse(normalized);
  let current = parsed.root;
  for (const segment of normalized.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProjectOwnershipError(
          `Coordination path contains a non-directory or symbolic link: ${current}`,
        );
      }
      if (
        current !== normalized &&
        (stat.mode & 0o022) !== 0 &&
        (stat.mode & 0o1000) === 0
      ) {
        throw new ProjectOwnershipError(
          `Coordination namespace traverses an unprotected writable parent: ${current}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new ProjectOwnershipError(
        `Coordination namespace path must be explicitly provisioned before use: ${current}`,
        { cause: error },
      );
    }
  }
  const rootStat = fs.statSync(normalized);
  if (
    (typeof process.getuid === "function" &&
      rootStat.uid !== process.getuid()) ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new ProjectOwnershipError(
      `Coordination namespace must be owned by this runtime user and not writable by group/other: ${normalized}`,
    );
  }
}

function assertProtectedFile(stat: fs.Stats, filePath: string): void {
  if (
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new ProjectOwnershipError(
      `Coordination evidence file has unsafe owner or write permissions: ${filePath}`,
    );
  }
}

const namespaceMarkerName = ".agent-orchestrator-coordination.json";

function readNamespaceMarker(root: string): NamespaceMarker {
  const markerPath = path.join(root, namespaceMarkerName);
  let contents: string;
  try {
    const fd = fs.openSync(
      markerPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("not a regular file");
      assertProtectedFile(stat, markerPath);
      contents = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new ProjectOwnershipError(
      `Coordination namespace marker is missing or unsafe; explicitly provision ${markerPath}`,
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ProjectOwnershipError(
      `Malformed coordination namespace marker preserved at ${markerPath}`,
      { cause: error },
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<NamespaceMarker>).version !== 1 ||
    typeof (value as Partial<NamespaceMarker>).namespaceId !== "string" ||
    !(value as Partial<NamespaceMarker>).namespaceId?.trim()
  ) {
    throw new ProjectOwnershipError(
      `Incompatible coordination namespace marker preserved at ${markerPath}`,
    );
  }
  return value as NamespaceMarker;
}

/** Explicit operator/setup action. The namespace directory must already exist. */
export function provisionCoordinationNamespace(
  coordinationRoot: string,
  namespaceId: string,
): void {
  assertSafeDirectory(coordinationRoot);
  if (!namespaceId.trim() || /[\r\n\0]/.test(namespaceId)) {
    throw new ProjectOwnershipError(
      "Namespace identifier must be nonblank and single-line",
    );
  }
  const markerPath = path.join(
    path.resolve(coordinationRoot),
    namespaceMarkerName,
  );
  let fd: number;
  try {
    fd = fs.openSync(
      markerPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new ProjectOwnershipError(
      `Could not provision coordination namespace marker at ${markerPath}; existing marker is never replaced`,
      { cause: error },
    );
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, namespaceId })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readOwnerRecord(metadataPath: string): OwnerRecord | undefined {
  let text: string;
  let fd: number;
  try {
    fd = fs.openSync(
      metadataPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProjectOwnershipError(
        `Ownership metadata is a symbolic link: ${metadataPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ProjectOwnershipError(
        `Ownership metadata is not a regular file: ${metadataPath}`,
      );
    }
    assertProtectedFile(stat, metadataPath);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ProjectOwnershipError(
      `Malformed ownership metadata preserved at ${metadataPath}`,
      { cause: error },
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<OwnerRecord>).version !== 1 ||
    typeof (value as Partial<OwnerRecord>).identity !== "string" ||
    typeof (value as Partial<OwnerRecord>).hostname !== "string" ||
    !Number.isSafeInteger((value as Partial<OwnerRecord>).pid) ||
    typeof (value as Partial<OwnerRecord>).acquiredAt !== "string" ||
    !Number.isSafeInteger((value as Partial<OwnerRecord>).device) ||
    !Number.isSafeInteger((value as Partial<OwnerRecord>).inode) ||
    typeof (value as Partial<OwnerRecord>).namespaceId !== "string"
  ) {
    throw new ProjectOwnershipError(
      `Incompatible ownership metadata preserved at ${metadataPath}`,
    );
  }
  return value as OwnerRecord;
}

function persistOwner(metadataPath: string, record: OwnerRecord): void {
  const previous = readOwnerRecord(metadataPath);
  if (previous !== undefined) {
    const historyPath = `${metadataPath}.history.jsonl`;
    try {
      const stat = fs.lstatSync(historyPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ProjectOwnershipError(
          `Unsafe ownership history path: ${historyPath}`,
        );
      }
      assertProtectedFile(stat, historyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const historyFd = fs.openSync(
      historyPath,
      fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      assertProtectedFile(fs.fstatSync(historyFd), historyPath);
      fs.writeFileSync(historyFd, `${JSON.stringify(previous)}\n`);
      fs.fsyncSync(historyFd);
    } finally {
      fs.closeSync(historyFd);
    }
  }
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  const fd = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryPath, metadataPath);
}

function resourceKeys(identity: ProjectIntegrationIdentity): string[] {
  const boardId = identity.trelloBoardId.trim();
  if (!boardId)
    throw new ProjectOwnershipError("Trello board identity is blank");
  const resources = [
    `trello:${boardId}`,
    `github:${canonicalizeGitHubRepository(identity.githubRepository)}`,
  ];
  return resources
    .map((resource) => createHash("sha256").update(resource).digest("hex"))
    .sort();
}

interface KernelLock {
  lockPath: string;
  descriptor: number;
  device: number;
  inode: number;
}

async function acquireKernelLock(lockPath: string): Promise<KernelLock> {
  const descriptor = openLockFile(lockPath);
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new ProjectOwnershipError(
        `Ownership lock is not a regular file: ${lockPath}`,
      );
    }
    assertProtectedFile(stat, lockPath);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  let child: ChildProcess;
  try {
    child = spawn("flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "pipe", descriptor],
    });
  } catch (error) {
    fs.closeSync(descriptor);
    throw new ProjectOwnershipError(
      "Could not start host kernel locking utility (flock)",
      {
        cause: error,
      },
    );
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        if (spawnError !== undefined) {
          reject(
            new ProjectOwnershipError(
              "Could not start host kernel locking utility (flock)",
              { cause: spawnError },
            ),
          );
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new ProjectOwnershipError(
              code === 1
                ? `Project integration ownership is already held (${lockPath})`
                : `Could not acquire project integration lock (${lockPath}): ${stderr.trim() || `flock exited ${String(code)}${signal === null ? "" : ` from ${signal}`}`}`,
            ),
          );
        }
      });
    });
    const current = fs.lstatSync(lockPath);
    if (
      current.isSymbolicLink() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    ) {
      throw new ProjectOwnershipError(
        `Ownership lock pathname changed during acquisition: ${lockPath}`,
      );
    }
    return {
      lockPath,
      descriptor,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openLockFile(lockPath: string): number {
  try {
    return fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new ProjectOwnershipError(
      `Could not safely open ownership lock path ${lockPath}`,
      { cause: error },
    );
  }
}

/**
 * Acquires independent locks for both shared integrations. Kernel flock
 * lifetime—not timestamps or PIDs—determines live ownership across aliases,
 * process namespaces, and runtime roots on the same host-visible filesystem.
 */
export async function acquireProjectOwnership(
  coordinationRoot: string,
  identity: ProjectIntegrationIdentity,
  expectedNamespaceId: string,
): Promise<ProjectOwnershipLease> {
  if (!expectedNamespaceId.trim()) {
    throw new ProjectOwnershipError(
      "Expected coordination namespace ID is required",
    );
  }
  assertSafeDirectory(coordinationRoot);
  const root = path.resolve(coordinationRoot);
  const namespace = readNamespaceMarker(root);
  if (namespace.namespaceId !== expectedNamespaceId) {
    throw new ProjectOwnershipError(
      `Coordination namespace identity mismatch: expected ${expectedNamespaceId}, found ${namespace.namespaceId}`,
    );
  }
  const held: KernelLock[] = [];
  let state: "held" | "releasing" | "released" | "lost" = "held";
  let releasePromise: Promise<void> | undefined;
  try {
    for (const key of resourceKeys(identity)) {
      const lockPath = path.join(root, `${key}.lock`);
      const metadataPath = path.join(root, `${key}.owner.json`);
      const lock = await acquireKernelLock(lockPath);
      try {
        const previous = readOwnerRecord(metadataPath);
        if (
          previous !== undefined &&
          (previous.device !== lock.device ||
            previous.inode !== lock.inode ||
            previous.namespaceId !== namespace.namespaceId)
        ) {
          throw new ProjectOwnershipError(
            `Ownership record does not match the current lock inode or namespace; evidence preserved at ${metadataPath}`,
          );
        }
        const record: OwnerRecord = {
          version: 1,
          identity: JSON.stringify({
            trelloBoardId: identity.trelloBoardId.trim(),
            githubRepository: canonicalizeGitHubRepository(
              identity.githubRepository,
            ),
          }),
          hostname: os.hostname(),
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          device: lock.device,
          inode: lock.inode,
          namespaceId: namespace.namespaceId,
        };
        persistOwner(metadataPath, record);
        held.push(lock);
      } catch (error) {
        await releaseKernelLock(lock);
        throw error;
      }
    }
  } catch (error) {
    state = "releasing";
    await Promise.all(held.reverse().map(releaseKernelLock));
    state = "released";
    throw error;
  }

  return {
    identity: {
      trelloBoardId: identity.trelloBoardId.trim(),
      githubRepository: canonicalizeGitHubRepository(identity.githubRepository),
    },
    assertHeld() {
      const lost = held.some((lock) => {
        try {
          const descriptorStat = fs.fstatSync(lock.descriptor);
          const stat = fs.lstatSync(lock.lockPath);
          return (
            descriptorStat.dev !== lock.device ||
            descriptorStat.ino !== lock.inode ||
            stat.isSymbolicLink() ||
            stat.dev !== lock.device ||
            stat.ino !== lock.inode
          );
        } catch {
          return true;
        }
      });
      if (state !== "held" || lost) {
        state = "lost";
        throw new ProjectOwnershipError(
          "Host kernel ownership is no longer held; project execution must stop",
        );
      }
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      state = "releasing";
      releasePromise = Promise.all(held.reverse().map(releaseKernelLock)).then(
        () => {
          state = "released";
        },
      );
      return releasePromise;
    },
  };
}

function releaseKernelLock(lock: KernelLock): Promise<void> {
  try {
    fs.closeSync(lock.descriptor);
  } catch {
    // An already-closed descriptor does not keep a kernel lock alive.
  }
  return Promise.resolve();
}
