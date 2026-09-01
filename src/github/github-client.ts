import { spawn } from "node:child_process";

const GITHUB_TIMEOUT_MS = 2 * 60 * 1000;
const GITHUB_TERMINATION_GRACE_MS = 5_000;

export interface CreatePullRequestOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

export interface MergePullRequestOptions {
  cwd: string;
  repository: string;
  pullRequestUrl: string;
  commitSha: string;
}

export interface FindPullRequestOptions {
  cwd: string;
  repository: string;
  headBranch: string;
}

export interface FindMergedPullRequestOptions {
  cwd: string;
  repository: string;
  headBranch: string;
}

export interface FindClosedPullRequestOptions {
  cwd: string;
  repository: string;
  headBranch: string;
}

export interface PullRequest {
  url: string;
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

export type RunGitHubCommand = (cwd: string, args: string[]) => Promise<string>;

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

const defaultRunGitHubCommand: RunGitHubCommand = async (cwd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;

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
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

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
            `GitHub CLI exited with code ${code ?? 1}: ${errorOutput.trim()}`,
          ),
        );
        return;
      }

      resolve(output.trim());
    });
  });

export class GitHubClient {
  constructor(
    private readonly runGitHubCommand: RunGitHubCommand = defaultRunGitHubCommand,
  ) {}

  async findPullRequest(
    options: FindPullRequestOptions,
  ): Promise<PullRequest | null> {
    const output = await this.runGitHubCommand(options.cwd, [
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
    ]);

    if (output.trim().length === 0) {
      return null;
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async findMergedPullRequest(
    options: FindMergedPullRequestOptions,
  ): Promise<PullRequest | null> {
    const output = await this.runGitHubCommand(options.cwd, [
      "pr",
      "list",
      "--repo",
      options.repository,
      "--head",
      options.headBranch,
      "--state",
      "merged",
      "--json",
      "url",
      "--limit",
      "1",
      "--jq",
      '.[0].url // ""',
    ]);

    if (output.trim().length === 0) {
      return null;
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async findClosedPullRequest(
    options: FindClosedPullRequestOptions,
  ): Promise<PullRequest | null> {
    const output = await this.runGitHubCommand(options.cwd, [
      "pr",
      "list",
      "--repo",
      options.repository,
      "--head",
      options.headBranch,
      "--state",
      "closed",
      "--json",
      "url",
      "--limit",
      "1",
      "--jq",
      '.[0].url // ""',
    ]);

    if (output.trim().length === 0) {
      return null;
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async findChangesRequestedPullRequest(
    options: FindPullRequestOptions,
  ): Promise<ChangesRequestedPullRequest | null> {
    const output = await this.runGitHubCommand(options.cwd, [
      "pr",
      "list",
      "--repo",
      options.repository,
      "--head",
      options.headBranch,
      "--state",
      "open",
      "--json",
      "url,number,reviewDecision,headRefOid",
      "--limit",
      "1",
    ]);

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

    const reviewOutput = await this.runGitHubCommand(options.cwd, [
      "api",
      `repos/${options.repository}/pulls/${pullRequest.number}/reviews`,
      "--paginate",
      "--slurp",
      "--jq",
      'flatten | map(select(.state == "CHANGES_REQUESTED")) | sort_by(.submitted_at) | last | {id, body, commitId: .commit_id, author: .user.login}',
    ]);

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

    const inlineComments = await this.runGitHubCommand(options.cwd, [
      "api",
      `repos/${options.repository}/pulls/${pullRequest.number}/comments`,
      "--paginate",
      "--slurp",
      "--jq",
      `flatten | map(select(.pull_request_review_id == ${review.id} and .body != null and .body != "")) | .[] | "\\(.user.login): \\(.body)"`,
    ]);

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
    const output = await this.runGitHubCommand(options.cwd, [
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
    ]);

    if (output.trim().length === 0) {
      throw new Error("GitHub CLI did not return a pull request URL");
    }

    return {
      url: parsePullRequestUrl(output),
    };
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<void> {
    await this.runGitHubCommand(options.cwd, [
      "pr",
      "merge",
      parsePullRequestUrl(options.pullRequestUrl),
      "--repo",
      options.repository,
      "--match-head-commit",
      options.commitSha,
      "--merge",
      "--delete-branch",
    ]);
  }
}
