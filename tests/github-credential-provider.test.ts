import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";
import { withGitHubOperationProject } from "../src/github/github-operation-context.js";

const execFileAsync = promisify(execFile);

function project(
  id: string,
  githubApp?: ProjectConfig["repository"]["githubApp"],
): ProjectConfig {
  return {
    id,
    repository: {
      github: `${id}/repository`,
      githubApp,
    },
  } as ProjectConfig;
}

describe("GitHubCredentialProvider", () => {
  it("selects a project GitHub App installation token", async () => {
    const getInstallationToken = vi
      .fn()
      .mockResolvedValue("project-a-installation-token");
    const provider = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app-a.pem",
    });

    const credential = await provider.resolve(configuredProject);

    expect(getInstallationToken).toHaveBeenCalledWith(
      configuredProject.repository.githubApp,
      configuredProject.repository.github,
    );
    expect(credential.mode).toBe("github-app");
    expect(credential.environment.GH_TOKEN).toBe(
      "project-a-installation-token",
    );
    expect(credential.environment.GITHUB_TOKEN).toBe(
      "project-a-installation-token",
    );
    expect(credential.environment.GIT_ASKPASS).not.toContain(
      "project-a-installation-token",
    );
    expect(credential.secretValues).toEqual(["project-a-installation-token"]);
  });

  it("configures an askpass executable that returns the App credentials", async () => {
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const credential = await provider.resolve(
      project("project-a", {
        appId: "app-a",
        installationId: "installation-a",
        privateKeyPath: "/secrets/a.pem",
      }),
    );

    const askpassPath = credential.environment.GIT_ASKPASS;
    expect(askpassPath).toBeDefined();

    const { stdout: username } = await execFileAsync(
      askpassPath!,
      ["Username for https://github.com:"],
      {
        env: { ...process.env, GITHUB_TOKEN: "token-a" },
      },
    );
    const { stdout: password } = await execFileAsync(
      askpassPath!,
      ["Password for https://github.com:"],
      {
        env: { ...process.env, GITHUB_TOKEN: "token-a" },
      },
    );

    expect(username).toBe("x-access-token\n");
    expect(password).toBe("token-a\n");
  });

  it("preserves ambient CLI authentication when no App is configured", async () => {
    const getInstallationToken = vi.fn();
    const provider = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });

    await expect(provider.resolve(project("ambient"))).resolves.toEqual({
      mode: "ambient",
      environment: {},
      secretValues: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("does not fall back when App token acquisition fails", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-pat");
    vi.stubEnv("GITHUB_TOKEN", "ambient-github-token");

    try {
      const provider = new GitHubCredentialProvider({
        authenticator: {
          getInstallationToken: vi
            .fn()
            .mockRejectedValue(new Error("scoped exchange failed")),
        },
      });
      const configuredProject = project("project-a", {
        appId: "app-a",
        installationId: "installation-a",
        privateKeyPath: "/secrets/app-a.pem",
      });

      await expect(provider.resolve(configuredProject)).rejects.toMatchObject({
        name: "GitHubCredentialResolutionError",
        projectId: "project-a",
      });
      await expect(provider.resolve(configuredProject)).rejects.toThrow(
        'GitHub authentication failed for project "project-a"',
      );
      await expect(provider.resolve(configuredProject)).rejects.toThrow(
        'repository "project-a/repository"',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps concurrent project credentials isolated", async () => {
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn(async (githubApp) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return githubApp.appId === "app-a" ? "token-a" : "token-b";
        }),
      },
    });
    const projectA = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });
    const projectB = project("project-b", {
      appId: "app-b",
      installationId: "installation-b",
      privateKeyPath: "/secrets/b.pem",
    });

    const credentials = await Promise.all([
      provider.resolve(projectA),
      provider.resolve(projectB),
    ]);

    expect(
      credentials.map((credential) => credential.environment.GH_TOKEN),
    ).toEqual(["token-a", "token-b"]);
  });
});

describe("GitHub credential command wiring", () => {
  it("uses one project token for every GitHub CLI review request", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>();
    runGitHubCommand
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/project-a/repository/pull/1",
            number: 1,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "head",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 2,
          body: "Fix this",
          commitId: "head",
          author: "reviewer",
        }),
      )
      .mockResolvedValueOnce("reviewer: Fix this inline");
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });

    await withGitHubOperationProject(configuredProject, () =>
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "project-a/repository",
        headBranch: "agent/card-1",
      }),
    );

    expect(runGitHubCommand).toHaveBeenCalledTimes(3);
    for (const call of runGitHubCommand.mock.calls) {
      expect(call[2]?.GH_TOKEN).toBe("token-a");
      expect(call[1]).not.toContain("token-a");
    }
  });

  it("uses the project token for state lookup, creation, and merge", async () => {
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/project-a/repository/pull/1",
            state: "OPEN",
            mergedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce("https://github.com/project-a/repository/pull/1")
      .mockResolvedValueOnce("");
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app-a.pem",
    });

    await github.findPullRequestState({
      cwd: "/repo",
      repository: "project-a/repository",
      headBranch: "agent/card-1",
      project: configuredProject,
    });
    await github.createPullRequest({
      cwd: "/repo",
      repository: "project-a/repository",
      baseBranch: "main",
      headBranch: "agent/card-1",
      title: "Task",
      body: "Body",
      project: configuredProject,
    });
    await github.mergePullRequest({
      cwd: "/repo",
      repository: "project-a/repository",
      pullRequestUrl: "https://github.com/project-a/repository/pull/1",
      commitSha: "head",
      project: configuredProject,
    });

    expect(runGitHubCommand).toHaveBeenCalledTimes(3);
    for (const call of runGitHubCommand.mock.calls) {
      expect(call[2]?.GH_TOKEN).toBe("token-a");
      expect(call[1]).not.toContain("token-a");
    }
  });

  it("does not run GitHub CLI when project credential resolution fails", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>();
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi
          .fn()
          .mockRejectedValue(new Error("token-a must not be exposed")),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app-a.pem",
    });

    const request = github.findPullRequest({
      cwd: "/repo",
      repository: "project-a/repository",
      headBranch: "agent/card-1",
      project: configuredProject,
    });

    await expect(request).rejects.toThrow("GitHub authentication failed");
    await expect(request).rejects.not.toThrow("token-a");
    expect(runGitHubCommand).not.toHaveBeenCalled();
  });

  it("redacts an App token from successful GitHub review output", async () => {
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/project-a/repository/pull/1",
            number: 1,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "head",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 2,
          body: "token-a must not reach feedback",
          commitId: "head",
          author: "reviewer",
        }),
      )
      .mockResolvedValueOnce("");
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);

    const result = await github.findChangesRequestedPullRequest({
      cwd: "/repo",
      repository: "project-a/repository",
      headBranch: "agent/card-1",
      project: project("project-a", {
        appId: "app-a",
        installationId: "installation-a",
        privateKeyPath: "/secrets/app-a.pem",
      }),
    });

    expect(result?.feedback).not.toContain("token-a");
    expect(result?.feedback).toContain("[REDACTED]");
  });

  it("preserves ambient GH_TOKEN without passing an environment override", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-token");

    try {
      const runGitHubCommand = vi
        .fn<RunGitHubCommand>()
        .mockRejectedValue(new Error("ambient-token was not accepted"));
      const github = new GitHubClient(runGitHubCommand);

      await expect(
        github.findPullRequest({
          cwd: "/repo",
          repository: "project-a/repository",
          headBranch: "agent/card-1",
        }),
      ).rejects.toThrow("[REDACTED]");

      expect(runGitHubCommand).toHaveBeenCalledTimes(1);
      expect(runGitHubCommand.mock.calls[0]).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("isolates project tokens across concurrent GitHub CLI operations", async () => {
    const calls: Array<{ repository: string; token: string | undefined }> = [];
    const runGitHubCommand = vi.fn<RunGitHubCommand>(
      async (_cwd, args, environment) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        calls.push({
          repository: args[args.indexOf("--repo") + 1] ?? "",
          token: environment?.GH_TOKEN,
        });
        return `https://github.com/${args[args.indexOf("--repo") + 1]}/pull/1`;
      },
    );
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn(async (githubApp) =>
          githubApp.appId === "app-a" ? "token-a" : "token-b",
        ),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);
    const projectA = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });
    const projectB = project("project-b", {
      appId: "app-b",
      installationId: "installation-b",
      privateKeyPath: "/secrets/b.pem",
    });

    await Promise.all([
      github.createPullRequest({
        cwd: "/repo-a",
        repository: "project-a/repository",
        baseBranch: "main",
        headBranch: "agent/a",
        title: "A",
        body: "A",
        project: projectA,
      }),
      github.createPullRequest({
        cwd: "/repo-b",
        repository: "project-b/repository",
        baseBranch: "main",
        headBranch: "agent/b",
        title: "B",
        body: "B",
        project: projectB,
      }),
    ]);

    expect(calls).toEqual([
      { repository: "project-a/repository", token: "token-a" },
      { repository: "project-b/repository", token: "token-b" },
    ]);
  });

  it("uses the project token for Git fetch, push, and remote cleanup", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockImplementation(async (_cwd, args) =>
        args.includes("ls-remote") ? "abc\trefs/heads/agent/card-1" : "",
      );
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const git = new GitClient(runGit, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });

    await withGitHubOperationProject(configuredProject, async () => {
      await git.fetch("/repo", "origin", "main", configuredProject);
      await git.push("/repo", "origin", "agent/card-1", configuredProject);
      await git.remoteBranchExists(
        "/repo",
        "origin",
        "agent/card-1",
        configuredProject,
      );
      await git.deleteRemoteBranch(
        "/repo",
        "origin",
        "agent/card-1",
        configuredProject,
      );
    });

    expect(runGit).toHaveBeenCalledTimes(4);
    for (const call of runGit.mock.calls) {
      expect(call[2]?.GH_TOKEN).toBe("token-a");
      expect(call[1].slice(0, 2)).toEqual(["-c", "credential.helper="]);
      expect(call[1]).not.toContain("token-a");
    }
  });

  it("does not copy ambient credentials into Git command overrides", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-token");

    try {
      const runGit = vi.fn<RunGit>().mockResolvedValue("");
      const git = new GitClient(runGit);

      await git.fetch("/repo", "origin", "main");

      expect(runGit).toHaveBeenCalledWith("/repo", ["fetch", "origin", "main"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redacts a Git failure without retaining an App token", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockRejectedValue(new Error("remote rejected token-a"));
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const git = new GitClient(runGit, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app-a.pem",
    });

    const request = git.push(
      "/repo",
      "origin",
      "agent/card-1",
      configuredProject,
    );

    await expect(request).rejects.toThrow("[REDACTED]");
    await expect(request).rejects.not.toThrow("token-a");
    expect(runGit).toHaveBeenCalledWith(
      "/repo",
      [
        "-c",
        "credential.helper=",
        "push",
        "--set-upstream",
        "origin",
        "agent/card-1",
      ],
      expect.objectContaining({
        GH_TOKEN: "token-a",
        GITHUB_TOKEN: "token-a",
      }),
    );
  });

  it("fails Git when App credential resolution fails without falling back", async () => {
    const runGit = vi.fn<RunGit>().mockResolvedValue("");
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi
          .fn()
          .mockRejectedValue(new Error("token-a must not be exposed")),
      },
    });
    const git = new GitClient(runGit, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/app-a.pem",
    });

    const request = git.fetch("/repo", "origin", "main", configuredProject);

    await expect(request).rejects.toThrow("GitHub authentication failed");
    await expect(request).rejects.not.toThrow("token-a");
    expect(runGit).not.toHaveBeenCalled();
  });

  it("keeps credentials isolated across concurrent Git operations", async () => {
    const calls: Array<{
      repositoryPath: string;
      token: string | undefined;
    }> = [];
    const runGit = vi.fn<RunGit>(async (cwd, _args, environment) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      calls.push({
        repositoryPath: cwd,
        token: environment?.GH_TOKEN,
      });
      return "";
    });
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn(async (githubApp) =>
          githubApp.appId === "app-a" ? "token-a" : "token-b",
        ),
      },
    });
    const git = new GitClient(runGit, provider);
    const projectA = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });
    const projectB = project("project-b", {
      appId: "app-b",
      installationId: "installation-b",
      privateKeyPath: "/secrets/b.pem",
    });

    await Promise.all([
      git.fetch("/repo-a", "origin", "main", projectA),
      git.push("/repo-b", "origin", "agent/card-1", projectB),
    ]);

    expect(calls).toEqual([
      { repositoryPath: "/repo-a", token: "token-a" },
      { repositoryPath: "/repo-b", token: "token-b" },
    ]);
    for (const call of runGit.mock.calls) {
      expect(call[1]).not.toContain("token-a");
      expect(call[1]).not.toContain("token-b");
    }
  });

  it("redacts an App token from GitHub operation failures", async () => {
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockRejectedValue(new Error("request failed with token-a"));
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi.fn().mockResolvedValue("token-a"),
      },
    });
    const github = new GitHubClient(runGitHubCommand, provider);
    const configuredProject = project("project-a", {
      appId: "app-a",
      installationId: "installation-a",
      privateKeyPath: "/secrets/a.pem",
    });

    await expect(
      github.findPullRequest({
        cwd: "/repo",
        repository: "project-a/repository",
        headBranch: "agent/card-1",
        project: configuredProject,
      }),
    ).rejects.toThrow("[REDACTED]");

    expect(runGitHubCommand).toHaveBeenCalledWith(
      "/repo",
      expect.any(Array),
      expect.objectContaining({ GH_TOKEN: "token-a" }),
    );
  });
});
