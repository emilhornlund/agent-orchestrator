import type { GitClient } from "./git-client.js";

/**
 * A clean branch with tracked changes relative to its base has work that is
 * represented by Git commits rather than only by the worktree.
 */
export async function hasCommittedImplementation(
  git: GitClient,
  worktreePath: string,
  baseRef: string,
  initialStatus?: string,
): Promise<boolean> {
  const status = initialStatus ?? (await git.getStatus(worktreePath));

  if (status.trim().length > 0) {
    return false;
  }

  const changedFiles = await git.getChangedFiles(worktreePath, baseRef);

  return changedFiles.trim().length > 0;
}
