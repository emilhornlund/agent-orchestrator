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
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (
    resolvedWorktreePath === resolvedWorktreeRoot ||
    !resolvedWorktreePath.startsWith(`${resolvedWorktreeRoot}${path.sep}`)
  ) {
    throw new Error(`Card ID would escape configured worktree root: ${cardId}`);
  }

  fs.mkdirSync(worktreeRoot, { recursive: true });

  const worktreeStat = fs.lstatSync(worktreePath, { throwIfNoEntry: false });

  if (worktreeStat !== undefined) {
    if (worktreeStat.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic-link worktree ${worktreePath}`);
    }

    if (!worktreeStat.isDirectory()) {
      throw new Error(`Refusing to use non-directory worktree ${worktreePath}`);
    }
  }

  await git.fetch(repositoryPath, "origin", branch);

  const existingWorktreeStat = fs.lstatSync(worktreePath, {
    throwIfNoEntry: false,
  });

  if (existingWorktreeStat !== undefined) {
    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Existing worktree ${worktreePath} is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const status = await git.getStatus(worktreePath);

    if (status.length > 0) {
      return {
        path: worktreePath,
        branch,
      };
    }

    await git.resetHardTo(worktreePath, remoteBranch);
    await git.cleanUntracked(worktreePath);

    const statusAfterReset = await git.getStatus(worktreePath);

    if (statusAfterReset.length > 0) {
      throw new Error(
        `Existing review worktree ${worktreePath} is still dirty after reset:\n${statusAfterReset}`,
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
