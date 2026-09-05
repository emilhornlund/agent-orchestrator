import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { FailureCategory } from "./failure-diagnostic.js";

export const RECONCILIATION_BLOCK_VERSION = 1;
export const RECONCILIATION_BLOCK_FILENAME = "reconciliation-block.json";

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});

const githubOperations = [
  "GitHub pull request",
  "GitHub pull request state",
  "GitHub requested changes",
  "GitHub maintenance state",
  "GitHub prepared conflict handoff",
] as const;

const trelloOperations = [
  "Trello card operation",
  "Trello board lookup",
  "Trello list lookup",
  "Trello label lookup",
  "Trello card lookup",
  "Trello card action lookup",
  "Trello transition history",
  "Trello card move",
  "Trello card content update",
  "Trello label update",
  "Trello comment",
  "Trello attachment metadata",
  "Trello attachment download",
] as const;

export type ReconciliationBlockOperation =
  (typeof githubOperations)[number] | (typeof trelloOperations)[number];

export type ReconciliationRecoveryCondition =
  "card-moved-to-ready" | "worker-restart";

export interface PersistedReconciliationBlock {
  version: typeof RECONCILIATION_BLOCK_VERSION;
  projectId: string;
  attemptKey: string;
  attempt: 3;
  operation: ReconciliationBlockOperation;
  cardId?: string;
  reconciliationListId?: string;
  failureCategory: FailureCategory;
  failureReason: string;
  recoveryCondition: ReconciliationRecoveryCondition;
  notificationIdentity: string;
  failureIdentity: string;
  handlingOutcome?: string;
  sessionLogPaths?: string[];
}

const persistedBlockSchema = z
  .strictObject({
    version: z.literal(RECONCILIATION_BLOCK_VERSION),
    projectId: nonBlankString,
    attemptKey: nonBlankString,
    attempt: z.literal(3),
    operation: z.enum([...githubOperations, ...trelloOperations]),
    cardId: nonBlankString.optional(),
    reconciliationListId: nonBlankString.optional(),
    failureCategory: z.enum([
      "OpenCode",
      "OpenCode permissions",
      "Setup",
      "Git/GitHub",
      "Workflow",
      "OpenCode timeout",
    ]),
    failureReason: nonBlankString,
    recoveryCondition: z.enum(["card-moved-to-ready", "worker-restart"]),
    notificationIdentity: nonBlankString,
    failureIdentity: nonBlankString,
    handlingOutcome: nonBlankString.optional(),
    sessionLogPaths: z.array(nonBlankString).optional(),
  })
  .superRefine((block, context) => {
    const isGitHub = block.operation.startsWith("GitHub ");

    if (
      block.cardId !== undefined &&
      !block.attemptKey.startsWith(`${block.cardId}:`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptKey"],
        message: "Attempt key must identify the recorded card",
      });
    }

    if (
      block.cardId === undefined &&
      !block.attemptKey.startsWith("project:")
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptKey"],
        message: "Cardless attempt key must identify the project",
      });
    }

    if (block.cardId === undefined) {
      if (isGitHub || block.recoveryCondition !== "worker-restart") {
        context.addIssue({
          code: "custom",
          path: ["cardId"],
          message:
            "Cardless reconciliation blocks must be Trello project blocks with worker-restart recovery",
        });
      }
    } else if (block.recoveryCondition !== "card-moved-to-ready") {
      context.addIssue({
        code: "custom",
        path: ["recoveryCondition"],
        message: "Known-card reconciliation blocks require card recovery",
      });
    }
  });

export type ReconciliationBlockLoadResult =
  | { status: "missing" }
  | { status: "loaded"; block: PersistedReconciliationBlock }
  | { status: "malformed"; error: Error };

function validatePersistedBlock(
  value: unknown,
  expectedProjectId?: string,
): PersistedReconciliationBlock {
  const result = persistedBlockSchema.safeParse(value);

  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }

  if (
    expectedProjectId !== undefined &&
    result.data.projectId !== expectedProjectId
  ) {
    throw new Error(
      `record projectId "${result.data.projectId}" does not match configured project "${expectedProjectId}"`,
    );
  }

  return result.data as PersistedReconciliationBlock;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function validatePathComponent(value: string, description: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid ${description}: must be a non-blank path component`,
    );
  }

  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.win32.parse(value).root.length > 0 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      );
    })
  ) {
    throw new Error(
      `Invalid ${description} "${value}": must be a single relative path component`,
    );
  }
}

function assertBelowRoot(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Refusing runtime storage path outside context root: ${candidate}`,
    );
  }
}

function inspectDirectory(directoryPath: string, description: string): void {
  const parsedPath = path.parse(directoryPath);
  let currentPath = parsedPath.root;

  for (const component of path
    .relative(parsedPath.root, directoryPath)
    .split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);
    const stat = fs.lstatSync(currentPath, { throwIfNoEntry: false });

    if (stat === undefined) {
      return;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link ${description} path "${currentPath}"`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(
        `Refusing non-directory ${description} path "${currentPath}"`,
      );
    }
  }
}

function projectDirectoryPath(contextRoot: string, projectId: string): string {
  const root = normalizeContextRoot(contextRoot);
  validatePathComponent(projectId, "project ID");
  const directory = path.resolve(root, projectId);
  assertBelowRoot(root, directory);
  inspectDirectory(directory, "runtime storage");
  return directory;
}

function blockPath(contextRoot: string, projectId: string): string {
  const directory = projectDirectoryPath(contextRoot, projectId);
  const filePath = path.resolve(directory, RECONCILIATION_BLOCK_FILENAME);
  assertBelowRoot(directory, filePath);

  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });

  if (stat?.isSymbolicLink()) {
    throw new Error(
      `Refusing symbolic-link runtime storage path "${filePath}"`,
    );
  }

  if (stat !== undefined && !stat.isFile()) {
    throw new Error(`Refusing non-file runtime storage path "${filePath}"`);
  }

  return filePath;
}

function ensureDirectory(directoryPath: string): void {
  const parsedPath = path.parse(directoryPath);
  let currentPath = parsedPath.root;

  for (const component of path
    .relative(parsedPath.root, directoryPath)
    .split(path.sep)) {
    if (component.length === 0) {
      continue;
    }

    currentPath = path.join(currentPath, component);
    const stat = fs.lstatSync(currentPath, { throwIfNoEntry: false });

    if (stat === undefined) {
      fs.mkdirSync(currentPath);
    } else if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link runtime storage path "${currentPath}"`,
      );
    } else if (!stat.isDirectory()) {
      throw new Error(
        `Refusing non-directory runtime storage path "${currentPath}"`,
      );
    }
  }
}

export function getReconciliationBlockPath(
  contextRoot: string,
  projectId: string,
): string {
  return blockPath(contextRoot, projectId);
}

export function getReconciliationBlockStateDirectory(
  contextRoot: string,
  projectId: string,
): string {
  return projectDirectoryPath(contextRoot, projectId);
}

export function loadReconciliationBlock(
  contextRoot: string,
  projectId: string,
): ReconciliationBlockLoadResult {
  let filePath: string;

  try {
    filePath = blockPath(contextRoot, projectId);
  } catch (error) {
    return {
      status: "malformed",
      error: new Error(
        `Could not inspect persisted reconciliation block for project "${projectId}": ${formatError(error)}`,
        { cause: error },
      ),
    };
  }

  if (!fs.existsSync(filePath)) {
    return { status: "missing" };
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const block = validatePersistedBlock(parsed, projectId);

    return {
      status: "loaded",
      block,
    };
  } catch (error) {
    return {
      status: "malformed",
      error: new Error(
        `Could not load persisted reconciliation block "${filePath}": ${formatError(error)}`,
        { cause: error },
      ),
    };
  }
}

export function writeReconciliationBlock(
  contextRoot: string,
  block: PersistedReconciliationBlock,
): void {
  const validatedBlock = validatePersistedBlock(block, block.projectId);
  const filePath = blockPath(contextRoot, block.projectId);
  const directory = path.dirname(filePath);
  ensureDirectory(directory);

  const temporaryPath = path.join(
    directory,
    `.${RECONCILIATION_BLOCK_FILENAME}.${process.pid}.${Math.random().toString(36).slice(2)}`,
  );

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(validatedBlock, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original storage error.
    }

    throw new Error(
      `Could not persist reconciliation block "${filePath}": ${formatError(error)}`,
      { cause: error },
    );
  }
}

export function removeReconciliationBlock(
  contextRoot: string,
  projectId: string,
): void {
  const filePath = blockPath(contextRoot, projectId);

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw new Error(
      `Could not remove persisted reconciliation block "${filePath}": ${formatError(error)}`,
      { cause: error },
    );
  }
}
