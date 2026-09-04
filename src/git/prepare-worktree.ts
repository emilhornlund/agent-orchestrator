import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";

import { GitClient } from "./git-client.js";
import type { GitRebaseState } from "./git-client.js";

export interface PreparedWorktree {
  path: string;
  branch: string;
}

export interface PreparedConflictWorktree extends PreparedWorktree {
  rebase: GitRebaseState | null;
}

export interface PreparedImplementationWorktree extends PreparedWorktree {
  reused: boolean;
  initialStatus?: string;
}

function isValidRebaseProgress(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function matchesPreparedRebaseProgress(
  expectedRebase: GitRebaseState,
  actualRebase: GitRebaseState,
): boolean {
  const expectedCurrentStep = expectedRebase.currentStep;
  const actualCurrentStep = actualRebase.currentStep;
  const expectedTotalSteps = expectedRebase.totalSteps;
  const actualTotalSteps = actualRebase.totalSteps;

  if (
    !isValidRebaseProgress(expectedCurrentStep) ||
    !isValidRebaseProgress(actualCurrentStep) ||
    !isValidRebaseProgress(expectedTotalSteps) ||
    !isValidRebaseProgress(actualTotalSteps)
  ) {
    return false;
  }

  if (
    expectedTotalSteps !== undefined &&
    actualTotalSteps !== undefined &&
    expectedTotalSteps !== actualTotalSteps
  ) {
    return false;
  }

  if (
    expectedCurrentStep !== undefined &&
    actualCurrentStep !== undefined &&
    actualCurrentStep < expectedCurrentStep
  ) {
    return false;
  }

  const availableTotals = [expectedTotalSteps, actualTotalSteps].filter(
    (totalSteps): totalSteps is number => totalSteps !== undefined,
  );

  return [expectedCurrentStep, actualCurrentStep]
    .filter((currentStep): currentStep is number => currentStep !== undefined)
    .every((currentStep) =>
      availableTotals.every((totalSteps) => currentStep <= totalSteps),
    );
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

export async function getExistingPreparedConflictWorktree(
  git: GitClient,
  project: ProjectConfig,
  cardId: string,
  expectedRebase: GitRebaseState,
): Promise<PreparedConflictWorktree | null> {
  const worktreePath = getWorktreePath(project, cardId);
  const branch = `agent/${cardId}`;
  const expectedHeadName = `refs/heads/${branch}`;

  if (!fs.existsSync(worktreePath)) {
    return null;
  }

  const worktreeStat = fs.lstatSync(worktreePath);

  if (worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory()) {
    return null;
  }

  if (!(await git.isValidRepository(worktreePath))) {
    return null;
  }

  const rebase = await git.getRebaseState(worktreePath);

  if (rebase !== null) {
    if (
      rebase.active !== true ||
      (expectedRebase.headName !== expectedHeadName &&
        expectedRebase.headName !== branch) ||
      rebase.headName !== expectedHeadName ||
      rebase.backend !== expectedRebase.backend ||
      rebase.onto !== expectedRebase.onto ||
      rebase.originalHead !== expectedRebase.originalHead ||
      !matchesPreparedRebaseProgress(expectedRebase, rebase)
    ) {
      return null;
    }

    return {
      path: worktreePath,
      branch,
      rebase,
    };
  }

  if ((await git.getCurrentBranch(worktreePath)) !== branch) {
    return null;
  }

  return {
    path: worktreePath,
    branch,
    rebase: null,
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
