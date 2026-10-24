import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import {
  decideTaskSessionAutoMergeReadiness,
  type TaskSessionAutoMergeReadinessInput,
} from "../task-session/task-session-auto-merge-readiness.js";
import { mergePullRequestForAutoMerge } from "./auto-merge.js";

export async function mergeTaskSessionPullRequest(
  github: GitHubClient,
  project: ProjectConfig,
  card: TrelloCard,
  pullRequestUrl: string,
  commitSha: string,
  cwd: string,
  readiness: TaskSessionAutoMergeReadinessInput,
  signal?: AbortSignal,
): Promise<void> {
  if (!project.autoMerge) {
    throw new Error("CI-aware merge requires autoMerge enabled");
  }
  const decision = decideTaskSessionAutoMergeReadiness(readiness);
  if (!decision.allowed || decision.headSha !== commitSha) {
    throw new Error(
      `Task-session auto-merge is blocked: ${[
        ...decision.reasons,
        ...(decision.headSha !== commitSha
          ? ["Merge commit does not match the verified PR head"]
          : []),
      ].join("; ")}`,
    );
  }
  await mergePullRequestForAutoMerge(
    github,
    project,
    card,
    pullRequestUrl,
    commitSha,
    cwd,
    signal,
  );
}
