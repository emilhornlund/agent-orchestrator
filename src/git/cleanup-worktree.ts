import fs from "node:fs";
import path from "node:path";

import type { ProjectConfig } from "../config/config.js";
import { readPreparedConflict } from "../orchestrator/prepared-conflict-state.js";

import type { GitClient } from "./git-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { assertTaskResourceProvenance } from "../task-session/task-resources.js";

export interface CleanupWorktreeOptions {
  git: GitClient;
  project: ProjectConfig;
  worktreePath: string;
  branch: string;
  preserveRecoveryState?: boolean;
  preservedHeadSha?: string;
  signal?: AbortSignal;
}

export class CleanupWorktreeSafetyError extends Error {
  readonly diagnostic: {
    reason: "dirty-worktree" | "unmerged-paths" | "unexpected-branch";
    observedCount: number;
    artifactReferences: readonly string[];
  };

  constructor(reason: CleanupWorktreeSafetyError["diagnostic"]["reason"], observedCount: number) {
    const diagnostic = { reason, observedCount, artifactReferences: ["process-executions/"] };
    super(
      `Refusing to remove ${reason === "dirty-worktree" ? "dirty worktree" : reason === "unmerged-paths" ? "worktree with unmerged paths" : "worktree on unexpected branch"}; ${JSON.stringify(diagnostic)}`,
    );
    this.name = "CleanupWorktreeSafetyError";
    this.diagnostic = diagnostic;
  }
}

export async function cleanupWorktree({
  git,
  project,
  worktreePath,
  branch,
  preserveRecoveryState = false,
  preservedHeadSha,
  signal,
}: CleanupWorktreeOptions): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  const repositoryPath = project.repository.path;
  const worktreeRoot = path.resolve(project.repository.worktreeRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);
  const authority = ProjectRunAuthority.current(project.id);
  if (authority) {
    const run = authority.store.assertCurrentLease(authority.ownerGeneration);
    if (
      !preservedHeadSha ||
      !run.resources.some((r) => r.kind === "worktree" && r.path === resolvedWorktreePath) ||
      !run.resources.some((r) => r.kind === "branch" && r.path === `refs/heads/${branch}`)
    )
      throw new Error("Cleanup lacks attempt ownership or preserved history");
  }

  if (
    resolvedWorktreePath === worktreeRoot ||
    !resolvedWorktreePath.startsWith(`${worktreeRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing to clean worktree outside configured root: ${worktreePath}`);
  }

  const relativeWorktreePath = path.relative(worktreeRoot, resolvedWorktreePath);

  if (relativeWorktreePath.length === 0 || relativeWorktreePath.includes(path.sep)) {
    throw new Error(`Refusing to clean worktree outside expected card path: ${worktreePath}`);
  }

  const expectedBranch = `agent/${relativeWorktreePath}`;

  if (branch !== expectedBranch) {
    throw new Error(
      `Refusing to clean worktree ${worktreePath} with unexpected branch "${branch}"`,
    );
  }

  if (preserveRecoveryState && readPreparedConflict(project, relativeWorktreePath) !== null) {
    throw new Error(
      `Refusing to remove worktree ${worktreePath} while its prepared-conflict handoff requires recovery`,
    );
  }

  if (preservedHeadSha && (await git.branchExists(repositoryPath, branch))) {
    const head = await git.getRefSha(repositoryPath, `refs/heads/${branch}`);
    if (
      !head ||
      (head !== preservedHeadSha && !(await git.isAncestor(repositoryPath, head, preservedHeadSha)))
    )
      throw new Error("Cleanup would discard local-only commits");
  }
  const worktreeStat = fs.lstatSync(worktreePath, { throwIfNoEntry: false });

  if (worktreeStat !== undefined) {
    if (authority) assertTaskResourceProvenance(authority.store.read()!);
    if (worktreeStat.isSymbolicLink()) {
      throw new Error(`Refusing to clean symbolic-link worktree ${worktreePath}`);
    }

    if (preservedHeadSha) {
      if (
        fs.realpathSync(worktreePath) !== resolvedWorktreePath ||
        (await git.getCommonGitDirectory(worktreePath)) !==
          (await git.getCommonGitDirectory(repositoryPath))
      )
        throw new Error("Cleanup worktree has ambiguous canonical repository identity");
    }

    const currentBranch = await git.getCurrentBranch(worktreePath);

    if (signal?.aborted) {
      return;
    }

    if (currentBranch !== branch) {
      throw new CleanupWorktreeSafetyError("unexpected-branch", 1);
    }

    if (preserveRecoveryState) {
      const rebaseState = await git.getRebaseState(worktreePath);

      if (signal?.aborted) {
        return;
      }

      if (rebaseState !== null) {
        throw new Error(`Refusing to remove worktree ${worktreePath} with an active rebase`);
      }

      const conflictedPaths = await git.getConflictedPaths(worktreePath);

      if (signal?.aborted) {
        return;
      }

      if (conflictedPaths.length > 0) {
        throw new CleanupWorktreeSafetyError("unmerged-paths", conflictedPaths.length);
      }
    }

    const status = preservedHeadSha
      ? await git.getCleanupStatus(worktreePath)
      : await git.getStatus(worktreePath);

    if (signal?.aborted) {
      return;
    }

    if (status.length > 0) {
      throw new CleanupWorktreeSafetyError("dirty-worktree", Buffer.byteLength(status));
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

  // Never broadly prune registrations belonging to other attempts.

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

    if (preservedHeadSha) {
      const head = await git.getRefSha(repositoryPath, `refs/heads/${branch}`);
      if (
        !head ||
        (head !== preservedHeadSha &&
          !(await git.isAncestor(repositoryPath, head, preservedHeadSha)))
      )
        throw new Error("Cleanup would discard local-only commits");
    }
    await git.deleteBranch(repositoryPath, branch);
  }
}
