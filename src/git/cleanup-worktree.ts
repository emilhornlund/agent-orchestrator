import fs from "node:fs";

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

  if (fs.existsSync(worktreePath)) {
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
