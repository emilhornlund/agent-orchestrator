import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GitClient } from "../git/git-client.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import {
  decideHumanReviewPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import {
  clearPendingCommitState,
  readPendingCommitState,
  writePendingCommitState,
  writeTrustedCommitState,
} from "./trusted-commit-state.js";
import { publishCard, type PublishCardOptions } from "./publish-card.js";

export interface PublishTaskSessionCardOptions extends Omit<
  PublishCardOptions,
  "commitSha" | "beforePushVerification"
> {
  git: GitClient;
  commitMessage: string;
  initialEvidence: VerifiedPublicationDecisionInput;
  verifyPreparedContent: () => Promise<VerifiedPublicationDecisionInput>;
  exhaustedReview?: ImplementationReviewResult;
}

function assertPublicationEvidence(
  input: VerifiedPublicationDecisionInput,
  exhaustedReview: ImplementationReviewResult | undefined,
  allowStaleExhaustedReview = false,
): void {
  const decision = decideHumanReviewPublication(input, exhaustedReview, {
    allowStaleExhaustedReview,
  });
  if (!decision.allowed) {
    throw new Error(
      `Task-session publication is blocked: ${decision.reasons.join("; ")}`,
    );
  }
}

/** Commit one verified task snapshot, then reuse the established safe publication path. */
export async function publishTaskSessionCard(
  options: PublishTaskSessionCardOptions,
): Promise<string> {
  assertPublicationEvidence(options.initialEvidence, options.exhaustedReview);
  const headBefore = await options.git.getHeadSha(options.worktreePath);
  if (readPendingCommitState(options.project, options.card.id) !== null)
    throw new Error("Unresolved pending task commit intent requires recovery");
  writePendingCommitState(options.project, options.card.id, {
    version: 1,
    kind: "pending-commit",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: options.branch,
    defaultBranch: options.project.repository.defaultBranch,
    parentSha: headBefore,
  });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-session-commit-"),
  );
  const messagePath = path.join(temporaryDirectory, "message");
  let commitSha: string;

  try {
    fs.writeFileSync(messagePath, options.commitMessage, {
      encoding: "utf8",
      mode: 0o600,
    });
    await options.git.stageAll(options.worktreePath);
    await options.git.commit(
      options.worktreePath,
      messagePath,
      options.project.repository.gitIdentity,
    );
    commitSha = await options.git.getHeadSha(options.worktreePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  if (commitSha === headBefore) {
    throw new Error("Task-session commit did not advance HEAD");
  }

  const commitCount = await options.git.getCommitCountBetween(
    options.worktreePath,
    headBefore,
    commitSha,
  );
  if (commitCount !== 1) {
    throw new Error(
      `Expected exactly one task-session commit, found ${commitCount}`,
    );
  }
  const remainingChanges = await options.git.getStatus(options.worktreePath);
  if (remainingChanges.length > 0) {
    throw new Error(
      `Task-session commit left repository changes: ${remainingChanges}`,
    );
  }

  writeTrustedCommitState(options.project, options.card.id, {
    version: 1,
    kind: "trusted-commit",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: options.branch,
    defaultBranch: options.project.repository.defaultBranch,
    commitSha,
  });

  clearPendingCommitState(options.project, options.card.id);

  await publishCard({
    ...options,
    commitSha,
    beforePushVerification: async () => {
      const preparedEvidence = await options.verifyPreparedContent();
      const preparedHead = await options.git.getHeadSha(options.worktreePath);
      const allowStaleExhaustedReview =
        options.exhaustedReview !== undefined && preparedHead !== commitSha;
      if (
        allowStaleExhaustedReview &&
        (await options.git.getStatus(options.worktreePath)).trim().length > 0
      )
        throw new Error(
          "Refusing exhausted-review publication from a dirty rebased worktree",
        );
      assertPublicationEvidence(
        preparedEvidence,
        options.exhaustedReview,
        allowStaleExhaustedReview,
      );
    },
  });
  return options.git.getHeadSha(options.worktreePath);
}
