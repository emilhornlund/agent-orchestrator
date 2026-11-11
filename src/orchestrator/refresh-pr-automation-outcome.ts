import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";

const START = "<!-- agent-orchestrator-outcome:start -->";
const END = "<!-- agent-orchestrator-outcome:end -->";

/** Preserve every byte outside the uniquely owned current-outcome section. */
export async function refreshPrAutomationOutcome(options: {
  github: Pick<
    GitHubClient,
    | "getPullRequestDescription"
    | "editPullRequestDescription"
    | "ensurePullRequestDraft"
  >;
  project: ProjectConfig;
  card: TrelloCard;
  pullRequestUrl: string;
  headSha: string;
  facts: readonly string[];
  draft: boolean;
}): Promise<void> {
  const request = {
    cwd: options.project.repository.path,
    repository: options.project.repository.github,
    pullRequestUrl: options.pullRequestUrl,
    project: options.project,
  };
  if (options.draft) await options.github.ensurePullRequestDraft(request);
  const current = await options.github.getPullRequestDescription(request);
  const starts = [
    ...current.matchAll(/<!-- agent-orchestrator-outcome:start -->/gu),
  ];
  const ends = [
    ...current.matchAll(/<!-- agent-orchestrator-outcome:end -->/gu),
  ];
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    (starts[0] && starts[0].index > ends[0]!.index)
  )
    throw new Error(
      "PR outcome markers are ambiguous; preserving human description for reconciliation",
    );
  const section = [
    START,
    "## Current automation outcome",
    `Revision: ${options.headSha}`,
    "These are the latest observed results; older validation summaries describe earlier snapshots.",
    ...options.facts.map(
      (fact) =>
        `- ${fact.replaceAll("<!-- agent-orchestrator-", "[managed marker: ")}`,
    ),
    `Trello: ${options.card.url}`,
    END,
  ].join("\n");
  const next = starts[0]
    ? current.slice(0, starts[0].index) +
      section +
      current.slice(ends[0]!.index + END.length)
    : `${current}\n\n${section}`;
  if (next !== current)
    await options.github.editPullRequestDescription({
      ...request,
      body: next,
      expectedBody: current,
    });
  if ((await options.github.getPullRequestDescription(request)) !== next)
    throw new Error(
      "PR outcome description was not verified; preserving pending presentation",
    );
}
