import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildChildEnvironment } from "../process/child-environment.js";

import {
  canonicalizeGitHubRepository,
  type ProjectConfig,
} from "../config/config.js";
import type { CiCheckExpectationSource } from "./ci-check-expectations.js";
import { collectCiWorkflowExpectationSources } from "./ci-workflow-contract.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import {
  containsSecret,
  createSecretRedactor,
  redactError,
  redactRegisteredSecrets,
  redactSecrets,
} from "../security/redact-secrets.js";
import { getGitHubOperationProject } from "./github-operation-context.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectResourceError } from "../startup/project-resource-error.js";
import {
  beginProcessEvidence,
  drainProcessGroup,
  getProcessRuntime,
  processGroupExists,
  signalProcessGroup,
  appendBoundedOutput,
  ProcessEvidenceError,
  ProcessExecutionError,
  getProcessFailureDiagnostic,
} from "../process/process-runtime.js";
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

const GITHUB_TERMINATION_GRACE_MS = 5_000;

export interface CreatePullRequestOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
  project?: ProjectConfig;
}

export interface FindPullRequestOptions {
  cwd: string;
  repository: string;
  headBranch: string;
  baseBranch?: string;
  project?: ProjectConfig;
}

export interface GetPullRequestStateByNumberOptions {
  cwd: string;
  repository: string;
  pullRequestNumber: number;
  project?: ProjectConfig;
}

export interface GetPullRequestRecoveryEvidenceOptions {
  cwd: string;
  repository: string;
  pullRequestNumber: number;
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
  pullRequestNumber?: number;
  project?: ProjectConfig;
}

export interface CiObservationsResult {
  headSha: string;
  checks: CiCheckObservation[];
  expectationSources: CiCheckExpectationSource[];
}

export type PullRequestStatus = "OPEN" | "CLOSED" | "MERGED";

export type PullRequestBaseRelation =
  "current" | "behind" | "diverged" | "uncertain";

export interface PullRequestBaseRelationOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headSha: string;
  project?: ProjectConfig;
}

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
  baseRefOid?: string;
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

function parsePullRequestBody(
  output: string,
  origin?: GitHubOutputOrigin,
): string {
  const parsed = parseGitHubJson(output, origin, "pull request body");

  if (
    !isRecord(parsed) ||
    (typeof parsed.body !== "string" && parsed.body !== null)
  )
    throw new MalformedGitHubResponseError("pull request body", origin);

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
    const baseRefOid = item.baseRefOid;
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
      ...(typeof baseRefOid === "string" ? { baseRefOid } : {}),
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

export function parsePaginatedGitHubResponse(
  output: string,
  description: string,
  collectionProperty?: string,
  origin?: GitHubOutputOrigin,
): unknown[] {
  try {
    return parsePaginatedGitHubResponseUnsafe(
      output,
      description,
      collectionProperty,
      origin,
    );
  } catch (error) {
    if (error instanceof MalformedGitHubResponseError) throw error;
    throw new MalformedGitHubResponseError(description, origin);
  }
}

function parsePaginatedGitHubResponseUnsafe(
  output: string,
  description: string,
  collectionProperty?: string,
  origin?: GitHubOutputOrigin,
): unknown[] {
  const parsed = parseGitHubJson(output, origin, description);

  if (!Array.isArray(parsed)) {
    throw new Error(`GitHub CLI returned an invalid ${description}`);
  }

  if (collectionProperty === undefined) {
    if (!parsed.every((page) => Array.isArray(page))) {
      throw new Error(`GitHub CLI returned an invalid ${description}`);
    }
    return parsed.flat();
  }

  const values: unknown[] = [];
  for (const [index, page] of parsed.entries()) {
    if (!isRecord(page) || !Array.isArray(page[collectionProperty])) {
      throw new Error(
        `GitHub CLI returned an invalid ${description}: page ${index} must contain an array in '${collectionProperty}'`,
      );
    }
    values.push(...page[collectionProperty]);
  }
  return values;
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
  onSuccessfulOutput?: (origin: GitHubOutputOrigin) => void,
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

  const messages = errorChain(error).flatMap((entry) => {
    const diagnostic =
      entry instanceof ProcessExecutionError
        ? getProcessFailureDiagnostic(entry)
        : undefined;
    return [
      entry.message.toLowerCase(),
      ...(diagnostic === undefined ? [] : [diagnostic.toLowerCase()]),
    ];
  });
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

function parsePullRequestUrl(
  value: string,
  origin?: GitHubOutputOrigin,
): string {
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
  } catch {
    throw new MalformedPullRequestUrlError(origin);
  }

  return url;
}

export class MalformedPullRequestUrlError extends Error {
  public readonly executionId?: string;
  public readonly stdoutArtifactReference?: string;

  constructor(origin?: GitHubOutputOrigin) {
    super(
      "GitHub CLI returned an invalid pull request URL (malformed response)",
    );
    this.name = "MalformedPullRequestUrlError";
    if (origin !== undefined) {
      this.executionId = origin.executionId;
      this.stdoutArtifactReference = origin.stdoutArtifactReference;
    }
  }
}

export interface GitHubOutputOrigin {
  executionId: string;
  stdoutArtifactReference: string;
}

/** A successful gh invocation returned data that could not be safely consumed. */
export class MalformedGitHubResponseError extends Error {
  public readonly executionId?: string;
  public readonly stdoutArtifactReference?: string;

  constructor(
    description = "GitHub CLI response",
    origin?: GitHubOutputOrigin,
  ) {
    super(`GitHub CLI returned an invalid ${description}`);
    this.name = "MalformedGitHubResponseError";
    if (origin !== undefined) {
      this.executionId = origin.executionId;
      this.stdoutArtifactReference = origin.stdoutArtifactReference;
    }
  }
}

export function parseGitHubJson(
  output: string,
  origin?: GitHubOutputOrigin,
  description = "JSON response",
): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    // Never retain parser exceptions: their messages can contain the child output.
    throw new MalformedGitHubResponseError(description, origin);
  }
}

function validateGitHubJson<T>(
  output: string,
  validate: (value: unknown) => T,
  origin?: GitHubOutputOrigin,
  description = "JSON response",
): T {
  try {
    return validate(parseGitHubJson(output, origin, description));
  } catch (error) {
    if (error instanceof MalformedGitHubResponseError) throw error;
    throw new MalformedGitHubResponseError(description, origin);
  }
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
  onSuccessfulOutput,
) =>
  new Promise((resolve, reject) => {
    const runtime = getProcessRuntime();
    const timeoutMilliseconds =
      (getGitHubOperationProject()?.opencode.timeoutMinutes ??
        runtime.operationTimeoutMilliseconds / 60_000) * 60_000;
    const environmentSecrets = [
      environment?.GH_TOKEN,
      environment?.GITHUB_TOKEN,
      ...runtime.secretValues,
    ].filter((value): value is string => value !== undefined);
    const execution = beginProcessEvidence(
      `gh ${args.join(" ")}`,
      cwd,
      environmentSecrets,
    );
    const contentFlags = new Set([
      "--body",
      "--title",
      "--comment",
      "--message",
      "--subject",
      "--notes",
    ]);
    const safeArguments = args.map((argument, index) => {
      if (index > 0 && contentFlags.has(args[index - 1]!)) {
        return redactRegisteredSecrets(argument, environmentSecrets);
      }
      const separator = argument.indexOf("=");
      const flag = separator < 0 ? argument : argument.slice(0, separator);
      return separator > 0 && contentFlags.has(flag)
        ? `${flag}=${redactRegisteredSecrets(argument.slice(separator + 1), environmentSecrets)}`
        : argument;
    });
    const child = spawn("gh", safeArguments, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildChildEnvironment("github", environment),
    });

    let output = "";
    let errorOutput = "";
    let settled = false;
    let timedOut = false;
    let recorderFailure: Error | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const stdoutRedactor = createSecretRedactor(environmentSecrets);
    const stderrRedactor = createSecretRedactor(environmentSecrets);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const record = (stream: "stdout" | "stderr", text: string): void => {
      if (recorderFailure !== undefined || settled) return;
      try {
        execution.append(stream, text);
        if (execution.failure !== undefined) throw execution.failure;
        if (stream === "stdout")
          output = appendBoundedOutput(output, text, stream);
        else errorOutput = appendBoundedOutput(errorOutput, text, stream);
      } catch (error) {
        recorderFailure =
          error instanceof Error
            ? error
            : new ProcessEvidenceError("GitHub process recording failed");
        signalProcessGroup(child.pid, "SIGTERM", (signal) =>
          child.kill(signal),
        );
        forceKillTimeout = setTimeout(
          () =>
            signalProcessGroup(child.pid, "SIGKILL", (signal) =>
              child.kill(signal),
            ),
          GITHUB_TERMINATION_GRACE_MS,
        );
      }
    };

    let redactorsFlushed = false;
    const flushRedactors = (): void => {
      if (redactorsFlushed) return;
      redactorsFlushed = true;
      record("stdout", stdoutRedactor.push(stdoutDecoder.end()));
      record("stderr", stderrRedactor.push(stderrDecoder.end()));
      const stdoutRemainder = stdoutRedactor.flush();
      const stderrRemainder = stderrRedactor.flush();
      record("stdout", stdoutRemainder);
      record("stderr", stderrRemainder);
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM", (signal) => child.kill(signal));

      forceKillTimeout = setTimeout(() => {
        if (settled && !processGroupExists(child.pid)) {
          return;
        }

        signalProcessGroup(child.pid, "SIGKILL", (signal) =>
          child.kill(signal),
        );
      }, GITHUB_TERMINATION_GRACE_MS);
    }, timeoutMilliseconds);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = stdoutRedactor.push(
        typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk),
      );
      record("stdout", text);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = stderrRedactor.push(
        typeof chunk === "string" ? chunk : stderrDecoder.write(chunk),
      );
      record("stderr", text);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      flushRedactors();
      settled = true;
      try {
        execution.finish("spawn-failure", {
          pid: child.pid,
          error: redactSecrets(error.message, environmentSecrets),
        });
      } catch (finishError) {
        settled = true;
        clearTimeout(timeout);
        runtime.signal?.removeEventListener("abort", abort);
        reject(finishError);
        return;
      }
      clearTimeout(timeout);
      runtime.signal?.removeEventListener("abort", abort);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }

      reject(
        new ProcessExecutionError(
          "GitHub CLI",
          execution.executionId,
          "spawn-failure",
        ),
      );
    });

    child.once("close", async (code, signalName) => {
      if (settled) {
        return;
      }

      try {
        await drainProcessGroup(child.pid, (signal) => child.kill(signal));
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        runtime.signal?.removeEventListener("abort", abort);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        try {
          execution.finish("process-group-ambiguous", { pid: child.pid });
        } catch (finishError) {
          recorderFailure ??=
            finishError instanceof Error
              ? finishError
              : new ProcessEvidenceError(
                  "Process evidence finalization failed",
                );
        }
        reject(error);
        return;
      }
      if (settled) return;

      flushRedactors();
      settled = true;
      clearTimeout(timeout);
      runtime.signal?.removeEventListener("abort", abort);
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      const status = timedOut
        ? "timeout"
        : runtime.signal?.aborted
          ? "interrupted"
          : code === 0
            ? "success"
            : "nonzero";
      recorderFailure ??= execution.failure;
      try {
        execution.finish(
          recorderFailure === undefined ? status : "evidence-failure",
          {
            pid: child.pid,
            exitCode: code ?? 1,
            ...(signalName === null ? {} : { signal: signalName }),
          },
        );
      } catch (finishError) {
        reject(finishError);
        return;
      }
      recorderFailure ??= execution.failure;
      if (recorderFailure !== undefined) {
        reject(recorderFailure);
        return;
      }

      if (runtime.signal?.aborted) {
        reject(
          new Error("GitHub CLI execution interrupted by runtime shutdown"),
        );
        return;
      }

      if (timedOut) {
        reject(
          new ProcessExecutionError(
            "GitHub CLI",
            execution.executionId,
            "timeout",
          ),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new ProcessExecutionError(
            "GitHub CLI",
            execution.executionId,
            "nonzero",
            code ?? 1,
            signalName ?? undefined,
            errorOutput.trim(),
          ),
        );
        return;
      }

      onSuccessfulOutput?.({
        executionId: execution.executionId,
        stdoutArtifactReference: `process-executions/${execution.executionId}/stdout.txt`,
      });
      resolve(output.trim());
    });

    const abort = (): void => {
      if (settled) return;
      signalProcessGroup(child.pid, "SIGTERM", (signal) => child.kill(signal));
      forceKillTimeout = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL", (signal) =>
          child.kill(signal),
        );
      }, GITHUB_TERMINATION_GRACE_MS);
    };
    runtime.signal?.addEventListener("abort", abort, { once: true });
    if (runtime.signal?.aborted) abort();
  });

export class GitHubClient {
  private async sanitizeMutationBody(
    body: string,
    project?: ProjectConfig,
  ): Promise<string> {
    const credential = await this.resolveCredential(project);
    return sanitizeControlledText(
      redactRegisteredSecrets(body, [
        ...getProcessRuntime().secretValues,
        ...credential.secretValues,
      ]),
    );
  }
  private assertMutationPullRequest(
    authority: ProjectRunAuthority,
    repository: string,
    url: string,
  ): void {
    const run = authority.store.read()!;
    const number = getPullRequestNumberForRepository(url, repository);
    if (
      repository !== run.pinned.repository ||
      !run.resources.some(
        (resource) =>
          resource.kind === "pull-request" &&
          resource.id === String(number) &&
          resource.path === url,
      )
    )
      throw new Error("GitHub mutation differs from pinned task PR identity");
  }

  private async assertMutationOpen(options: {
    cwd: string;
    repository: string;
    pullRequestUrl: string;
    project?: ProjectConfig;
  }): Promise<void> {
    const state = await this.getPullRequestStateByNumber({
      ...options,
      pullRequestNumber: getPullRequestNumberForRepository(
        options.pullRequestUrl,
        options.repository,
      ),
    });
    if (state.state !== "OPEN")
      throw new Error("Terminal PR cannot accept new automated mutations");
  }
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
    onSuccessfulOutput?: (origin: GitHubOutputOrigin) => void,
  ): Promise<string> {
    const dispatch = async (): Promise<string> => {
      if (
        (args[0] === "pr" &&
          ["create", "edit", "ready"].includes(args[1] ?? "")) ||
        (args[0] === "api" &&
          ((args.includes("--method") &&
            args[args.indexOf("--method") + 1] !== "GET") ||
            args.some(
              (arg) =>
                arg.startsWith("query=") && /\bmutation\s*[({]/u.test(arg),
            )))
      )
        assertJournaledTransport();
      try {
        const canCaptureOrigin =
          onSuccessfulOutput !== undefined &&
          (this.runGitHubCommand === defaultRunGitHubCommand ||
            this.runGitHubCommand.length >= 4);
        const output = canCaptureOrigin
          ? await this.runGitHubCommand(
              cwd,
              args,
              Object.keys(credential.environment).length === 0
                ? undefined
                : credential.environment,
              onSuccessfulOutput,
            )
          : Object.keys(credential.environment).length === 0
            ? await this.runGitHubCommand(cwd, args)
            : await this.runGitHubCommand(cwd, args, credential.environment);

        return redactSecrets(output, credential.secretValues);
      } catch (error) {
        if (error instanceof ProcessExecutionError) throw error;
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
    };
    const projectId =
      getGitHubOperationProject()?.id ?? ProjectRunAuthority.currentProjectId();
    return projectId === undefined
      ? dispatch()
      : ProjectRunAuthority.dispatch(projectId, dispatch);
  }

  /** Runs one command and returns provenance captured by that invocation only. */
  private async runWithOrigin(
    cwd: string,
    args: string[],
    credential: GitHubCredential,
  ): Promise<{ output: string; origin?: GitHubOutputOrigin }> {
    let origin: GitHubOutputOrigin | undefined;
    const output = await this.run(cwd, args, credential, (value) => {
      origin = value;
    });
    return { output, ...(origin === undefined ? {} : { origin }) };
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
    const [checkRunsResult, statusesResult, branchRulesResult] =
      await Promise.all([
        this.runWithOrigin(
          options.cwd,
          ["api", "--paginate", "--slurp", checkRunsPath],
          credential,
        ),
        this.runWithOrigin(
          options.cwd,
          ["api", "--paginate", "--slurp", statusesPath],
          credential,
        ),
        this.runWithOrigin(
          options.cwd,
          ["api", branchRulesPath],
          credential,
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        ),
      ]);

    const checkRunPages = parsePaginatedGitHubResponse(
      checkRunsResult.output,
      "paginated check runs",
      "check_runs",
      checkRunsResult.origin,
    );

    const checks: CiCheckObservation[] = [];
    for (const value of checkRunPages) {
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
        throw new MalformedGitHubResponseError(
          "check runs",
          checkRunsResult.origin,
        );
      }
      if (value.head_sha !== options.headSha) {
        throw new MalformedGitHubResponseError(
          "check runs for a different commit SHA",
          checkRunsResult.origin,
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
      statusesResult.output,
      "paginated commit statuses",
      undefined,
      statusesResult.origin,
    );
    for (const value of statusValues) {
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
        throw new MalformedGitHubResponseError(
          "commit statuses",
          statusesResult.origin,
        );
      }
      if (value.sha !== options.headSha) {
        throw new MalformedGitHubResponseError(
          "commit statuses for a different commit SHA",
          statusesResult.origin,
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
    if ("result" in branchRulesResult) {
      try {
        const rules: unknown = parseGitHubJson(
          branchRulesResult.result.output,
          branchRulesResult.result.origin,
        );
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
      const workflowSources = collectCiWorkflowExpectationSources(
        options.cwd,
        options.baseBranch ?? options.defaultBranch,
      );
      const incompleteWorkflows = workflowSources.filter(
        (source) => !source.complete,
      );
      if (
        incompleteWorkflows.length > 0 &&
        options.pullRequestNumber !== undefined
      ) {
        const runtime = await this.getWorkflowRunJobs({
          cwd: options.cwd,
          repository: options.repository,
          pullRequestNumber: options.pullRequestNumber,
          headSha: options.headSha,
          credential,
        });
        if (runtime.discovered) {
          const resolvedIds = new Set(
            incompleteWorkflows.map(({ sourceId }) => sourceId),
          );
          expectationSources.push(
            ...workflowSources.filter(
              (source) => !resolvedIds.has(source.sourceId),
            ),
            {
              kind: "workflow-contract",
              sourceId: `workflow-runs:pull-request:${options.pullRequestNumber}:${options.headSha}`,
              complete: runtime.complete,
              checkNames: runtime.expectedNames,
              ...(runtime.complete
                ? {}
                : {
                    uncertainty:
                      runtime.uncertainty ??
                      "Applicable workflow jobs have not all reached a terminal state",
                  }),
            },
          );
        } else {
          expectationSources.push(...workflowSources);
        }
      } else {
        expectationSources.push(...workflowSources);
      }
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

  private async getWorkflowRunJobs(options: {
    cwd: string;
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    credential: GitHubCredential;
  }): Promise<{
    discovered: boolean;
    complete: boolean;
    expectedNames: string[];
    uncertainty?: string;
  }> {
    const query = new URLSearchParams({
      head_sha: options.headSha,
      per_page: "100",
    });
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${options.repository}/actions/runs?${query}`,
      ],
      options.credential,
    );
    const workflowRuns = parsePaginatedGitHubResponse(
      runResult.output,
      "workflow runs",
      "workflow_runs",
      runResult.origin,
    );
    const runs: Record<string, unknown>[] = [];
    let allRunsCompleted = true;
    for (const run of workflowRuns) {
      if (
        !isRecord(run) ||
        typeof run.id !== "number" ||
        typeof run.head_sha !== "string" ||
        typeof run.status !== "string" ||
        !Array.isArray(run.pull_requests)
      )
        throw new MalformedGitHubResponseError(
          "workflow runs",
          runResult.origin,
        );
      if (run.head_sha !== options.headSha) continue;
      const associated = run.pull_requests.some(
        (pr) => isRecord(pr) && Number(pr.number) === options.pullRequestNumber,
      );
      if (associated) {
        runs.push(run);
        if (run.status !== "completed") allRunsCompleted = false;
      }
    }
    if (runs.length === 0)
      return {
        discovered: false,
        complete: false,
        expectedNames: [],
      };

    const expectedNames = new Set<string>();
    let allJobsTerminal = true;
    for (const run of runs) {
      const jobsResult = await this.runWithOrigin(
        options.cwd,
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${options.repository}/actions/runs/${run.id}/jobs?per_page=100`,
        ],
        options.credential,
      );
      const jobPages = parsePaginatedGitHubResponse(
        jobsResult.output,
        "workflow jobs",
        "jobs",
        jobsResult.origin,
      );
      let jobCount = 0;
      for (const job of jobPages) {
        if (
          !isRecord(job) ||
          typeof job.name !== "string" ||
          job.name.trim().length === 0 ||
          typeof job.status !== "string" ||
          (job.conclusion !== null && typeof job.conclusion !== "string")
        )
          throw new MalformedGitHubResponseError(
            "workflow jobs",
            jobsResult.origin,
          );
        jobCount += 1;
        // A skipped job is authoritative evidence that this conditional branch did not apply.
        if (job.conclusion !== "skipped") expectedNames.add(job.name);
        if (
          job.status !== "completed" ||
          (job.conclusion !== "success" &&
            job.conclusion !== "failure" &&
            job.conclusion !== "cancelled" &&
            job.conclusion !== "skipped" &&
            job.conclusion !== "neutral" &&
            job.conclusion !== "timed_out" &&
            job.conclusion !== "action_required" &&
            job.conclusion !== "startup_failure")
        ) {
          allJobsTerminal = false;
        }
      }
      if (jobCount === 0)
        return {
          discovered: false,
          complete: false,
          expectedNames: [],
        };
    }
    const complete =
      allRunsCompleted && allJobsTerminal && expectedNames.size > 0;
    return {
      discovered: true,
      complete,
      expectedNames: [...expectedNames],
      ...(complete
        ? {}
        : {
            uncertainty: !allRunsCompleted
              ? "An applicable workflow run is still in progress"
              : !allJobsTerminal
                ? "An applicable workflow job is still in progress"
                : "Applicable workflow runs did not establish a non-skipped job set",
          }),
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
          const runResult = await this.runWithOrigin(
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
            runResult.output,
            "paginated check annotations",
            undefined,
            runResult.origin,
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
              throw new MalformedGitHubResponseError(
                "check annotations",
                runResult.origin,
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
    const runResult = await this.runWithOrigin(
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
      runResult.output,
      "paginated pull request conversation comments",
      undefined,
      runResult.origin,
    ).map((value): PullRequestConversationComment => {
      if (!isRecord(value)) {
        throw new MalformedGitHubResponseError(
          "pull request conversation comments",
          runResult.origin,
        );
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
        throw new MalformedGitHubResponseError(
          "pull request conversation comments",
          runResult.origin,
        );
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
    options = { ...options };
    const authority = mutationAuthority(options.project?.id);
    if (
      !consumeJournaledDispatch(authority, {
        route: "github-thread-reply",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          pullRequestUrl: options.pullRequestUrl,
          threadId: options.threadId,
          body: options.body,
        },
      }) &&
      authority
    ) {
      options = {
        ...options,
        body: await this.sanitizeMutationBody(options.body, options.project),
      };
      this.assertMutationPullRequest(
        authority,
        options.repository,
        options.pullRequestUrl,
      );
      const request = {
        route: "github-thread-reply",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          pullRequestUrl: options.pullRequestUrl,
          threadId: options.threadId,
          body: options.body,
        },
      };
      return workflowMutation({
        authority,
        kind: "github-reply",
        target: `${options.pullRequestUrl}:${options.threadId}`,
        request,
        preflight: () => this.assertMutationOpen(options),
        send: async (marker) => {
          return this.replyToReviewThread({
            ...options,
            body: `${options.body}\n\n${marker}`,
          });
        },
        observe: async (marker) => {
          const credential = await this.resolveCredential(options.project);
          const number = getPullRequestNumberForRepository(
            options.pullRequestUrl,
            options.repository,
          );
          const threads = await this.findReviewThreads(
            {
              cwd: options.cwd,
              repository: options.repository,
              headBranch: "mutation-readback",
              ...(options.project ? { project: options.project } : {}),
            },
            number,
            credential,
          );
          const comments =
            threads
              .find((thread) => thread.id === options.threadId)
              ?.comments.filter(
                (comment) => comment.body === `${options.body}\n\n${marker}`,
              ) ?? [];
          if (comments.length !== 1) return null;
          const result: GitHubContextualReply = {
            id: String(comments[0]!.id),
            kind: "review-thread",
            threadId: options.threadId,
          };
          return { id: result.id, fields: comments[0], result };
        },
      });
    }
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
    const dispatchedBody = redactRegisteredSecrets(options.body, [
      ...getProcessRuntime().secretValues,
      ...credential.secretValues,
    ]);
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
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `threadId=${options.threadId}`,
        "-F",
        `body=${dispatchedBody}`,
      ],
      credential,
    );
    let response: unknown;
    try {
      response = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "review-thread reply",
        runResult.origin,
      );
    }
    if (
      !isRecord(response) ||
      (response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !isRecord(response.data)
    ) {
      throw new MalformedGitHubResponseError(
        "review-thread reply",
        runResult.origin,
      );
    }
    const mutation = response.data.addPullRequestReviewThreadReply;
    const comment = isRecord(mutation) ? mutation.comment : undefined;
    const id = isRecord(comment) ? comment.databaseId : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new MalformedGitHubResponseError(
        "review-thread reply",
        runResult.origin,
      );
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
    options = { ...options };
    const authority = mutationAuthority(options.project?.id);
    if (
      !consumeJournaledDispatch(authority, {
        route: "github-conversation-reply",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          pullRequestUrl: options.pullRequestUrl,
          body: options.body,
        },
      }) &&
      authority
    ) {
      options = {
        ...options,
        body: await this.sanitizeMutationBody(options.body, options.project),
      };
      this.assertMutationPullRequest(
        authority,
        options.repository,
        options.pullRequestUrl,
      );
      return workflowMutation({
        authority,
        kind: "github-reply",
        target: options.pullRequestUrl,
        request: {
          route: "github-conversation-reply",
          args: {
            cwd: options.cwd,
            repository: options.repository,
            pullRequestUrl: options.pullRequestUrl,
            body: options.body,
          },
        },
        preflight: () => this.assertMutationOpen(options),
        send: async (marker) => {
          return this.replyToConversationComment({
            ...options,
            body: `${options.body}\n\n${marker}`,
          });
        },
        observe: async (marker) => {
          const comments = (
            await this.getPullRequestConversationComments(options)
          ).filter(
            (comment) => comment.body === `${options.body}\n\n${marker}`,
          );
          if (comments.length !== 1) return null;
          const result: GitHubContextualReply = {
            id: String(comments[0]!.id),
            kind: "conversation",
          };
          return { id: result.id, fields: comments[0], result };
        },
      });
    }
    const number = getPullRequestNumberForRepository(
      options.pullRequestUrl,
      options.repository,
    );
    if (options.body.trim().length === 0) {
      throw new Error("Conversation reply body must not be blank");
    }
    const credential = await this.resolveCredential(options.project);
    const dispatchedBody = redactRegisteredSecrets(options.body, [
      ...getProcessRuntime().secretValues,
      ...credential.secretValues,
    ]);
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        "--method",
        "POST",
        `repos/${options.repository}/issues/${number}/comments`,
        "-f",
        `body=${dispatchedBody}`,
      ],
      credential,
    );
    let response: unknown;
    try {
      response = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "conversation reply",
        runResult.origin,
      );
    }
    if (
      !isRecord(response) ||
      typeof response.id !== "number" ||
      !Number.isSafeInteger(response.id) ||
      response.id <= 0 ||
      typeof response.body !== "string" ||
      response.body !== dispatchedBody
    ) {
      throw new MalformedGitHubResponseError(
        "conversation reply",
        runResult.origin,
      );
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

    const runResult = await this.runWithOrigin(
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
      parsed = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "review thread response",
        runResult.origin,
      );
    }

    try {
      return validateReviewThreadsResponse(parsed);
    } catch {
      throw new MalformedGitHubResponseError(
        "review thread response",
        runResult.origin,
      );
    }
  }

  async findPullRequest(
    options: FindPullRequestOptions,
  ): Promise<PullRequest | null> {
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
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

    if (runResult.output.trim().length === 0) {
      return null;
    }

    return {
      url: parsePullRequestUrl(runResult.output, runResult.origin),
    };
  }

  async getPullRequestDescription(options: {
    cwd: string;
    repository: string;
    pullRequestUrl: string;
    project?: ProjectConfig;
  }): Promise<string> {
    const credential = await this.resolveCredential(options.project);
    const pullRequestUrl = parsePullRequestUrl(options.pullRequestUrl);
    const runResult = await this.runWithOrigin(
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
    return parsePullRequestBody(runResult.output, runResult.origin);
  }

  async editPullRequestDescription(options: {
    cwd: string;
    repository: string;
    pullRequestUrl: string;
    body: string;
    project?: ProjectConfig;
  }): Promise<void> {
    options = { ...options };
    const authority = mutationAuthority(options.project?.id);
    if (
      !consumeJournaledDispatch(authority, {
        route: "github-pr-body",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          pullRequestUrl: options.pullRequestUrl,
          body: options.body,
        },
      }) &&
      authority
    ) {
      options = {
        ...options,
        body: await this.sanitizeMutationBody(options.body, options.project),
      };
      this.assertMutationPullRequest(
        authority,
        options.repository,
        options.pullRequestUrl,
      );
      await workflowMutation({
        authority,
        kind: "github-pr-body",
        target: options.pullRequestUrl,
        request: {
          route: "github-pr-body",
          args: {
            cwd: options.cwd,
            repository: options.repository,
            pullRequestUrl: options.pullRequestUrl,
            body: options.body,
          },
        },
        preflight: () => this.assertMutationOpen(options),
        send: async () => {
          return this.editPullRequestDescription(options);
        },
        observe: async () => {
          const body = await this.getPullRequestDescription(options);
          return body === options.body
            ? { id: options.pullRequestUrl, fields: { body }, result: true }
            : null;
        },
      });
      return;
    }
    const credential = await this.resolveCredential(options.project);
    const pullRequestUrl = parsePullRequestUrl(options.pullRequestUrl);
    await this.run(
      options.cwd,
      [
        "pr",
        "edit",
        pullRequestUrl,
        "--repo",
        options.repository,
        "--body",
        options.body,
      ],
      credential,
    );
  }

  async updatePullRequestDescriptionStatus(
    options: PullRequestDescriptionStatusOptions,
  ): Promise<boolean> {
    rejectJournaledDispatch();
    const credential = await this.resolveCredential(options.project);
    const pullRequestUrl = parsePullRequestUrl(options.pullRequestUrl);
    const runResult = await this.runWithOrigin(
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
    const currentBody = parsePullRequestBody(
      runResult.output,
      runResult.origin,
    );
    const nextBody = reconcileManagedPullRequestStatus(
      currentBody,
      options.status,
      options.project?.repository.defaultBranch ?? "main",
    );

    if (nextBody === currentBody) {
      return false;
    }

    // The body read immediately above is intentional: never write a body from an earlier poll.
    await this.editPullRequestDescription({ ...options, body: nextBody });

    return true;
  }

  /**
   * Retrieve an exact PR identity by number, including after the head branch
   * was deleted. Never infer a terminal PR from the newest branch match.
   */
  async getPullRequestStateByNumber(
    options: GetPullRequestStateByNumberOptions,
  ): Promise<PullRequestState> {
    if (
      !Number.isSafeInteger(options.pullRequestNumber) ||
      options.pullRequestNumber < 1
    )
      throw new Error("PR number must be a positive integer");
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "pr",
        "view",
        String(options.pullRequestNumber),
        "--repo",
        options.repository,
        "--json",
        GITHUB_CLI_PR_MAINTENANCE_JSON_FIELDS.join(","),
      ],
      credential,
    );
    let parsed: unknown;
    try {
      parsed = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "numbered pull request",
        runResult.origin,
      );
    }
    let result: PullRequestState | undefined;
    try {
      result = validatePullRequestStateList([parsed])[0];
    } catch {
      throw new MalformedGitHubResponseError(
        "numbered pull request",
        runResult.origin,
      );
    }
    if (
      result === undefined ||
      !isRecord(parsed) ||
      (typeof parsed.headRefOid !== "string" &&
        !(result.state !== "OPEN" && parsed.headRefOid === null)) ||
      typeof parsed.headRefName !== "string" ||
      typeof parsed.baseRefName !== "string"
    )
      throw new MalformedGitHubResponseError(
        "numbered pull request",
        runResult.origin,
      );
    // Closed PRs can have null mergeability, which must not remove
    // their still-authoritative base/head names from the parsed identity.
    return {
      ...result,
      ...(typeof parsed.headRefOid === "string"
        ? { headRefOid: parsed.headRefOid }
        : {}),
      headRefName: parsed.headRefName,
      baseRefName: parsed.baseRefName,
    };
  }

  /** Check GitHub's authoritative commit graph, not only patch similarity. */
  async isAncestorCommit(options: {
    cwd: string;
    repository: string;
    ancestorSha: string;
    descendantSha: string;
    project?: ProjectConfig;
  }): Promise<boolean> {
    const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
    if (
      !shaPattern.test(options.ancestorSha) ||
      !shaPattern.test(options.descendantSha)
    )
      throw new Error("Commit ancestry requires valid Git commit identities");
    if (
      options.ancestorSha.toLowerCase() === options.descendantSha.toLowerCase()
    )
      return true;
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/compare/${options.ancestorSha}...${options.descendantSha}`,
      ],
      credential,
    );
    let response: unknown;
    try {
      response = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "commit comparison evidence",
        runResult.origin,
      );
    }
    if (
      !isRecord(response) ||
      typeof response.status !== "string" ||
      !isRecord(response.merge_base_commit) ||
      typeof response.merge_base_commit.sha !== "string"
    )
      throw new MalformedGitHubResponseError(
        "commit comparison evidence",
        runResult.origin,
      );
    return (
      response.status === "ahead" &&
      response.merge_base_commit.sha.toLowerCase() ===
        options.ancestorSha.toLowerCase()
    );
  }

  /** Returns the complete ordered commit list reported for a pull request. */
  async getPullRequestCommitShas(
    options: GetPullRequestRecoveryEvidenceOptions,
  ): Promise<string[]> {
    if (
      !Number.isSafeInteger(options.pullRequestNumber) ||
      options.pullRequestNumber < 1
    ) {
      throw new Error("PR number must be a positive integer");
    }
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${options.repository}/pulls/${options.pullRequestNumber}/commits?per_page=100`,
      ],
      credential,
    );
    const values = parsePaginatedGitHubResponse(
      runResult.output,
      "pull request commits",
      undefined,
      runResult.origin,
    );
    let shas: string[];
    try {
      shas = values.map((value) => {
        if (
          !isRecord(value) ||
          typeof value.sha !== "string" ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value.sha)
        ) {
          throw new Error("malformed commit");
        }
        return value.sha.toLowerCase();
      });
      if (shas.length === 0 || new Set(shas).size !== shas.length)
        throw new Error("missing or ambiguous commits");
    } catch {
      throw new MalformedGitHubResponseError(
        "pull request commit evidence",
        runResult.origin,
      );
    }
    return shas;
  }

  async findPullRequestState(
    options: FindPullRequestOptions,
  ): Promise<PullRequestState | null> {
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
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

    const pullRequestOutput = runResult.output.trim();

    if (pullRequestOutput.length === 0) {
      throw new MalformedGitHubResponseError(
        "pull request state list",
        runResult.origin,
      );
    }

    return (
      validateGitHubJson(
        pullRequestOutput,
        (value) =>
          validatePullRequestStateList(value, options.baseBranch !== undefined),
        runResult.origin,
        "pull request state list item",
      )[0] ?? null
    );
  }

  /** Resolve the actual current default-branch HEAD, not the PR's historical baseRefOid. */
  async getBaseBranchHeadSha(options: {
    cwd: string;
    repository: string;
    baseBranch: string;
    project?: ProjectConfig;
  }): Promise<string> {
    const credential = await this.resolveCredential(options.project);
    const runResult = await this.runWithOrigin(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/branches/${encodeURIComponent(options.baseBranch)}`,
      ],
      credential,
    );
    let parsed: unknown;
    try {
      parsed = parseGitHubJson(runResult.output, runResult.origin);
    } catch {
      throw new MalformedGitHubResponseError(
        "branch HEAD metadata",
        runResult.origin,
      );
    }
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.commit) ||
      typeof parsed.commit.sha !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(parsed.commit.sha)
    )
      throw new MalformedGitHubResponseError(
        "branch HEAD metadata",
        runResult.origin,
      );
    return parsed.commit.sha;
  }

  /** Compares the configured base with an exact PR head using GitHub's authoritative compare API. */
  async comparePullRequestHeadToBase(
    options: PullRequestBaseRelationOptions,
  ): Promise<PullRequestBaseRelation> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(options.headSha)) {
      return "uncertain";
    }
    let runResult: { output: string; origin?: GitHubOutputOrigin };
    try {
      const credential = await this.resolveCredential(options.project);
      const comparison = `${encodeURIComponent(options.baseBranch)}...${options.headSha}`;
      runResult = await this.runWithOrigin(
        options.cwd,
        ["api", `repos/${options.repository}/compare/${comparison}`],
        credential,
      );
    } catch {
      return "uncertain";
    }
    let parsed: unknown;
    try {
      parsed = parseGitHubJson(runResult.output, runResult.origin);
    } catch (error) {
      if (error instanceof MalformedGitHubResponseError) throw error;
      return "uncertain";
    }
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.base_commit) ||
      typeof parsed.base_commit.sha !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(parsed.base_commit.sha) ||
      !isRecord(parsed.merge_base_commit) ||
      typeof parsed.merge_base_commit.sha !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(parsed.merge_base_commit.sha) ||
      !Number.isSafeInteger(parsed.ahead_by) ||
      !Number.isSafeInteger(parsed.behind_by) ||
      (parsed.ahead_by as number) < 0 ||
      (parsed.behind_by as number) < 0 ||
      typeof parsed.status !== "string"
    ) {
      throw new MalformedGitHubResponseError(
        "commit comparison evidence",
        runResult.origin,
      );
    }
    if (parsed.status === "behind") return "behind";
    if (parsed.status === "diverged") return "diverged";
    if (parsed.status === "ahead" || parsed.status === "identical")
      return "current";
    return "uncertain";
  }

  async findChangesRequestedPullRequest(
    options: FindPullRequestOptions,
  ): Promise<ChangesRequestedPullRequest | null> {
    const credential = await this.resolveCredential(options.project);
    let pullRequestOrigin: GitHubOutputOrigin | undefined;
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
      (origin) => {
        pullRequestOrigin = origin;
      },
    );

    const pullRequestOutput = output.trim();

    if (pullRequestOutput.length === 0) {
      return null;
    }

    const pullRequests = validateGitHubJson(
      pullRequestOutput,
      validatePullRequestList,
      pullRequestOrigin,
      "pull request list",
    );
    const pullRequest = pullRequests[0];

    if (!pullRequest || pullRequest.reviewDecision !== "CHANGES_REQUESTED") {
      return null;
    }

    let reviewOrigin: GitHubOutputOrigin | undefined;
    const reviewOutput = await this.run(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/pulls/${pullRequest.number}/reviews`,
        "--paginate",
        "--slurp",
      ],
      credential,
      (origin) => {
        reviewOrigin = origin;
      },
    );

    const requestedChangesOutput = reviewOutput.trim();

    const reviews = parsePaginatedGitHubResponse(
      requestedChangesOutput,
      "paginated requested changes review response",
      undefined,
      reviewOrigin,
    )
      .filter(
        (review) => isRecord(review) && review.state === "CHANGES_REQUESTED",
      )
      .map((review) => {
        try {
          return validateRequestedChangesReview(review);
        } catch {
          throw new MalformedGitHubResponseError(
            "requested changes review",
            reviewOrigin,
          );
        }
      })
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

    let inlineCommentsOrigin: GitHubOutputOrigin | undefined;
    const inlineCommentsOutput = await this.run(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/pulls/${pullRequest.number}/comments`,
        "--paginate",
        "--slurp",
      ],
      credential,
      (origin) => {
        inlineCommentsOrigin = origin;
      },
    );

    const inlineComments = parsePaginatedGitHubResponse(
      inlineCommentsOutput.trim(),
      "paginated inline review comment response",
      undefined,
      inlineCommentsOrigin,
    )
      .map((comment) => {
        try {
          return validateInlineReviewComment(comment);
        } catch {
          throw new MalformedGitHubResponseError(
            "inline review comment",
            inlineCommentsOrigin,
          );
        }
      })
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

  async ensurePullRequestDraft(options: {
    cwd: string;
    repository: string;
    pullRequestUrl: string;
    project?: ProjectConfig;
  }): Promise<void> {
    options = { ...options };
    const authority = mutationAuthority(options.project?.id);
    if (
      !consumeJournaledDispatch(authority, {
        route: "github-pr-draft",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          pullRequestUrl: options.pullRequestUrl,
        },
      }) &&
      authority
    ) {
      this.assertMutationPullRequest(
        authority,
        options.repository,
        options.pullRequestUrl,
      );
      await workflowMutation({
        authority,
        kind: "github-pr-draft",
        target: options.pullRequestUrl,
        request: {
          route: "github-pr-draft",
          args: {
            cwd: options.cwd,
            repository: options.repository,
            pullRequestUrl: options.pullRequestUrl,
          },
        },
        preflight: () => this.assertMutationOpen(options),
        send: async () => {
          return this.ensurePullRequestDraft(options);
        },
        observe: async () => {
          const fields = await this.getPullRequestPublicationFields(options);
          return fields.isDraft
            ? { id: options.pullRequestUrl, fields, result: true }
            : null;
        },
      });
      return;
    }
    const credential = await this.resolveCredential(options.project);
    const url = parsePullRequestUrl(options.pullRequestUrl);
    const inspect = async (): Promise<boolean> => {
      const runResult = await this.runWithOrigin(
        options.cwd,
        [
          "pr",
          "view",
          url,
          "--repo",
          options.repository,
          "--json",
          "isDraft",
          "--jq",
          ".isDraft",
        ],
        credential,
      );
      if (
        runResult.output.trim() !== "true" &&
        runResult.output.trim() !== "false"
      )
        throw new MalformedGitHubResponseError(
          "pull request draft state",
          runResult.origin,
        );
      return runResult.output.trim() === "true";
    };
    if (await inspect()) return;
    await this.run(
      options.cwd,
      ["pr", "ready", url, "--undo", "--repo", options.repository],
      credential,
    );
    if (!(await inspect()))
      throw new Error(
        "GitHub did not confirm draft status for reused pull request",
      );
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<PullRequest> {
    options = { ...options };
    const authority = mutationAuthority(options.project?.id);
    if (
      !consumeJournaledDispatch(authority, {
        route: "github-pr-create",
        args: {
          cwd: options.cwd,
          repository: options.repository,
          baseBranch: options.baseBranch,
          headBranch: options.headBranch,
          title: options.title,
          body: options.body,
          draft: options.draft ?? false,
        },
      }) &&
      authority
    )
      throw new Error(
        "PR creation requires the initial publication reconciler",
      );
    const credential = await this.resolveCredential(options.project);
    let outputOrigin: GitHubOutputOrigin | undefined;
    const output = await this.run(
      options.cwd,
      [
        "pr",
        "create",
        ...(options.draft === true ? ["--draft"] : []),
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
      (origin) => {
        outputOrigin = origin;
      },
    );

    if (output.trim().length === 0) {
      throw new Error("GitHub CLI did not return a pull request URL");
    }

    return {
      url: parsePullRequestUrl(output, outputOrigin),
    };
  }

  /** Independent creation readback; a create response is never this evidence. */
  async getPullRequestPublicationFields(options: {
    cwd: string;
    repository: string;
    pullRequestUrl: string;
    project?: ProjectConfig;
  }): Promise<{ title: string; body: string; isDraft: boolean }> {
    getPullRequestNumberForRepository(
      options.pullRequestUrl,
      options.repository,
    );
    const credential = await this.resolveCredential(options.project);
    const result = await this.runWithOrigin(
      options.cwd,
      [
        "pr",
        "view",
        options.pullRequestUrl,
        "--repo",
        options.repository,
        "--json",
        "title,body,isDraft",
      ],
      credential,
    );
    return validateGitHubJson(
      result.output,
      (value) => {
        if (
          !isRecord(value) ||
          typeof value.title !== "string" ||
          typeof value.body !== "string" ||
          typeof value.isDraft !== "boolean"
        )
          throw new Error("Malformed publication fields");
        return { title: value.title, body: value.body, isDraft: value.isDraft };
      },
      result.origin,
      "pull request publication fields",
    );
  }

  async validateCliCompatibility(
    projects: readonly ProjectConfig[],
  ): Promise<void> {
    await validateGitHubCliCompatibility(async (args, project) => {
      const credential = await this.resolveCredential(project);
      const dispatch = () => this.run(process.cwd(), [...args], credential);
      return project === undefined
        ? dispatch()
        : ProjectRunAuthority.dispatch(project.id, dispatch);
    }, projects);
  }

  /** Project-scoped authenticated resource check; never changes repository state. */
  async validateRepositoryAccess(project: ProjectConfig): Promise<void> {
    let credential: GitHubCredential;
    try {
      credential = await this.resolveCredential(project);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "GitHub credential resolution failed";
      const status = message.match(/HTTP\s+(\d{3})/i)?.[1];
      throw new ProjectResourceError(
        status && Number(status) >= 500 ? "unavailable" : "invalid",
        `GitHub authentication check failed for project "${project.id}"${status ? ` (HTTP ${status})` : "; verify configured credentials"}`,
        error,
      );
    }
    let runResult: { output: string; origin?: GitHubOutputOrigin };
    try {
      runResult = await this.runWithOrigin(
        process.cwd(),
        ["repo", "view", project.repository.github, "--json", "nameWithOwner"],
        credential,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "GitHub repository lookup failed";
      const status = message.match(/(?:HTTP|status)\s+(401|403|404)\b/i)?.[1];
      const transient =
        /timed?\s*out|connection reset|connection refused|could not resolve|network|HTTP\s+5\d\d/i.test(
          message,
        );
      throw new ProjectResourceError(
        transient ? "unavailable" : "invalid",
        `GitHub repository access check failed for project "${project.id}" (${status ? `HTTP ${status}; verify repository and credentials` : transient ? "temporarily unavailable; retrying" : "verify repository access and credentials"})`,
        error,
      );
    }
    let actual: string;
    try {
      const parsed: unknown = parseGitHubJson(
        runResult.output,
        runResult.origin,
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { nameWithOwner?: unknown }).nameWithOwner !==
          "string"
      )
        throw new Error("malformed repository identity response");
      actual = canonicalizeGitHubRepository(
        (parsed as { nameWithOwner: string }).nameWithOwner,
      );
    } catch (error) {
      const safeError =
        error instanceof MalformedGitHubResponseError
          ? error
          : new MalformedGitHubResponseError(
              "repository identity response",
              runResult.origin,
            );
      throw new ProjectResourceError(
        "invalid",
        `GitHub returned a malformed repository identity for project "${project.id}"`,
        safeError,
      );
    }
    if (actual !== canonicalizeGitHubRepository(project.repository.github))
      throw new ProjectResourceError(
        "invalid",
        `GitHub repository identity mismatch for project "${project.id}"`,
      );
  }
}
import {
  mutationAuthority,
  consumeJournaledDispatch,
  assertJournaledTransport,
  rejectJournaledDispatch,
  workflowMutation,
} from "../task-session/workflow-mutation.js";
