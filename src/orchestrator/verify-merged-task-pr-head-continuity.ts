import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";

/** Only a verified continuation of the original owned PR may be reconciled. */
export async function verifyMergedTaskPrHeadContinuity(options: {
  github: Pick<GitHubClient, "isAncestorCommit" | "getPullRequestCommitShas">;
  project: ProjectConfig;
  cwd: string;
  pullRequestNumber: number;
  recordedHeadSha: string;
  mergedHeadSha: string;
}): Promise<void> {
  const { recordedHeadSha, mergedHeadSha } = options;
  const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
  if (
    !shaPattern.test(recordedHeadSha) ||
    !shaPattern.test(mergedHeadSha) ||
    !Number.isSafeInteger(options.pullRequestNumber) ||
    options.pullRequestNumber < 1
  )
    throw new Error("Merged pull request has incomplete head identity");
  if (recordedHeadSha.toLowerCase() === mergedHeadSha.toLowerCase()) return;
  const evidence = {
    cwd: options.cwd,
    repository: options.project.repository.github,
    project: options.project,
  };
  const commits = await options.github.getPullRequestCommitShas({
    ...evidence,
    pullRequestNumber: options.pullRequestNumber,
  });
  if (
    commits.at(-1)?.toLowerCase() !== mergedHeadSha.toLowerCase() ||
    !commits.some((sha) => sha.toLowerCase() === recordedHeadSha.toLowerCase())
  )
    throw new Error(
      "Merged pull request does not contain the persisted owned head",
    );
  const isAncestor = await options.github.isAncestorCommit({
    ...evidence,
    ancestorSha: recordedHeadSha,
    descendantSha: mergedHeadSha,
  });
  if (!isAncestor)
    throw new Error(
      "Merged pull request head is not descended from the persisted owned head",
    );
}
