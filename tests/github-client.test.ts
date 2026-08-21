import { describe, expect, it, vi } from "vitest";

import { GitHubClient } from "../src/github/github-client.js";

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
});
