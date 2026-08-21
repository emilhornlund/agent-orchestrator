import { spawn } from "node:child_process";

export interface CreatePullRequestOptions {
  cwd: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

export interface PullRequest {
  url: string;
}

export type RunGitHub = (
  options: CreatePullRequestOptions,
) => Promise<PullRequest>;

const defaultRunGitHub: RunGitHub = async ({
  cwd,
  repository,
  baseBranch,
  headBranch,
  title,
  body,
}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        baseBranch,
        "--head",
        headBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    let output = "";
    let errorOutput = "";

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
      reject(
        new Error(`Failed to start GitHub CLI: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `GitHub CLI exited with code ${code ?? 1}: ${errorOutput.trim()}`,
          ),
        );
        return;
      }

      const url = output.trim();

      if (url.length === 0) {
        reject(new Error("GitHub CLI did not return a pull request URL"));
        return;
      }

      resolve({ url });
    });
  });

export class GitHubClient {
  constructor(private readonly runGitHub: RunGitHub = defaultRunGitHub) {}

  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {
    return this.runGitHub(options);
  }
}
