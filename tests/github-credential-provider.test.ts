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
      secretValues: [],
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("does not fall back when App token acquisition fails", async () => {
    const provider = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi
          .fn()
          .mockRejectedValue(new Error("exchange failed")),
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

  it("uses the project token for Git fetch, push, and remote cleanup", async () => {
    const runGit = vi
      .fn<RunGit>()
      .mockImplementation(async (_cwd, args) =>
        args[0] === "ls-remote" ? "abc\trefs/heads/agent/card-1" : "",
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
      await git.fetch("/repo", "origin", "main");
      await git.push("/repo", "origin", "agent/card-1");
      await git.remoteBranchExists("/repo", "origin", "agent/card-1");
      await git.deleteRemoteBranch("/repo", "origin", "agent/card-1");
    });

    expect(runGit).toHaveBeenCalledTimes(4);
    for (const call of runGit.mock.calls) {
      expect(call[2]?.GH_TOKEN).toBe("token-a");
      expect(call[1]).not.toContain("token-a");
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
