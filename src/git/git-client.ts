import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectConfig } from "../config/config.js";
import { GitHubCredentialProvider } from "../github/github-credential-provider.js";
import { getGitHubOperationProject } from "../github/github-operation-context.js";
import {
  containsSecret,
  redactError,
  redactSecrets,
} from "../security/redact-secrets.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TASK_BRANCH_PREFIX = "agent/";

export interface GitIdentity {
  name: string;
  email: string;
  signingKey?: string | undefined;
}

export type GitEnvironment = Record<string, string>;

export interface GitRebaseState {
  active: true;
  backend: "merge" | "apply";
  headName: string;
  onto: string;
  originalHead: string;
  currentStep?: number | undefined;
  totalSteps?: number | undefined;
}

export type RunGit = (
  cwd: string,
  args: string[],
  environment?: GitEnvironment,
) => Promise<string>;

export function getGitIdentityEnvironment(
  identity: GitIdentity,
): GitEnvironment {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    ...(identity.signingKey === undefined
      ? {}
      : {
          GIT_CONFIG_COUNT: "3",
          GIT_CONFIG_KEY_0: "gpg.format",
          GIT_CONFIG_VALUE_0: "ssh",
          GIT_CONFIG_KEY_1: "user.signingKey",
          GIT_CONFIG_VALUE_1: identity.signingKey,
          GIT_CONFIG_KEY_2: "commit.gpgSign",
          GIT_CONFIG_VALUE_2: "true",
        }),
  };
}

const defaultRunGit: RunGit = async (cwd, args, environment) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      ...(environment === undefined
        ? {}
        : { env: { ...process.env, ...environment } }),
    });

    return stdout.trim();
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      [environment?.GH_TOKEN, environment?.GITHUB_TOKEN],
    );

    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`, {
      cause: error,
    });
  }
};

function assertOwnedTaskBranch(branch: string): void {
  const cardId =
    typeof branch === "string" && branch.startsWith(TASK_BRANCH_PREFIX)
      ? branch.slice(TASK_BRANCH_PREFIX.length)
      : "";

  if (
    cardId.length === 0 ||
    cardId === "." ||
    cardId === ".." ||
    cardId.includes("/") ||
    cardId.includes("\\") ||
    hasControlCharacter(cardId)
  ) {
    throw new Error(
      `Refusing force-with-lease update for non-owned branch "${branch}"; expected an agent/<card-id> branch`,
    );
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
}

export class GitClient {
  constructor(
    private readonly runGit: RunGit = defaultRunGit,
    private readonly credentials: GitHubCredentialProvider = new GitHubCredentialProvider(),
  ) {}

  private async runAuthenticated(
    cwd: string,
    args: string[],
    project?: ProjectConfig,
  ): Promise<string> {
    const operationProject = project ?? getGitHubOperationProject();

    const credential = await this.credentials.resolve(operationProject);
    const authenticatedArgs =
      credential.mode === "github-app"
        ? ["-c", "credential.helper=", ...args]
        : args;

    try {
      const output =
        Object.keys(credential.environment).length === 0
          ? await this.runGit(cwd, authenticatedArgs)
          : await this.runGit(cwd, authenticatedArgs, credential.environment);

      return redactSecrets(output, credential.secretValues);
    } catch (error) {
      const safeError = redactError(error, credential.secretValues);

      if (
        credential.mode === "ambient" &&
        error instanceof Error &&
        !containsSecret(error, credential.secretValues)
      ) {
        throw error;
      }

      // Do not retain the caught error: Git output may have included a credential.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeError.message, { cause: safeError });
    }
  }

  async isValidRepository(repositoryPath: string): Promise<boolean> {
    try {
      return (
        (
          await this.runGit(repositoryPath, [
            "rev-parse",
            "--is-inside-work-tree",
          ])
        ).trim() === "true"
      );
    } catch {
      return false;
    }
  }

  async fetch(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<void> {
    await this.runAuthenticated(
      repositoryPath,
      ["fetch", remote, branch],
      project,
    );
  }

  async rebase(
    repositoryPath: string,
    baseRef: string,
    identity: GitIdentity,
  ): Promise<void> {
    await this.runGit(
      repositoryPath,
      ["rebase", baseRef],
      getGitIdentityEnvironment(identity),
    );
  }

  async getConflictedPaths(repositoryPath: string): Promise<string[]> {
    const output = await this.runGit(repositoryPath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);

    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ];
  }

  async getRebaseState(repositoryPath: string): Promise<GitRebaseState | null> {
    const mergePath = await this.runGit(repositoryPath, [
      "rev-parse",
      "--git-path",
      "rebase-merge",
    ]);
    const applyPath = await this.runGit(repositoryPath, [
      "rev-parse",
      "--git-path",
      "rebase-apply",
    ]);
    const rebaseDirectories = [
      ["merge", mergePath],
      ["apply", applyPath],
    ] as const;
    const activeRebases = rebaseDirectories.filter(([, candidate]) =>
      fs.existsSync(path.resolve(repositoryPath, candidate)),
    );

    if (activeRebases.length === 0) {
      return null;
    }

    if (activeRebases.length > 1) {
      throw new Error("Git has multiple active rebase states");
    }

    const [backend, directory] = activeRebases[0]!;
    const readRequired = (name: string): string => {
      const value = fs
        .readFileSync(path.resolve(repositoryPath, directory, name), "utf8")
        .trim();

      if (value.length === 0) {
        throw new Error(`Git rebase state file ${name} is empty`);
      }

      return value;
    };
    const readStep = (name: string): number | undefined => {
      const candidate = path.resolve(repositoryPath, directory, name);

      if (!fs.existsSync(candidate)) {
        return undefined;
      }

      const value = Number(fs.readFileSync(candidate, "utf8").trim());

      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Git rebase state file ${name} is invalid`);
      }

      return value;
    };

    const currentStep = readStep(backend === "merge" ? "msgnum" : "next");
    const totalSteps = readStep(backend === "merge" ? "end" : "last");

    return {
      active: true,
      backend,
      headName: readRequired("head-name"),
      onto: readRequired("onto"),
      originalHead: readRequired("orig-head"),
      ...(currentStep === undefined ? {} : { currentStep }),
      ...(totalSteps === undefined ? {} : { totalSteps }),
    };
  }

  async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await this.runGit(repositoryPath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);

      return true;
    } catch {
      return false;
    }
  }

  async push(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<void> {
    await this.runAuthenticated(
      repositoryPath,
      ["push", "--set-upstream", remote, branch],
      project,
    );
  }

  async pushWithLease(
    repositoryPath: string,
    remote: string,
    branch: string,
    expectedRemoteSha: string,
    project?: ProjectConfig,
  ): Promise<void> {
    assertOwnedTaskBranch(branch);

    if (
      typeof expectedRemoteSha !== "string" ||
      expectedRemoteSha.trim().length === 0 ||
      expectedRemoteSha !== expectedRemoteSha.trim()
    ) {
      throw new Error(
        `Refusing force-with-lease update for ${branch}: an authoritative current remote SHA is required`,
      );
    }

    await this.runAuthenticated(
      repositoryPath,
      [
        "push",
        `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`,
        remote,
        branch,
      ],
      project,
    );
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

  async getChangedFiles(
    repositoryPath: string,
    baseRef: string,
  ): Promise<string> {
    return this.runGit(repositoryPath, [
      "diff",
      "--name-only",
      `${baseRef}...HEAD`,
    ]);
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

  async resetHardTo(repositoryPath: string, ref: string): Promise<void> {
    await this.runGit(repositoryPath, ["reset", "--hard", ref]);
  }

  async cleanUntracked(repositoryPath: string): Promise<void> {
    await this.runGit(repositoryPath, ["clean", "-fd"]);
  }

  async remoteBranchExists(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<boolean> {
    return (
      (await this.getRemoteBranchSha(
        repositoryPath,
        remote,
        branch,
        project,
      )) !== null
    );
  }

  async getRemoteBranchSha(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<string | null> {
    const output = await this.runAuthenticated(
      repositoryPath,
      ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
      project,
    );

    const remoteOutput = output.trim();

    if (remoteOutput.length === 0) {
      return null;
    }

    const lines = remoteOutput.split(/\r?\n/);

    if (lines.length !== 1) {
      throw new Error(
        `Git returned an invalid remote branch result for ${branch}`,
      );
    }

    const fields = lines[0]?.split(/\s+/);

    if (fields === undefined || fields.length !== 2) {
      throw new Error(
        `Git returned an invalid remote branch result for ${branch}`,
      );
    }

    const [sha, ref] = fields;

    if (
      sha === undefined ||
      sha.length === 0 ||
      ref !== `refs/heads/${branch}`
    ) {
      throw new Error(
        `Git returned an invalid remote branch result for ${branch}`,
      );
    }

    return sha;
  }

  async deleteRemoteBranch(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<void> {
    await this.runAuthenticated(
      repositoryPath,
      ["push", remote, "--delete", branch],
      project,
    );
  }
}
