import { spawn } from "node:child_process";

import type { ProjectConfig } from "../config/config.js";
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

export interface PullRequest {
  url: string;
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

export interface PullRequestState extends PullRequest {
  state: PullRequestStatus;
  mergedAt: string | null;
  baseRefName?: string;
  headRefName?: string;
  mergeable?: PullRequestMergeability;
  mergeStateStatus?: PullRequestMergeStateStatus;
}

export interface ChangesRequestedPullRequest extends PullRequest {
  feedback: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    const mergeable = item.mergeable;
    const mergeStateStatus = item.mergeStateStatus;
    const requiresMaintenanceFacts =
      requireMaintenanceFacts && state === "OPEN";

    if (
      typeof url !== "string" ||
      (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
      (typeof mergedAt !== "string" && mergedAt !== null) ||
      (requiresMaintenanceFacts &&
        (typeof baseRefName !== "string" ||
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
  const commitId = value.commitId;
  const author = value.author;

  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    (typeof body !== "string" && body !== null) ||
    typeof commitId !== "string" ||
    commitId.length === 0 ||
    (typeof author !== "string" && author !== null)
  ) {
    throw new Error("GitHub CLI returned an invalid requested changes review");
  }

  return {
    id,
    body,
    commitId,
    author,
  };
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
          ? "url,state,mergedAt"
          : "url,state,mergedAt,baseRefName,headRefName,mergeable,mergeStateStatus",
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
        "url,number,reviewDecision,headRefOid",
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
        "--jq",
        'flatten | map(select(.state == "CHANGES_REQUESTED")) | sort_by(.submitted_at) | last | {id, body, commitId: .commit_id, author: .user.login}',
      ],
      credential,
    );

    const requestedChangesOutput = reviewOutput.trim();

    if (
      requestedChangesOutput.length === 0 ||
      requestedChangesOutput === "null"
    ) {
      return null;
    }

    const review = validateRequestedChangesReview(
      JSON.parse(requestedChangesOutput),
    );

    if (review.commitId !== pullRequest.headRefOid) {
      return null;
    }

    const inlineComments = await this.run(
      options.cwd,
      [
        "api",
        `repos/${options.repository}/pulls/${pullRequest.number}/comments`,
        "--paginate",
        "--slurp",
        "--jq",
        `flatten | map(select(.pull_request_review_id == ${review.id} and .body != null and .body != "")) | .[] | "\\(.user.login): \\(.body)"`,
      ],
      credential,
    );

    const feedbackParts: string[] = [];

    if (review.body?.trim()) {
      const author = review.author ?? "reviewer";

      feedbackParts.push(`${author}: ${review.body.trim()}`);
    }

    if (inlineComments.length > 0) {
      feedbackParts.push(`Inline review comments:\n${inlineComments}`);
    }

    const feedback =
      feedbackParts.length > 0
        ? feedbackParts.join("\n\n")
        : "Changes were requested on GitHub, but no written review feedback was returned.";

    return {
      url: parsePullRequestUrl(pullRequest.url),
      feedback,
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
}
