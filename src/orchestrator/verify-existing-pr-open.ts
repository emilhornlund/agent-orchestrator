import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import {
  assertNoTerminalPr,
  recordTerminalPrFence,
  ObservedPrTerminalError,
} from "../task-session/terminal-pr-fence.js";

/** Authoritative all-state lookup, not an open-only PR search or an agent claim.
 * A lost resource/outage never grants permission to recreate a published branch. */
export async function verifyExistingPrOpen(options: {
  project: ProjectConfig;
  github: GitHubClient;
  cardId: string;
  branch: string;
  pullRequestUrl: string;
}): Promise<void> {
  const { project, github } = options;
  const authority = ProjectRunAuthority.current(project.id);
  assertNoTerminalPr(authority, true);
  const pr = await github.findPullRequestState({
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: options.branch,
    baseBranch: project.repository.defaultBranch,
    project,
  });
  if (!pr || pr.url !== options.pullRequestUrl)
    throw new Error(
      "Existing PR identity is unavailable; preserve the branch and do not republish",
    );
  if (pr.state !== "OPEN") {
    if (authority) {
      const task = new TaskExecutionStore(authority.store.storageRoot, project, authority).read(
        options.cardId,
      );
      if (!task)
        throw new Error("Terminal PR has no matching task checkpoint; preserve publication state");
      const active = new TaskMutationQueue(
        authority.store.storageRoot,
        project,
        authority,
      ).getActive();
      const fence = recordTerminalPrFence(
        authority,
        task,
        pr,
        active !== null && active.kind !== "terminal-pr",
        project.repository.defaultBranch,
      );
      throw new ObservedPrTerminalError(fence);
    }
    throw new Error(
      `Existing PR is ${pr.state.toLowerCase()}; no push or Human Review transition is permitted`,
    );
  }
  const [owner, repository] = project.repository.github.split("/");
  if (
    (pr.headRefName !== undefined && pr.headRefName !== options.branch) ||
    (pr.baseRefName !== undefined && pr.baseRefName !== project.repository.defaultBranch) ||
    (pr.headRepositoryOwner !== undefined &&
      pr.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase()) ||
    (pr.headRepository !== undefined &&
      pr.headRepository?.name.toLowerCase() !== repository?.toLowerCase())
  )
    throw new Error("Existing PR repository or branch identity changed; preserve publication work");
  assertNoTerminalPr(authority, true);
}
