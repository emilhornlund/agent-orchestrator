import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { readPreparedConflict } from "../orchestrator/prepared-conflict-state.js";

import type { GitClient } from "./git-client.js";

export interface CleanupWorktreeOptions {
  git: GitClient;
  project: ProjectConfig;
  worktreePath: string;
  branch: string;
  preserveRecoveryState?: boolean;
  signal?: AbortSignal;
}

export async function cleanupWorktree({
  git,
  project,
  worktreePath,
  branch,
  preserveRecoveryState = false,
  signal,
}: CleanupWorktreeOptions): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  const repositoryPath = project.repository.path;
  const worktreeRoot = path.resolve(project.repository.worktreeRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (
    resolvedWorktreePath === worktreeRoot ||
    !resolvedWorktreePath.startsWith(`${worktreeRoot}${path.sep}`)
  ) {
    throw new Error(
      `Refusing to clean worktree outside configured root: ${worktreePath}`,
    );
  }

  const relativeWorktreePath = path.relative(
    worktreeRoot,
    resolvedWorktreePath,
  );

  if (
    relativeWorktreePath.length === 0 ||
    relativeWorktreePath.includes(path.sep)
  ) {
    throw new Error(
      `Refusing to clean worktree outside expected card path: ${worktreePath}`,
    );
  }

  const expectedBranch = `agent/${relativeWorktreePath}`;

  if (branch !== expectedBranch) {
    throw new Error(
      `Refusing to clean worktree ${worktreePath} with unexpected branch "${branch}"`,
    );
  }

  if (
    preserveRecoveryState &&
    readPreparedConflict(project, relativeWorktreePath) !== null
  ) {
    throw new Error(
      `Refusing to remove worktree ${worktreePath} while its prepared-conflict handoff requires recovery`,
    );
  }

  const worktreeStat = fs.lstatSync(worktreePath, { throwIfNoEntry: false });

  if (worktreeStat !== undefined) {
    if (worktreeStat.isSymbolicLink()) {
      throw new Error(
        `Refusing to clean symbolic-link worktree ${worktreePath}`,
      );
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (signal?.aborted) {
      return;
    }

    if (currentBranch !== branch) {
      throw new Error(
        `Refusing to clean worktree ${worktreePath} on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    if (preserveRecoveryState) {
      const rebaseState = await git.getRebaseState(worktreePath);

      if (signal?.aborted) {
        return;
      }

      if (rebaseState !== null) {
        throw new Error(
          `Refusing to remove worktree ${worktreePath} with an active rebase`,
        );
      }

      const conflictedPaths = await git.getConflictedPaths(worktreePath);

      if (signal?.aborted) {
        return;
      }

      if (conflictedPaths.length > 0) {
        throw new Error(
          `Refusing to remove worktree ${worktreePath} with unmerged paths: ${conflictedPaths.join(", ")}`,
        );
      }
    }

    const status = await git.getStatus(worktreePath);

    if (signal?.aborted) {
      return;
    }

    if (status.length > 0) {
      throw new Error(
        `Refusing to remove dirty worktree ${worktreePath}:\n${status}`,
      );
    }

    if (signal?.aborted) {
      return;
    }

    await git.removeWorktree(repositoryPath, worktreePath);

    if (signal?.aborted) {
      return;
    }
  }

  if (signal?.aborted) {
    return;
  }

  await git.pruneWorktrees(repositoryPath);

  if (signal?.aborted) {
    return;
  }

  const branchExists = await git.branchExists(repositoryPath, branch);

  if (signal?.aborted) {
    return;
  }

  if (branchExists) {
    if (signal?.aborted) {
      return;
    }

    await git.deleteBranch(repositoryPath, branch);
  }
}
