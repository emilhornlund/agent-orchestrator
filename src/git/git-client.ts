import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type RunGit = (cwd: string, args: string[]) => Promise<string>;

const defaultRunGit: RunGit = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });

    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`, {
      cause: error,
    });
  }
};

export class GitClient {
  constructor(private readonly runGit: RunGit = defaultRunGit) {}

  async fetch(
    repositoryPath: string,
    remote: string,
    branch: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, ["fetch", remote, branch]);
  }

  async push(
    repositoryPath: string,
    remote: string,
    branch: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, [
      "push",
      "--set-upstream",
      remote,
      branch,
    ]);
  }

  async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const output = await this.runGit(repositoryPath, [
      "branch",
      "--list",
      branch,
    ]);

    return output.length > 0;
  }

  async getStatus(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
  }

  async hasChanges(repositoryPath: string): Promise<boolean> {
    return (await this.getStatus(repositoryPath)).length > 0;
  }

  async getHeadSha(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["rev-parse", "HEAD"]);
  }

  async getCurrentBranch(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["branch", "--show-current"]);
  }

  async addWorktree(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, [
      "worktree",
      "add",
      worktreePath,
      branch,
    ]);
  }

  async addWorktreeWithNewBranch(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      startPoint,
    ]);
  }

  async removeWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, ["worktree", "remove", worktreePath]);
  }

  async deleteBranch(repositoryPath: string, branch: string): Promise<void> {
    await this.runGit(repositoryPath, ["branch", "-D", branch]);
  }

  async pruneWorktrees(repositoryPath: string): Promise<void> {
    await this.runGit(repositoryPath, ["worktree", "prune"]);
  }

  async resetHard(repositoryPath: string): Promise<void> {
    await this.runGit(repositoryPath, ["reset", "--hard", "HEAD"]);
  }

  async cleanUntracked(repositoryPath: string): Promise<void> {
    await this.runGit(repositoryPath, ["clean", "-fd"]);
  }

  async remoteBranchExists(
    repositoryPath: string,
    remote: string,
    branch: string,
  ): Promise<boolean> {
    const output = await this.runGit(repositoryPath, [
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branch}`,
    ]);

    return output.length > 0;
  }

  async deleteRemoteBranch(
    repositoryPath: string,
    remote: string,
    branch: string,
  ): Promise<void> {
    await this.runGit(repositoryPath, ["push", remote, "--delete", branch]);
  }
}
