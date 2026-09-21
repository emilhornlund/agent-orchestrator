import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
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
