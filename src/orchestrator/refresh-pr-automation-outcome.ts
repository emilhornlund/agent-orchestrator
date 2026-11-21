import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";

const START = "<!-- agent-orchestrator-outcome:start -->";
const END = "<!-- agent-orchestrator-outcome:end -->";

function outcomeSection(headSha: string, trelloUrl: string, facts: readonly string[]): string {
  return [
    START,
    "## Current automation outcome",
    `Revision: ${headSha}`,
    "These are the latest observed results; older validation summaries describe earlier snapshots.",
    ...facts.map((fact) => `- ${fact.replaceAll("<!-- agent-orchestrator-", "[managed marker: ")}`),
    `Trello: ${trelloUrl}`,
    END,
  ].join("\n");
}

/** Atomically replace a prior revision's recognized outcome with a pending observation. */
export function resetStalePrAutomationOutcome(
  body: string,
  headSha: string,
  trelloUrl: string,
): string {
  const starts = [...body.matchAll(/<!-- agent-orchestrator-outcome:start -->/gu)];
  const ends = [...body.matchAll(/<!-- agent-orchestrator-outcome:end -->/gu)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index > ends[0]!.index) return body;
  const start = starts[0]!.index;
  const end = ends[0]!.index + END.length;
  const revisions = [
    ...body.slice(start, end).matchAll(/^Revision: ([0-9a-f]{40}|[0-9a-f]{64})\r?$/gimu),
  ];
  if (revisions.length !== 1 || revisions[0]![1]!.toLowerCase() === headSha.toLowerCase())
    return body;
  return (
    body.slice(0, start) +
    outcomeSection(headSha, trelloUrl, [
      "CI results for this revision have not yet been observed.",
    ]) +
    body.slice(end)
  );
}

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
  draft: boolean;
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
  const starts = [...current.matchAll(/<!-- agent-orchestrator-outcome:start -->/gu)];
  const ends = [...current.matchAll(/<!-- agent-orchestrator-outcome:end -->/gu)];
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    (starts[0] && starts[0].index > ends[0]!.index)
  )
    throw new Error(
      "PR outcome markers are ambiguous; preserving human description for reconciliation",
    );
  const section = outcomeSection(options.headSha, options.card.url, options.facts);
  const next = starts[0]
    ? current.slice(0, starts[0].index) + section + current.slice(ends[0]!.index + END.length)
    : `${current}\n\n${section}`;
  if (next !== current)
    await options.github.editPullRequestDescription({
      ...request,
      body: next,
      expectedBody: current,
    });
  if ((await options.github.getPullRequestDescription(request)) !== next)
    throw new Error("PR outcome description was not verified; preserving pending presentation");
  if (!options.draft && options.readiness) {
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
