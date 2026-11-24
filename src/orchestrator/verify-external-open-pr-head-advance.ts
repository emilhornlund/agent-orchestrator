import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import { logger } from "../logging/logger.js";
import { verifyMergedTaskPrHeadContinuity } from "./verify-merged-task-pr-head-continuity.js";

const reportedAdvances = new Set<string>();
const verifiedAdvances = new Set<string>();

/**
 * An open PR may have been fast-forwarded by a human. Verify both the complete
 * PR commit history and Git ancestry before acknowledging that event.
 * This is read-only: it must not rebind the owned writer or silently adopt a
 * different local worktree HEAD.
 */
export async function verifyExternalOpenPrHeadAdvance(options: {
  github: Pick<GitHubClient, "isAncestorCommit" | "getPullRequestCommitShas">;
  project: ProjectConfig;
  cwd: string;
  cardId: string;
  pullRequestNumber: number;
  recordedHeadSha: string;
  observedHeadSha: string;
}): Promise<void> {
  const identity = [
    options.project.id,
    options.project.repository.github,
    options.cwd,
    options.cardId,
    options.pullRequestNumber,
    options.recordedHeadSha,
    options.observedHeadSha,
  ].join(":");
  // Git commit SHAs are immutable. Reuse exact verified ancestry while the
  // same open PR head is observed; do not re-fetch the full commit list every poll.
  if (!verifiedAdvances.has(identity)) {
    await verifyMergedTaskPrHeadContinuity({
      github: options.github,
      project: options.project,
      cwd: options.cwd,
      pullRequestNumber: options.pullRequestNumber,
      recordedHeadSha: options.recordedHeadSha,
      mergedHeadSha: options.observedHeadSha,
    });
    verifiedAdvances.add(identity);
  }
  if (reportedAdvances.has(identity)) return;
  reportedAdvances.add(identity);
  logger
    .child({ projectId: options.project.id, cardId: options.cardId })
    .warn(
      `Owned open PR head advanced externally from ${options.recordedHeadSha} to ${options.observedHeadSha}; waiting for the serialized writer to verify and reconcile`,
    );
}
