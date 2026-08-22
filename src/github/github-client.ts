import { spawn } from "node:child_process";

const GITHUB_TIMEOUT_MS = 2 * 60 * 1000;

export interface CreatePullRequestOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
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

export type RunGitHubCommand = (cwd: string, args: string[]) => Promise<string>;

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

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      child.kill("SIGTERM");
    }, GITHUB_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      errorOutput += text;
      process.stderr.write(text);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

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

    if (output.length === 0) {
      return null;
    }

    return {
      url: output,
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

    if (output.length === 0) {
      return null;
    }

    return {
      url: output,
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

    if (output.length === 0) {
      return null;
    }

    return {
      url: output,
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

    if (output.length === 0) {
      return null;
    }

    const pullRequests = JSON.parse(output) as PullRequestReviewListItem[];
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

    if (reviewOutput.length === 0 || reviewOutput === "null") {
      return null;
    }

    const review = JSON.parse(reviewOutput) as RequestedChangesReview;

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
      url: pullRequest.url,
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

    if (output.length === 0) {
      throw new Error("GitHub CLI did not return a pull request URL");
    }

    return {
      url: output,
    };
  }
}
