import { spawn } from "node:child_process";

import type { ProjectConfig } from "../config/config.js";
import type { CiCheckExpectationSource } from "./ci-check-expectations.js";
import { collectCiWorkflowExpectationSources } from "./ci-workflow-contract.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import {
  containsSecret,
  createSecretRedactor,
  redactError,
  redactSecrets,
} from "../security/redact-secrets.js";
import { getGitHubOperationProject } from "./github-operation-context.js";
import {
  GitHubCredentialProvider,
  type GitHubCredential,
  type GitHubCredentialEnvironment,
} from "./github-credential-provider.js";
import {
  GITHUB_CLI_PR_MAINTENANCE_JSON_FIELDS,
  GITHUB_CLI_PR_REVIEW_JSON_FIELDS,
  GITHUB_CLI_PR_STATE_JSON_FIELDS,
  validateGitHubCliCompatibility,
} from "./github-cli-compatibility.js";
import {
  reconcileManagedPullRequestStatus,
  type ManagedPullRequestStatus,
} from "./pull-request-status.js";

const GITHUB_TIMEOUT_MS = 2 * 60 * 1000;
const GITHUB_TERMINATION_GRACE_MS = 5_000;

export interface CreatePullRequestOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  project?: ProjectConfig;
}

export interface MergePullRequestOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  commitSha: string;
  project?: ProjectConfig;
}

export interface FindPullRequestOptions {
  cwd: string;
  repository: string;
  headBranch: string;
  baseBranch?: string;
  project?: ProjectConfig;
}

export interface PullRequestDescriptionStatusOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  status: ManagedPullRequestStatus | null;
  project?: ProjectConfig;
}

export interface PullRequest {
  url: string;
}

export interface PullRequestConversationComment {
  id: number;
  author: string | null;
  createdAt: string;
  updatedAt: string | null;
  body: string;
  commitSha?: string;
}

export interface PullRequestConversationCommentsOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  project?: ProjectConfig;
}

export interface CreateReviewThreadReplyOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  threadId: string;
  body: string;
  project?: ProjectConfig;
}

export interface CreateConversationReplyOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  body: string;
  project?: ProjectConfig;
}

export interface GitHubContextualReply {
  id: string;
  kind: "review-thread" | "conversation";
  threadId?: string;
}

export interface FailedCheckDiagnostic {
  name: string;
  checkRunId?: number;
  headSha: string;
  logUrl: string | null;
  available: boolean;
  diagnostic: string;
}

export interface CiCheckRunDiagnosticsOptions {
  cwd: string;
  repository: string;
  headSha: string;
  checks: readonly Extract<CiCheckObservation, { source: "check-run" }>[];
  project?: ProjectConfig;
}

export type CiCheckObservation =
  | {
      source: "check-run";
      id: number;
      name: string;
      headSha: string;
      status: string;
      conclusion: string | null;
      url: string | null;
    }
  | {
      source: "commit-status";
      id: number;
      context: string;
      headSha: string;
      state: string;
      createdAt: string;
      updatedAt: string;
      url: string | null;
      description: string | null;
    };

export interface CiObservationsOptions {
  cwd: string;
  repository: string;
  defaultBranch: string;
  baseBranch?: string;
  headSha: string;
  project?: ProjectConfig;
}

export interface CiObservationsResult {
  headSha: string;
  checks: CiCheckObservation[];
  expectationSources: CiCheckExpectationSource[];
}

export type PullRequestStatus = "OPEN" | "CLOSED" | "MERGED";

export type PullRequestMergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type PullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export class GitHubMergeStateUnknownError extends Error {
  constructor(
    mergeable: PullRequestMergeability,
    mergeStateStatus: PullRequestMergeStateStatus,
  ) {
    super(
      `GitHub returned a temporary unresolved pull request merge state while recalculating (mergeable: ${mergeable}, mergeStateStatus: ${mergeStateStatus})`,
    );
    this.name = "GitHubMergeStateUnknownError";
  }
}

export interface PullRequestHeadRepository {
  name: string;
}

export interface PullRequestHeadRepositoryOwner {
  login: string;
}

export interface PullRequestState extends PullRequest {
  state: PullRequestStatus;
  mergedAt: string | null;
  headRefOid?: string;
  baseRefName?: string;
  headRefName?: string;
  headRepository?: PullRequestHeadRepository | null;
  headRepositoryOwner?: PullRequestHeadRepositoryOwner | null;
  mergeable?: PullRequestMergeability;
  mergeStateStatus?: PullRequestMergeStateStatus;
}

export interface ChangesRequestedPullRequest extends PullRequest {
  headSha: string;
  feedback: PullRequestReviewFeedback;
}

export interface PullRequestReviewFeedback {
  reviews: PullRequestReview[];
}

export interface PullRequestReview {
  id: number;
  commitSha?: string;
  body: string | null;
  author: string | null;
  submittedAt: string;
  inlineComments: InlineReviewComment[];
  source?: "current-head" | "carried-forward";
}

interface PullRequestReviewListItem {
  url: string;
  number: number;
  reviewDecision: string;
  headRefOid: string;
}

interface RequestedChangesReview {
  id: number;
  body: string | null;
  commitId: string;
  author: string | null;
  state: string;
  submittedAt: string;
}

interface ValidatedInlineReviewComment {
  id?: number;
  reviewId: number | null;
  commitSha?: string;
  body: string | null;
  author: string | null;
  path?: string;
  line?: number;
  originalLine?: number;
  diffHunk?: string;
}

interface ValidatedReviewThreadComment {
  id: number;
  threadId: string;
  reviewId: number;
  isResolved: boolean;
  isOutdated: boolean;
  body: string;
  author: string | null;
  path?: string;
  line?: number;
  originalLine?: number;
  diffHunk?: string;
}

interface ValidatedReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ValidatedReviewThreadComment[];
}

export interface InlineReviewComment {
  id?: number;
  reviewId?: number;
  commitSha?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  body: string;
  author: string | null;
  path?: string;
  line?: number;
  originalLine?: number;
  diffHunk?: string;
  threadId?: string;
  source?: "current-head" | "carried-forward";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHeadRepository(
  value: unknown,
): PullRequestHeadRepository | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    return undefined;
  }

  return { name: value.name };
}

function parseHeadRepositoryOwner(
  value: unknown,
): PullRequestHeadRepositoryOwner | null | undefined {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value) ||
    typeof value.login !== "string" ||
    value.login === ""
  ) {
    return undefined;
  }

  return { login: value.login };
}

export function getPullRequestHeadRepositoryIdentity(
  pullRequest: Pick<PullRequestState, "headRepository" | "headRepositoryOwner">,
): string | undefined {
  if (
    pullRequest.headRepository === undefined ||
    pullRequest.headRepository === null ||
    pullRequest.headRepositoryOwner === undefined ||
    pullRequest.headRepositoryOwner === null
  ) {
    return undefined;
  }

  return `${pullRequest.headRepositoryOwner.login}/${pullRequest.headRepository.name}`;
}

function validatePullRequestList(value: unknown): PullRequestReviewListItem[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub CLI returned an invalid pull request list");
  }

  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.url !== "string" ||
      !Number.isSafeInteger(item.number) ||
      item.number <= 0 ||
      typeof item.reviewDecision !== "string" ||
      typeof item.headRefOid !== "string" ||
      item.headRefOid.length === 0
    ) {
      throw new Error("GitHub CLI returned an invalid pull request list item");
    }

    parsePullRequestUrl(item.url);

    return {
      url: item.url,
      number: item.number,
      reviewDecision: item.reviewDecision,
      headRefOid: item.headRefOid,
    };
  });
}

function parsePullRequestBody(output: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("GitHub CLI returned an invalid pull request body", {
      cause: error,
    });
  }

  if (
    !isRecord(parsed) ||
    (typeof parsed.body !== "string" && parsed.body !== null)
  ) {
    throw new Error("GitHub CLI returned an invalid pull request body");
  }

  return parsed.body ?? "";
}

function validatePullRequestStateList(
  value: unknown,
  requireMaintenanceFacts = false,
): PullRequestState[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub CLI returned an invalid pull request state list");
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(
        "GitHub CLI returned an invalid pull request state list item",
      );
    }

    const url = item.url;
    const state = item.state;
    const mergedAt = item.mergedAt;
    const baseRefName = item.baseRefName;
    const headRefName = item.headRefName;
    const headRepository = parseHeadRepository(item.headRepository);
    const headRepositoryOwner = parseHeadRepositoryOwner(
      item.headRepositoryOwner,
    );
    const mergeable = item.mergeable;
    const mergeStateStatus = item.mergeStateStatus;
    const headRefOid = item.headRefOid;
    const requiresMaintenanceFacts =
      requireMaintenanceFacts && state === "OPEN";
    const hasHeadRepositoryIdentity =
      headRepository !== undefined &&
      headRepository !== null &&
      headRepositoryOwner !== undefined &&
      headRepositoryOwner !== null;

    if (
      typeof url !== "string" ||
      (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
      (typeof mergedAt !== "string" && mergedAt !== null) ||
      (requireMaintenanceFacts && !hasHeadRepositoryIdentity) ||
      (requiresMaintenanceFacts &&
        (typeof headRefOid !== "string" ||
          headRefOid.length === 0 ||
          typeof baseRefName !== "string" ||
          typeof headRefName !== "string" ||
          (mergeable !== "MERGEABLE" &&
            mergeable !== "CONFLICTING" &&
            mergeable !== "UNKNOWN") ||
          (mergeStateStatus !== "BEHIND" &&
            mergeStateStatus !== "BLOCKED" &&
            mergeStateStatus !== "CLEAN" &&
            mergeStateStatus !== "DIRTY" &&
            mergeStateStatus !== "DRAFT" &&
            mergeStateStatus !== "HAS_HOOKS" &&
            mergeStateStatus !== "UNKNOWN" &&
            mergeStateStatus !== "UNSTABLE")))
    ) {
      throw new Error(
        "GitHub CLI returned an invalid pull request state list item",
      );
    }

    return {
      url: parsePullRequestUrl(url),
      state,
      mergedAt,
      ...(typeof headRefOid === "string" ? { headRefOid } : {}),
      ...(headRepository === undefined ? {} : { headRepository }),
      ...(headRepositoryOwner === undefined ? {} : { headRepositoryOwner }),
      ...(typeof baseRefName === "string" &&
      typeof headRefName === "string" &&
      (mergeable === "MERGEABLE" ||
        mergeable === "CONFLICTING" ||
        mergeable === "UNKNOWN") &&
      (mergeStateStatus === "BEHIND" ||
        mergeStateStatus === "BLOCKED" ||
        mergeStateStatus === "CLEAN" ||
        mergeStateStatus === "DIRTY" ||
        mergeStateStatus === "DRAFT" ||
        mergeStateStatus === "HAS_HOOKS" ||
        mergeStateStatus === "UNKNOWN" ||
        mergeStateStatus === "UNSTABLE")
        ? {
            baseRefName,
            headRefName,
            mergeable,
            mergeStateStatus,
          }
        : {}),
    };
  });
}

function validateRequestedChangesReview(
  value: unknown,
): RequestedChangesReview {
  if (!isRecord(value)) {
    throw new Error("GitHub CLI returned an invalid requested changes review");
  }

  const id = value.id;
  const body = value.body;
  const commitId = value.commit_id;
  const state = value.state;
  const submittedAt = value.submitted_at;
  const user = value.user;
  const author =
    user === null
      ? null
      : isRecord(user) &&
          typeof user.login === "string" &&
          user.login.length > 0
        ? user.login
        : undefined;

  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    (typeof body !== "string" && body !== null) ||
    typeof commitId !== "string" ||
    commitId.length === 0 ||
    typeof state !== "string" ||
    state.length === 0 ||
    typeof submittedAt !== "string" ||
    submittedAt.length === 0 ||
    author === undefined
  ) {
    throw new Error("GitHub CLI returned an invalid requested changes review");
  }

  return {
    id,
    body,
    commitId,
    author,
    state,
    submittedAt,
  };
}

function parsePaginatedGitHubResponse(
  output: string,
  description: string,
): unknown[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub CLI returned an invalid ${description}`, {
      cause: error,
    });
  }

  if (!Array.isArray(parsed) || !parsed.every((page) => Array.isArray(page))) {
    throw new Error(`GitHub CLI returned an invalid ${description}`);
  }

  return parsed.flat();
}

function validateInlineReviewComment(
  value: unknown,
): ValidatedInlineReviewComment {
  if (!isRecord(value)) {
    throw new Error("GitHub CLI returned an invalid inline review comment");
  }

  const id = value.id;
  const reviewId = value.pull_request_review_id;
  const body = value.body;
  const user = value.user;
  const path = value.path;
  const line = value.line;
  const originalLine = value.original_line;
  const commitSha = value.commit_id;
  const diffHunk = value.diff_hunk;
  const author =
    user === null
      ? null
      : isRecord(user) &&
          typeof user.login === "string" &&
          user.login.length > 0
        ? user.login
        : undefined;

  if (
    (id !== undefined &&
      (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) ||
    (reviewId !== null &&
      (typeof reviewId !== "number" ||
        !Number.isSafeInteger(reviewId) ||
        reviewId <= 0)) ||
    (typeof body !== "string" && body !== null) ||
    (commitSha !== undefined &&
      (typeof commitSha !== "string" || commitSha.length === 0)) ||
    author === undefined ||
    (path !== undefined &&
      path !== null &&
      (typeof path !== "string" || path.length === 0)) ||
    (line !== undefined &&
      line !== null &&
      (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)) ||
    (originalLine !== undefined &&
      originalLine !== null &&
      (typeof originalLine !== "number" ||
        !Number.isSafeInteger(originalLine) ||
        originalLine <= 0)) ||
    (diffHunk !== undefined &&
      diffHunk !== null &&
      typeof diffHunk !== "string")
  ) {
    throw new Error("GitHub CLI returned an invalid inline review comment");
  }

  return {
    ...(typeof id === "number" ? { id } : {}),
    reviewId,
    ...(typeof commitSha === "string" ? { commitSha } : {}),
    body,
    author,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof originalLine === "number" ? { originalLine } : {}),
    ...(typeof diffHunk === "string" ? { diffHunk } : {}),
  };
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              databaseId
              body
              author { login }
              path
              line
              originalLine
              diffHunk
              pullRequestReview {
                databaseId
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
}`;

function validateReviewThreadComment(
  value: unknown,
  threadId: string,
  isResolved: boolean,
  isOutdated: boolean,
): ValidatedReviewThreadComment {
  if (!isRecord(value)) {
    throw new Error("GitHub CLI returned an invalid review thread comment");
  }

  const id = value.databaseId;
  const body = value.body;
  const authorValue = value.author;
  const author =
    authorValue === null
      ? null
      : isRecord(authorValue) &&
          typeof authorValue.login === "string" &&
          authorValue.login.length > 0
        ? authorValue.login
        : undefined;
  const path = value.path;
  const line = value.line;
  const originalLine = value.originalLine;
  const diffHunk = value.diffHunk;
  const reviewValue = value.pullRequestReview;
  const reviewId =
    isRecord(reviewValue) && reviewValue.databaseId !== null
      ? reviewValue.databaseId
      : undefined;

  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof body !== "string" ||
    body.length === 0 ||
    author === undefined ||
    typeof reviewId !== "number" ||
    !Number.isSafeInteger(reviewId) ||
    reviewId <= 0 ||
    (path !== null && typeof path !== "string") ||
    (line !== null &&
      (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)) ||
    (originalLine !== null &&
      (typeof originalLine !== "number" ||
        !Number.isSafeInteger(originalLine) ||
        originalLine <= 0)) ||
    (diffHunk !== null && typeof diffHunk !== "string")
  ) {
    throw new Error("GitHub CLI returned an invalid review thread comment");
  }

  return {
    id,
    threadId,
    reviewId,
    isResolved,
    isOutdated,
    body,
    author,
    ...(typeof path === "string" ? { path } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof originalLine === "number" ? { originalLine } : {}),
    ...(typeof diffHunk === "string" ? { diffHunk } : {}),
  };
}

function validateReviewThreadsResponse(
  value: unknown,
): ValidatedReviewThread[] {
  if (
    !isRecord(value) ||
    (value.errors !== undefined &&
      (!Array.isArray(value.errors) || value.errors.length > 0)) ||
    !isRecord(value.data)
  ) {
    throw new Error("GitHub CLI returned an invalid review thread response");
  }

  const repository = value.data.repository;
  const pullRequest = isRecord(repository) ? repository.pullRequest : undefined;
  const reviewThreads = isRecord(pullRequest)
    ? pullRequest.reviewThreads
    : undefined;

  if (!isRecord(reviewThreads)) {
    throw new Error("GitHub CLI returned an invalid review thread response");
  }

  const nodes = reviewThreads.nodes;
  const pageInfo = reviewThreads.pageInfo;

  if (
    !Array.isArray(nodes) ||
    !isRecord(pageInfo) ||
    typeof pageInfo.hasNextPage !== "boolean" ||
    pageInfo.hasNextPage
  ) {
    throw new Error("GitHub CLI returned an incomplete review thread response");
  }

  return nodes.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.isResolved !== "boolean" ||
      typeof value.isOutdated !== "boolean" ||
      !isRecord(value.comments) ||
      !Array.isArray(value.comments.nodes) ||
      !isRecord(value.comments.pageInfo) ||
      typeof value.comments.pageInfo.hasNextPage !== "boolean" ||
      value.comments.pageInfo.hasNextPage
    ) {
      throw new Error("GitHub CLI returned an invalid review thread");
    }

    const threadId = value.id;

    return {
      id: threadId,
      isResolved: value.isResolved,
      isOutdated: value.isOutdated,
      comments: value.comments.nodes.map((comment) =>
        validateReviewThreadComment(
          comment,
          threadId,
          value.isResolved as boolean,
          value.isOutdated as boolean,
        ),
      ),
    };
  });
}

export type RunGitHubCommand = (
  cwd: string,
  args: string[],
  environment?: GitHubCredentialEnvironment,
) => Promise<string>;

const transientHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function errorChain(error: unknown): Error[] {
  const errors: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    errors.push(current);
    current = current.cause;
  }

  return errors;
}

function hasTransientHttpStatus(error: unknown, message: string): boolean {
  const statusValues: unknown[] = [];

  for (const entry of errorChain(error)) {
    const candidate = entry as Error & {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };

    statusValues.push(
      candidate.status,
      candidate.statusCode,
      candidate.response?.status,
    );
  }

  if (
    statusValues.some(
      (status) =>
        typeof status === "number" && transientHttpStatuses.has(status),
    )
  ) {
    return true;
  }

  const statusMatches = message.match(/\b(?:HTTP\s+)?([45]\d{2})\b/gi) ?? [];

  return statusMatches.some((match) => {
    const status = Number(match.match(/\d{3}/)?.[0]);
    return transientHttpStatuses.has(status);
  });
}

/** Returns true only for failures that can reasonably change on a later read. */
export function isRetryableGitHubError(error: unknown): boolean {
  if (
    errorChain(error).some(
      (entry) => entry instanceof GitHubMergeStateUnknownError,
    )
  ) {
    return true;
  }

  const messages = errorChain(error).map((entry) =>
    entry.message.toLowerCase(),
  );
  const message = messages.join("\n");

  if (messages.some((entry) => /\brate[- ]limit\b|\bratelimit\b/.test(entry))) {
    return true;
  }

  if (
    messages.some(
      (entry) =>
        entry.includes("authentication") ||
        entry.includes("not logged in") ||
        entry.includes("bad credentials") ||
        entry.includes("invalid token") ||
        entry.includes("permission denied") ||
        entry.includes("configuration") ||
        entry.includes("configur") ||
        entry.includes("invalid pull request") ||
        entry.includes("invalid requested changes") ||
        entry.includes("invalid json") ||
        entry.includes("unexpected token") ||
        /\b(?:http\s*)?(?:401|403)\b/.test(entry),
    )
  ) {
    return false;
  }

  if (hasTransientHttpStatus(error, message)) {
    return true;
  }

  return messages.some(
    (entry) =>
      entry.includes("timed out") ||
      entry.includes("timeout") ||
      entry.includes("etimedout") ||
      entry.includes("econnreset") ||
      entry.includes("econnrefused") ||
      entry.includes("enetunreach") ||
      entry.includes("ehostunreach") ||
      entry.includes("eai_again") ||
      entry.includes("enotfound") ||
      entry.includes("socket hang up") ||
      entry.includes("temporary network") ||
      entry.includes("temporary connectivity") ||
      entry.includes("temporary failure in name resolution") ||
      entry.includes("network error") ||
      entry.includes("network is unreachable") ||
      entry.includes("connection reset") ||
      entry.includes("connection refused") ||
      entry.includes("connection aborted") ||
      entry.includes("failed to fetch") ||
      entry.includes("service unavailable"),
  );
}

function parsePullRequestUrl(value: string): string {
  const url = value.trim();

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(parsed.pathname)
    ) {
      throw new Error("not a GitHub pull request URL");
    }
  } catch (error) {
    throw new Error(`GitHub CLI returned an invalid pull request URL: ${url}`, {
      cause: error,
    });
  }

  return url;
}

function getPullRequestNumberForRepository(
  pullRequestUrl: string,
  repository: string,
): number {
  const parsed = new URL(parsePullRequestUrl(pullRequestUrl));
  const [, owner, name, , number] = parsed.pathname.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    `${owner}/${name}` !== repository ||
    number === undefined ||
    !/^\d+$/u.test(number)
  ) {
    throw new Error(
      "Pull request URL does not belong to the requested repository",
    );
  }
  const parsedNumber = Number(number);
  if (!Number.isSafeInteger(parsedNumber) || parsedNumber < 1) {
    throw new Error("Pull request URL contains an invalid number");
  }
  return parsedNumber;
}

const defaultRunGitHubCommand: RunGitHubCommand = async (
  cwd,
  args,
  environment,
) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      ...(environment === undefined
        ? {}
        : { env: { ...process.env, ...environment } }),
    });

    let output = "";
    let errorOutput = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const environmentSecrets = [
      environment?.GH_TOKEN,
      environment?.GITHUB_TOKEN,
    ];
    const stdoutRedactor = createSecretRedactor(environmentSecrets);
    const stderrRedactor = createSecretRedactor(environmentSecrets);

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      child.kill("SIGTERM");

      forceKillTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        child.kill("SIGKILL");
        settled = true;
        reject(new Error(`GitHub CLI timed out after ${GITHUB_TIMEOUT_MS}ms`));
      }, GITHUB_TERMINATION_GRACE_MS);
    }, GITHUB_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      output += stdoutRedactor.push(chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += stderrRedactor.push(chunk.toString());
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      output += stdoutRedactor.flush();
      errorOutput += stderrRedactor.flush();
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }

      reject(
        new Error(`Failed to start GitHub CLI: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      output += stdoutRedactor.flush();
      errorOutput += stderrRedactor.flush();
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }

      if (timedOut) {
        reject(new Error(`GitHub CLI timed out after ${GITHUB_TIMEOUT_MS}ms`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `GitHub CLI exited with code ${code ?? 1}: ${redactSecrets(errorOutput.trim(), environmentSecrets)}`,
          ),
        );
        return;
      }

      resolve(output.trim());
    });
  });

export class GitHubClient {
  private readonly credentials: GitHubCredentialProvider;

  constructor(
    private readonly runGitHubCommand: RunGitHubCommand = defaultRunGitHubCommand,
    credentials: GitHubCredentialProvider = new GitHubCredentialProvider(),
  ) {
    this.credentials = credentials;
  }

  private async run(
    cwd: string,
    args: string[],
    credential: GitHubCredential,
  ): Promise<string> {
    try {
      const output =
        Object.keys(credential.environment).length === 0
          ? await this.runGitHubCommand(cwd, args)
          : await this.runGitHubCommand(cwd, args, credential.environment);

      return redactSecrets(output, credential.secretValues);
    } catch (error) {
      const safeError = redactError(error, credential.secretValues);

      if (
        credential.mode === "ambient" &&
        !containsSecret(error, credential.secretValues)
      ) {
        throw error;
      }

      // Do not retain the caught error: CLI output may have included a credential.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeError.message, { cause: safeError });
    }
  }

  private resolveCredential(
    project?: ProjectConfig,
  ): Promise<GitHubCredential> {
    const operationProject = project ?? getGitHubOperationProject();

    return this.credentials.resolve(operationProject);
  }

  /** Collects exact-head check runs, statuses, and available CI contracts. */
  async getCiObservations(
    options: CiObservationsOptions,
  ): Promise<CiObservationsResult> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(options.headSha)) {
      throw new Error("CI observations require a full expected commit SHA");
    }
    if (options.defaultBranch.trim().length === 0) {
      throw new Error("CI observations require a configured default branch");
    }

    const credential = await this.resolveCredential(options.project);
    const checkRunsPath = `repos/${options.repository}/commits/${options.headSha}/check-runs?per_page=100`;
    const statusesPath = `repos/${options.repository}/commits/${options.headSha}/statuses?per_page=100`;
    const branchRulesPath = `repos/${options.repository}/branches/${encodeURIComponent(options.defaultBranch)}/protection/required_status_checks`;
    const [checkRunsOutput, statusesOutput, branchRulesResult] =
      await Promise.all([
        this.run(
          options.cwd,
          ["api", "--paginate", "--slurp", checkRunsPath],
          credential,
        ),
        this.run(
          options.cwd,
          ["api", "--paginate", "--slurp", statusesPath],
          credential,
        ),
        this.run(options.cwd, ["api", branchRulesPath], credential).then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        ),
      ]);

    const checkRunPages = parsePaginatedGitHubResponse(
      checkRunsOutput,
      "paginated check runs",
    );
    const checkRunValues: unknown[] = [];
    for (const [index, page] of checkRunPages.entries()) {
      if (!isRecord(page) || !Array.isArray(page.check_runs)) {
        throw new Error(`GitHub returned a malformed check-runs page ${index}`);
      }
      checkRunValues.push(...page.check_runs);
    }

    const checks: CiCheckObservation[] = [];
    for (const [index, value] of checkRunValues.entries()) {
      if (
        !isRecord(value) ||
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        value.id <= 0 ||
        typeof value.name !== "string" ||
        value.name.trim().length === 0 ||
        typeof value.head_sha !== "string" ||
        typeof value.status !== "string" ||
        (value.conclusion !== null && typeof value.conclusion !== "string") ||
        (value.html_url !== null && typeof value.html_url !== "string")
      ) {
        throw new Error(
          `GitHub returned a malformed check run at index ${index}`,
        );
      }
      if (value.head_sha !== options.headSha) {
        throw new Error(
          "GitHub returned a check run for a different commit SHA",
        );
      }
      checks.push({
        source: "check-run",
        id: value.id,
        name: value.name,
        headSha: value.head_sha,
        status: value.status,
        conclusion:
          typeof value.conclusion === "string" ? value.conclusion : null,
        url: typeof value.html_url === "string" ? value.html_url : null,
      });
    }

    const statusValues = parsePaginatedGitHubResponse(
      statusesOutput,
      "paginated commit statuses",
    );
    for (const [index, value] of statusValues.entries()) {
      if (
        !isRecord(value) ||
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        value.id <= 0 ||
        typeof value.context !== "string" ||
        value.context.trim().length === 0 ||
        typeof value.sha !== "string" ||
        typeof value.state !== "string" ||
        typeof value.created_at !== "string" ||
        typeof value.updated_at !== "string" ||
        (value.target_url !== null && typeof value.target_url !== "string") ||
        (value.description !== null && typeof value.description !== "string")
      ) {
        throw new Error(
          `GitHub returned a malformed commit status at index ${index}`,
        );
      }
      if (value.sha !== options.headSha) {
        throw new Error(
          "GitHub returned a commit status for a different commit SHA",
        );
      }
      checks.push({
        source: "commit-status",
        id: value.id,
        context: value.context,
        headSha: value.sha,
        state: value.state,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
        url: typeof value.target_url === "string" ? value.target_url : null,
        description:
          typeof value.description === "string" ? value.description : null,
      });
    }

    const expectationSources: CiCheckExpectationSource[] = [];
    if ("output" in branchRulesResult) {
      try {
        const rules: unknown = JSON.parse(branchRulesResult.output);
        if (!isRecord(rules)) throw new Error("rules result is not an object");
        const names: string[] = [];
        if (Array.isArray(rules.contexts)) {
          for (const context of rules.contexts) {
            if (typeof context !== "string" || context.trim().length === 0)
              throw new Error("branch rules include a malformed check context");
            names.push(context);
          }
        }
        if (Array.isArray(rules.checks)) {
          for (const check of rules.checks) {
            if (!isRecord(check) || typeof check.context !== "string")
              throw new Error(
                "branch rules include a malformed check contract",
              );
            names.push(check.context);
          }
        }
        expectationSources.push({
          kind: "repository-rules",
          sourceId: `branch-protection:${options.defaultBranch}`,
          complete: true,
          checkNames: [...new Set(names)],
        });
      } catch {
        expectationSources.push({
          kind: "repository-rules",
          sourceId: `branch-protection:${options.defaultBranch}`,
          complete: false,
          checkNames: [],
          uncertainty:
            "GitHub branch protection returned an invalid check contract",
        });
      }
    } else if (
      branchRulesResult.error instanceof Error &&
      /(?:\b404\b|not found)/iu.test(branchRulesResult.error.message)
    ) {
      // A 404 means no branch protection contract is configured for this branch;
      // it is absence of that optional source, not proof that observed checks pass.
    } else {
      expectationSources.push({
        kind: "repository-rules",
        sourceId: `branch-protection:${options.defaultBranch}`,
        complete: false,
        checkNames: [],
        uncertainty: "GitHub branch protection expectations are unavailable",
      });
    }

    try {
      expectationSources.push(
        ...collectCiWorkflowExpectationSources(
          options.cwd,
          options.baseBranch ?? options.defaultBranch,
        ),
      );
    } catch {
      expectationSources.push({
        kind: "workflow-contract",
        sourceId: "workflow-contract:repository",
        complete: false,
        checkNames: [],
        uncertainty: "Repository-owned workflow expectations could not be read",
      });
    }

    return {
      headSha: options.headSha,
      checks,
      expectationSources,
    };
  }

  async getCiCheckRunDiagnostics(
    options: CiCheckRunDiagnosticsOptions,
  ): Promise<FailedCheckDiagnostic[]> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(options.headSha)) {
      throw new Error("Check diagnostics require a full expected commit SHA");
    }
    const credential = await this.resolveCredential(options.project);
    const failedChecks = options.checks.filter(
      (check) =>
        check.status === "completed" &&
        ["failure", "timed_out", "action_required", "startup_failure"].includes(
          check.conclusion ?? "",
        ),
    );
    return Promise.all(
      failedChecks.map(async (check) => {
        if (
          check.headSha !== options.headSha ||
          !Number.isSafeInteger(check.id) ||
          check.id <= 0
        ) {
          throw new Error(
            "Failed check diagnostics refer to a stale or unidentified check run",
          );
        }
        try {
          const output = await this.run(
            options.cwd,
            [
              "api",
              "--paginate",
              "--slurp",
              `repos/${options.repository}/check-runs/${check.id}/annotations?per_page=100`,
            ],
            credential,
          );
          const annotations = parsePaginatedGitHubResponse(
            output,
            "paginated check annotations",
          );
          const details = annotations.map((annotation) => {
            if (
              !isRecord(annotation) ||
              typeof annotation.annotation_level !== "string" ||
              typeof annotation.message !== "string" ||
              typeof annotation.path !== "string" ||
              typeof annotation.start_line !== "number" ||
              !Number.isSafeInteger(annotation.start_line)
            ) {
              throw new Error(
                "GitHub CLI returned a malformed check annotation",
              );
            }
            return `${annotation.annotation_level}: ${annotation.path}:${annotation.start_line}: ${annotation.message}`;
          });
          return {
            name: check.name,
            checkRunId: check.id,
            headSha: options.headSha,
            logUrl: check.url,
            available: details.length > 0,
            diagnostic: presentExternalDiagnostic(
              details.length > 0
                ? details.join("\n")
                : "No check annotations were available.",
              credential.secretValues,
            ),
          };
        } catch (error) {
          return {
            name: check.name,
            checkRunId: check.id,
            headSha: options.headSha,
            logUrl: check.url,
            available: false,
            diagnostic: presentExternalDiagnostic(
              `Check diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`,
              credential.secretValues,
            ),
          };
        }
      }),
    );
  }

  async getPullRequestConversationComments(
    options: PullRequestConversationCommentsOptions,
  ): Promise<PullRequestConversationComment[]> {
    const pullRequestUrl = parsePullRequestUrl(options.pullRequestUrl);
    const url = new URL(pullRequestUrl);
    const [, owner, repository, , number] = url.pathname.split("/");
    if (
      owner === undefined ||
      repository === undefined ||
      `${owner}/${repository}` !== options.repository ||
      number === undefined ||
      !/^\d+$/u.test(number)
    ) {
      throw new Error(
        "Pull request URL does not match the requested repository",
      );
    }

    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${options.repository}/issues/${number}/comments?per_page=100`,
      ],
      credential,
    );
    return parsePaginatedGitHubResponse(
      output,
      "paginated pull request conversation comments",
    ).map((value): PullRequestConversationComment => {
      if (!isRecord(value)) {
        throw new Error("GitHub CLI returned a malformed conversation comment");
      }
      const user = value.user;
      const author =
        user === null
          ? null
          : isRecord(user) &&
              typeof user.login === "string" &&
              user.login.length > 0
            ? user.login
            : undefined;
      if (
        typeof value.id !== "number" ||
        !Number.isSafeInteger(value.id) ||
        value.id <= 0 ||
        author === undefined ||
        typeof value.body !== "string" ||
        typeof value.created_at !== "string" ||
        !Number.isFinite(Date.parse(value.created_at)) ||
        (value.updated_at !== undefined &&
          value.updated_at !== null &&
          (typeof value.updated_at !== "string" ||
            !Number.isFinite(Date.parse(value.updated_at)))) ||
        (value.commit_id !== undefined &&
          value.commit_id !== null &&
          typeof value.commit_id !== "string")
      ) {
        throw new Error("GitHub CLI returned a malformed conversation comment");
      }
      return {
        id: value.id,
        author,
        createdAt: value.created_at,
        updatedAt:
          typeof value.updated_at === "string" ? value.updated_at : null,
        body: value.body,
        ...(typeof value.commit_id === "string"
          ? { commitSha: value.commit_id }
          : {}),
      };
    });
  }

  async replyToReviewThread(
    options: CreateReviewThreadReplyOptions,
  ): Promise<GitHubContextualReply> {
    const pullRequestNumber = getPullRequestNumberForRepository(
      options.pullRequestUrl,
      options.repository,
    );
    if (
      options.threadId.trim().length === 0 ||
      options.body.trim().length === 0
    ) {
      throw new Error(
        "Review-thread reply requires a thread ID and nonblank body",
      );
    }
    const credential = await this.resolveCredential(options.project);
    const threads = await this.findReviewThreads(
      {
        cwd: options.cwd,
        repository: options.repository,
        headBranch: "reply-validation-only",
        ...(options.project === undefined ? {} : { project: options.project }),
      },
      pullRequestNumber,
      credential,
    );
    if (!threads.some((thread) => thread.id === options.threadId)) {
      throw new Error(
        "Review thread does not belong to the requested pull request",
      );
    }
    const query = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) { comment { databaseId } } }`;
    const output = await this.run(
      options.cwd,
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `threadId=${options.threadId}`,
        "-F",
        `body=${options.body}`,
      ],
      credential,
    );
    let response: unknown;
    try {
      response = JSON.parse(output) as unknown;
    } catch (error) {
      throw new Error("GitHub CLI returned an invalid review-thread reply", {
        cause: error,
      });
    }
    if (
      !isRecord(response) ||
      (response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !isRecord(response.data)
    ) {
      throw new Error("GitHub CLI returned an invalid review-thread reply");
    }
    const mutation = response.data.addPullRequestReviewThreadReply;
    const comment = isRecord(mutation) ? mutation.comment : undefined;
    const id = isRecord(comment) ? comment.databaseId : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("GitHub CLI returned a malformed review-thread reply ID");
    }
    return {
      id: String(id),
      kind: "review-thread",
      threadId: options.threadId,
    };
  }

  async findReviewThreadReplyByMarker(
    options: Omit<CreateReviewThreadReplyOptions, "body"> & { marker: string },
  ): Promise<string | null> {
    const pullRequestNumber = getPullRequestNumberForRepository(
      options.pullRequestUrl,
      options.repository,
    );
    if (
      options.threadId.trim().length === 0 ||
      options.marker.trim().length === 0
    ) {
      throw new Error(
        "Review-thread reconciliation requires a thread ID and marker",
      );
    }
    const credential = await this.resolveCredential(options.project);
    const threads = await this.findReviewThreads(
      {
        cwd: options.cwd,
        repository: options.repository,
        headBranch: "reply-reconciliation-only",
        ...(options.project === undefined ? {} : { project: options.project }),
      },
      pullRequestNumber,
      credential,
    );
    const thread = threads.find(
      (candidate) => candidate.id === options.threadId,
    );
    if (thread === undefined) {
      throw new Error(
        "Review thread does not belong to the requested pull request",
      );
    }
    return (
      thread.comments
        .find((comment) => comment.body.includes(options.marker))
        ?.id.toString() ?? null
    );
  }

  async replyToConversationComment(
    options: CreateConversationReplyOptions,
  ): Promise<GitHubContextualReply> {
    const number = getPullRequestNumberForRepository(
      options.pullRequestUrl,
      options.repository,
    );
    if (options.body.trim().length === 0) {
      throw new Error("Conversation reply body must not be blank");
    }
    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "api",
        "--method",
        "POST",
        `repos/${options.repository}/issues/${number}/comments`,
        "-f",
        `body=${options.body}`,
      ],
      credential,
    );
    let response: unknown;
    try {
      response = JSON.parse(output) as unknown;
    } catch (error) {
      throw new Error("GitHub CLI returned an invalid conversation reply", {
        cause: error,
      });
    }
    if (
      !isRecord(response) ||
      typeof response.id !== "number" ||
      !Number.isSafeInteger(response.id) ||
      response.id <= 0 ||
      typeof response.body !== "string" ||
      response.body !== options.body
    ) {
      throw new Error("GitHub CLI returned a malformed conversation reply");
    }
    return { id: String(response.id), kind: "conversation" };
  }

  private async findReviewThreads(
    options: FindPullRequestOptions,
    pullRequestNumber: number,
    credential: GitHubCredential,
  ): Promise<ValidatedReviewThread[]> {
    const repositoryParts = options.repository.split("/");

    if (
      repositoryParts.length !== 2 ||
      repositoryParts.some((part) => part.length === 0)
    ) {
      throw new Error(
        "Cannot reconcile review threads because the GitHub repository is invalid",
      );
    }

    const output = await this.run(
      options.cwd,
      [
        "api",
        "graphql",
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        "-F",
        `owner=${repositoryParts[0]}`,
        "-F",
        `name=${repositoryParts[1]}`,
        "-F",
        `number=${pullRequestNumber}`,
      ],
      credential,
    );

    let parsed: unknown;

    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error("GitHub CLI returned an invalid review thread response", {
        cause: error,
      });
    }

    return validateReviewThreadsResponse(parsed);
  }

  async findPullRequest(
    options: FindPullRequestOptions,
  ): Promise<PullRequest | null> {
    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "list",
        "--repo",
        options.repository,
        "--head",
        options.headBranch,
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
        "--jq",
        '.[0].url // ""',
      ],
      credential,
    );

    if (output.trim().length === 0) {
      return null;
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async updatePullRequestDescriptionStatus(
    options: PullRequestDescriptionStatusOptions,
  ): Promise<boolean> {
    const credential = await this.resolveCredential(options.project);
    const pullRequestUrl = parsePullRequestUrl(options.pullRequestUrl);
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "view",
        pullRequestUrl,
        "--repo",
        options.repository,
        "--json",
        "body",
      ],
      credential,
    );
    const currentBody = parsePullRequestBody(output);
    const nextBody = reconcileManagedPullRequestStatus(
      currentBody,
      options.status,
      options.project?.repository.defaultBranch ?? "main",
    );

    if (nextBody === currentBody) {
      return false;
    }

    // The body read immediately above is intentional: never write a body from an earlier poll.
    await this.run(
      options.cwd,
      [
        "pr",
        "edit",
        pullRequestUrl,
        "--repo",
        options.repository,
        "--body",
        nextBody,
      ],
      credential,
    );

    return true;
  }

  async findPullRequestState(
    options: FindPullRequestOptions,
  ): Promise<PullRequestState | null> {
    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "list",
        "--repo",
        options.repository,
        "--head",
        options.headBranch,
        ...(options.baseBranch === undefined
          ? []
          : ["--base", options.baseBranch]),
        "--state",
        "all",
        "--json",
        options.baseBranch === undefined
          ? GITHUB_CLI_PR_STATE_JSON_FIELDS.join(",")
          : GITHUB_CLI_PR_MAINTENANCE_JSON_FIELDS.join(","),
        "--limit",
        "1",
      ],
      credential,
    );

    const pullRequestOutput = output.trim();

    if (pullRequestOutput.length === 0) {
      return null;
    }

    let parsedPullRequests: unknown;

    try {
      parsedPullRequests = JSON.parse(pullRequestOutput);
    } catch (error) {
      throw new Error(
        "GitHub CLI returned an invalid pull request state list",
        {
          cause: error,
        },
      );
    }

    return (
      validatePullRequestStateList(
        parsedPullRequests,
        options.baseBranch !== undefined,
      )[0] ?? null
    );
  }

  async findChangesRequestedPullRequest(
    options: FindPullRequestOptions,
  ): Promise<ChangesRequestedPullRequest | null> {
    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "list",
        "--repo",
        options.repository,
        "--head",
        options.headBranch,
        ...(options.baseBranch === undefined
          ? []
          : ["--base", options.baseBranch]),
        "--state",
        "open",
        "--json",
        GITHUB_CLI_PR_REVIEW_JSON_FIELDS.join(","),
        "--limit",
        "1",
      ],
      credential,
    );

    const pullRequestOutput = output.trim();

    if (pullRequestOutput.length === 0) {
      return null;
    }

    const parsedPullRequests: unknown = JSON.parse(pullRequestOutput);
    const pullRequests = validatePullRequestList(parsedPullRequests);
    const pullRequest = pullRequests[0];

    if (!pullRequest || pullRequest.reviewDecision !== "CHANGES_REQUESTED") {
      return null;
    }

    const reviewOutput = await this.run(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/pulls/${pullRequest.number}/reviews`,
        "--paginate",
        "--slurp",
      ],
      credential,
    );

    const requestedChangesOutput = reviewOutput.trim();

    const reviews = parsePaginatedGitHubResponse(
      requestedChangesOutput,
      "paginated requested changes review response",
    )
      .filter(
        (review) => isRecord(review) && review.state === "CHANGES_REQUESTED",
      )
      .map(validateRequestedChangesReview)
      .sort((left, right) =>
        left.submittedAt < right.submittedAt
          ? -1
          : left.submittedAt > right.submittedAt
            ? 1
            : 0,
      );
    if (reviews.length === 0) {
      return null;
    }

    const currentHeadReviews = reviews.filter(
      (review) => review.commitId === pullRequest.headRefOid,
    );

    // Older reviews may carry inline threads forward, but cannot make the PR
    // actionable without a current-head requested-changes review.
    if (currentHeadReviews.length === 0) {
      return null;
    }

    const inlineCommentsOutput = await this.run(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/pulls/${pullRequest.number}/comments`,
        "--paginate",
        "--slurp",
      ],
      credential,
    );

    const inlineComments = parsePaginatedGitHubResponse(
      inlineCommentsOutput.trim(),
      "paginated inline review comment response",
    )
      .map(validateInlineReviewComment)
      .filter(
        (comment): comment is ValidatedInlineReviewComment & { body: string } =>
          reviews.some((review) => comment.reviewId === review.id) &&
          comment.body !== null &&
          comment.body.length > 0,
      );

    const earlierReviewIds = new Set(
      reviews
        .filter((review) => review.commitId !== pullRequest.headRefOid)
        .map((review) => review.id),
    );
    const carriedCommentsByReview = new Map<
      number,
      ValidatedReviewThreadComment[]
    >();
    const threadIdByCommentId = new Map<number, string>();
    const threadStateByCommentId = new Map<
      number,
      { isResolved: boolean; isOutdated: boolean }
    >();

    if (
      earlierReviewIds.size > 0 ||
      inlineComments.some((comment) => comment.id !== undefined)
    ) {
      const reviewThreads = await this.findReviewThreads(
        options,
        pullRequest.number,
        credential,
      );

      for (const thread of reviewThreads) {
        for (const comment of thread.comments) {
          threadIdByCommentId.set(comment.id, thread.id);
          threadStateByCommentId.set(comment.id, {
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
          });

          if (thread.isResolved || thread.isOutdated) {
            continue;
          }

          if (!earlierReviewIds.has(comment.reviewId)) {
            continue;
          }

          const comments = carriedCommentsByReview.get(comment.reviewId) ?? [];
          comments.push(comment);
          carriedCommentsByReview.set(comment.reviewId, comments);
        }
      }
    }

    const currentReviewFeedback = currentHeadReviews.map((review) => ({
      id: review.id,
      commitSha: review.commitId,
      body: review.body,
      author: review.author,
      submittedAt: review.submittedAt,
      inlineComments: inlineComments
        .filter((comment) => comment.reviewId === review.id)
        .map((comment): InlineReviewComment => {
          const threadId =
            comment.id === undefined
              ? undefined
              : threadIdByCommentId.get(comment.id);
          const threadState =
            comment.id === undefined
              ? undefined
              : threadStateByCommentId.get(comment.id);

          return {
            body: comment.body,
            author: comment.author,
            ...(comment.id === undefined ? {} : { id: comment.id }),
            ...(comment.reviewId === null
              ? {}
              : { reviewId: comment.reviewId }),
            ...(comment.commitSha === undefined
              ? {}
              : { commitSha: comment.commitSha }),
            ...(threadState === undefined ? {} : threadState),
            ...(threadId === undefined ? {} : { threadId }),
            ...(comment.path === undefined ? {} : { path: comment.path }),
            ...(comment.line === undefined ? {} : { line: comment.line }),
            ...(comment.originalLine === undefined
              ? {}
              : { originalLine: comment.originalLine }),
            ...(comment.diffHunk === undefined
              ? {}
              : { diffHunk: comment.diffHunk }),
          };
        }),
    }));

    const carriedReviewFeedback = reviews
      .filter((review) => review.commitId !== pullRequest.headRefOid)
      .flatMap((review) => {
        const comments = carriedCommentsByReview.get(review.id) ?? [];

        if (comments.length === 0) {
          return [];
        }

        return [
          {
            id: review.id,
            commitSha: review.commitId,
            body: null,
            author: review.author,
            submittedAt: review.submittedAt,
            source: "carried-forward" as const,
            inlineComments: comments.map((comment): InlineReviewComment => ({
              id: comment.id,
              reviewId: comment.reviewId,
              commitSha: review.commitId,
              isResolved: comment.isResolved,
              isOutdated: comment.isOutdated,
              body: comment.body,
              author: comment.author,
              threadId: comment.threadId,
              source: "carried-forward",
              ...(comment.path === undefined ? {} : { path: comment.path }),
              ...(comment.line === undefined ? {} : { line: comment.line }),
              ...(comment.originalLine === undefined
                ? {}
                : { originalLine: comment.originalLine }),
              ...(comment.diffHunk === undefined
                ? {}
                : { diffHunk: comment.diffHunk }),
            })),
          },
        ];
      });

    return {
      url: parsePullRequestUrl(pullRequest.url),
      headSha: pullRequest.headRefOid,
      feedback: {
        reviews: [...currentReviewFeedback, ...carriedReviewFeedback],
      },
    };
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<PullRequest> {
    const credential = await this.resolveCredential(options.project);
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "create",
        "--repo",
        options.repository,
        "--base",
        options.baseBranch,
        "--head",
        options.headBranch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      credential,
    );

    if (output.trim().length === 0) {
      throw new Error("GitHub CLI did not return a pull request URL");
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<void> {
    const credential = await this.resolveCredential(options.project);
    await this.run(
      options.cwd,
      [
        "pr",
        "merge",
        parsePullRequestUrl(options.pullRequestUrl),
        "--repo",
        options.repository,
        "--match-head-commit",
        options.commitSha,
        "--merge",
        "--delete-branch",
      ],
      credential,
    );
  }

  async validateCliCompatibility(
    projects: readonly ProjectConfig[],
  ): Promise<void> {
    await validateGitHubCliCompatibility(async (args, project) => {
      const credential = await this.resolveCredential(project);

      return this.run(process.cwd(), [...args], credential);
    }, projects);
  }
}
