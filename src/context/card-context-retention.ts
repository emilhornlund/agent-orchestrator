import fs from "node:fs";
import path from "node:path";

import { isActiveCardContext } from "./active-card-context.js";
import { logger } from "../logging/logger.js";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const descriptorPathRoot =
  process.platform === "linux"
    ? "/proc/self/fd"
    : process.platform === "darwin"
      ? "/dev/fd"
      : undefined;

export const contextRetentionIntervalMilliseconds = millisecondsPerDay;

function getFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(action: string, filePath: string, error: unknown): void {
  try {
    logger.error(
      `Card context retention could not ${action} ${filePath}: ${getFailureReason(error)}`,
    );
  } catch {
    // A logging failure must not stop retention from processing other paths.
  }
}

function reportRemoval(
  projectId: string,
  cardId: string,
  directoryPath: string,
): void {
  try {
    logger
      .child({ projectId, cardId })
      .info(`Removed expired card context directory ${directoryPath}`);
  } catch {
    // A logging failure must not stop retention from processing other paths.
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

function isBelowRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeContextRoot(contextRoot: string): string | undefined {
  if (typeof contextRoot !== "string" || contextRoot.trim().length === 0) {
    reportFailure(
      "scan",
      String(contextRoot),
      new Error("context root must be a non-blank absolute path"),
    );
    return undefined;
  }

  if (!path.isAbsolute(contextRoot)) {
    reportFailure(
      "scan",
      contextRoot,
      new Error("context root must be an absolute path"),
    );
    return undefined;
  }

  return path.resolve(contextRoot);
}

function getDirectoryOpenFlags(): number | undefined {
  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = fs.constants;

  if (
    descriptorPathRoot === undefined ||
    O_DIRECTORY === undefined ||
    O_NOFOLLOW === undefined
  ) {
    return undefined;
  }

  return O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
}

function descriptorPath(descriptor: number, child?: string): string {
  const parentPath = path.join(descriptorPathRoot ?? "", String(descriptor));

  return child === undefined ? parentPath : path.join(parentPath, child);
}

function closeDescriptor(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    reportFailure("close", String(descriptor), error);
  }
}

function openDirectoryChain(directoryPath: string): number | undefined {
  const flags = getDirectoryOpenFlags();

  if (flags === undefined) {
    reportFailure(
      "remove",
      directoryPath,
      new Error(
        "safe descriptor-based removal is not supported on this platform",
      ),
    );
    return undefined;
  }

  const parsedPath = path.parse(directoryPath);
  let descriptor: number | undefined;

  try {
    descriptor = fs.openSync(parsedPath.root, flags);

    for (const component of path
      .relative(parsedPath.root, directoryPath)
      .split(path.sep)) {
      if (component.length === 0) {
        continue;
      }

      const nextDescriptor = fs.openSync(
        descriptorPath(descriptor, component),
        flags,
      );
      closeDescriptor(descriptor);
      descriptor = nextDescriptor;
    }

    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      closeDescriptor(descriptor);
    }

    reportFailure("inspect", directoryPath, error);
    return undefined;
  }
}

function openDirectoryEntry(
  parentDescriptor: number,
  entryName: string,
  directoryPath: string,
): number | undefined {
  const flags = getDirectoryOpenFlags();

  if (flags === undefined) {
    return undefined;
  }

  try {
    return fs.openSync(descriptorPath(parentDescriptor, entryName), flags);
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("inspect", directoryPath, error);
    }

    return undefined;
  }
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

function inspectRemovalTree(directoryPath: string): boolean {
  const entries = readManagedDirectory(directoryPath);

  if (entries === undefined) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.resolve(directoryPath, entry.name);

    if (!isBelowRoot(directoryPath, entryPath)) {
      reportFailure(
        "inspect",
        entryPath,
        new Error(`path is outside card context directory "${directoryPath}"`),
      );
      return false;
    }

    if (entry.isSymbolicLink()) {
      return false;
    }

    let entryStats: fs.Stats;

    try {
      entryStats = fs.lstatSync(entryPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }

      reportFailure("inspect", entryPath, error);
      return false;
    }

    if (entryStats.isSymbolicLink()) {
      return false;
    }

    if (entryStats.isDirectory() && !inspectRemovalTree(entryPath)) {
      return false;
    }
  }

  return true;
}

function removeIfExpired(
  projectId: string,
  cardId: string,
  directoryPath: string,
  cutoffMilliseconds: number,
  contextRootDescriptor: number,
): void {
  if (isActiveCardContext(projectId, cardId)) {
    return;
  }

  let directoryStats: fs.Stats;

  try {
    directoryStats = fs.lstatSync(directoryPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("inspect", directoryPath, error);
    }

    return;
  }

  if (
    directoryStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    directoryStats.mtimeMs >= cutoffMilliseconds ||
    isActiveCardContext(projectId, cardId)
  ) {
    return;
  }

  if (!inspectRemovalTree(directoryPath)) {
    return;
  }

  if (isActiveCardContext(projectId, cardId)) {
    return;
  }

  const projectDirectoryPath = path.dirname(directoryPath);
  const projectDescriptor = openDirectoryEntry(
    contextRootDescriptor,
    projectId,
    projectDirectoryPath,
  );

  if (projectDescriptor === undefined) {
    return;
  }

  try {
    fs.rmSync(descriptorPath(projectDescriptor, cardId), {
      recursive: true,
    });
    reportRemoval(projectId, cardId, directoryPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      reportFailure("remove", directoryPath, error);
    }
  } finally {
    closeDescriptor(projectDescriptor);
  }
}

function inspectContextRoot(contextRoot: string): boolean {
  const parsedPath = path.parse(contextRoot);
  let currentPath = parsedPath.root;

  for (const component of path
    .relative(parsedPath.root, contextRoot)
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
        reportFailure("scan", currentPath, error);
      }

      return false;
    }

    if (stats === undefined) {
      return false;
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return false;
    }
  }

  return true;
}

export function cleanupCardContextRetention(
  contextRoot: string,
  retentionDays: number,
  now = new Date(),
  projectIds?: readonly string[],
): void {
  const normalizedRoot = normalizeContextRoot(contextRoot);

  if (normalizedRoot === undefined || !inspectContextRoot(normalizedRoot)) {
    return;
  }

  const cutoffMilliseconds = now.getTime() - retentionDays * millisecondsPerDay;
  const configuredProjectIds =
    projectIds === undefined ? undefined : new Set(projectIds);
  const contextRootDescriptor = openDirectoryChain(normalizedRoot);

  if (contextRootDescriptor === undefined) {
    return;
  }

  const projectDirectories = readManagedDirectory(normalizedRoot);

  if (projectDirectories === undefined) {
    closeDescriptor(contextRootDescriptor);
    return;
  }

  try {
    for (const projectDirectory of projectDirectories) {
      if (
        projectDirectory.isSymbolicLink() ||
        !projectDirectory.isDirectory() ||
        (configuredProjectIds !== undefined &&
          !configuredProjectIds.has(projectDirectory.name))
      ) {
        continue;
      }

      const projectDirectoryPath = path.resolve(
        normalizedRoot,
        projectDirectory.name,
      );

      if (!isBelowRoot(normalizedRoot, projectDirectoryPath)) {
        reportFailure(
          "inspect",
          projectDirectoryPath,
          new Error(`path is outside context root "${normalizedRoot}"`),
        );
        continue;
      }

      const cardDirectories = readManagedDirectory(projectDirectoryPath);

      if (cardDirectories === undefined) {
        continue;
      }

      for (const cardDirectory of cardDirectories) {
        if (cardDirectory.isSymbolicLink() || !cardDirectory.isDirectory()) {
          continue;
        }

        const cardDirectoryPath = path.resolve(
          projectDirectoryPath,
          cardDirectory.name,
        );

        if (!isBelowRoot(normalizedRoot, cardDirectoryPath)) {
          reportFailure(
            "inspect",
            cardDirectoryPath,
            new Error(`path is outside context root "${normalizedRoot}"`),
          );
          continue;
        }

        removeIfExpired(
          projectDirectory.name,
          cardDirectory.name,
          cardDirectoryPath,
          cutoffMilliseconds,
          contextRootDescriptor,
        );
      }
    }
  } finally {
    closeDescriptor(contextRootDescriptor);
  }
}
