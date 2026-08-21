import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";

import { GitClient } from "./git-client.js";

export interface PreparedWorktree {
  path: string;
  branch: string;
}

export async function prepareWorktree(
  git: GitClient,
  project: ProjectConfig,
  cardId: string,
): Promise<PreparedWorktree> {
  const repositoryPath = project.repository.path;
  const worktreeRoot = project.repository.worktreeRoot;
  const defaultBranch = project.repository.defaultBranch;

  const branch = `agent/${cardId}`;
  const worktreePath = path.join(worktreeRoot, cardId);

  fs.mkdirSync(worktreeRoot, { recursive: true });

  if (fs.existsSync(worktreePath)) {
    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Existing worktree ${worktreePath} is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const status = await git.getStatus(worktreePath);

    if (status.length > 0) {
      throw new Error(
        `Existing worktree ${worktreePath} has uncommitted changes:\n${status}`,
      );
    }

    return {
      path: worktreePath,
      branch,
    };
  }

  await git.fetch(repositoryPath, "origin", defaultBranch);

  const branchExists = await git.branchExists(repositoryPath, branch);

  if (branchExists) {
    await git.addWorktree(repositoryPath, worktreePath, branch);
  } else {
    await git.addWorktreeWithNewBranch(
      repositoryPath,
      worktreePath,
      branch,
      `origin/${defaultBranch}`,
    );
  }

  return {
    path: worktreePath,
    branch,
  };
}
