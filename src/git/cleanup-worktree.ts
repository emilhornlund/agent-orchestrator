import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";

import type { GitClient } from "./git-client.js";

export interface CleanupWorktreeOptions {
  git: GitClient;
  project: ProjectConfig;
  worktreePath: string;
  branch: string;
}

export async function cleanupWorktree({
  git,
  project,
  worktreePath,
  branch,
}: CleanupWorktreeOptions): Promise<void> {
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
  const expectedBranch = `agent/${relativeWorktreePath}`;

  if (branch !== expectedBranch) {
    throw new Error(
      `Refusing to clean worktree ${worktreePath} with unexpected branch "${branch}"`,
    );
  }

  if (fs.existsSync(worktreePath)) {
    if (fs.lstatSync(worktreePath).isSymbolicLink()) {
      throw new Error(
        `Refusing to clean symbolic-link worktree ${worktreePath}`,
      );
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Refusing to clean worktree ${worktreePath} on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const status = await git.getStatus(worktreePath);

    if (status.length > 0) {
      throw new Error(
        `Refusing to remove dirty worktree ${worktreePath}:\n${status}`,
      );
    }

    await git.removeWorktree(repositoryPath, worktreePath);
  }

  await git.pruneWorktrees(repositoryPath);

  if (await git.branchExists(repositoryPath, branch)) {
    await git.deleteBranch(repositoryPath, branch);
  }
}
