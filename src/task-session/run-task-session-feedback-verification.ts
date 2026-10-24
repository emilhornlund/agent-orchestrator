import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type {
  OpenCodeClient,
  OpenCodeRunOptions,
} from "../opencode/opencode-client.js";
import { buildTaskSessionFeedbackVerificationPrompt } from "../opencode/build-task-session-feedback-verification-prompt.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { FeedbackLedgerEntry } from "./feedback-ledger.js";
import type { TaskPlan } from "./task-plan.js";
import {
  parseFeedbackVerificationResult,
  type FeedbackVerificationResult,
} from "./feedback-verification.js";
import { assertOwnedTaskWorktreePath } from "./run-task-session-implementation.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import {
  decideVerifiedPublication,
  type VerifiedPublicationDecisionInput,
} from "./verified-publication-decision.js";

export interface RunTaskSessionFeedbackVerificationOptions {
  project: ProjectConfig;
  card: TrelloCard;
  expectedBranch: string;
  expectedHeadSha: string;
  worktreePath: string;
  approvedPlan: TaskPlan;
  actionableFeedback: readonly FeedbackLedgerEntry[];
  qualityEvidence: VerifiedPublicationDecisionInput;
  git: Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getDiff"
  >;
  openCode: OpenCodeClient;
  runOptions: Omit<
    OpenCodeRunOptions,
    "cwd" | "prompt" | "sessionId" | "captureSessionId" | "readOnly"
  >;
}

export class TaskSessionFeedbackVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskSessionFeedbackVerificationError";
  }
}

export async function runTaskSessionFeedbackVerification(
  options: RunTaskSessionFeedbackVerificationOptions,
): Promise<FeedbackVerificationResult> {
  if (
    options.approvedPlan.projectId !== options.project.id ||
    options.approvedPlan.cardId !== options.card.id
  ) {
    throw new TaskSessionFeedbackVerificationError(
      "Feedback verification plan does not match task ownership",
    );
  }
  assertOwnedTaskWorktreePath(options.project, options.worktreePath);
  if (
    (await options.git.getCurrentBranch(options.worktreePath)) !==
    options.expectedBranch
  ) {
    throw new TaskSessionFeedbackVerificationError(
      "Feedback verification branch does not match the owned task branch",
    );
  }
  const identity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  if (
    identity !== options.qualityEvidence.currentContentIdentity ||
    options.qualityEvidence.review?.reviewedContentIdentity !== identity
  ) {
    throw new TaskSessionFeedbackVerificationError(
      "Feedback verification requires current local validation, coverage, and passing independent review evidence",
    );
  }
  const decision = decideVerifiedPublication(options.qualityEvidence);
  if (!decision.allowed) {
    throw new TaskSessionFeedbackVerificationError(
      `Feedback verification quality gates failed: ${decision.reasons.join("; ")}`,
    );
  }
  const headSha = await options.git.getHeadSha(options.worktreePath);
  if (headSha !== options.expectedHeadSha) {
    throw new TaskSessionFeedbackVerificationError(
      "Feedback verification PR head does not match the current task head",
    );
  }
  const [stagedDiff, unstagedDiff] = await Promise.all([
    options.git.getDiff(options.worktreePath, true),
    options.git.getDiff(options.worktreePath),
  ]);
  const prompt = buildTaskSessionFeedbackVerificationPrompt({
    projectId: options.project.id,
    card: options.card,
    approvedPlan: options.approvedPlan,
    currentHeadSha: headSha,
    contentIdentity: identity,
    currentDiff: [
      "Staged diff:",
      stagedDiff,
      "Unstaged diff:",
      unstagedDiff,
    ].join("\n"),
    actionableFeedback: options.actionableFeedback,
    qualityEvidence: options.qualityEvidence,
  });
  const response = await options.openCode.run({
    ...options.runOptions,
    cwd: options.worktreePath,
    prompt,
    readOnly: true,
  });
  if (response.exitCode !== 0) {
    throw new TaskSessionFeedbackVerificationError(
      `Independent feedback verification exited with code ${response.exitCode}`,
    );
  }
  const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  if (
    currentIdentity !== identity ||
    (await options.git.getHeadSha(options.worktreePath)) !== headSha
  ) {
    throw new TaskSessionFeedbackVerificationError(
      "Feedback verification source or PR head changed during review",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(response.output) as unknown;
  } catch (error) {
    throw new TaskSessionFeedbackVerificationError(
      "Independent feedback verifier returned malformed JSON",
      { cause: error },
    );
  }
  try {
    return parseFeedbackVerificationResult(decoded, {
      projectId: options.project.id,
      cardId: options.card.id,
      headSha,
      contentIdentity: identity,
      actionableFeedbackIds: options.actionableFeedback.map(
        (item) => `${item.kind}:${item.id}`,
      ),
    });
  } catch (error) {
    throw new TaskSessionFeedbackVerificationError(
      "Independent feedback verifier returned incomplete, invented, or stale dispositions",
      { cause: error },
    );
  }
}
