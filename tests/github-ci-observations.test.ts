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
          {
            total_count: 1,
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
          {
            total_count: 5,
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
          {
            total_count: 1,
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
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
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
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
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
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
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

  it("resolves matrix and reusable workflow contracts from PR-associated runtime jobs", async () => {
    const cwd = workingDirectory();
    const workflows = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "ci.yml"),
      `name: CI\non: [pull_request]\njobs:\n  matrix:\n    strategy:\n      matrix:\n        node: [20, 22]\n  conditional:\n    if: github.event.pull_request.draft == false\n  reusable:\n    uses: ./.github/workflows/reusable.yml\n`,
    );
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      if (
        args.some((arg) => arg.includes("/protection/required_status_checks"))
      )
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 2,
            workflow_runs: [
              {
                id: 100,
                head_sha: headSha,
                status: "completed",
                pull_requests: [{ number: 7 }],
              },
            ],
          },
        ]);
      if (args.some((arg) => arg.includes("/actions/runs/100/jobs?")))
        return JSON.stringify([
          {
            total_count: 1,
            jobs: [
              {
                name: "CI / test (ubuntu, 20)",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "CI / test (ubuntu, 22)",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "CI / conditional",
                status: "completed",
                conclusion: "skipped",
              },
              {
                name: "CI / reusable / build",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(command).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
      pullRequestNumber: 7,
    });

    expect(result.expectationSources).toContainEqual(
      expect.objectContaining({
        sourceId: `workflow-runs:pull-request:7:${headSha}`,
        complete: true,
        checkNames: [
          "CI / test (ubuntu, 20)",
          "CI / test (ubuntu, 22)",
          "CI / reusable / build",
        ],
      }),
    );
  });

  it("does not use runtime jobs associated with a different PR", async () => {
    const cwd = workingDirectory();
    const workflows = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "ci.yml"),
      "on: [pull_request]\njobs:\n  test:\n    if: always()\n",
    );
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      if (
        args.some((arg) => arg.includes("/protection/required_status_checks"))
      )
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 101,
                head_sha: headSha,
                status: "completed",
                pull_requests: [{ number: 8 }],
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(command).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
      pullRequestNumber: 7,
    });

    expect(result.expectationSources).toContainEqual(
      expect.objectContaining({
        complete: false,
        uncertainty: expect.stringContaining("conditional"),
      }),
    );
    expect(
      command.mock.calls.some(([, args]) =>
        args.some((arg) => arg.includes("/actions/runs/101/jobs")),
      ),
    ).toBe(false);
  });

  it("keeps discovered matrix jobs incomplete while their workflow run is pending", async () => {
    const cwd = workingDirectory();
    const workflows = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "ci.yml"),
      "on: [pull_request]\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [ubuntu, macos]\n",
    );
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      if (
        args.some((arg) => arg.includes("/protection/required_status_checks"))
      )
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 102,
                head_sha: headSha,
                status: "in_progress",
                pull_requests: [{ number: 7 }],
              },
            ],
          },
        ]);
      if (args.some((arg) => arg.includes("/actions/runs/102/jobs?")))
        return JSON.stringify([
          {
            total_count: 2,
            jobs: [
              {
                name: "CI / test (ubuntu)",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "CI / test (macos)",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(command).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
      pullRequestNumber: 7,
    });

    expect(result.expectationSources).toContainEqual(
      expect.objectContaining({
        sourceId: `workflow-runs:pull-request:7:${headSha}`,
        complete: false,
        checkNames: ["CI / test (ubuntu)", "CI / test (macos)"],
        uncertainty: expect.stringContaining("in progress"),
      }),
    );
    expect(
      result.expectationSources.some(
        (source) => source.complete && source.kind === "workflow-contract",
      ),
    ).toBe(false);
  });

  it("rejects runtime observations for a stale head even when the PR matches", async () => {
    const cwd = workingDirectory();
    const workflows = path.join(cwd, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "ci.yml"),
      "on: [pull_request]\njobs:\n  conditional:\n    if: always()\n",
    );
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
      if (args.some((arg) => arg.includes("/statuses?")))
        return JSON.stringify([[]]);
      if (
        args.some((arg) => arg.includes("/protection/required_status_checks"))
      )
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 103,
                head_sha: "b".repeat(40),
                status: "completed",
                pull_requests: [{ number: 7 }],
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(command).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
      pullRequestNumber: 7,
    });

    expect(
      result.expectationSources.some((source) =>
        source.sourceId.startsWith("workflow-runs:"),
      ),
    ).toBe(false);
    expect(result.expectationSources.some((source) => !source.complete)).toBe(
      true,
    );
    expect(
      command.mock.calls.some(([, args]) =>
        args.some((arg) => arg.includes("/actions/runs/103/jobs")),
      ),
    ).toBe(false);
  });
});
