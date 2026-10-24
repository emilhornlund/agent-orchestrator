import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function workingDirectory(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "github-ci-observations-"));
  return root;
}

const headSha = "a".repeat(40);

describe("GitHubClient.getCiObservations", () => {
  it("collects paginated check runs and commit statuses for the exact SHA plus branch contracts", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?"))) {
        return JSON.stringify([
          [
            {
              check_runs: [
                {
                  id: 11,
                  name: "Build (node 20)",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "success",
                  html_url: "https://example.test/check/11",
                },
              ],
            },
          ],
          [
            {
              check_runs: [
                {
                  id: 12,
                  name: "Build (node 22)",
                  head_sha: headSha,
                  status: "in_progress",
                  conclusion: null,
                  html_url: "https://example.test/check/12",
                },
                {
                  id: 13,
                  name: "Cancelled",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "cancelled",
                  html_url: "https://example.test/check/13",
                },
                {
                  id: 14,
                  name: "Skipped",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "skipped",
                  html_url: "https://example.test/check/14",
                },
                {
                  id: 15,
                  name: "Neutral",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "neutral",
                  html_url: "https://example.test/check/15",
                },
                {
                  id: 16,
                  name: "Lint",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "failure",
                  html_url: "https://example.test/check/16",
                },
              ],
            },
          ],
        ]);
      }
      if (args.some((arg) => arg.includes("/statuses?"))) {
        return JSON.stringify([
          [
            {
              id: 21,
              context: "External / security",
              sha: headSha,
              state: "pending",
              created_at: "2026-10-24T10:00:00Z",
              updated_at: "2026-10-24T10:00:00Z",
              target_url: null,
              description: "Waiting for scanner",
            },
          ],
          [
            {
              id: 22,
              context: "Legacy tests",
              sha: headSha,
              state: "failure",
              created_at: "2026-10-24T10:01:00Z",
              updated_at: "2026-10-24T10:02:00Z",
              target_url: "https://example.test/status/22",
              description: null,
            },
            {
              id: 23,
              context: "External / security",
              sha: headSha,
              state: "success",
              created_at: "2026-10-24T10:03:00Z",
              updated_at: "2026-10-24T10:03:00Z",
              target_url: null,
              description: "Scanner completed",
            },
          ],
        ]);
      }
      if (
        args.some((arg) => arg.includes("/protection/required_status_checks"))
      ) {
        return JSON.stringify({
          contexts: ["Build"],
          checks: [{ context: "Tests", app_id: 42 }],
        });
      }
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });
    const github = new GitHubClient(command);

    const observation = await github.getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
    });

    expect(observation.headSha).toBe(headSha);
    expect(observation.checks).toHaveLength(9);
    expect(observation.checks).toContainEqual(
      expect.objectContaining({
        source: "check-run",
        id: 12,
        name: "Build (node 22)",
        status: "in_progress",
        headSha,
      }),
    );
    expect(
      observation.checks.filter(
        (check) =>
          check.source === "commit-status" &&
          check.context === "External / security",
      ),
    ).toHaveLength(2);
    expect(
      observation.checks
        .filter((check) => check.source === "check-run")
        .map((check) =>
          check.source === "check-run" ? check.conclusion : null,
        ),
    ).toContain("skipped");
    expect(observation.checks).toContainEqual(
      expect.objectContaining({
        source: "commit-status",
        context: "Legacy tests",
        state: "failure",
        headSha,
      }),
    );
    expect(observation.expectationSources).toContainEqual({
      kind: "repository-rules",
      sourceId: "branch-protection:main",
      complete: true,
      checkNames: ["Build", "Tests"],
    });
    expect(command).toHaveBeenCalledTimes(3);
  });

  it("fails closed on malformed or stale external results", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?"))) {
        return JSON.stringify([
          [
            {
              check_runs: [
                {
                  id: 1,
                  name: "Build",
                  head_sha: "b".repeat(40),
                  status: "completed",
                  conclusion: "success",
                  html_url: null,
                },
              ],
            },
          ],
        ]);
      }
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      return JSON.stringify({ contexts: [], checks: [] });
    });
    const github = new GitHubClient(command);

    await expect(
      github.getCiObservations({
        cwd,
        repository: "owner/repo",
        defaultBranch: "main",
        headSha,
      }),
    ).rejects.toThrow("different commit SHA");
  });

  it("rejects a stale commit status even when check runs match the head", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?"))) {
        return JSON.stringify([[{ check_runs: [] }]]);
      }
      if (args.some((arg) => arg.includes("/statuses?"))) {
        return JSON.stringify([
          [
            {
              id: 1,
              context: "Tests",
              sha: "b".repeat(40),
              state: "success",
              created_at: "2026-10-24T10:00:00Z",
              updated_at: "2026-10-24T10:00:00Z",
              target_url: null,
              description: null,
            },
          ],
        ]);
      }
      return JSON.stringify({ contexts: [], checks: [] });
    });

    await expect(
      new GitHubClient(command).getCiObservations({
        cwd,
        repository: "owner/repo",
        defaultBranch: "main",
        headSha,
      }),
    ).rejects.toThrow("different commit SHA");
  });

  it("records unavailable branch rules as incomplete evidence", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([[]]);
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      throw new Error("HTTP 403: resource not accessible by integration");
    });
    const github = new GitHubClient(command);

    const observation = await github.getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
    });

    expect(observation.expectationSources).toContainEqual(
      expect.objectContaining({
        sourceId: "branch-protection:main",
        complete: false,
      }),
    );
  });

  it("does not treat a missing branch-protection endpoint as successful CI evidence", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?"))) {
        return JSON.stringify([[{ check_runs: [] }]]);
      }
      if (args.some((arg) => arg.includes("/statuses?"))) {
        return JSON.stringify([[]]);
      }
      throw new Error("HTTP 404: branch protection not found");
    });
    const result = await new GitHubClient(command).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
    });

    expect(result.checks).toEqual([]);
    expect(result.expectationSources).toEqual([]);
  });
});
