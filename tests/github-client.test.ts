import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { GitHubClient } from "../src/github/github-client.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("GitHubClient", () => {
  it("creates a pull request", async () => {
    const runGitHub = vi.fn(async (): Promise<{ url: string }> => ({
      url: "https://github.com/example/repository/pull/123",
    }));

    const github = new GitHubClient(runGitHub);

    const result = await github.createPullRequest({
      cwd: "/tmp/repository",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "agent/example",
      title: "Example task",
      body: "Example body",
    });

    expect(runGitHub).toHaveBeenCalledWith({
      cwd: "/tmp/repository",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "agent/example",
      title: "Example task",
      body: "Example body",
    });

    expect(result.url).toBe("https://github.com/example/repository/pull/123");
  });

  it("parses and trims the URL returned by gh", async () => {
    const child = createFakeChild();

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from("\nhttps://github.com/example/repository/pull/123\n"),
        );
        child.emit("close", 0);
      });

      return child;
    });

    const github = new GitHubClient();

    await expect(
      github.createPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        baseBranch: "main",
        headBranch: "agent/example",
        title: "Example task",
        body: "Example body",
      }),
    ).resolves.toEqual({
      url: "https://github.com/example/repository/pull/123",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        "example/repository",
        "--base",
        "main",
        "--head",
        "agent/example",
        "--title",
        "Example task",
        "--body",
        "Example body",
      ],
      {
        cwd: "/tmp/repository",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
  });

  it("rejects when gh exits non-zero", async () => {
    const child = createFakeChild();

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("permission denied"));
        child.emit("close", 2);
      });

      return child;
    });

    const github = new GitHubClient();

    await expect(
      github.createPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        baseBranch: "main",
        headBranch: "agent/example",
        title: "Example task",
        body: "Example body",
      }),
    ).rejects.toThrow("GitHub CLI exited with code 2: permission denied");
  });

  it("rejects when gh cannot be started", async () => {
    const child = createFakeChild();

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.emit("error", new Error("spawn gh ENOENT"));
      });

      return child;
    });

    const github = new GitHubClient();

    await expect(
      github.createPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        baseBranch: "main",
        headBranch: "agent/example",
        title: "Example task",
        body: "Example body",
      }),
    ).rejects.toThrow("Failed to start GitHub CLI: spawn gh ENOENT");
  });

  it("rejects when gh succeeds without returning a URL", async () => {
    const child = createFakeChild();

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const github = new GitHubClient();

    await expect(
      github.createPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        baseBranch: "main",
        headBranch: "agent/example",
        title: "Example task",
        body: "Example body",
      }),
    ).rejects.toThrow("GitHub CLI did not return a pull request URL");
  });
});
