import fs from "node:fs";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "./git-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  runTaskResources,
  assertTaskResourceProvenance,
} from "../task-session/task-resources.js";

/** Preservation is a release outcome only for known, noninterfering resources.
 * It never establishes writer termination or resolves a dispatched mutation. */
export async function assertTerminalArtifactIsolation(
  project: ProjectConfig,
  git: Pick<GitClient, "getCommonGitDirectory" | "getCurrentBranch">,
): Promise<void> {
  const authority = ProjectRunAuthority.current(project.id);
  if (!authority)
    throw new Error("Preservation requires canonical attempt ownership");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  const resource = runTaskResources(run);
  if (
    !run.resources.some(
      (r) => r.kind === "worktree" && r.path === resource.path,
    ) ||
    !run.resources.some(
      (r) => r.kind === "branch" && r.path === `refs/heads/${resource.branch}`,
    ) ||
    resource.path === run.pinned.repositoryPath
  )
    throw new Error("Terminal artifacts have unknown ownership");
  const stat = fs.lstatSync(resource.path, { throwIfNoEntry: false });
  if (!stat) return;
  assertTaskResourceProvenance(run);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(resource.path) !== resource.path ||
    (await git.getCommonGitDirectory(resource.path)) !==
      (await git.getCommonGitDirectory(run.pinned.repositoryPath))
  )
    throw new Error("Terminal artifacts have ambiguous repository identity");
  const branch = await git.getCurrentBranch(resource.path);
  // Detached HEAD can be an interrupted owned rebase; preserve it and its metadata.
  if (branch !== resource.branch && branch !== "")
    throw new Error("Terminal worktree belongs to another branch");
}
