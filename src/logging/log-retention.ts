import fs from "node:fs";
import path from "node:path";

import { isActiveLogFile } from "./active-log-files.js";
import { getLoggerRuntimeRoot, logger } from "./logger.js";
import { isConclusiveOperationResolution, parseRunRecord } from "../task-session/run-record.js";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const dailyLogFilePattern = /^(?:test-)?orchestrator-\d{4}-\d{2}-\d{2}\.log$/;
const sessionLogFilePattern = /^.+\.log$/;

export const logRetentionIntervalMilliseconds = millisecondsPerDay;

function getFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(action: string, filePath: string, error: unknown): void {
  try {
    logger.warn(`Log retention could not ${action} ${filePath}: ${getFailureReason(error)}`);
  } catch {
    // A logging failure must not stop retention from processing other files.
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readManagedDirectory(directoryPath: string): fs.Dirent[] | undefined {
  let directoryStats: fs.Stats;

  try {
    directoryStats = fs.lstatSync(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    reportFailure("scan", directoryPath, error);
    return undefined;
  }

  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    return undefined;
  }

  try {
    return fs.readdirSync(directoryPath, {
      withFileTypes: true,
    });
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("scan", directoryPath, error);
    }

    return undefined;
  }
}

function hasSafeAncestors(absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of path.relative(parsed.root, resolved).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) return false;
      if (!stats.isDirectory()) return false;
    } catch (error) {
      if (isMissingPathError(error)) return true;
      reportFailure("inspect", current, error);
      return false;
    }
  }
  return true;
}

function removeIfExpired(filePath: string, cutoffMilliseconds: number): void {
  if (isActiveLogFile(filePath)) {
    return;
  }

  let fileStats: fs.Stats;

  try {
    fileStats = fs.lstatSync(filePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("inspect", filePath, error);
    }

    return;
  }

  if (
    fileStats.isSymbolicLink() ||
    !fileStats.isFile() ||
    fileStats.mtimeMs >= cutoffMilliseconds ||
    isActiveLogFile(filePath)
  ) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    reportFailure("remove", filePath, error);
  }
}

function scanSessionLogs(
  sessionsDirectory: string,
  cutoffMilliseconds: number,
  protectedPaths: ReadonlySet<string>,
): void {
  const projectDirectories = readManagedDirectory(sessionsDirectory);

  if (projectDirectories === undefined) {
    return;
  }

  for (const projectDirectory of projectDirectories) {
    if (projectDirectory.isSymbolicLink() || !projectDirectory.isDirectory()) {
      continue;
    }

    const projectDirectoryPath = path.join(sessionsDirectory, projectDirectory.name);
    const sessionFiles = readManagedDirectory(projectDirectoryPath);

    if (sessionFiles === undefined) {
      continue;
    }

    for (const sessionFile of sessionFiles) {
      if (
        sessionFile.isSymbolicLink() ||
        !sessionFile.isFile() ||
        !sessionLogFilePattern.test(sessionFile.name)
      ) {
        continue;
      }

      const filePath = path.join(projectDirectoryPath, sessionFile.name);
      if (!protectedPaths.has(path.resolve(filePath)))
        removeIfExpired(filePath, cutoffMilliseconds);
    }
  }
}

function legacySessionPath(root: string, projectId: string, cardId: string): string | undefined {
  if (
    !projectId ||
    !cardId ||
    projectId === "." ||
    projectId === ".." ||
    cardId === "." ||
    cardId === ".."
  )
    return undefined;
  const safePart = (value: string) =>
    value.replace(/[^a-zA-Z0-9._-]/g, (character) => `_${character.codePointAt(0)!.toString(16)}_`);
  return path.resolve(root, "sessions", safePart(projectId), `${safePart(cardId)}.log`);
}

const terminalProcessStatuses = new Set([
  "success",
  "nonzero",
  "timeout",
  "interrupted",
  "spawn-failure",
  "evidence-failure",
  "lock-acquired",
  "lock-contended",
  "lock-released",
  "acquisition-failure",
]);

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function scanProcessExecutions(
  runtimeRoot: string,
  cutoff: number,
  protectedPaths: ReadonlySet<string>,
): void {
  const directory = path.join(runtimeRoot, "process-executions");
  for (const entry of readManagedDirectory(directory) ?? []) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const executionDirectory = path.join(directory, entry.name);
    try {
      const metadataPath = path.join(executionDirectory, "execution.json");
      const stats = fs.lstatSync(metadataPath);
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      const metadata: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!metadata || typeof metadata !== "object") continue;
      const value = metadata as {
        executionId?: unknown;
        status?: unknown;
        startedAt?: unknown;
        finishedAt?: unknown;
        stdoutArtifact?: unknown;
        stderrArtifact?: unknown;
      };
      // Unknown outcomes or incomplete identity/timing are not deletion proof.
      if (
        value.executionId !== entry.name ||
        !/^[A-Za-z0-9_-]+$/.test(entry.name) ||
        typeof value.status !== "string" ||
        !terminalProcessStatuses.has(value.status) ||
        !isValidTimestamp(value.startedAt) ||
        !isValidTimestamp(value.finishedAt) ||
        Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
        typeof value.stdoutArtifact !== "string" ||
        typeof value.stderrArtifact !== "string" ||
        path.resolve(value.stdoutArtifact) !== path.join(executionDirectory, "stdout.txt") ||
        path.resolve(value.stderrArtifact) !== path.join(executionDirectory, "stderr.txt")
      )
        continue;
      if (
        Date.parse(value.finishedAt) >= cutoff ||
        stats.mtimeMs >= cutoff ||
        [...protectedPaths].some((reference) => isWithin(executionDirectory, reference))
      )
        continue;
      const files = readManagedDirectory(executionDirectory);
      if (!files || files.some((file) => file.isSymbolicLink() || !file.isFile())) continue;
      fs.rmSync(executionDirectory, { recursive: true, force: false });
    } catch (error) {
      if (!isMissingPathError(error)) reportFailure("inspect", executionDirectory, error);
    }
  }
}

export function cleanupLogRetention(
  retentionDays: number,
  now = new Date(),
  runtimeRoots: readonly string[] = [],
  protectedAttemptIds: readonly string[] = [],
): void {
  const cutoffMilliseconds = now.getTime() - retentionDays * millisecondsPerDay;
  const effectiveRoots = runtimeRoots.length ? runtimeRoots : [getLoggerRuntimeRoot()];
  const roots = [
    ...new Set([
      path.join(process.cwd(), "logs"),
      ...effectiveRoots.map((root) => path.join(root, "orchestrator-logs")),
    ]),
  ];
  const protectedPaths = new Set<string>();
  const protectedIds = new Set(protectedAttemptIds);
  const unsafeRoots = new Set<string>();
  let inventoryIsUncertain = false;
  let hasActiveAttempt = false;
  // Inventory every root before deleting anything: references may cross roots.
  for (const runtimeRoot of effectiveRoots) {
    if (!hasSafeAncestors(runtimeRoot)) {
      unsafeRoots.add(runtimeRoot);
      inventoryIsUncertain = true;
      continue;
    }
    const attemptsPath = path.join(runtimeRoot, "attempts");
    let attempts: fs.Dirent[] | undefined;
    try {
      const s = fs.lstatSync(attemptsPath);
      if (s.isSymbolicLink() || !s.isDirectory()) {
        unsafeRoots.add(runtimeRoot);
        inventoryIsUncertain = true;
        continue;
      }
      attempts = fs.readdirSync(attemptsPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      unsafeRoots.add(runtimeRoot);
      inventoryIsUncertain = true;
      continue;
    }
    for (const entry of attempts) {
      if (!entry.name.endsWith(".json")) continue;
      const file = path.join(attemptsPath, entry.name),
        id = entry.name.slice(0, -5);
      try {
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("unsupported attempt entry");
        const record = parseRunRecord(JSON.parse(fs.readFileSync(file, "utf8")));
        if (record.attemptId !== id) throw new Error("attempt filename identity mismatch");
        const terminal =
          ["done", "refined", "failed", "cancelled"].includes(record.lifecycle) &&
          record.terminalSync === "verified" &&
          record.terminalEvidence !== null &&
          record.pendingOperations.every(isConclusiveOperationResolution);
        // Record artifacts are content-addressed state referenced by the
        // durable run envelope, including after the run becomes terminal.
        for (const artifact of record.artifacts)
          if (path.isAbsolute(artifact.path)) protectedPaths.add(path.resolve(artifact.path));
        if (!terminal || protectedIds.has(id)) {
          hasActiveAttempt ||= !terminal;
          protectedIds.add(id);
          for (const resource of record.resources)
            if (path.isAbsolute(resource.path)) protectedPaths.add(path.resolve(resource.path));
          for (const session of Object.values(record.sessions))
            if (path.isAbsolute(session)) protectedPaths.add(path.resolve(session));
          if (!terminal) {
            for (const root of [process.cwd(), ...effectiveRoots]) {
              const legacy = legacySessionPath(
                path.join(root, "logs"),
                record.projectId,
                record.cardId,
              );
              if (legacy) protectedPaths.add(legacy);
            }
          }
        }
      } catch {
        unsafeRoots.add(runtimeRoot);
        inventoryIsUncertain = true;
      }
    }
  }
  // A malformed owner can hide cross-root references. In that case no
  // retention deletion is safe, including legacy logs/sessions.
  if (inventoryIsUncertain) return;
  if (roots.some((root) => !hasSafeAncestors(root))) return;
  for (const runtimeRoot of effectiveRoots)
    scanProcessExecutions(runtimeRoot, cutoffMilliseconds, protectedPaths);
  for (const runtimeRoot of effectiveRoots) {
    if (unsafeRoots.has(runtimeRoot)) continue;
    const candidates: string[] = [];
    const walk = (directory: string, depth: number): void => {
      if (depth > 12) {
        unsafeRoots.add(runtimeRoot);
        return;
      }
      const entries = readManagedDirectory(directory);
      if (entries === undefined) return;
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          unsafeRoots.add(runtimeRoot);
          continue;
        }
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(target, depth + 1);
          continue;
        }
        if (
          !entry.isFile() ||
          protectedPaths.has(path.resolve(target)) ||
          [...protectedIds].some((id) => target.includes(id))
        )
          continue;
        candidates.push(target);
      }
    };
    walk(path.join(runtimeRoot, "history"), 0);
    walk(path.join(runtimeRoot, "artifacts"), 0);
    if (!unsafeRoots.has(runtimeRoot))
      for (const candidate of candidates) removeIfExpired(candidate, cutoffMilliseconds);
  }
  for (const logsDirectory of roots) {
    const logEntries = readManagedDirectory(logsDirectory);

    if (logEntries === undefined) continue;

    for (const logEntry of logEntries) {
      if (logEntry.isSymbolicLink()) {
        continue;
      }

      if (logEntry.isFile() && dailyLogFilePattern.test(logEntry.name)) {
        if (!hasActiveAttempt)
          removeIfExpired(path.join(logsDirectory, logEntry.name), cutoffMilliseconds);
        continue;
      }

      if (logEntry.isFile() && logEntry.name === "execution.json") {
        removeIfExpired(path.join(logsDirectory, logEntry.name), cutoffMilliseconds);
        continue;
      }

      if (logEntry.isDirectory() && logEntry.name === "sessions") {
        scanSessionLogs(
          path.join(logsDirectory, logEntry.name),
          cutoffMilliseconds,
          protectedPaths,
        );
      }
    }
  }
}
