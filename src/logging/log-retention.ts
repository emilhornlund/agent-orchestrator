import fs from "node:fs";
import path from "node:path";

import { isActiveLogFile } from "./active-log-files.js";
import { logger } from "./logger.js";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const dailyLogFilePattern = /^(?:test-)?orchestrator-\d{4}-\d{2}-\d{2}\.log$/;
const sessionLogFilePattern = /^.+\.log$/;

export const logRetentionIntervalMilliseconds = millisecondsPerDay;

function getFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(action: string, filePath: string, error: unknown): void {
  try {
    logger.warn(
      `Log retention could not ${action} ${filePath}: ${getFailureReason(error)}`,
    );
  } catch {
    // A logging failure must not stop retention from processing other files.
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
): void {
  const projectDirectories = readManagedDirectory(sessionsDirectory);

  if (projectDirectories === undefined) {
    return;
  }

  for (const projectDirectory of projectDirectories) {
    if (projectDirectory.isSymbolicLink() || !projectDirectory.isDirectory()) {
      continue;
    }

    const projectDirectoryPath = path.join(
      sessionsDirectory,
      projectDirectory.name,
    );
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

      removeIfExpired(
        path.join(projectDirectoryPath, sessionFile.name),
        cutoffMilliseconds,
      );
    }
  }
}

export function cleanupLogRetention(
  retentionDays: number,
  now = new Date(),
): void {
  const cutoffMilliseconds = now.getTime() - retentionDays * millisecondsPerDay;
  const logsDirectory = path.join(process.cwd(), "logs");
  const logEntries = readManagedDirectory(logsDirectory);

  if (logEntries === undefined) {
    return;
  }

  for (const logEntry of logEntries) {
    if (logEntry.isSymbolicLink()) {
      continue;
    }

    if (logEntry.isFile() && dailyLogFilePattern.test(logEntry.name)) {
      removeIfExpired(
        path.join(logsDirectory, logEntry.name),
        cutoffMilliseconds,
      );
      continue;
    }

    if (logEntry.isDirectory() && logEntry.name === "sessions") {
      scanSessionLogs(
        path.join(logsDirectory, logEntry.name),
        cutoffMilliseconds,
      );
    }
  }
}
