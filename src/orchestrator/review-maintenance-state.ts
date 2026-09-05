import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
import {
  PersistedStateFileTooLargeError,
  readPersistedStateJson,
} from "./persisted-state-reader.js";

const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const command = z.string().min(1);

const reviewMaintenanceStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("review-maintenance"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  defaultBranch: z.string().min(1),
  remoteTaskSha: gitSha,
  remoteDefaultSha: gitSha,
  // Kept non-blank for compatibility with Git adapters that do not validate
  // the local HEAD representation themselves.
  effectiveHeadSha: z.string().min(1),
  setupCommand: command.optional(),
  setupCompleted: z.boolean(),
  validationCommand: command.optional(),
  validation: z
    .strictObject({
      outcome: z.enum(["passed", "failed"]),
      reason: command.optional(),
    })
    .optional(),
});

export type ReviewMaintenanceState = z.infer<
  typeof reviewMaintenanceStateSchema
>;

function getStatePath(project: ProjectConfig, cardId: string): string {
  const worktreeRoot = project.repository.worktreeRoot;

  if (
    cardId.length === 0 ||
    cardId === "." ||
    cardId === ".." ||
    cardId.includes("/") ||
    cardId.includes("\\") ||
    path.isAbsolute(cardId)
  ) {
    throw new Error(`Invalid card ID for review maintenance state: ${cardId}`);
  }

  if (
    project.id.length === 0 ||
    project.id === "." ||
    project.id === ".." ||
    project.id.includes("/") ||
    project.id.includes("\\") ||
    path.isAbsolute(project.id)
  ) {
    throw new Error(
      `Invalid project ID for review maintenance state: ${project.id}`,
    );
  }

  return path.join(
    worktreeRoot,
    ".orchestrator",
    "review-maintenance",
    project.id,
    `${cardId}.json`,
  );
}

export function getReviewMaintenanceStateDirectory(
  project: ProjectConfig,
): string {
  return path.dirname(getStatePath(project, "placeholder"));
}

export function getReviewMaintenanceStatePath(
  project: ProjectConfig,
  cardId: string,
): string {
  return getStatePath(project, cardId);
}

export function readReviewMaintenanceState(
  project: ProjectConfig,
  cardId: string,
): ReviewMaintenanceState | null {
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

    throw new Error(
      `Review maintenance state is not valid JSON: ${statePath}`,
      {
        cause: error,
      },
    );
  }

  const result = reviewMaintenanceStateSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Review maintenance state is invalid: ${statePath}`);
  }

  if (
    result.data.projectId !== project.id ||
    result.data.cardId !== cardId ||
    result.data.taskBranch !== `agent/${cardId}` ||
    result.data.defaultBranch !== project.repository.defaultBranch
  ) {
    throw new Error(
      `Review maintenance state does not match project ${project.id} and card ${cardId}`,
    );
  }

  return result.data;
}

export function writeReviewMaintenanceState(
  project: ProjectConfig,
  cardId: string,
  state: ReviewMaintenanceState,
): void {
  const result = reviewMaintenanceStateSchema.safeParse(state);

  if (!result.success) {
    throw new Error(
      "Cannot record review maintenance state: state is incomplete",
    );
  }

  const statePath = getStatePath(project, cardId);
  const directory = path.dirname(statePath);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

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
    throw new Error(
      `Could not persist review maintenance state: ${statePath}`,
      {
        cause: error,
      },
    );
  }
}

export function clearReviewMaintenanceState(
  project: ProjectConfig,
  cardId: string,
): void {
  const state = readReviewMaintenanceState(project, cardId);

  if (state === null) {
    return;
  }

  fs.rmSync(getStatePath(project, cardId), { force: true });
}

export function matchesReviewMaintenanceRepositoryState(
  state: ReviewMaintenanceState,
  values: {
    remoteTaskSha: string;
    remoteDefaultSha: string;
    effectiveHeadSha: string;
    setupCommand?: string;
    validationCommand?: string;
  },
): boolean {
  return (
    state.remoteTaskSha === values.remoteTaskSha &&
    state.remoteDefaultSha === values.remoteDefaultSha &&
    state.effectiveHeadSha === values.effectiveHeadSha &&
    state.setupCommand === values.setupCommand &&
    state.validationCommand === values.validationCommand
  );
}
