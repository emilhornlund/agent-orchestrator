import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";

import type { GitClient } from "./git-client.js";
import type { PreparedWorktree } from "./prepare-worktree.js";

export async function prepareReviewWorktree(
  git: GitClient,
  project: ProjectConfig,
  cardId: string,
): Promise<PreparedWorktree> {
  const repositoryPath = project.repository.path;
  const worktreeRoot = project.repository.worktreeRoot;

  const branch = `agent/${cardId}`;
  const remoteBranch = `origin/${branch}`;
  const worktreePath = path.join(worktreeRoot, cardId);

  fs.mkdirSync(worktreeRoot, { recursive: true });

  await git.fetch(repositoryPath, "origin", branch);

  if (fs.existsSync(worktreePath)) {
    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Existing worktree ${worktreePath} is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    await git.resetHardTo(worktreePath, remoteBranch);
    await git.cleanUntracked(worktreePath);

    const status = await git.getStatus(worktreePath);

    if (status.length > 0) {
      throw new Error(
        `Existing review worktree ${worktreePath} is still dirty after reset:\n${status}`,
      );
    }

    return {
      path: worktreePath,
      branch,
    };
  }

  await git.pruneWorktrees(repositoryPath);

  if (await git.branchExists(repositoryPath, branch)) {
    await git.deleteBranch(repositoryPath, branch);
  }

  await git.addWorktreeWithNewBranch(
    repositoryPath,
    worktreePath,
    branch,
    remoteBranch,
  );

  return {
    path: worktreePath,
    branch,
  };
}
