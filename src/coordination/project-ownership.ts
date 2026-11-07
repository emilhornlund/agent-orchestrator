import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { canonicalizeGitHubRepository } from "../config/config.js";
import {
  beginProcessEvidence,
  drainProcessGroup,
  ProcessExecutionError,
  getProcessRuntime,
  signalProcessGroup,
} from "../process/process-runtime.js";

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
  readonly instanceId: string;
  readonly token: string;
  assertHeld(): void;
  markProcessGroupAmbiguous(
    pid: number | undefined,
    artifactRefs?: readonly string[],
  ): void;
  release(): Promise<void>;
}

interface AmbiguityMarker {
  version: 1;
  identity: string;
  processGroup: number | null;
  hostname: string;
  bootId: string | null;
  pidNamespace: string | null;
  artifacts: readonly string[];
  recordedAt: string;
}

function ambiguityPath(root: string, key: string): string {
  return path.join(root, `${key}.ambiguity.json`);
}

function publishAmbiguityMarker(
  root: string,
  key: string,
  record: AmbiguityMarker,
): void {
  const destination = ambiguityPath(root, key);
  let fd: number;
  let created = false;
  try {
    fd = fs.openSync(
      destination,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = fs.openSync(
      destination,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile())
      throw new ProjectOwnershipError("Unsafe ambiguity marker");
    assertProtectedFile(stat, destination);
    if (!created) {
      const pathStat = fs.lstatSync(destination);
      if (
        pathStat.isSymbolicLink() ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino
      )
        throw new ProjectOwnershipError(
          "Ambiguity marker changed during validation",
        );
      const value = JSON.parse(
        fs.readFileSync(fd, "utf8"),
      ) as Partial<AmbiguityMarker>;
      if (value.version !== 1 || value.identity !== record.identity)
        throw new ProjectOwnershipError(
          "Existing ambiguity marker has a different identity",
        );
    } else {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directory = fs.openSync(root, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function assertNoAmbiguity(root: string, keys: readonly string[]): void {
  for (const key of keys) {
    const file = ambiguityPath(root, key);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("unsafe marker");
      assertProtectedFile(stat, file);
      const value = JSON.parse(
        fs.readFileSync(file, "utf8"),
      ) as Partial<AmbiguityMarker>;
      if (value.version !== 1 || typeof value.identity !== "string")
        throw new Error("malformed marker");
      throw new ProjectOwnershipError(
        `Project integration is blocked by unresolved process-group termination ambiguity; marker: ${file}. Preserve evidence and obtain operator verification that the recorded process group cannot execute before any recovery.`,
      );
    } catch (error) {
      if (error instanceof ProjectOwnershipError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ProjectOwnershipError(
          `Unsafe or malformed process ambiguity marker preserved at ${file}`,
          { cause: error },
        );
    }
  }
}

/** Runs a short host-wide registry transaction under a kernel flock. */
export async function withProjectRegistryLock<T>(
  coordinationRoot: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  assertSafeDirectory(coordinationRoot);
  const lock = await acquireKernelLock(
    path.join(path.resolve(coordinationRoot), ".projects-registry.lock"),
    true,
  );
  try {
    return await operation();
  } finally {
    await releaseKernelLock(lock);
  }
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
  execution: ReturnType<typeof beginProcessEvidence>;
}

async function acquireKernelLock(
  lockPath: string,
  wait = false,
): Promise<KernelLock> {
  const descriptor = openLockFile(lockPath);
  let execution: ReturnType<typeof beginProcessEvidence>;
  try {
    execution = beginProcessEvidence(
      `flock ${wait ? "wait" : "nonblocking"} ${lockPath}`,
      process.cwd(),
      getProcessRuntime().secretValues,
    );
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
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
    execution.finish("spawn-failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  let child: ChildProcess;
  try {
    child = spawn("flock", [...(wait ? [] : ["-n"]), "3"], {
      stdio: ["ignore", "ignore", "pipe", descriptor],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    fs.closeSync(descriptor);
    execution.finish("spawn-failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ProjectOwnershipError(
      "Could not start host kernel locking utility (flock)",
      {
        cause: error,
      },
    );
  }
  const runtime = getProcessRuntime();
  try {
    await new Promise<void>((resolve, reject) => {
      let cancellation: "timeout" | "interrupted" | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (forceKill !== undefined) clearTimeout(forceKill);
        runtime.signal?.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        if (cancellation !== undefined) return;
        cancellation = "interrupted";
        signalProcessGroup(child.pid, "SIGTERM", (signal) =>
          child.kill(signal),
        );
        forceKill = setTimeout(
          () =>
            signalProcessGroup(child.pid, "SIGKILL", (signal) =>
              child.kill(signal),
            ),
          100,
        );
      };
      const timer = setTimeout(() => {
        if (cancellation !== undefined) return;
        cancellation = "timeout";
        signalProcessGroup(child.pid, "SIGTERM", (signal) =>
          child.kill(signal),
        );
        forceKill = setTimeout(
          () =>
            signalProcessGroup(child.pid, "SIGKILL", (signal) =>
              child.kill(signal),
            ),
          100,
        );
      }, runtime.operationTimeoutMilliseconds);
      runtime.signal?.addEventListener("abort", abort, { once: true });
      if (runtime.signal?.aborted) abort();
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        execution.append("stderr", chunk);
      });
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", async (code, signal) => {
        cleanup();
        try {
          await drainProcessGroup(child.pid, (name) => child.kill(name));
        } catch (error) {
          reject(error);
          return;
        }
        try {
          if (spawnError !== undefined) {
            execution.finish("spawn-failure", { error: spawnError.message });
            reject(
              new ProcessExecutionError(
                "flock",
                execution.executionId,
                "spawn-failure",
              ),
            );
          } else if (code === 0) {
            if (execution.failure !== undefined) {
              reject(execution.failure);
              return;
            }
            execution.finish("lock-acquired", {
              exitCode: 0,
              ...(signal === null ? {} : { signal }),
            });
            resolve();
          } else {
            const status =
              cancellation ?? (code === 1 ? "lock-contended" : "nonzero");
            execution.finish(status, {
              exitCode: code ?? 1,
              ...(signal === null ? {} : { signal }),
            });
            reject(
              cancellation === undefined
                ? new ProjectOwnershipError(
                    code === 1
                      ? `Project integration ownership is already held (${lockPath})`
                      : new ProcessExecutionError(
                          "flock",
                          execution.executionId,
                          "nonzero",
                          code ?? 1,
                          signal ?? undefined,
                        ).message,
                  )
                : new ProcessExecutionError(
                    "flock",
                    execution.executionId,
                    cancellation,
                    code ?? 1,
                    signal ?? undefined,
                  ),
            );
          }
        } catch (error) {
          reject(error);
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
      execution,
    };
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the acquisition failure; descriptor cleanup was attempted.
    }
    try {
      execution.finish("acquisition-failure", {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Preserve the original error and never let evidence failure escape cleanup.
    }
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
  const keys = resourceKeys(identity);
  assertNoAmbiguity(root, keys);
  let state: "held" | "releasing" | "released" | "lost" = "held";
  let ambiguityObserved = false;
  const durableAmbiguityKeys = new Set<string>();
  let fenceRetry: NodeJS.Timeout | undefined;
  let fenceRecord: AmbiguityMarker | undefined;
  let fenceWarningReported = false;
  let releasePromise: Promise<void> | undefined;
  try {
    for (const key of keys) {
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
    instanceId: `${os.hostname()}:${process.pid}:${randomUUID()}`,
    token: randomUUID(),
    assertHeld() {
      assertNoAmbiguity(root, keys);
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
    markProcessGroupAmbiguous(pid, artifacts = []) {
      // Fail closed before touching the filesystem. If either marker cannot be
      // durably published, release must retain both kernel locks.
      ambiguityObserved = true;
      state = "lost";
      const record: AmbiguityMarker = {
        version: 1,
        identity: JSON.stringify({
          trelloBoardId: identity.trelloBoardId.trim(),
          githubRepository: canonicalizeGitHubRepository(
            identity.githubRepository,
          ),
        }),
        processGroup: pid ?? null,
        hostname: os.hostname(),
        bootId: (() => {
          try {
            return fs
              .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
              .trim();
          } catch {
            return null;
          }
        })(),
        pidNamespace: (() => {
          try {
            return fs.readlinkSync("/proc/self/ns/pid");
          } catch {
            return null;
          }
        })(),
        artifacts,
        recordedAt: new Date().toISOString(),
      };
      fenceRecord = record;
      let persistenceFailure: unknown;
      for (const key of keys) {
        try {
          publishAmbiguityMarker(root, key, record);
          durableAmbiguityKeys.add(key);
        } catch (error) {
          persistenceFailure ??= error;
        }
      }
      if (durableAmbiguityKeys.size !== keys.length) {
        if (!fenceWarningReported) {
          fenceWarningReported = true;
          process.stderr.write(
            "OPERATOR REQUIRED: ambiguous process termination could not be durably fenced; service remains alive holding project ownership. Verify process termination and coordination storage before recovery.\n",
          );
        }
        // Keep a referenced handle alive, and continue one bounded publication
        // attempt per interval. Locks are never released until every fence is
        // durably synced. SIGKILL or host failure can still end this guarantee.
        if (fenceRetry === undefined) {
          fenceRetry = setInterval(() => {
            for (const key of keys) {
              if (durableAmbiguityKeys.has(key)) continue;
              try {
                publishAmbiguityMarker(root, key, fenceRecord!);
                durableAmbiguityKeys.add(key);
              } catch {
                // Retain locks and retry later; the initial sanitized warning
                // is the sole alert for this publication episode.
              }
            }
            if (durableAmbiguityKeys.size === keys.length && fenceRetry) {
              clearInterval(fenceRetry);
              fenceRetry = undefined;
            }
          }, 1_000);
        }
        throw persistenceFailure;
      }
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      if (
        ambiguityObserved &&
        keys.some((key) => !durableAmbiguityKeys.has(key))
      )
        return Promise.reject(
          new ProjectOwnershipError(
            "Process-group ambiguity markers are not durably present for every leased resource; ownership locks are retained",
          ),
        );
      if (fenceRetry !== undefined) {
        clearInterval(fenceRetry);
        fenceRetry = undefined;
      }
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
    lock.execution.finish("lock-released", { lockPath: lock.lockPath });
  } catch {
    // An already-closed descriptor does not keep a kernel lock alive.
  }
  return Promise.resolve();
}
