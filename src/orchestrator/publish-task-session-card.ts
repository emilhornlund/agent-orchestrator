import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GitClient } from "../git/git-client.js";
import {
  decideVerifiedPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import { writeTrustedCommitState } from "./trusted-commit-state.js";
import { publishCard, type PublishCardOptions } from "./publish-card.js";

export interface PublishTaskSessionCardOptions extends Omit<
  PublishCardOptions,
  "commitSha" | "beforePushVerification"
> {
  git: GitClient;
  commitMessage: string;
  initialEvidence: VerifiedPublicationDecisionInput;
  verifyPreparedContent: () => Promise<VerifiedPublicationDecisionInput>;
}

function assertPublicationEvidence(
  input: VerifiedPublicationDecisionInput,
): void {
  const decision = decideVerifiedPublication(input);
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
  if (options.project.executionMode !== "task-session") {
    throw new Error("Task-session publication requires task-session mode");
  }

  assertPublicationEvidence(options.initialEvidence);
  const headBefore = await options.git.getHeadSha(options.worktreePath);
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

  await publishCard({
    ...options,
    commitSha,
    beforePushVerification: async () => {
      const preparedEvidence = await options.verifyPreparedContent();
      assertPublicationEvidence(preparedEvidence);
    },
  });
  return options.git.getHeadSha(options.worktreePath);
}
