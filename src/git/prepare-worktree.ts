import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";

import { GitClient } from "./git-client.js";

export interface PreparedWorktree {
  path: string;
  branch: string;
}

export interface PreparedImplementationWorktree extends PreparedWorktree {
  reused: boolean;
  initialStatus?: string;
}

function getWorktreePath(project: ProjectConfig, cardId: string): string {
  const worktreePath = path.join(project.repository.worktreeRoot, cardId);
  const resolvedWorktreeRoot = path.resolve(project.repository.worktreeRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (
    resolvedWorktreePath === resolvedWorktreeRoot ||
    !resolvedWorktreePath.startsWith(`${resolvedWorktreeRoot}${path.sep}`)
  ) {
    throw new Error(`Card ID would escape configured worktree root: ${cardId}`);
  }

  return worktreePath;
}

export async function getExistingWorktree(
  git: GitClient,
  project: ProjectConfig,
  cardId: string,
): Promise<PreparedWorktree | null> {
  const worktreePath = getWorktreePath(project, cardId);
  const branch = `agent/${cardId}`;

  if (!fs.existsSync(worktreePath)) {
    return null;
  }

  const worktreeStat = fs.lstatSync(worktreePath);

  if (worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory()) {
    return null;
  }

  const currentBranch = await git.getCurrentBranch(worktreePath);

  if (currentBranch !== branch) {
    return null;
  }

  return {
    path: worktreePath,
    branch,
  };
}

export async function prepareWorktree(
  git: GitClient,
  project: ProjectConfig,
  cardId: string,
): Promise<PreparedImplementationWorktree> {
  const repositoryPath = project.repository.path;
  const worktreeRoot = project.repository.worktreeRoot;
  const defaultBranch = project.repository.defaultBranch;

  const branch = `agent/${cardId}`;
  const worktreePath = getWorktreePath(project, cardId);

  fs.mkdirSync(worktreeRoot, { recursive: true });

  if (fs.existsSync(worktreePath)) {
    if (fs.lstatSync(worktreePath).isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic-link worktree ${worktreePath}`);
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (currentBranch !== branch) {
      throw new Error(
        `Existing worktree ${worktreePath} is on branch "${currentBranch}", expected "${branch}"`,
      );
    }

    const status = await git.getStatus(worktreePath);

    if (status.trim().length > 0) {
      logger
        .child({ projectId: project.id })
        .info(
          "Existing worktree has uncommitted changes; preserving them for retry...",
        );
    }

    return {
      path: worktreePath,
      branch,
      reused: true,
      initialStatus: status,
    };
  }

  await git.fetch(repositoryPath, "origin", defaultBranch, project);

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
    reused: branchExists,
  };
}
