import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { getPreparedConflictStateDirectory } from "./prepared-conflict-state.js";
import { getReconciliationBlockStateDirectory } from "./reconciliation-block-storage.js";
import { getReviewMaintenanceStateDirectory } from "./review-maintenance-state.js";

const cardStateTemporaryFilePattern = /^.+\.json\.([1-9]\d*)\.tmp$/;
const reconciliationBlockTemporaryFilePattern =
  /^\.reconciliation-block\.json\.([1-9]\d*)\.[a-z0-9]+$/;

type WriterProcessStatus = "active" | "stopped" | "unknown";

function getFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(action: string, filePath: string, error: unknown): void {
  try {
    logger.warn(
      `Persisted-state temporary-file cleanup could not ${action} ${filePath}: ${getFailureReason(error)}`,
    );
  } catch {
    // A logging failure must not stop cleanup from processing other projects.
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

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function readManagedDirectory(directoryPath: string): fs.Dirent[] | undefined {
  const parsedPath = path.parse(directoryPath);
  let currentPath = parsedPath.root;

  for (const component of path
    .relative(parsedPath.root, directoryPath)
    .split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);

    let stats: fs.Stats | undefined;

    try {
      stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    } catch (error) {
      if (!isMissingPathError(error)) {
        reportFailure("inspect", currentPath, error);
      }

      return undefined;
    }

    if (stats === undefined) {
      return undefined;
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return undefined;
    }
  }

  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("scan", directoryPath, error);
    }

    return undefined;
  }
}

function getWriterProcessStatus(
  processId: number,
  filePath: string,
): WriterProcessStatus {
  if (processId === process.pid) {
    return "active";
  }

  try {
    process.kill(processId, 0);
    return "active";
  } catch (error) {
    const errorCode = getErrorCode(error);

    if (errorCode === "ESRCH") {
      return "stopped";
    }

    // Permission denied proves that the process exists. Other failures leave
    // ownership uncertain, so preserve the candidate and report the reason.
    if (errorCode === "EPERM") {
      return "active";
    }

    reportFailure("inspect", filePath, error);
    return "unknown";
  }
}

function removeStaleCandidate(filePath: string, processId: number): void {
  let stats: fs.Stats | undefined;

  try {
    stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("inspect", filePath, error);
    }

    return;
  }

  if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) {
    return;
  }

  const processStatus = getWriterProcessStatus(processId, filePath);

  if (processStatus !== "stopped") {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("remove", filePath, error);
    }
  }
}

function cleanupDirectory(
  directoryPath: string,
  filenamePattern: RegExp,
): void {
  const entries = readManagedDirectory(directoryPath);

  if (entries === undefined) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = filenamePattern.exec(entry.name);

    if (match === null) {
      continue;
    }

    const processId = Number(match[1]);

    if (!Number.isSafeInteger(processId)) {
      reportFailure(
        "inspect",
        path.join(directoryPath, entry.name),
        new Error(
          `writer process ID is outside the safe integer range: ${match[1]}`,
        ),
      );
      continue;
    }

    removeStaleCandidate(path.join(directoryPath, entry.name), processId);
  }
}

function cleanupProjectPersistedStateTemporaryFiles(
  project: ProjectConfig,
  contextRoot: string,
): void {
  const directories = [
    {
      getPath: () => getReviewMaintenanceStateDirectory(project),
      pattern: cardStateTemporaryFilePattern,
    },
    {
      getPath: () => getPreparedConflictStateDirectory(project),
      pattern: cardStateTemporaryFilePattern,
    },
    {
      getPath: () =>
        getReconciliationBlockStateDirectory(contextRoot, project.id),
      pattern: reconciliationBlockTemporaryFilePattern,
    },
  ];

  for (const directory of directories) {
    let directoryPath: string;

    try {
      directoryPath = directory.getPath();
    } catch (error) {
      reportFailure("inspect", `${project.id} persisted state`, error);
      continue;
    }

    try {
      cleanupDirectory(directoryPath, directory.pattern);
    } catch (error) {
      reportFailure("scan", directoryPath, error);
    }
  }
}

/**
 * Removes only interrupted atomic-write files for the configured projects.
 * Authoritative state, unknown entries, and active writer files are retained.
 */
export function cleanupPersistedStateTemporaryFiles(
  projects: readonly ProjectConfig[],
  contextRoot: string,
): void {
  for (const project of projects) {
    try {
      cleanupProjectPersistedStateTemporaryFiles(project, contextRoot);
    } catch (error) {
      reportFailure("scan", `project ${project.id} persisted state`, error);
    }
  }
}
