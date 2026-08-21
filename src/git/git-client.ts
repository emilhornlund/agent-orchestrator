import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunGit = (cwd: string, args: string[]) => Promise<string>;

const defaultRunGit: RunGit = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
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

  async fetch(repositoryPath: string, remote: string, branch: string) {
    await this.runGit(repositoryPath, ["fetch", remote, branch]);
  }

  async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const output = await this.runGit(repositoryPath, [
      "branch",
      "--list",
      branch,
    ]);

    return output.length > 0;
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
}
