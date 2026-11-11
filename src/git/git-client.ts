import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { buildChildEnvironment } from "../process/child-environment.js";
import fs from "node:fs";
import { runTaskResources } from "../task-session/task-resources.js";
import { ObservedPrTerminalError } from "../task-session/terminal-pr-fence.js";
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
  mutationAuthority,
  consumeJournaledDispatch,
  assertJournaledTransport,
  rejectJournaledDispatch,
  workflowMutation,
} from "../task-session/workflow-mutation.js";
import type { GitMutationRequest } from "./git-mutation-request.js";
import {
  containsSecret,
  createSecretRedactor,
  redactError,
  redactSecrets,
  sanitizeControlledText,
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

export interface GitPublicationDestinations {
  fetch: string;
  push: string;
}

/** Verbatim Git commits still need a final LF. Preserve all other whitespace;
 * never let repository commit.cleanup choose the journal's message semantics. */
export function prepareVerbatimCommitMessage(message: string): string {
  if (!message.trim() || message.includes("\0"))
    throw new Error("Invalid publication commit message");
  return message.endsWith("\n") ? message : `${message}\n`;
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
  signalOverride?: AbortSignal | null,
) => Promise<string>;

export function getGitIdentityEnvironment(
  identity: GitIdentity,
): GitEnvironment {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

const defaultRunGit: RunGit = async (
  cwd,
  args,
  environment,
  signalOverride,
) => {
  const runtime = getProcessRuntime();
  const signal =
    signalOverride === null ? undefined : (signalOverride ?? runtime.signal);
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
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
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
      append("stdout", stdoutRedactor.push(stdoutDecoder.end()));
      append("stderr", stderrRedactor.push(stderrDecoder.end()));
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
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer | string) =>
      append(
        "stdout",
        stdoutRedactor.push(
          typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk),
        ),
      ),
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      append(
        "stderr",
        stderrRedactor.push(
          typeof chunk === "string" ? chunk : stderrDecoder.write(chunk),
        ),
      ),
    );
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      flush();
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
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
        signal?.removeEventListener("abort", abort);
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
      signal?.removeEventListener("abort", abort);
      const interrupted = signal?.aborted === true;
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
  /** Concrete Git journal readback. Requests contain objects/refs, never shell
   * commands. Reconciliation observes the original object, not today's HEAD. */
  async reconcileMutation(
    request: GitMutationRequest,
    project?: ProjectConfig,
  ): Promise<void> {
    rejectJournaledDispatch();
    const authority = mutationAuthority(project?.id);
    if (!authority)
      throw new Error("Git reconciliation requires attempt authority");
    const run = authority.store.read()!;
    const args = request.args;
    const { branch, path: worktree } = runTaskResources(run);
    if (request.route === "git-worktree") {
      const value = request.args;
      if (
        value.cwd !== run.pinned.repositoryPath ||
        value.worktree !== worktree ||
        value.branch !== branch ||
        !run.resources.some(
          (resource) =>
            resource.kind === "worktree" && resource.path === worktree,
        )
      )
        throw new Error(
          "Worktree creation differs from attempt resource intent",
        );
      await workflowMutation({
        authority,
        kind: "git-worktree",
        target: `git:worktree:${encodeURIComponent(worktree)}`,
        request,
        send: async () => {
          if (value.createBranch)
            await this.addWorktreeWithNewBranch(
              value.cwd,
              value.worktree,
              value.branch,
              value.start,
            );
          else {
            if (
              (await this.getRefSha(
                value.cwd,
                `refs/heads/${value.branch}`,
              )) !== value.start
            )
              throw new Error("Worktree branch changed after intent");
            await this.addWorktree(value.cwd, value.worktree, value.branch);
          }
        },
        observe: async () => {
          if (
            !fs.existsSync(value.worktree) ||
            fs.lstatSync(value.worktree).isSymbolicLink()
          )
            return null;
          const actual = {
            branch: await this.getCurrentBranch(value.worktree),
            sha: await this.getHeadSha(value.worktree),
            common: await this.getCommonGitDirectory(value.worktree),
          };
          return actual.branch === value.branch &&
            actual.sha === value.start &&
            actual.common === (await this.getCommonGitDirectory(value.cwd))
            ? { id: value.worktree, fields: actual, result: true }
            : null;
        },
      });
      return;
    }
    if (
      request.route !== "git-cleanup" &&
      (args.cwd !== worktree || request.args.branch !== branch)
    )
      throw new Error("Git mutation differs from pinned task worktree/branch");
    if (
      request.route === "git-cleanup" &&
      (args.cwd !== run.pinned.repositoryPath ||
        !run.resources.some(
          (resource) =>
            resource.kind ===
              (request.args.kind === "worktree" ? "worktree" : "branch") &&
            resource.path ===
              (request.args.kind === "worktree"
                ? request.args.resource
                : `refs/heads/${request.args.resource}`),
        ))
    )
      throw new Error("Cleanup resource is not owned by this attempt");
    const common = await this.getCommonGitDirectory(run.pinned.repositoryPath);
    if (
      request.route !== "git-cleanup" &&
      (await this.getCommonGitDirectory(args.cwd)) !== common
    )
      throw new Error("Git common repository differs from attempt");
    const verifyDestination = async (destination: string, fetch?: string) => {
      const actual = await this.resolvePublicationDestinations(
        args.cwd,
        run.pinned.repository,
      );
      if (
        actual.push !== destination ||
        (fetch !== undefined && actual.fetch !== fetch)
      )
        throw new Error("Git destination changed after intent");
    };
    if (request.route === "git-commit") {
      const value = request.args;
      await workflowMutation({
        authority,
        kind: "git-commit",
        target: `git:${branch}`,
        request,
        send: async () => {
          if (
            (await this.getHeadSha(value.cwd)) !== value.parent ||
            (await this.getIndexTreeSha(value.cwd)) !== value.tree ||
            (await this.getCurrentBranch(value.cwd)) !== value.branch ||
            (await this.getRefSha(value.cwd, `refs/heads/${value.branch}`)) !==
              value.parent
          )
            throw new Error("Commit inputs changed after intent");
          const temporary = fs.mkdtempSync(
            path.join(os.tmpdir(), "orchestrator-journal-commit-"),
          );
          const messagePath = path.join(temporary, "message");
          try {
            fs.writeFileSync(messagePath, value.message, { mode: 0o600 });
            await this.commit(
              value.cwd,
              messagePath,
              value.identity,
              "verbatim",
            );
          } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
          }
        },
        observe: async () => {
          const parents = await this.getCommitParentShas(value.cwd);
          const sha = await this.getHeadSha(value.cwd);
          return parents.length === 1 &&
            (await this.getCurrentBranch(value.cwd)) === value.branch &&
            (await this.getRefSha(value.cwd, `refs/heads/${value.branch}`)) ===
              sha &&
            parents[0] === value.parent &&
            (await this.getCommitTreeSha(value.cwd)) === value.tree &&
            (await this.getVerbatimCommitMessage(value.cwd)) ===
              value.message &&
            !(await this.hasChanges(value.cwd))
            ? {
                id: sha,
                fields: {
                  sha,
                  parents,
                  tree: value.tree,
                  message: value.message,
                  branch: value.branch,
                  ref: `refs/heads/${value.branch}`,
                },
                result: true,
              }
            : null;
        },
      });
    } else if (request.route === "git-push") {
      const value = request.args;
      await workflowMutation({
        authority,
        kind: "git-push",
        target: `git:${value.destination}:${value.branch}`,
        request,
        send: async () => {
          await verifyDestination(value.destination, value.fetch);
          if (
            (await this.getHeadSha(value.cwd)) !== value.sha ||
            (await this.getCurrentBranch(value.cwd)) !== value.branch ||
            (await this.getRefSha(value.cwd, `refs/heads/${value.branch}`)) !==
              value.sha
          )
            throw new Error("Push task branch/ref changed after intent");
          await this.push(
            value.cwd,
            value.destination,
            value.branch,
            project,
            value.sha,
          );
        },
        observe: async () => {
          await verifyDestination(value.destination, value.fetch);
          const sha = await this.getRemoteBranchSha(
            value.cwd,
            value.destination,
            value.branch,
            project,
          );
          return sha === value.sha
            ? {
                id: sha,
                fields: {
                  sha,
                  destination: value.destination,
                  ref: `refs/heads/${value.branch}`,
                },
                result: true,
              }
            : null;
        },
      });
    } else {
      const value = request.args;
      await workflowMutation({
        authority,
        kind: "git-cleanup",
        target: `git:${value.kind}:${encodeURIComponent(value.resource)}`,
        request,
        send: async () => {
          if (value.kind === "worktree") {
            if (!fs.existsSync(value.resource)) return;
            if (
              fs.lstatSync(value.resource).isSymbolicLink() ||
              (await this.getCommonGitDirectory(value.resource)) !== common ||
              (await this.getCurrentBranch(value.resource)) !== branch ||
              (await this.getHeadSha(value.resource)) !== value.sha ||
              (await this.getCleanupStatus(value.resource)).trim() !== ""
            )
              throw new Error("Unsafe worktree cleanup");
            await this.removeWorktree(value.cwd, value.resource);
          } else if (value.kind === "branch") {
            const actual = await this.getRefSha(
              value.cwd,
              `refs/heads/${value.resource}`,
            );
            if (actual === null) return;
            if (actual !== value.sha)
              throw new Error("Cleanup branch changed after intent");
            if (value.sha !== null)
              await this.deleteBranch(value.cwd, value.resource);
          } else {
            if (!value.destination)
              throw new Error("Remote cleanup destination missing");
            await verifyDestination(value.destination);
            const actual = await this.getRemoteBranchSha(
              value.cwd,
              value.destination,
              value.resource,
              project,
            );
            if (actual === null) return;
            if (actual !== value.sha)
              throw new Error("Remote cleanup ref changed after intent");
            if (value.sha !== null)
              await this.deleteRemoteBranch(
                value.cwd,
                value.destination,
                value.resource,
                project,
                value.sha ?? undefined,
              );
          }
        },
        observe: async () => {
          let absent: boolean;
          if (value.kind === "worktree") {
            const registrations = await this.runGit(value.cwd, [
              "worktree",
              "list",
              "--porcelain",
            ]);
            absent =
              !fs.existsSync(value.resource) &&
              !registrations.split("\n").includes(`worktree ${value.resource}`);
          } else if (value.kind === "branch")
            absent =
              (await this.getRefSha(
                value.cwd,
                `refs/heads/${value.resource}`,
              )) === null;
          else {
            if (!value.destination)
              throw new Error("Remote cleanup destination missing");
            await verifyDestination(value.destination);
            absent =
              (await this.getRemoteBranchSha(
                value.cwd,
                value.destination,
                value.resource,
                project,
              )) === null;
          }
          return absent
            ? {
                id: `removed:${encodeURIComponent(value.resource)}`,
                fields: { absent, resource: value.resource, kind: value.kind },
                result: true,
              }
            : null;
        },
      });
    }
  }
  private readonly runGit: RunGit;

  constructor(
    runGit: RunGit = defaultRunGit,
    private readonly credentials: GitHubCredentialProvider = new GitHubCredentialProvider(),
  ) {
    this.runGit = async (cwd, args, environment, signalOverride) => {
      const project = getGitHubOperationProject();
      const projectId = project?.id ?? ProjectRunAuthority.currentProjectId();
      const dispatch = () => {
        let commandIndex = 0;
        while (args[commandIndex] === "-c") commandIndex += 2;
        const command = args[commandIndex];
        if (
          [
            "push",
            "commit",
            "add",
            "reset",
            "clean",
            "update-ref",
            "fetch",
            "init",
          ].includes(command ?? "") ||
          (command === "worktree" &&
            ["add", "remove", "prune"].includes(
              args[commandIndex + 1] ?? "",
            )) ||
          (command === "branch" && args[commandIndex + 1] === "-D") ||
          (command === "remote" && args[commandIndex + 1] === "add")
        )
          assertJournaledTransport();
        if (signalOverride !== undefined)
          return environment === undefined
            ? runGit(cwd, args, undefined, signalOverride)
            : runGit(cwd, args, environment, signalOverride);
        return environment === undefined
          ? runGit(cwd, args)
          : runGit(cwd, args, environment);
      };
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
        if (
          error instanceof ProcessExecutionError ||
          error instanceof ObservedPrTerminalError
        )
          throw error;
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

  /** Resolve Git's effective destinations (including insteadOf/pushInsteadOf),
   * not merely remote.origin.url. Multiple push URLs mean multiple effects and
   * are refused, even when they spell the same repository. Returned URLs are
   * terminal under rewriting so passing them explicitly cannot rewrite twice. */
  async resolvePublicationDestinations(
    repositoryPath: string,
    expectedRepository: string,
  ): Promise<GitPublicationDestinations> {
    const expected = canonicalizeGitHubRepository(expectedRepository);
    const configured = await this.runGit(repositoryPath, [
      "config",
      "--null",
      "--get-regexp",
      "^remote\\.origin\\.(url|pushurl)$|^url\\..*\\.(insteadof|pushinsteadof)$",
    ]);
    const entries = configured.split("\0").filter(Boolean);
    // NUL framing retains empty URL values that a trimmed get-url result alone
    // could hide. Do not turn an empty/multiple configured destination into one.
    if (
      entries.filter((entry) => entry.startsWith("remote.origin.url\n"))
        .length !== 1 ||
      entries.filter((entry) => entry.startsWith("remote.origin.pushurl\n"))
        .length > 1
    )
      throw new Error(
        "Publication requires a single configured origin destination per direction",
      );
    const resolve = async (remote: string, push: boolean): Promise<string> => {
      const output = await this.runGit(repositoryPath, [
        "remote",
        "get-url",
        ...(push ? ["--push"] : []),
        "--all",
        remote,
      ]);
      const urls = output.trim().split(/\r?\n/u);
      if (
        urls.length !== 1 ||
        !urls[0] ||
        !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/iu.test(
          urls[0],
        )
      )
        throw new Error(
          "Publication requires one supported GitHub destination per direction",
        );
      let actual: string;
      try {
        actual = canonicalizeGitHubRepository(urls[0]);
      } catch {
        throw new Error(
          "Publication Git destination is not a supported repository identity",
        );
      }
      if (actual !== expected)
        throw new Error(
          "Publication Git destination differs from the pinned repository",
        );
      return urls[0];
    };
    const fetch = await resolve("origin", false);
    const push = await resolve("origin", true);
    // Explicit URL arguments can be rewritten again. Fail closed on any
    // additional non-identity rewrite of a resolved destination (including
    // pushInsteadOf on an explicit pushurl, and insteadOf on push readback).
    // This intentionally rejects ambiguous chained/overlapping mappings rather
    // than emulating Git's precedence or mutating repository configuration.
    for (const entry of entries) {
      if (entry.startsWith("remote.origin.")) continue;
      const match = /^url\.(.*)\.(insteadof|pushinsteadof)\n([\s\S]*)$/u.exec(
        entry,
      );
      if (!match)
        throw new Error("Malformed publication Git URL rewrite configuration");
      const base = match[1]!,
        kind = match[2]!,
        prefix = match[3]!;
      for (const url of kind === "insteadof" ? [fetch, push] : [push]) {
        if (
          url.startsWith(prefix) &&
          `${base}${url.slice(prefix.length)}` !== url
        )
          throw new Error(
            "Publication concrete destination is subject to another Git URL rewrite",
          );
      }
    }
    return { fetch, push };
  }

  async fetch(
    repositoryPath: string,
    remote: string,
    branch: string,
    project?: ProjectConfig,
  ): Promise<void> {
    rejectJournaledDispatch();
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
      "Git rebase is disabled to protect published history; preserve the worktree for operator reconciliation",
    );
  }

  /** Prepare an additive merge only; the caller persists provenance before dispatch. */
  async mergeTarget(
    repositoryPath: string,
    targetSha: string,
    identity: GitIdentity,
  ): Promise<void> {
    rejectJournaledDispatch();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(targetSha))
      throw new Error("Invalid merge target");
    await this.runGit(
      repositoryPath,
      [
        "-c",
        "merge.autoStash=false",
        "-c",
        "rerere.enabled=false",
        "merge",
        "--no-ff",
        "--no-commit",
        "--no-overwrite-ignore",
        "--",
        targetSha,
      ],
      getGitIdentityEnvironment(identity),
    );
  }

  async completeTargetMerge(
    repositoryPath: string,
    identity: GitIdentity,
  ): Promise<void> {
    rejectJournaledDispatch();
    if ((await this.getMergeHead(repositoryPath)) === null)
      throw new Error("No active merge to complete");
    await this.runGit(
      repositoryPath,
      ["commit", "-m", "chore: merge latest target branch"],
      getGitIdentityEnvironment(identity),
    );
  }

  async stagePaths(
    repositoryPath: string,
    paths: readonly string[],
  ): Promise<void> {
    rejectJournaledDispatch();
    if (paths.length > 0)
      await this.runGit(repositoryPath, ["add", "--", ...paths]);
  }

  async getMergeHead(repositoryPath: string): Promise<string | null> {
    const mergePath = await this.runGit(repositoryPath, [
      "rev-parse",
      "--git-path",
      "MERGE_HEAD",
    ]);
    if (!fs.existsSync(path.resolve(repositoryPath, mergePath))) return null;
    return this.resolveCommitSha(repositoryPath, "MERGE_HEAD");
  }

  async getTargetMergePaths(
    repositoryPath: string,
    target: string,
  ): Promise<string[]> {
    const output = await this.runGit(repositoryPath, [
      "diff",
      "--name-only",
      "-z",
      `HEAD...${target}`,
    ]);
    return output.split("\0").filter(Boolean);
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
    intendedSha?: string,
  ): Promise<void> {
    const authority = mutationAuthority(project?.id);
    let journaled = false;
    let pushSha: string | undefined;
    if (authority) {
      const run = authority.store.read()!;
      const destinations = await this.resolvePublicationDestinations(
        repositoryPath,
        run.pinned.repository,
      );
      if (remote !== "origin" && remote !== destinations.push)
        throw new Error("Unpinned Git push destination");
      const sha = intendedSha ?? (await this.getHeadSha(repositoryPath));
      pushSha = sha;
      journaled = consumeJournaledDispatch(authority, {
        route: "git-push",
        args: {
          cwd: repositoryPath,
          branch,
          destination: remote,
          fetch: destinations.fetch,
          sha,
        },
      });
      if (journaled) {
        if (
          (await this.getCurrentBranch(repositoryPath)) !== branch ||
          (await this.getRefSha(repositoryPath, `refs/heads/${branch}`)) !==
            sha ||
          (await this.getHeadSha(repositoryPath)) !== sha
        )
          throw new Error("Push task branch/ref changed before transport");
      } else {
        await this.reconcileMutation(
          {
            route: "git-push",
            args: {
              cwd: repositoryPath,
              branch,
              destination: destinations.push,
              fetch: destinations.fetch,
              sha,
            },
          },
          project,
        );
        return;
      }
    }
    await this.runAuthenticated(
      repositoryPath,
      journaled
        ? [
            "push",
            "--no-follow-tags",
            remote,
            `${pushSha!}:refs/heads/${branch}`,
          ]
        : ["push", "--set-upstream", remote, branch],
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

  async getStatus(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string> {
    return this.runGit(
      repositoryPath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      undefined,
      signalOverride,
    );
  }

  async getDiff(repositoryPath: string, staged = false): Promise<string> {
    return this.runGit(
      repositoryPath,
      staged ? ["diff", "--cached", "--binary"] : ["diff", "--binary"],
    );
  }

  /** Includes ignored setup output: ordinary status alone is not removal proof. */
  async getCleanupStatus(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored",
    ]);
  }

  async getUntrackedFiles(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string[]> {
    const output = await this.runGit(
      repositoryPath,
      ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"],
      undefined,
      signalOverride,
    );

    return output.split("\0").filter((filePath) => filePath.length > 0);
  }

  async getUnstagedChangedPaths(repositoryPath: string): Promise<string[]> {
    const [diff, untracked] = await Promise.all([
      this.runGit(repositoryPath, ["diff", "--name-only", "-z"]),
      this.getUntrackedFiles(repositoryPath),
    ]);
    return [...new Set([...diff.split("\0"), ...untracked].filter(Boolean))];
  }

  async getCommittableChangedPaths(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.runGit(
        repositoryPath,
        ["diff", "--no-renames", "HEAD", "--name-only", "-z"],
        undefined,
        signalOverride,
      ),
      this.getUntrackedFiles(repositoryPath, signalOverride),
    ]);
    return [...new Set([...tracked.split("\0"), ...untracked].filter(Boolean))];
  }

  async getIgnoredFiles(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string[]> {
    const output = await this.runGit(
      repositoryPath,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--full-name",
        "-z",
      ],
      undefined,
      signalOverride,
    );
    return output.split("\0").filter((filePath) => filePath.length > 0);
  }

  async getHeadTrackedFiles(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string[]> {
    const output = await this.runGit(
      repositoryPath,
      ["ls-tree", "--full-tree", "-r", "--name-only", "-z", "HEAD"],
      undefined,
      signalOverride,
    );

    return output.split("\0").filter((filePath) => filePath.length > 0);
  }

  async getIndexEntries(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["ls-files", "--stage", "-z"]);
  }

  async hasChanges(repositoryPath: string): Promise<boolean> {
    return (await this.getStatus(repositoryPath)).length > 0;
  }

  async getHeadSha(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string> {
    return this.runGit(
      repositoryPath,
      ["rev-parse", "HEAD"],
      undefined,
      signalOverride,
    );
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
    rejectJournaledDispatch();
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

  /** Stable identity for every ref visible in the shared Git directory. */
  async getRefsIdentity(repositoryPath: string): Promise<string> {
    const refs = await this.runGit(repositoryPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    const canonical = refs
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort()
      .join("\n");
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  }

  async createRefIfAbsent(
    repositoryPath: string,
    ref: string,
    sha: string,
  ): Promise<void> {
    rejectJournaledDispatch();
    const zero = "0".repeat(sha.length);
    await this.runGit(repositoryPath, ["update-ref", ref, sha, zero]);
  }

  async getCommitMessage(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["log", "-1", "--format=%B"]);
  }

  /** Framing keeps the process adapter's outer trim from altering message
   * bytes. Slice the frames, not whitespace; embedded frame text is harmless. */
  async getVerbatimCommitMessage(repositoryPath: string): Promise<string> {
    const start = "orchestrator-message-start\0";
    const end = "\0orchestrator-message-end";
    const output = await this.runGit(repositoryPath, [
      "log",
      "-1",
      "--no-show-signature",
      "--no-notes",
      "--format=orchestrator-message-start%x00%B%x00orchestrator-message-end",
    ]);
    if (!output.startsWith(start) || !output.endsWith(end))
      throw new Error("Malformed framed commit message");
    return output.slice(start.length, -end.length);
  }

  async stageAll(repositoryPath: string): Promise<void> {
    rejectJournaledDispatch();
    await this.runGit(repositoryPath, ["add", "-A"]);
  }

  /** Stage the complete task worktree except reviewed unrelated paths. */
  async stageAllExcept(
    repositoryPath: string,
    excludedPaths: string[],
  ): Promise<void> {
    rejectJournaledDispatch();
    const uniquePaths = [...new Set(excludedPaths)];
    for (const filePath of uniquePaths) {
      if (
        filePath.length === 0 ||
        filePath.startsWith("/") ||
        filePath.split(/[\\/]/u).includes("..") ||
        filePath.includes("\0")
      )
        throw new Error(`Unsafe path excluded from task commit: ${filePath}`);
    }
    await this.runGit(repositoryPath, ["add", "-A"]);
    if (uniquePaths.length > 0)
      await this.runGit(repositoryPath, [
        "restore",
        "--staged",
        "--",
        ...uniquePaths.map((filePath) => `:(literal)${filePath}`),
      ]);
    const staged = await this.runGit(repositoryPath, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "HEAD",
    ]);
    const stagedPaths = staged.split("\0").filter(Boolean);
    if (uniquePaths.some((excluded) => stagedPaths.includes(excluded)))
      throw new Error("Excluded setup changes remain in the Git index");
  }

  async getIndexTreeSha(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["write-tree"]);
  }

  async getCommitTreeSha(repositoryPath: string): Promise<string> {
    return this.runGit(repositoryPath, ["rev-parse", "HEAD^{tree}"]);
  }

  async getCommitParentShas(repositoryPath: string): Promise<string[]> {
    const parents = await this.runGit(repositoryPath, [
      "log",
      "-1",
      "--format=%P",
    ]);
    return parents.trim().split(/\s+/u).filter(Boolean);
  }

  async commit(
    repositoryPath: string,
    messageFilePath: string,
    identity: GitIdentity,
    cleanup?: "verbatim",
  ): Promise<void> {
    identity = { ...identity };
    const authority = mutationAuthority(undefined);
    let dispatchedMessage: string | undefined;
    if (authority) {
      const rawMessage = fs.readFileSync(messageFilePath, "utf8");
      const message = prepareVerbatimCommitMessage(
        sanitizeControlledText(rawMessage),
      );
      const request: Extract<GitMutationRequest, { route: "git-commit" }> = {
        route: "git-commit",
        args: {
          cwd: repositoryPath,
          branch: await this.getCurrentBranch(repositoryPath),
          parent: await this.getHeadSha(repositoryPath),
          tree: await this.getIndexTreeSha(repositoryPath),
          message,
          identity: {
            name: identity.name,
            email: identity.email,
            ...(identity.signingKey ? { signingKey: identity.signingKey } : {}),
          },
        },
      };
      if (
        consumeJournaledDispatch(authority, {
          ...request,
          args: { ...request.args, message: rawMessage, cleanup },
        })
      ) {
        if (
          (await this.getRefSha(
            repositoryPath,
            `refs/heads/${request.args.branch}`,
          )) !== request.args.parent
        )
          throw new Error("Commit task ref changed before transport");
        dispatchedMessage = rawMessage;
      } else {
        await this.reconcileMutation(request);
        return;
      }
    }
    const signingOptions =
      identity.signingKey === undefined
        ? []
        : [
            "-c",
            "gpg.format=ssh",
            "-c",
            `user.signingKey=${identity.signingKey}`,
            "-c",
            "commit.gpgSign=true",
          ];
    // Capture exact authorized bytes in a private file: a caller-controlled -F
    // path must not change the payload after capability consumption.
    const directory =
      dispatchedMessage === undefined
        ? undefined
        : fs.mkdtempSync(path.join(os.tmpdir(), "journal-commit-transport-"));
    const transportMessagePath = directory
      ? path.join(directory, "message")
      : messageFilePath;
    if (directory)
      fs.writeFileSync(transportMessagePath, dispatchedMessage!, {
        mode: 0o600,
      });
    try {
      await this.runGit(
        repositoryPath,
        [
          ...signingOptions,
          "commit",
          ...(cleanup === undefined ? [] : ["--cleanup=verbatim"]),
          "-F",
          transportMessagePath,
        ],
        getGitIdentityEnvironment(identity),
      );
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
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

  async getCurrentBranch(
    repositoryPath: string,
    signalOverride?: AbortSignal | null,
  ): Promise<string> {
    return this.runGit(
      repositoryPath,
      ["branch", "--show-current"],
      undefined,
      signalOverride,
    );
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
    const authority = mutationAuthority(undefined);
    if (authority) {
      const start = await this.getRefSha(
        repositoryPath,
        `refs/heads/${branch}`,
      );
      if (!start) throw new Error("Worktree branch has no observed object");
      const request: GitMutationRequest = {
        route: "git-worktree",
        args: {
          cwd: repositoryPath,
          worktree: worktreePath,
          branch,
          start,
          createBranch: false,
        },
      };
      if (!consumeJournaledDispatch(authority, request)) {
        await this.reconcileMutation(request);
        return;
      }
    }
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
    const authority = mutationAuthority(undefined);
    if (authority) {
      const request: Extract<GitMutationRequest, { route: "git-worktree" }> = {
        route: "git-worktree",
        args: {
          cwd: repositoryPath,
          worktree: worktreePath,
          branch,
          start: await this.resolveCommitSha(repositoryPath, startPoint),
          createBranch: true,
        },
      };
      if (!consumeJournaledDispatch(authority, request)) {
        await this.reconcileMutation(request);
        return;
      }
      startPoint = request.args.start;
    }
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
    const authority = mutationAuthority(undefined);
    if (authority) {
      // Refuse unsafe cleanup before publishing a dispatch obligation. Repeat
      // the checks inside the sender to fence changes between intent and send.
      if (
        fs.existsSync(worktreePath) &&
        (fs.lstatSync(worktreePath).isSymbolicLink() ||
          (await this.getCleanupStatus(worktreePath)).trim() !== "")
      )
        throw new Error(
          "Unsafe worktree cleanup; artifacts preserved without dispatch",
        );
      const request: GitMutationRequest = {
        route: "git-cleanup",
        args: {
          cwd: repositoryPath,
          resource: worktreePath,
          kind: "worktree",
          sha: fs.existsSync(worktreePath)
            ? await this.getHeadSha(worktreePath)
            : null,
        },
      };
      if (!consumeJournaledDispatch(authority, request)) {
        await this.reconcileMutation(request);
        return;
      }
    }
    await this.runGit(repositoryPath, ["worktree", "remove", worktreePath]);
  }

  async deleteBranch(repositoryPath: string, branch: string): Promise<void> {
    const authority = mutationAuthority(undefined);
    if (authority) {
      const request: GitMutationRequest = {
        route: "git-cleanup",
        args: {
          cwd: repositoryPath,
          resource: branch,
          kind: "branch",
          sha: await this.getRefSha(repositoryPath, `refs/heads/${branch}`),
        },
      };
      if (!consumeJournaledDispatch(authority, request)) {
        await this.reconcileMutation(request);
        return;
      }
    }
    await this.runGit(repositoryPath, ["branch", "-D", branch]);
  }

  async pruneWorktrees(repositoryPath: string): Promise<void> {
    rejectJournaledDispatch();
    // Broad pruning has no attempt-scoped destination. Owned removals already
    // remove their registration; never prune unrelated worktrees in production.
    if (mutationAuthority(undefined)) return;
    await this.runGit(repositoryPath, ["worktree", "prune"]);
  }

  async resetHard(repositoryPath: string): Promise<void> {
    rejectJournaledDispatch();
    await this.runGit(repositoryPath, ["reset", "--hard", "HEAD"]);
  }

  async resetHardTo(repositoryPath: string, ref: string): Promise<void> {
    rejectJournaledDispatch();
    await this.runGit(repositoryPath, ["reset", "--hard", ref]);
  }

  async cleanUntracked(repositoryPath: string): Promise<void> {
    rejectJournaledDispatch();
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
    expectedHead?: string,
  ): Promise<void> {
    const authority = mutationAuthority(project?.id);
    if (authority) {
      const destinations = await this.resolvePublicationDestinations(
        repositoryPath,
        authority.store.read()!.pinned.repository,
      );
      if (remote !== "origin" && remote !== destinations.push)
        throw new Error("Unpinned remote cleanup");
      const request: GitMutationRequest = {
        route: "git-cleanup",
        args: {
          cwd: repositoryPath,
          resource: branch,
          kind: "remote-branch",
          sha:
            expectedHead ??
            (await this.getRemoteBranchSha(
              repositoryPath,
              destinations.push,
              branch,
              project,
            )),
          destination: destinations.push,
        },
      };
      if (!consumeJournaledDispatch(authority, request)) {
        await this.reconcileMutation(request, project);
        return;
      }
    }
    if (expectedHead !== undefined) {
      const actual = await this.getRemoteBranchSha(
        repositoryPath,
        remote,
        branch,
        project,
      );
      if (actual === null) return;
      if (actual !== expectedHead)
        throw new Error("Remote cleanup ref changed before deletion");
    }
    await this.runAuthenticated(
      repositoryPath,
      ["push", remote, "--delete", branch],
      project,
    );
  }
}
