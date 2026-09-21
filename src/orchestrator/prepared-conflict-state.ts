import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ProjectConfig } from "../config/config.js";
import type { GitRebaseState } from "../git/git-client.js";
import {
  PersistedStateFileTooLargeError,
  readPersistedStateJson,
} from "./persisted-state-reader.js";

const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const rebaseStateSchema = z.strictObject({
  active: z.literal(true),
  backend: z.enum(["merge", "apply"]),
  headName: z.string().min(1),
  onto: gitSha,
  originalHead: gitSha,
  currentStep: z.number().int().positive().optional(),
  totalSteps: z.number().int().positive().optional(),
});

const preparedConflictSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("prepared-conflict"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  defaultBranch: z.string().min(1),
  origin: z
    .enum(["human-review-maintenance", "initial-publication"])
    .optional(),
  expectedRemoteTaskSha: gitSha.optional(),
  trustedTaskCommitSha: gitSha.optional(),
  rebaseTargetSha: gitSha.optional(),
  conflictedPaths: z.array(z.string().min(1)).min(1),
  rebase: rebaseStateSchema,
  preparedAt: z.string().datetime(),
});

export type PreparedConflictOrigin =
  "human-review-maintenance" | "initial-publication";

export type PreparedConflictHandoff = Omit<
  z.infer<typeof preparedConflictSchema>,
  | "origin"
  | "expectedRemoteTaskSha"
  | "trustedTaskCommitSha"
  | "rebaseTargetSha"
> & {
  origin: PreparedConflictOrigin;
  expectedRemoteTaskSha?: string | undefined;
  trustedTaskCommitSha: string;
  rebaseTargetSha: string;
};

function statePath(project: ProjectConfig, cardId: string): string {
  if (typeof project.repository.worktreeRoot !== "string") {
    throw new Error(
      "Prepared conflict handoff requires a configured worktree root",
    );
  }

  if (
    cardId.length === 0 ||
    cardId === "." ||
    cardId === ".." ||
    cardId.includes("/") ||
    cardId.includes("\\") ||
    path.isAbsolute(cardId)
  ) {
    throw new Error(`Invalid card ID for prepared conflict handoff: ${cardId}`);
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
      `Invalid project ID for prepared conflict handoff: ${project.id}`,
    );
  }

  return path.join(
    project.repository.worktreeRoot,
    ".orchestrator",
    "prepared-conflicts",
    project.id,
    `${cardId}.json`,
  );
}

export function getPreparedConflictPath(
  project: ProjectConfig,
  cardId: string,
): string {
  return statePath(project, cardId);
}

export function getPreparedConflictStateDirectory(
  project: ProjectConfig,
): string {
  return path.dirname(statePath(project, "placeholder"));
}

export function readPreparedConflict(
  project: ProjectConfig,
  cardId: string,
): PreparedConflictHandoff | null {
  if (typeof project.repository.worktreeRoot !== "string") {
    return null;
  }

  const handoffPath = statePath(project, cardId);

  if (!fs.existsSync(handoffPath)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = readPersistedStateJson(handoffPath);
  } catch (error) {
    if (error instanceof PersistedStateFileTooLargeError) {
      throw new Error(error.message, { cause: error });
    }

    throw new Error(
      `Prepared conflict handoff is not valid JSON: ${handoffPath}`,
      {
        cause: error,
      },
    );
  }

  const result = preparedConflictSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Prepared conflict handoff is invalid: ${handoffPath}`);
  }

  const origin = result.data.origin ?? "human-review-maintenance";
  const trustedTaskCommitSha =
    result.data.trustedTaskCommitSha ?? result.data.expectedRemoteTaskSha;
  const rebaseTargetSha =
    result.data.rebaseTargetSha ?? result.data.rebase.onto;

  if (
    trustedTaskCommitSha === undefined ||
    rebaseTargetSha === undefined ||
    result.data.projectId !== project.id ||
    result.data.cardId !== cardId ||
    result.data.taskBranch !== `agent/${cardId}` ||
    result.data.defaultBranch !== project.repository.defaultBranch ||
    (result.data.rebase.headName !== `agent/${cardId}` &&
      result.data.rebase.headName !== `refs/heads/agent/${cardId}`) ||
    result.data.rebase.originalHead !== trustedTaskCommitSha ||
    result.data.rebase.onto !== rebaseTargetSha ||
    (origin === "human-review-maintenance" &&
      result.data.expectedRemoteTaskSha !== trustedTaskCommitSha)
  ) {
    throw new Error(
      `Prepared conflict handoff does not match project ${project.id} and card ${cardId}`,
    );
  }

  const normalizedHandoff: PreparedConflictHandoff = {
    ...result.data,
    origin,
    ...(result.data.expectedRemoteTaskSha === undefined
      ? {}
      : { expectedRemoteTaskSha: result.data.expectedRemoteTaskSha }),
    trustedTaskCommitSha,
    rebaseTargetSha,
  };

  return normalizedHandoff;
}

export function writePreparedConflict(
  project: ProjectConfig,
  cardId: string,
  expectedRemoteTaskSha: string | undefined,
  conflictedPaths: string[],
  rebase: GitRebaseState,
  metadata: {
    origin?: PreparedConflictOrigin;
    trustedTaskCommitSha?: string;
    rebaseTargetSha?: string;
  } = {},
): PreparedConflictHandoff {
  const origin = metadata.origin ?? "human-review-maintenance";
  const trustedTaskCommitSha =
    metadata.trustedTaskCommitSha ?? expectedRemoteTaskSha;
  const rebaseTargetSha = metadata.rebaseTargetSha ?? rebase.onto;

  if (trustedTaskCommitSha === undefined) {
    throw new Error(
      "Cannot record prepared conflict: trusted task commit is required",
    );
  }

  if (
    origin === "human-review-maintenance" &&
    expectedRemoteTaskSha === undefined
  ) {
    throw new Error(
      "Cannot record Human Review prepared conflict: authoritative remote SHA is required",
    );
  }

  const handoff: PreparedConflictHandoff = {
    version: 1,
    kind: "prepared-conflict",
    projectId: project.id,
    cardId,
    taskBranch: `agent/${cardId}`,
    defaultBranch: project.repository.defaultBranch,
    origin,
    ...(expectedRemoteTaskSha === undefined ? {} : { expectedRemoteTaskSha }),
    trustedTaskCommitSha,
    rebaseTargetSha,
    conflictedPaths: [...new Set(conflictedPaths)].sort(),
    rebase,
    preparedAt: new Date().toISOString(),
  };

  if (
    rebase.headName !== `agent/${cardId}` &&
    rebase.headName !== `refs/heads/agent/${cardId}`
  ) {
    throw new Error(
      "Cannot record prepared conflict: rebase branch is ambiguous",
    );
  }

  if (rebase.originalHead !== trustedTaskCommitSha) {
    throw new Error(
      "Cannot record prepared conflict: rebase original HEAD does not match the trusted task commit",
    );
  }

  if (rebase.onto !== rebaseTargetSha) {
    throw new Error(
      "Cannot record prepared conflict: rebase target does not match the captured target",
    );
  }

  if (
    origin === "human-review-maintenance" &&
    expectedRemoteTaskSha !== trustedTaskCommitSha
  ) {
    throw new Error(
      "Cannot record Human Review prepared conflict: trusted commit does not match the authoritative remote SHA",
    );
  }

  const result = preparedConflictSchema.safeParse(handoff);

  if (!result.success) {
    throw new Error("Cannot record prepared conflict: Git state is incomplete");
  }

  const handoffPath = statePath(project, cardId);
  const directory = path.dirname(handoffPath);
  const temporaryPath = `${handoffPath}.${process.pid}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(result.data, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporaryPath, handoffPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(
      `Could not persist prepared conflict handoff: ${handoffPath}`,
      {
        cause: error,
      },
    );
  }

  return handoff;
}

export function readPreparedConflicts(
  project: ProjectConfig,
): PreparedConflictHandoff[] {
  if (typeof project.repository.worktreeRoot !== "string") {
    return [];
  }

  const directory = path.dirname(statePath(project, "placeholder"));

  if (!fs.existsSync(directory)) {
    return [];
  }

  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error(
      `Prepared conflict state path is not a directory: ${directory}`,
    );
  }

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const cardId = entry.name.slice(0, -".json".length);

      return readPreparedConflict(project, cardId);
    })
    .filter((handoff): handoff is PreparedConflictHandoff => handoff !== null)
    .sort((first, second) => first.cardId.localeCompare(second.cardId));
}

/** Removes only a validated handoff after dedicated remediation is complete. */
export function clearPreparedConflict(
  project: ProjectConfig,
  cardId: string,
): void {
  const handoff = readPreparedConflict(project, cardId);

  if (handoff === null) {
    return;
  }

  fs.rmSync(statePath(project, cardId), { force: true });
}
