import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import {
  PersistedStateFileTooLargeError,
  readPersistedStateJson,
} from "./persisted-state-reader.js";

const trustedCommitStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("trusted-commit"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  defaultBranch: z.string().min(1),
  commitSha: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value, "Commit SHA must not be padded"),
});

export type TrustedCommitState = z.infer<typeof trustedCommitStateSchema>;

const pendingCommitStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("pending-commit"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  defaultBranch: z.string().min(1),
  parentSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
});

export type PendingCommitState = z.infer<typeof pendingCommitStateSchema>;

const rejectedCommitStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("rejected-commit"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  defaultBranch: z.string().min(1),
  commitSha: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value, "Commit SHA must not be padded"),
});

export type RejectedCommitState = z.infer<typeof rejectedCommitStateSchema>;

function assertSafeStateComponent(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.isAbsolute(value)
  ) {
    throw new Error(`Invalid ${label} for trusted commit state: ${value}`);
  }
}

function getStatePath(project: ProjectConfig, cardId: string): string {
  assertSafeStateComponent(project.id, "project ID");
  assertSafeStateComponent(cardId, "card ID");

  return path.join(
    project.repository.worktreeRoot,
    ".orchestrator",
    "trusted-commits",
    project.id,
    `${cardId}.json`,
  );
}

function getPendingCommitStatePath(
  project: ProjectConfig,
  cardId: string,
): string {
  assertSafeStateComponent(project.id, "project ID");
  assertSafeStateComponent(cardId, "card ID");
  return path.join(
    project.repository.worktreeRoot,
    ".orchestrator",
    "pending-commits",
    project.id,
    `${cardId}.json`,
  );
}

export function readPendingCommitState(
  project: ProjectConfig,
  cardId: string,
): PendingCommitState | null {
  const filePath = getPendingCommitStatePath(project, cardId);
  if (!fs.existsSync(filePath)) return null;
  const state = pendingCommitStateSchema.parse(
    readPersistedStateJson(filePath),
  );
  if (
    state.projectId !== project.id ||
    state.cardId !== cardId ||
    state.taskBranch !== `agent/${cardId}` ||
    state.defaultBranch !== project.repository.defaultBranch
  )
    throw new Error("Pending commit intent does not match task ownership");
  return state;
}

export function writePendingCommitState(
  project: ProjectConfig,
  cardId: string,
  input: PendingCommitState,
): void {
  const state = pendingCommitStateSchema.parse(input);
  if (
    state.projectId !== project.id ||
    state.cardId !== cardId ||
    state.taskBranch !== `agent/${cardId}` ||
    state.defaultBranch !== project.repository.defaultBranch
  )
    throw new Error("Cannot persist mismatched pending commit intent");
  const filePath = getPendingCommitStatePath(project, cardId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Adopt a task commit only when an on-disk intent proves its exact parent and
 * the worktree is clean on the owned branch. Never infer ownership merely
 * from an arbitrary HEAD or remote PR.
 */
export async function recoverPendingTaskCommit(options: {
  project: ProjectConfig;
  cardId: string;
  worktreePath: string;
  git: Pick<
    GitClient,
    "getCurrentBranch" | "getHeadSha" | "getCommitParentSha" | "getStatus"
  >;
  remoteHeadSha: string | null;
  pullRequestExists: boolean;
}): Promise<TrustedCommitState | null> {
  const { project, cardId, worktreePath, git } = options;
  const pending = readPendingCommitState(project, cardId);
  if (pending === null) return readTrustedCommitState(project, cardId);
  const trusted = readTrustedCommitState(project, cardId);
  const head = await git.getHeadSha(worktreePath);
  if (trusted !== null) {
    if (trusted.commitSha !== head)
      throw new Error("Pending commit intent conflicts with trusted commit");
    clearPendingCommitState(project, cardId);
    return trusted;
  }
  if (
    options.pullRequestExists ||
    options.remoteHeadSha !== null ||
    (await git.getCurrentBranch(worktreePath)) !== pending.taskBranch ||
    (await git.getStatus(worktreePath)).trim().length !== 0 ||
    head === pending.parentSha ||
    (await git.getCommitParentSha(worktreePath)) !== pending.parentSha
  )
    throw new Error(
      "Pending task commit cannot be adopted from ambiguous Git state",
    );
  const adopted: TrustedCommitState = {
    version: 1,
    kind: "trusted-commit",
    projectId: project.id,
    cardId,
    taskBranch: pending.taskBranch,
    defaultBranch: pending.defaultBranch,
    commitSha: head,
  };
  writeTrustedCommitState(project, cardId, adopted);
  clearPendingCommitState(project, cardId);
  return adopted;
}

export function clearPendingCommitState(
  project: ProjectConfig,
  cardId: string,
): void {
  fs.rmSync(getPendingCommitStatePath(project, cardId), { force: true });
}

function getRejectedStatePath(project: ProjectConfig, cardId: string): string {
  assertSafeStateComponent(project.id, "project ID");
  assertSafeStateComponent(cardId, "card ID");

  return path.join(
    project.repository.worktreeRoot,
    ".orchestrator",
    "rejected-commits",
    project.id,
    `${cardId}.json`,
  );
}

export function getTrustedCommitStateDirectory(project: ProjectConfig): string {
  return path.dirname(getStatePath(project, "placeholder"));
}

export function getRejectedCommitStateDirectory(
  project: ProjectConfig,
): string {
  return path.dirname(getRejectedStatePath(project, "placeholder"));
}

export function getTrustedCommitStatePath(
  project: ProjectConfig,
  cardId: string,
): string {
  return getStatePath(project, cardId);
}

export function getRejectedCommitStatePath(
  project: ProjectConfig,
  cardId: string,
): string {
  return getRejectedStatePath(project, cardId);
}

export function readTrustedCommitState(
  project: ProjectConfig,
  cardId: string,
): TrustedCommitState | null {
  const statePath = getStatePath(project, cardId);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = readPersistedStateJson(statePath);
  } catch (error) {
    if (error instanceof PersistedStateFileTooLargeError) {
      throw new Error(error.message, { cause: error });
    }

    throw new Error(`Trusted commit state is not valid JSON: ${statePath}`, {
      cause: error,
    });
  }

  const result = trustedCommitStateSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Trusted commit state is invalid: ${statePath}`);
  }

  if (
    result.data.projectId !== project.id ||
    result.data.cardId !== cardId ||
    result.data.taskBranch !== `agent/${cardId}` ||
    result.data.defaultBranch !== project.repository.defaultBranch
  ) {
    throw new Error(
      `Trusted commit state does not match project ${project.id} and card ${cardId}`,
    );
  }

  return result.data;
}

export function readRejectedCommitState(
  project: ProjectConfig,
  cardId: string,
): RejectedCommitState | null {
  const statePath = getRejectedStatePath(project, cardId);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = readPersistedStateJson(statePath);
  } catch (error) {
    if (error instanceof PersistedStateFileTooLargeError) {
      throw new Error(error.message, { cause: error });
    }

    throw new Error(`Rejected commit state is not valid JSON: ${statePath}`, {
      cause: error,
    });
  }

  const result = rejectedCommitStateSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Rejected commit state is invalid: ${statePath}`);
  }

  if (
    result.data.projectId !== project.id ||
    result.data.cardId !== cardId ||
    result.data.taskBranch !== `agent/${cardId}` ||
    result.data.defaultBranch !== project.repository.defaultBranch
  ) {
    throw new Error(
      `Rejected commit state does not match project ${project.id} and card ${cardId}`,
    );
  }

  return result.data;
}

export function writeTrustedCommitState(
  project: ProjectConfig,
  cardId: string,
  state: TrustedCommitState,
): void {
  const result = trustedCommitStateSchema.safeParse(state);

  if (!result.success) {
    throw new Error("Cannot record trusted commit state: state is incomplete");
  }

  const statePath = getStatePath(project, cardId);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(result.data, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`Could not persist trusted commit state: ${statePath}`, {
      cause: error,
    });
  }
}

export function writeRejectedCommitState(
  project: ProjectConfig,
  cardId: string,
  state: RejectedCommitState,
): void {
  const result = rejectedCommitStateSchema.safeParse(state);

  if (!result.success) {
    throw new Error("Cannot record rejected commit state: state is incomplete");
  }

  const statePath = getRejectedStatePath(project, cardId);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(result.data, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`Could not persist rejected commit state: ${statePath}`, {
      cause: error,
    });
  }
}
