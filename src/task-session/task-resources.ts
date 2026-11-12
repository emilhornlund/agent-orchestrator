import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { RunRecord } from "./run-record.js";
import { ProjectRunAuthority } from "./project-run-authority.js";

/** Older attempts keep their original identities; new attempts own distinct ones. */
export function runTaskResources(run: RunRecord): {
  path: string;
  branch: string;
} {
  const worktrees = run.resources.filter(
    (r) => r.kind === "worktree" && r.id === run.cardId,
  );
  const branches = run.resources.filter(
    (r) => r.kind === "branch" && r.id === run.cardId,
  );
  if (worktrees.length === 0 && branches.length === 0)
    return {
      path: path.join(run.pinned.worktreeRoot, run.cardId),
      branch: `agent/${run.cardId}`,
    };
  if (worktrees.length !== 1 || branches.length !== 1)
    throw new Error("Attempt resource identity is missing or ambiguous");
  const worktree = worktrees[0]!.path;
  const name = path.basename(worktree);
  const branch = branches[0]!.path.replace(/^refs\/heads\//, "");
  if (
    path.dirname(worktree) !== run.pinned.worktreeRoot ||
    (name !== run.cardId && name !== `${run.cardId}--${run.attemptId}`) ||
    branch !== `agent/${name}`
  )
    throw new Error("Attempt resources differ from pinned task identity");
  return { path: worktree, branch };
}

export function taskResources(
  project: ProjectConfig,
  cardId: string,
): { path: string; branch: string } {
  const run = ProjectRunAuthority.current(project.id)?.store.read();
  if (run?.cardId === cardId) return runTaskResources(run);
  return {
    path: path.join(project.repository.worktreeRoot, cardId),
    branch: `agent/${cardId}`,
  };
}

/** A chosen name is not proof that an already-existing resource was created. */
export function assertTaskResourceProvenance(run: RunRecord): void {
  const resource = runTaskResources(run);
  const planned = run.resources.some(
    (r) =>
      r.kind === "worktree" &&
      r.path === resource.path &&
      r.provenance === "attempt-planned",
  );
  if (
    planned &&
    !run.pendingOperations.some(
      (entry) =>
        entry.kind === "git-worktree" &&
        entry.status === "completed" &&
        entry.mutation?.intent.target ===
          `git:worktree:${encodeURIComponent(resource.path)}` &&
        entry.mutation.observations.some(
          (observation) =>
            observation.outcome === "verified" &&
            observation.resourceId === resource.path,
        ),
    )
  )
    throw new Error(
      "Existing worktree lacks verified attempt creation provenance",
    );
}
