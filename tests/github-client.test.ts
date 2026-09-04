import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  GitHubClient,
  isRetryableGitHubError,
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
    vi.restoreAllMocks();
  });

  it.each([500, 502, 503, 504])(
    "classifies HTTP %s as a retryable GitHub failure",
    (status) => {
      expect(
        isRetryableGitHubError(
          new Error(`GitHub API returned HTTP ${status}: temporary outage`),
        ),
      ).toBe(true);
    },
  );

  it.each([
    "GitHub API returned HTTP 403: API rate limit exceeded for user ID 123",
    "GitHub API returned HTTP 403: You have exceeded a secondary rate limit",
  ])("classifies rate-limit failures as retryable: %s", (message) => {
    expect(isRetryableGitHubError(new Error(message))).toBe(true);
  });

  it.each([
    "temporary connectivity failure",
    "connect ECONNRESET",
    "getaddrinfo ETIMEDOUT",
    "request timed out",
  ])("classifies %s as a retryable GitHub failure", (message) => {
    expect(isRetryableGitHubError(new Error(message))).toBe(true);
  });

  it.each([
    "HTTP 401: Bad credentials",
    "HTTP 403: Resource access denied",
    "GitHub CLI returned an invalid pull request state list",
    "GitHub configuration is invalid",
  ])("does not classify %s as retryable", (message) => {
    expect(isRetryableGitHubError(new Error(message))).toBe(false);
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

  it("merges a pull request through the injected command runner", async () => {
    const runGitHubCommand = vi.fn<RunGitHubCommand>(async () => "");
    const github = new GitHubClient(runGitHubCommand);

    await github.mergePullRequest({
      cwd: "/tmp/worktree",
      repository: "example/repository",
      pullRequestUrl: "https://github.com/example/repository/pull/123",
      commitSha: "abc123",
    });

    expect(runGitHubCommand).toHaveBeenCalledWith("/tmp/worktree", [
      "pr",
      "merge",
      "https://github.com/example/repository/pull/123",
      "--repo",
      "example/repository",
      "--match-head-commit",
      "abc123",
      "--merge",
      "--delete-branch",
    ]);
  });

  it("surfaces pull request merge failures", async () => {
    const mergeError = new Error("merge is blocked");
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockRejectedValue(mergeError),
    );

    await expect(
      github.mergePullRequest({
        cwd: "/tmp/worktree",
        repository: "example/repository",
        pullRequestUrl: "https://github.com/example/repository/pull/123",
        commitSha: "abc123",
      }),
    ).rejects.toBe(mergeError);
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

  it("rejects a non-GitHub pull request URL from gh", async () => {
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockResolvedValue("https://example.com/pr/1"),
    );

    await expect(
      github.findPullRequest({
        cwd: "/tmp/repository",
        repository: "example/repository",
        headBranch: "agent/example",
      }),
    ).rejects.toThrow("invalid pull request URL");
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

  it("force-kills gh when it ignores the termination signal", async () => {
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
    const rejection = expect(request).rejects.toThrow(
      "GitHub CLI timed out after 120000ms",
    );

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 5_000);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await rejection;
  });

  it("finds pull request state by head branch", async () => {
    const runGitHub = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          url: "https://github.com/example/repository/pull/123",
          state: "MERGED",
          mergedAt: "2026-09-01T13:42:03Z",
        },
      ]),
    );

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toEqual({
      url: "https://github.com/example/repository/pull/123",
      state: "MERGED",
      mergedAt: "2026-09-01T13:42:03Z",
    });

    expect(runGitHub).toHaveBeenCalledWith("/repo", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/card-1",
      "--state",
      "all",
      "--json",
      "url,state,mergedAt",
      "--limit",
      "1",
    ]);
  });

  it("returns null when no pull request exists for the head branch", async () => {
    const runGitHub = vi.fn().mockResolvedValue("[]");
    const github = new GitHubClient(runGitHub);

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toBeNull();
  });

  it("returns current merge state facts when a base branch is requested", async () => {
    const runGitHub = vi.fn<RunGitHubCommand>().mockResolvedValue(
      JSON.stringify([
        {
          url: "https://github.com/example/repository/pull/123",
          state: "OPEN",
          mergedAt: null,
          baseRefName: "main",
          headRefName: "agent/card-1",
          headRepository: { name: "repository" },
          headRepositoryOwner: { login: "example" },
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        },
      ]),
    );
    const github = new GitHubClient(runGitHub);

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
        baseBranch: "main",
      }),
    ).resolves.toEqual({
      url: "https://github.com/example/repository/pull/123",
      state: "OPEN",
      mergedAt: null,
      baseRefName: "main",
      headRefName: "agent/card-1",
      headRepository: { name: "repository" },
      headRepositoryOwner: { login: "example" },
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });

    expect(runGitHub).toHaveBeenCalledWith("/repo", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/card-1",
      "--base",
      "main",
      "--state",
      "all",
      "--json",
      "url,state,mergedAt,baseRefName,headRefName,headRepository,headRepositoryOwner,mergeable,mergeStateStatus",
      "--limit",
      "1",
    ]);
  });

  it("rejects malformed merge state facts for an open pull request", async () => {
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockResolvedValue(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            state: "OPEN",
            mergedAt: null,
            baseRefName: "main",
            headRefName: "agent/card-1",
            mergeable: "MAYBE",
            mergeStateStatus: "CLEAN",
          },
        ]),
      ),
    );

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
        baseBranch: "main",
      }),
    ).rejects.toThrow("invalid pull request state list item");
  });

  it("rejects missing head repository identity for a base-scoped lookup", async () => {
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockResolvedValue(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            state: "OPEN",
            mergedAt: null,
            baseRefName: "main",
            headRefName: "agent/card-1",
            mergeable: "MERGEABLE",
            mergeStateStatus: "BEHIND",
          },
        ]),
      ),
    );

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
        baseBranch: "main",
      }),
    ).rejects.toThrow("invalid pull request state list item");
  });

  it("rejects a malformed pull request state response", async () => {
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockResolvedValue(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            state: "CLOSED",
            mergedAt: 123,
          },
        ]),
      ),
    );

    await expect(
      github.findPullRequestState({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).rejects.toThrow("invalid pull request state list item");
  });

  it("finds requested changes when the review targets the current PR head", async () => {
    const runGitHub = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            number: 123,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "current-head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 456,
          body: "Please handle the null case.",
          commitId: "current-head-sha",
          author: "reviewer-one",
        }),
      )
      .mockResolvedValueOnce("reviewer-one: Please add a regression test.");

    const github = new GitHubClient(runGitHub);

    const result = await github.findChangesRequestedPullRequest({
      cwd: "/repo",
      repository: "example/repository",
      headBranch: "agent/card-1",
      baseBranch: "main",
    });

    expect(result).toEqual({
      url: "https://github.com/example/repository/pull/123",
      feedback: [
        "reviewer-one: Please handle the null case.",
        "",
        "Inline review comments:",
        "reviewer-one: Please add a regression test.",
      ].join("\n"),
    });

    expect(runGitHub).toHaveBeenNthCalledWith(1, "/repo", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/card-1",
      "--base",
      "main",
      "--state",
      "open",
      "--json",
      "url,number,reviewDecision,headRefOid",
      "--limit",
      "1",
    ]);

    expect(runGitHub).toHaveBeenNthCalledWith(2, "/repo", [
      "api",
      "repos/example/repository/pulls/123/reviews",
      "--paginate",
      "--slurp",
      "--jq",
      'flatten | map(select(.state == "CHANGES_REQUESTED")) | sort_by(.submitted_at) | last | {id, body, commitId: .commit_id, author: .user.login}',
    ]);

    expect(runGitHub).toHaveBeenNthCalledWith(3, "/repo", [
      "api",
      "repos/example/repository/pulls/123/comments",
      "--paginate",
      "--slurp",
      "--jq",
      'flatten | map(select(.pull_request_review_id == 456 and .body != null and .body != "")) | .[] | "\\(.user.login): \\(.body)"',
    ]);
  });

  it("returns null when the open pull request does not have requested changes", async () => {
    const runGitHub = vi.fn<RunGitHubCommand>().mockResolvedValue(
      JSON.stringify([
        {
          url: "https://github.com/example/repository/pull/123",
          number: 123,
          reviewDecision: "REVIEW_REQUIRED",
          headRefOid: "current-head-sha",
        },
      ]),
    );

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toBeNull();

    expect(runGitHub).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed pull request list response", async () => {
    const github = new GitHubClient(
      vi.fn<RunGitHubCommand>().mockResolvedValue(JSON.stringify({})),
    );

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).rejects.toThrow("invalid pull request list");
  });

  it("rejects a malformed requested-changes review response", async () => {
    const runGitHub = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            number: 123,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "current-head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 456,
          body: 123,
          commitId: "current-head-sha",
          author: "reviewer-one",
        }),
      );

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).rejects.toThrow("invalid requested changes review");
  });

  it("ignores requested changes that target an older PR head", async () => {
    const runGitHub = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            number: 123,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "new-agent-head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 456,
          body: "Please handle the null case.",
          commitId: "old-reviewed-head-sha",
          author: "reviewer-one",
        }),
      );

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toBeNull();

    expect(runGitHub).toHaveBeenCalledTimes(2);

    expect(runGitHub).not.toHaveBeenCalledWith(
      "/repo",
      expect.arrayContaining(["repos/example/repository/pulls/123/comments"]),
    );
  });

  it("processes a new requested-changes review after the PR head changes", async () => {
    const runGitHub = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            number: 123,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "second-review-head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 789,
          body: "One more change is required.",
          commitId: "second-review-head-sha",
          author: "reviewer-two",
        }),
      )
      .mockResolvedValueOnce("");

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toEqual({
      url: "https://github.com/example/repository/pull/123",
      feedback: "reviewer-two: One more change is required.",
    });

    expect(runGitHub).toHaveBeenCalledTimes(3);
  });

  it("returns null when GitHub reports changes requested but no submitted change review exists", async () => {
    const runGitHub = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/example/repository/pull/123",
            number: 123,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "current-head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce("null");

    const github = new GitHubClient(runGitHub);

    await expect(
      github.findChangesRequestedPullRequest({
        cwd: "/repo",
        repository: "example/repository",
        headBranch: "agent/card-1",
      }),
    ).resolves.toBeNull();

    expect(runGitHub).toHaveBeenCalledTimes(2);
  });

  it("does not write GitHub CLI output directly to the console", async () => {
    const child = createFakeChild();
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from("https://github.com/example/repository/pull/123\n"),
        );
        child.stderr.emit("data", Buffer.from("warning from gh\n"));
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

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
