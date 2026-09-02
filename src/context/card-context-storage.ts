import fs from "node:fs";
import path from "node:path";

export interface CardContextPaths {
  contextDirectory: string;
  attachmentsDirectory: string;
  manifestPath: string;
}

function normalizeContextRoot(contextRoot: string): string {
  if (typeof contextRoot !== "string" || contextRoot.trim().length === 0) {
    throw new Error("Invalid context root: must be a non-blank absolute path");
  }

  if (!path.isAbsolute(contextRoot)) {
    throw new Error(
      `Invalid context root "${contextRoot}": must be an absolute path`,
    );
  }

  return path.resolve(contextRoot);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
}

function validatePathComponent(component: string, description: string): void {
  if (typeof component !== "string" || component.trim().length === 0) {
    throw new Error(
      `Invalid ${description} "${component}": must be a non-blank path component`,
    );
  }

  if (hasControlCharacter(component)) {
    throw new Error(
      `Invalid ${description} "${component}": control characters are not allowed`,
    );
  }

  if (
    component === "." ||
    component === ".." ||
    component.includes("/") ||
    component.includes("\\") ||
    path.isAbsolute(component) ||
    path.win32.isAbsolute(component) ||
    path.win32.parse(component).root.length > 0
  ) {
    throw new Error(
      `Invalid ${description} "${component}": must be a single relative path component without traversal or separators`,
    );
  }
}

function assertBelowRoot(
  root: string,
  candidate: string,
  description: string,
): void {
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Refusing ${description} outside context root "${root}": ${candidate}`,
    );
  }
}

function formatFilesystemError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectExistingDirectoryPath(
  targetPath: string,
  description: string,
): void {
  const parsedPath = path.parse(targetPath);
  let currentPath = parsedPath.root;

  const inspect = (): fs.Stats | undefined => {
    try {
      return fs.lstatSync(currentPath, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(
        `Unable to inspect ${description} path "${currentPath}": ${formatFilesystemError(error)}`,
        { cause: error },
      );
    }
  };

  let stat = inspect();

  if (stat === undefined) {
    return;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing symbolic-link ${description} path component "${currentPath}"`,
    );
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `Refusing non-directory ${description} path component "${currentPath}"`,
    );
  }

  const relativePath = path.relative(parsedPath.root, targetPath);

  for (const component of relativePath.split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);
    stat = inspect();

    if (stat === undefined) {
      return;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link ${description} path component "${currentPath}"`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(
        `Refusing non-directory ${description} path component "${currentPath}"`,
      );
    }
  }
}

function inspectExistingFilePath(
  targetPath: string,
  description: string,
): void {
  let stat: fs.Stats | undefined;

  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(
      `Unable to inspect ${description} path "${targetPath}": ${formatFilesystemError(error)}`,
      { cause: error },
    );
  }

  if (stat === undefined) {
    return;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing symbolic-link ${description} path "${targetPath}"`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(`Refusing non-file ${description} path "${targetPath}"`);
  }
}

function buildCardContextPaths(
  contextRoot: string,
  projectId: string,
  cardId: string,
): CardContextPaths {
  const normalizedRoot = normalizeContextRoot(contextRoot);
  validatePathComponent(projectId, "project ID");
  validatePathComponent(cardId, "card ID");

  const contextDirectory = path.resolve(normalizedRoot, projectId, cardId);
  const attachmentsDirectory = path.resolve(contextDirectory, "attachments");
  const manifestPath = path.resolve(contextDirectory, "attachments.json");

  assertBelowRoot(normalizedRoot, contextDirectory, "card context path");
  assertBelowRoot(
    normalizedRoot,
    attachmentsDirectory,
    "attachments directory",
  );
  assertBelowRoot(normalizedRoot, manifestPath, "manifest path");

  return {
    contextDirectory,
    attachmentsDirectory,
    manifestPath,
  };
}

export function resolveCardContextPaths(
  contextRoot: string,
  projectId: string,
  cardId: string,
): CardContextPaths {
  const paths = buildCardContextPaths(contextRoot, projectId, cardId);

  inspectExistingDirectoryPath(paths.contextDirectory, "card context");

  return paths;
}

export function resolveCardContextDirectory(
  contextRoot: string,
  projectId: string,
  cardId: string,
): string {
  return resolveCardContextPaths(contextRoot, projectId, cardId)
    .contextDirectory;
}

export function resolveCardAttachmentsDirectory(
  contextRoot: string,
  projectId: string,
  cardId: string,
): string {
  const paths = resolveCardContextPaths(contextRoot, projectId, cardId);

  inspectExistingDirectoryPath(paths.attachmentsDirectory, "attachments");

  return paths.attachmentsDirectory;
}

export function resolveCardAttachmentsManifestPath(
  contextRoot: string,
  projectId: string,
  cardId: string,
): string {
  const paths = buildCardContextPaths(contextRoot, projectId, cardId);

  inspectExistingDirectoryPath(paths.attachmentsDirectory, "attachments");
  inspectExistingFilePath(paths.manifestPath, "attachments manifest");

  return paths.manifestPath;
}

export function resolveCardAttachmentPath(
  contextRoot: string,
  projectId: string,
  cardId: string,
  filename: string,
): string {
  validatePathComponent(filename, "attachment filename");

  const attachmentsDirectory = resolveCardAttachmentsDirectory(
    contextRoot,
    projectId,
    cardId,
  );
  const attachmentPath = path.resolve(attachmentsDirectory, filename);

  assertBelowRoot(attachmentsDirectory, attachmentPath, "attachment path");
  inspectExistingFilePath(attachmentPath, "attachment");

  return attachmentPath;
}

function ensureDirectoryPath(targetPath: string, description: string): void {
  const parsedPath = path.parse(targetPath);
  let currentPath = parsedPath.root;

  const ensure = (): void => {
    let stat: fs.Stats | undefined;

    try {
      stat = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(
        `Unable to inspect ${description} path "${currentPath}": ${formatFilesystemError(error)}`,
        { cause: error },
      );
    }

    if (stat === undefined) {
      try {
        fs.mkdirSync(currentPath);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )) {
          throw new Error(
            `Unable to create ${description} directory "${currentPath}": ${formatFilesystemError(error)}`,
            { cause: error },
          );
        }
      }

      try {
        stat = fs.lstatSync(currentPath);
      } catch (error) {
        throw new Error(
          `Unable to verify created ${description} directory "${currentPath}": ${formatFilesystemError(error)}`,
          { cause: error },
        );
      }
    }

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link ${description} path component "${currentPath}"`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(
        `Refusing non-directory ${description} path component "${currentPath}"`,
      );
    }
  };

  ensure();

  const relativePath = path.relative(parsedPath.root, targetPath);

  for (const component of relativePath.split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);
    ensure();
  }
}

export function createCardContextDirectories(
  contextRoot: string,
  projectId: string,
  cardId: string,
): CardContextPaths {
  const paths = resolveCardContextPaths(contextRoot, projectId, cardId);

  ensureDirectoryPath(paths.contextDirectory, "card context");
  ensureDirectoryPath(paths.attachmentsDirectory, "attachments");
  inspectExistingFilePath(paths.manifestPath, "attachments manifest");

  return paths;
}

export const ensureCardContextDirectories = createCardContextDirectories;
