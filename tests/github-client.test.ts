import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);

  return child;
}

describe("GitHubClient", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a pull request through the injected command runner", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>(
      async () => "https://github.com/example/repository/pull/123",
    );

    const github = new GitHubClient(runGitHubCommand);

    const result = await github.createPullRequest({
      cwd: "/tmp/repository",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "agent/example",
      title: "Example task",
      body: "Example body",
    });

    expect(runGitHubCommand).toHaveBeenCalledWith("/tmp/repository", [
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
    ]);

    expect(result).toEqual({
      url: "https://github.com/example/repository/pull/123",
    });
  });

  it("finds an existing pull request", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>(
      async () => "https://github.com/example/repository/pull/123",
    );

    const github = new GitHubClient(runGitHubCommand);

    const result = await github.findPullRequest({
      cwd: "/tmp/repository",
      repository: "example/repository",
      headBranch: "agent/example",
    });

    expect(runGitHubCommand).toHaveBeenCalledWith("/tmp/repository", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/example",
      "--state",
      "open",
      "--json",
      "url",
      "--limit",
      "1",
      "--jq",
      '.[0].url // ""',
    ]);

    expect(result).toEqual({
      url: "https://github.com/example/repository/pull/123",
    });
  });

  it("returns null when there is no existing pull request", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>(async () => "");

    const github = new GitHubClient(runGitHubCommand);

    await expect(
      github.findPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        headBranch: "agent/example",
      }),
    ).resolves.toBeNull();
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

  it("kills gh and rejects when the command times out", async () => {
    vi.useFakeTimers();

    const child = createFakeChild();

    spawnMock.mockReturnValueOnce(child);

    const github = new GitHubClient();
    const request = github.createPullRequest({
      cwd: "/tmp/repository",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "agent/example",
      title: "Example task",
      body: "Example body",
    });

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);

    await expect(request).rejects.toThrow(
      "GitHub CLI timed out after 120000ms",
    );
  });

  it("finds a merged pull request by head branch", async () => {
    const runGitHub = vi
      .fn()
      .mockResolvedValue("https://github.com/example/repository/pull/123");

    const github = new GitHubClient(runGitHub);

    const result = await github.findMergedPullRequest({
      cwd: "/repo",
      repository: "example/repository",
      headBranch: "agent/card-1",
    });

    expect(result).toEqual({
      url: "https://github.com/example/repository/pull/123",
    });

    expect(runGitHub).toHaveBeenCalledWith("/repo", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/card-1",
      "--state",
      "merged",
      "--json",
      "url",
      "--limit",
      "1",
      "--jq",
      '.[0].url // ""',
    ]);
  });

  it("returns null when no merged pull request exists", async () => {
    const runGitHub = vi.fn().mockResolvedValue("");
    const github = new GitHubClient(runGitHub);

    await expect(
      github.findMergedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toBeNull();
  });
});
