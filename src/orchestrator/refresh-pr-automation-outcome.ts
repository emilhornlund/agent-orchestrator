import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { updatePullRequestQuality } from "../github/pull-request-quality.js";

/** Preserve every byte outside the uniquely owned current-outcome section. */
export async function refreshPrAutomationOutcome(options: {
  github: Pick<
    GitHubClient,
    "getPullRequestDescription" | "editPullRequestDescription" | "ensurePullRequestDraft"
  > &
    Partial<Pick<GitHubClient, "ensurePullRequestReady">>;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestUrl: string;
  headSha: string;
  facts: readonly string[];
  retain?: NonNullable<Parameters<typeof updatePullRequestQuality>[3]>;
  /** Omit to report the outcome without changing the PR's current readiness. */
  draft?: boolean;
  readiness?: {
    headBranch: string;
  };
}): Promise<void> {
  const request = {
    cwd: options.project.repository.path,
    repository: options.project.repository.github,
    pullRequestUrl: options.pullRequestUrl,
    project: options.project,
  };
  if (options.draft) await options.github.ensurePullRequestDraft(request);
  const current = await options.github.getPullRequestDescription(request);
  const next = updatePullRequestQuality(current, options.facts, options.headSha, options.retain);
  if (next !== current)
    await options.github.editPullRequestDescription({
      ...request,
      body: next,
      expectedBody: current,
    });
  if ((await options.github.getPullRequestDescription(request)) !== next)
    throw new Error("PR outcome description was not verified; preserving pending presentation");
  if (options.draft === false && options.readiness) {
    if (!options.github.ensurePullRequestReady)
      throw new Error("PR readiness promotion capability is unavailable");
    await options.github.ensurePullRequestReady({
      ...request,
      headBranch: options.readiness.headBranch,
      expectedHeadSha: options.headSha,
      expectedBody: next,
    });
  }
}
