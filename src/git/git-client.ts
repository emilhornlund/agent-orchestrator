import { spawn } from "node:child_process";
import { buildChildEnvironment } from "../process/child-environment.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalizeGitHubRepository,
  type ProjectConfig,
} from "../config/config.js";
import { GitHubCredentialProvider } from "../github/github-credential-provider.js";
import { getGitHubOperationProject } from "../github/github-operation-context.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  containsSecret,
  createSecretRedactor,
  redactError,
  redactSecrets,
} from "../security/redact-secrets.js";
import {
  haveEquivalentImplementationChanges,
  isCompletePullRequestCommitRange,
} from "./implementation-change-equivalence.js";
import {
  beginProcessEvidence,
  drainProcessGroup,
  getProcessRuntime,
  signalProcessGroup,
  appendBoundedOutput,
  ProcessEvidenceError,
  ProcessExecutionError,
} from "../process/process-runtime.js";

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
  const runtime = getProcessRuntime();
  const operationTimeoutMilliseconds =
    (getGitHubOperationProject()?.opencode.timeoutMinutes ??
      runtime.operationTimeoutMilliseconds / 60_000) * 60_000;
  const secretValues = [
    environment?.GH_TOKEN,
    environment?.GITHUB_TOKEN,
    ...runtime.secretValues,
  ].filter((value): value is string => value !== undefined);
  const execution = beginProcessEvidence(
    `git ${args.join(" ")}`,
    cwd,
    secretValues,
  );
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildChildEnvironment("git", environment),
    });
    const stdoutRedactor = createSecretRedactor(secretValues);
    const stderrRedactor = createSecretRedactor(secretValues);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let recorderFailure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (stream: "stdout" | "stderr", text: string): void => {
      if (recorderFailure !== undefined || settled) return;
      try {
        execution.append(stream, text);
        if (execution.failure !== undefined) throw execution.failure;
        if (stream === "stdout")
          stdout = appendBoundedOutput(stdout, text, stream);
        else stderr = appendBoundedOutput(stderr, text, stream);
      } catch (error) {
        recorderFailure =
          error instanceof Error
            ? error
            : new ProcessEvidenceError("Process recording failed");
        signalProcessGroup(child.pid, "SIGTERM", (signal) =>
          child.kill(signal),
        );
        killTimer = setTimeout(
          () =>
            signalProcessGroup(child.pid, "SIGKILL", (signal) =>
              child.kill(signal),
            ),
          5_000,
        );
      }
    };
    const flush = (): void => {
      append("stdout", stdoutRedactor.flush());
      append("stderr", stderrRedactor.flush());
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM", (signal) => child.kill(signal));
      killTimer = setTimeout(
        () =>
          signalProcessGroup(child.pid, "SIGKILL", (signal) =>
            child.kill(signal),
          ),
        5_000,
      );
    }, operationTimeoutMilliseconds);
    const abort = (): void => {
      if (settled) return;
      signalProcessGroup(child.pid, "SIGTERM", (signal) => child.kill(signal));
      killTimer = setTimeout(
        () =>
          signalProcessGroup(child.pid, "SIGKILL", (signal) =>
            child.kill(signal),
          ),
        5_000,
      );
    };
    runtime.signal?.addEventListener("abort", abort, { once: true });
    if (runtime.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) =>
      append("stdout", stdoutRedactor.push(chunk.toString())),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      append("stderr", stderrRedactor.push(chunk.toString())),
    );
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      flush();
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      runtime.signal?.removeEventListener("abort", abort);
      try {
        execution.finish("spawn-failure", {
          pid: child.pid,
          error: redactSecrets(error.message, secretValues),
        });
      } catch (finishError) {
        reject(finishError);
        return;
      }
      reject(
        new ProcessExecutionError(
          "Git",
          execution.executionId,
          "spawn-failure",
        ),
      );
    });
    child.once("close", async (code, signalName) => {
      if (settled) return;
      try {
        await drainProcessGroup(child.pid, (signal) => child.kill(signal));
      } catch (error) {
        if (settled) return;
        settled = true;
        flush();
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        runtime.signal?.removeEventListener("abort", abort);
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
      flush();
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      runtime.signal?.removeEventListener("abort", abort);
      const interrupted = runtime.signal?.aborted === true;
      try {
        execution.finish(
          recorderFailure !== undefined || execution.failure !== undefined
            ? "evidence-failure"
            : timedOut
              ? "timeout"
              : interrupted
                ? "interrupted"
                : code === 0
                  ? "success"
                  : "nonzero",
          {
            pid: child.pid,
            exitCode: code ?? 1,
            ...(signalName === null ? {} : { signal: signalName }),
          },
        );
      } catch (error) {
        recorderFailure ??=
          error instanceof Error
            ? error
            : new ProcessEvidenceError("Process evidence finalization failed");
      }
      recorderFailure ??= execution.failure;
      if (recorderFailure !== undefined) reject(recorderFailure);
      else if (timedOut || interrupted || code !== 0) {
        reject(
          new ProcessExecutionError(
            "Git",
            execution.executionId,
            timedOut ? "timeout" : interrupted ? "interrupted" : "nonzero",
            code ?? 1,
            signalName ?? undefined,
          ),
        );
      } else resolve(stdout.trim());
    });
  });
};

export class GitClient {
  private readonly runGit: RunGit;

  constructor(
    runGit: RunGit = defaultRunGit,
    private readonly credentials: GitHubCredentialProvider = new GitHubCredentialProvider(),
  ) {
    this.runGit = async (cwd, args, environment) => {
      const project = getGitHubOperationProject();
      const projectId = project?.id ?? ProjectRunAuthority.currentProjectId();
      const dispatch = () =>
        environment === undefined
          ? runGit(cwd, args)
          : runGit(cwd, args, environment);
      return projectId === undefined
        ? dispatch()
        : ProjectRunAuthority.dispatch(projectId, dispatch);
    };
  }

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

    const dispatch = async (): Promise<string> => {
      try {
        const output =
          Object.keys(credential.environment).length === 0
            ? await this.runGit(cwd, authenticatedArgs)
            : await this.runGit(cwd, authenticatedArgs, credential.environment);

        return redactSecrets(output, credential.secretValues);
      } catch (error) {
        if (error instanceof ProcessExecutionError) throw error;
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
    };
    return operationProject === undefined
      ? dispatch()
      : ProjectRunAuthority.dispatch(operationProject.id, dispatch);
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

  /** Read-only verification of the configured checkout's origin identity. */
  async assertOriginMatches(
    repositoryPath: string,
    expectedRepository: string,
  ): Promise<void> {
    const output = await this.runGit(repositoryPath, [
      "remote",
      "get-url",
      "origin",
    ]);
    const remote = output.trim().replace(/\.git$/iu, "");
    let actual: string;
    try {
      actual = canonicalizeGitHubRepository(remote);
    } catch (error) {
      throw new Error(
        `Repository origin is not a supported GitHub identity: ${remote}`,
        { cause: error },
      );
    }
    const expected = canonicalizeGitHubRepository(expectedRepository);
    if (actual !== expected)
      throw new Error(
        `Repository origin mismatch: configured ${expected}, checkout origin is ${actual}`,
      );
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
    void repositoryPath;
    void baseRef;
    void identity;
    throw new Error(
      "Git rebase is disabled by the P1 safety guardrail; preserve the worktree for additive maintenance in P8",
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
    void repositoryPath;
    void remote;
    void branch;
    void expectedRemoteSha;
    void project;
    throw new Error(
      "Force-with-lease pushes are disabled; published task history must not be rewritten",
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

  async getDiff(repositoryPath: string, staged = false): Promise<string> {
    return this.runGit(
      repositoryPath,
      staged ? ["diff", "--cached", "--binary"] : ["diff", "--binary"],
    );
  }

  async getUntrackedFiles(repositoryPath: string): Promise<string[]> {
    const output = await this.runGit(repositoryPath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ]);

    return output.split("\0").filter((filePath) => filePath.length > 0);
  }

  async getHeadTrackedFiles(repositoryPath: string): Promise<string[]> {
    const output = await this.runGit(repositoryPath, [
      "ls-tree",
      "--full-tree",
      "-r",
      "--name-only",
      "-z",
      "HEAD",
    ]);

    return output.split("\0").filter((filePath) => filePath.length > 0);
  }

  async getIndexEntries(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["ls-files", "--stage", "-z"]);
  }

  async hasChanges(repositoryPath: string): Promise<boolean> {
    return (await this.getStatus(repositoryPath)).length > 0;
  }

  async getHeadSha(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["rev-parse", "HEAD"]);
  }

  async getCommitParentSha(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["rev-parse", "HEAD^"]);
  }

  /** Verify the complete PR change set against the implementation in isolation. */
  async hasEquivalentImplementationCommit(options: {
    project: ProjectConfig;
    implementationCommit: string;
    pullRequestNumber: number;
    pullRequestHeadSha: string;
    pullRequestCommitShas: readonly string[];
  }): Promise<boolean> {
    const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
    if (
      !shaPattern.test(options.implementationCommit) ||
      !shaPattern.test(options.pullRequestHeadSha) ||
      options.pullRequestCommitShas.length === 0 ||
      options.pullRequestCommitShas.some((sha) => !shaPattern.test(sha)) ||
      new Set(options.pullRequestCommitShas).size !==
        options.pullRequestCommitShas.length ||
      !options.pullRequestCommitShas.some(
        (sha) => sha.toLowerCase() === options.pullRequestHeadSha.toLowerCase(),
      ) ||
      !Number.isSafeInteger(options.pullRequestNumber) ||
      options.pullRequestNumber < 1
    ) {
      throw new Error(
        "Implementation comparison requires identified commits and pull request",
      );
    }

    const temporaryRepository = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-recovery-git-"),
    );
    try {
      await this.runAuthenticated(
        temporaryRepository,
        ["init", "--quiet"],
        options.project,
      );
      await this.runAuthenticated(
        temporaryRepository,
        [
          "remote",
          "add",
          "origin",
          `https://github.com/${options.project.repository.github}.git`,
        ],
        options.project,
      );
      await this.runAuthenticated(
        temporaryRepository,
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          options.implementationCommit,
          `+refs/pull/${options.pullRequestNumber}/head:refs/recovery/pull-request`,
        ],
        options.project,
      );
      const fetchedHead = await this.runAuthenticated(
        temporaryRepository,
        ["rev-parse", "refs/recovery/pull-request"],
        options.project,
      );
      if (
        fetchedHead.toLowerCase() !== options.pullRequestHeadSha.toLowerCase()
      )
        return false;

      const originalParent = await this.runAuthenticated(
        temporaryRepository,
        ["rev-parse", `${options.implementationCommit}^`],
        options.project,
      );
      const prCommitSet = new Set(
        options.pullRequestCommitShas.map((sha) => sha.toLowerCase()),
      );
      const roots: string[] = [];
      for (const sha of options.pullRequestCommitShas) {
        const parent = await this.runAuthenticated(
          temporaryRepository,
          ["rev-parse", `${sha}^`],
          options.project,
        );
        if (!prCommitSet.has(parent.toLowerCase())) roots.push(sha);
      }
      if (roots.length !== 1) return false;
      const recoveredParent = await this.runAuthenticated(
        temporaryRepository,
        ["rev-parse", `${roots[0]}^`],
        options.project,
      );
      const rangeCommits = (
        await this.runAuthenticated(
          temporaryRepository,
          [
            "rev-list",
            "--reverse",
            `${recoveredParent}..${options.pullRequestHeadSha}`,
          ],
          options.project,
        )
      )
        .split("\n")
        .filter(Boolean)
        .map((sha) => sha.toLowerCase());
      if (
        !isCompletePullRequestCommitRange(
          options.pullRequestCommitShas,
          rangeCommits,
          options.pullRequestHeadSha,
        )
      ) {
        return false;
      }
      const originalPatch = await this.runAuthenticated(
        temporaryRepository,
        [
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--no-color",
          "--unified=3",
          originalParent,
          options.implementationCommit,
        ],
        options.project,
      );
      const recoveredPatch = await this.runAuthenticated(
        temporaryRepository,
        [
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--no-color",
          "--unified=3",
          recoveredParent,
          options.pullRequestHeadSha,
        ],
        options.project,
      );
      return haveEquivalentImplementationChanges(originalPatch, recoveredPatch);
    } finally {
      fs.rmSync(temporaryRepository, { recursive: true, force: true });
    }
  }

  async getCommonGitDirectory(repositoryPath: string): Promise<string> {
    const directory = await this.runGit(repositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return path.resolve(repositoryPath, directory);
  }

  async resolveCommitSha(
    repositoryPath: string,
    revision: string,
  ): Promise<string> {
    return this.runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ]);
  }

  async getRefSha(repositoryPath: string, ref: string): Promise<string | null> {
    const name = await this.runGit(repositoryPath, [
      "for-each-ref",
      "--format=%(refname)",
      ref,
    ]);
    if (name.trim() !== ref) return null;
    return this.resolveCommitSha(repositoryPath, ref);
  }

  async createRefIfAbsent(
    repositoryPath: string,
    ref: string,
    sha: string,
  ): Promise<void> {
    const zero = "0".repeat(sha.length);
    await this.runGit(repositoryPath, ["update-ref", ref, sha, zero]);
  }

  async getCommitMessage(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["log", "-1", "--format=%B"]);
  }

  async stageAll(repositoryPath: string): Promise<void> {
    await this.runGit(repositoryPath, ["add", "-A"]);
  }

  async commit(
    repositoryPath: string,
    messageFilePath: string,
    identity: GitIdentity,
  ): Promise<void> {
    await this.runGit(
      repositoryPath,
      ["commit", "-F", messageFilePath],
      getGitIdentityEnvironment(identity),
    );
  }

  async getCommitCountBetween(
    repositoryPath: string,
    fromExclusive: string,
    toInclusive: string,
  ): Promise<number> {
    const output = await this.runGit(repositoryPath, [
      "rev-list",
      "--count",
      `${fromExclusive}..${toInclusive}`,
    ]);
    const count = Number(output.trim());

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Git returned an invalid commit count: ${output}`);
    }

    return count;
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
