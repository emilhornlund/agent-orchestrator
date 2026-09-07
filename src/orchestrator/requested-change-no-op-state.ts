import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type {
  PullRequestReviewFeedback,
  PullRequestReview,
} from "../github/github-client.js";
import type { ProjectConfig } from "../config/config.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import {
  PersistedStateFileTooLargeError,
  readPersistedStateJson,
} from "./persisted-state-reader.js";

const requestedChangeNoOpStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("requested-change-no-op"),
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  taskBranch: z.string().min(1),
  pullRequestUrl: z.string().min(1).max(500),
  headSha: z.string().min(1).max(200),
  feedbackHash: z.string().regex(/^[0-9a-f]{64}$/),
  identity: z.string().min(1).max(1_000),
  reviewIds: z.array(z.number().int().nonnegative()).max(100),
});

export type RequestedChangeNoOpState = z.infer<
  typeof requestedChangeNoOpStateSchema
>;

export interface RequestedChangeNoOpInput {
  pullRequestUrl: string;
  headSha: string;
  feedback: PullRequestReviewFeedback | string;
}

export function buildRequestedChangeNoOpComment(
  input: RequestedChangeNoOpInput,
): string {
  const feedbackContext =
    typeof input.feedback === "string"
      ? input.feedback
      : input.feedback.reviews
          .map(
            (review) =>
              `Review ID ${review.id}; reviewer ${review.author ?? "unknown"}; submitted ${review.submittedAt}; body: ${review.body ?? "No review body"}`,
          )
          .join(" | ");

  return [
    "Requested-change remediation made no repository changes.",
    "",
    `Pull request: ${presentExternalDiagnostic(input.pullRequestUrl)}`,
    `Pull request head: ${presentExternalDiagnostic(input.headSha)}`,
    `Feedback context: ${presentExternalDiagnostic(feedbackContext || "No feedback text was returned.")}`,
    "",
    "The feedback was not marked resolved or applied. A human reviewer should dismiss or update the review, or provide clearer feedback before trying again.",
  ].join("\n");
}

function getStatePath(project: ProjectConfig, cardId: string): string {
  if (
    cardId.length === 0 ||
    cardId === "." ||
    cardId === ".." ||
    cardId.includes("/") ||
    cardId.includes("\\") ||
    path.isAbsolute(cardId)
  ) {
    throw new Error(
      `Invalid card ID for requested-change no-op state: ${cardId}`,
    );
  }

  if (
    project.id.length === 0 ||
    project.id === "." ||
    project.id === ".." ||
    project.id.includes("/") ||
    project.id.includes("\\") ||
    path.isAbsolute(project.id)
  ) {
    throw new Error(
      `Invalid project ID for requested-change no-op state: ${project.id}`,
    );
  }

  return path.join(
    project.repository.worktreeRoot,
    ".orchestrator",
    "requested-change-no-op",
    project.id,
    `${cardId}.json`,
  );
}

function canonicalReview(review: PullRequestReview): Record<string, unknown> {
  return {
    id: review.id,
    body: review.body,
    author: review.author,
    submittedAt: review.submittedAt,
    source: review.source ?? null,
    inlineComments: review.inlineComments.map((comment) => ({
      body: comment.body,
      author: comment.author,
      path: comment.path ?? null,
      line: comment.line ?? null,
      originalLine: comment.originalLine ?? null,
      diffHunk: comment.diffHunk ?? null,
      threadId: comment.threadId ?? null,
      source: comment.source ?? null,
    })),
  };
}

function canonicalFeedback(
  feedback: PullRequestReviewFeedback | string,
): Record<string, unknown> {
  if (typeof feedback === "string") {
    return { legacy: feedback };
  }

  return {
    reviews: [...feedback.reviews]
      .sort((left, right) => left.id - right.id)
      .map(canonicalReview),
  };
}

export function getRequestedChangeFeedbackHash(
  feedback: PullRequestReviewFeedback | string,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalFeedback(feedback)), "utf8")
    .digest("hex");
}

export function getRequestedChangeNoOpIdentity(
  input: RequestedChangeNoOpInput,
): string {
  return JSON.stringify({
    pullRequestUrl: input.pullRequestUrl,
    headSha: input.headSha,
    feedbackHash: getRequestedChangeFeedbackHash(input.feedback),
  });
}

export function getRequestedChangeNoOpStatePath(
  project: ProjectConfig,
  cardId: string,
): string {
  return getStatePath(project, cardId);
}

export function readRequestedChangeNoOpState(
  project: ProjectConfig,
  cardId: string,
): RequestedChangeNoOpState | null {
  const statePath = getStatePath(project, cardId);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = readPersistedStateJson(statePath);
  } catch (error) {
    if (error instanceof PersistedStateFileTooLargeError) {
      throw new Error(error.message, { cause: error });
    }

    throw new Error(
      `Requested-change no-op state is not valid JSON: ${statePath}`,
      { cause: error },
    );
  }

  const result = requestedChangeNoOpStateSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Requested-change no-op state is invalid: ${statePath}`);
  }

  if (
    result.data.projectId !== project.id ||
    result.data.cardId !== cardId ||
    result.data.taskBranch !== `agent/${cardId}`
  ) {
    throw new Error(
      `Requested-change no-op state does not match project ${project.id} and card ${cardId}`,
    );
  }

  return result.data;
}

export function writeRequestedChangeNoOpState(
  project: ProjectConfig,
  cardId: string,
  input: RequestedChangeNoOpInput,
): RequestedChangeNoOpState {
  const feedbackHash = getRequestedChangeFeedbackHash(input.feedback);
  const identity = getRequestedChangeNoOpIdentity(input);
  const state: RequestedChangeNoOpState = {
    version: 1,
    kind: "requested-change-no-op",
    projectId: project.id,
    cardId,
    taskBranch: `agent/${cardId}`,
    pullRequestUrl: input.pullRequestUrl,
    headSha: input.headSha,
    feedbackHash,
    identity,
    reviewIds:
      typeof input.feedback === "string"
        ? []
        : input.feedback.reviews.map((review) => review.id),
  };
  const result = requestedChangeNoOpStateSchema.safeParse(state);

  if (!result.success) {
    throw new Error(
      "Cannot record requested-change no-op state: state is incomplete",
    );
  }

  const statePath = getStatePath(project, cardId);
  const directory = path.dirname(statePath);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(
      `Could not persist requested-change no-op state: ${statePath}`,
      {
        cause: error,
      },
    );
  }

  return state;
}

export function matchesRequestedChangeNoOp(
  state: RequestedChangeNoOpState,
  input: RequestedChangeNoOpInput,
): boolean {
  return (
    state.pullRequestUrl === input.pullRequestUrl &&
    state.headSha === input.headSha &&
    state.feedbackHash === getRequestedChangeFeedbackHash(input.feedback) &&
    state.identity === getRequestedChangeNoOpIdentity(input)
  );
}
