import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubClient, type RunGitHubCommand } from "../src/github/github-client.js";
import { establishCiCheckExpectations } from "../src/github/ci-check-expectations.js";
import { evaluateCiChecks } from "../src/github/evaluate-ci-checks.js";
import type { ProjectConfig } from "../src/config/config.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function workingDirectory(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "github-ci-observations-"));
  return root;
}

const headSha = "a".repeat(40);

/** Serve the fixture documents through the exact-revision GitHub contents API. */
function withWorkflowApi(command: RunGitHubCommand): RunGitHubCommand {
  return async (cwd, args, ...rest) => {
    const endpoint = args.find((arg) => arg.includes("/contents/.github/workflows"));
    if (!endpoint) return command(cwd, args, ...rest);
    expect(endpoint).toContain(`ref=${headSha}`);
    const directory = path.join(cwd, ".github", "workflows");
    if (endpoint.includes("/workflows?"))
      return JSON.stringify(
        fs.existsSync(directory)
          ? fs.readdirSync(directory).map((name) => ({
              name,
              path: `.github/workflows/${name}`,
              type: "file",
            }))
          : [],
      );
    const name = decodeURIComponent(endpoint.split("?")[0]!.split("/").at(-1)!);
    return JSON.stringify({
      encoding: "base64",
      content: fs.readFileSync(path.join(directory, name)).toString("base64"),
    });
  };
}

describe("GitHubClient.getCiObservations", () => {
  it("reads workflow files once while polling current policy, checks and runtime jobs", async () => {
    const cwd = workingDirectory();
    const files: Record<string, string> = {
      "ci.yml": "on: [pull_request]\njobs:\n  build:\n    if: always()\n",
      "deploy.yml": "on: [push]\njobs:\n  deploy: {}\n",
      "release.yml": "on: [release]\njobs:\n  release: {}\n",
    };
    let completed = false;
    const run = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      const endpoint = args.at(-1)!;
      const status = completed ? "completed" : "in_progress";
      const conclusion = completed ? "success" : null;
      if (endpoint.endsWith(`/contents/.github/workflows?ref=${headSha}`))
        return JSON.stringify(
          Object.keys(files).map((name) => ({
            name,
            path: `.github/workflows/${name}`,
            type: "file",
          })),
        );
      if (endpoint.includes("/contents/")) {
        const name = endpoint.split("?")[0]!.split("/").at(-1)!;
        return JSON.stringify({
          encoding: "base64",
          content: Buffer.from(files[name]!).toString("base64"),
        });
      }
      if (endpoint.includes("/protection/")) return JSON.stringify({ contexts: ["coverage"] });
      if (endpoint.includes("/check-runs?"))
        return JSON.stringify([
          {
            check_runs: [
              { id: 1, name: "Build", head_sha: headSha, status, conclusion, html_url: null },
            ],
          },
        ]);
      if (endpoint.includes("/statuses?"))
        return JSON.stringify([
          [
            {
              id: 1,
              context: "coverage",
              state: completed ? "success" : "pending",
              created_at: "2026-11-26T22:50:08Z",
              updated_at: "2026-11-26T22:50:08Z",
              target_url: null,
              description: null,
            },
          ],
        ]);
      if (endpoint.includes("/actions/runs?"))
        return JSON.stringify([
          {
            workflow_runs: [
              {
                id: 7,
                path: ".github/workflows/ci.yml",
                head_sha: headSha,
                event: "pull_request",
                status,
                pull_requests: [{ number: 123 }],
              },
            ],
          },
        ]);
      if (endpoint.includes("/actions/runs/7/jobs?"))
        return JSON.stringify([{ jobs: [{ name: "Build", status, conclusion }] }]);
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const github = new GitHubClient(run);
    const options = {
      cwd,
      repository: "owner/repo",
      headSha,
      defaultBranch: "main",
      pullRequestNumber: 123,
    };
    const observe = async () => {
      const current = await github.getCiObservations(options);
      return evaluateCiChecks({
        expectedHeadSha: headSha,
        observedHeadSha: current.headSha,
        expectations: establishCiCheckExpectations(current.expectationSources),
        checks: current.checks,
      });
    };
    expect(await observe()).toMatchObject({ status: "uncertain" });
    const coldRequests = run.mock.calls.length;
    completed = true;
    expect(await observe()).toMatchObject({
      status: "passed",
      expectedCheckNames: ["Build", "coverage"],
    });
    const warmEndpoints = run.mock.calls.slice(coldRequests).map(([, args]) => args.at(-1));
    expect(coldRequests - warmEndpoints.length).toBe(Object.keys(files).length);
    expect(warmEndpoints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/workflows?ref="),
        expect.stringContaining("/protection/"),
        expect.stringContaining("/check-runs?"),
        expect.stringContaining("/statuses?"),
        expect.stringContaining("/actions/runs?"),
        expect.stringContaining("/actions/runs/7/jobs?"),
      ]),
    );
    expect(warmEndpoints.some((endpoint) => endpoint?.includes("/workflows/"))).toBe(false);
  });

  it("rechecks unreadable files and scopes workflow contracts to the revision, base, and live listing", async () => {
    const cwd = workingDirectory();
    let missingFile = true;
    let directoryDenied = false;
    const nextHead = "b".repeat(40);
    const run = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      const endpoint = args.at(-1)!;
      if (endpoint.includes("/protection/")) return JSON.stringify({ contexts: [] });
      if (endpoint.includes("/check-runs?")) return '[{"check_runs":[]}]';
      if (endpoint.includes("/statuses?")) return "[[]]";
      if (endpoint.includes("/workflows?")) {
        if (directoryDenied) throw new Error("HTTP 403: forbidden");
        return JSON.stringify([{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" }]);
      }
      if (endpoint.includes("/workflows/ci.yml?")) {
        if (missingFile) throw new Error("HTTP 404: file not found");
        const name = endpoint.endsWith(nextHead) ? "NewBuild" : "Build";
        const content = Buffer.from(
          `on:\n  pull_request:\n    branches: [main]\njobs:\n  ${name}: {}\n`,
        ).toString("base64");
        return JSON.stringify({ encoding: "base64", content });
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const github = new GitHubClient(run);
    const observe = async (sha = headSha, baseBranch = "main") => {
      const result = await github.getCiObservations({
        cwd,
        repository: "owner/repo",
        headSha: sha,
        defaultBranch: "main",
        baseBranch,
      });
      return establishCiCheckExpectations(result.expectationSources);
    };
    expect(await observe()).toMatchObject({ status: "uncertain" });
    missingFile = false;
    expect(await observe()).toMatchObject({ status: "complete", expectedCheckNames: ["Build"] });
    expect(await observe(headSha, "release")).toMatchObject({
      status: "uncertain",
      expectedCheckNames: [],
    });
    expect(await observe(nextHead)).toMatchObject({
      status: "complete",
      expectedCheckNames: ["NewBuild"],
    });
    directoryDenied = true;
    expect(await observe()).toMatchObject({ status: "uncertain" });
  });

  it.each([true, false])(
    "connects observed check details to same-head Actions logs only for the owned repository (trusted=%s)",
    async (trusted) => {
      const cwd = workingDirectory();
      const jobUrl = "https://github.com/owner/repo/actions/runs/12/job/34";
      const run = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
        const endpoint = args.at(-1)!;
        if (endpoint.includes("/check-runs?"))
          return JSON.stringify([
            {
              check_runs: [
                {
                  id: 42,
                  name: "Frontend E2E",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "failure",
                  html_url: "https://github.com/owner/repo/runs/42",
                  details_url: trusted
                    ? jobUrl
                    : "https://github.com/other/repo/actions/runs/12/job/34",
                },
              ],
            },
          ]);
        if (endpoint.includes("/statuses?")) return "[[]]";
        if (endpoint.includes("/protection/"))
          return JSON.stringify({ contexts: ["Frontend E2E"], checks: [] });
        if (endpoint.includes("/annotations?")) return "[[]]";
        if (endpoint.endsWith("/actions/jobs/34"))
          return JSON.stringify({
            id: 34,
            run_id: 12,
            head_sha: headSha,
            status: "completed",
            conclusion: "failure",
            check_run_url: "https://api.github.com/repos/owner/repo/check-runs/42",
          });
        if (endpoint.endsWith("/actions/jobs/34/logs"))
          return "1) [chromium] › GameJoinAvatar.spec.ts\nError: waiting for Game PIN\nat GameJoinAvatar.spec.ts:197";
        throw new Error(`Unexpected endpoint ${endpoint}`);
      });
      const github = new GitHubClient(withWorkflowApi(run));
      const observation = await github.getCiObservations({
        cwd,
        repository: "owner/repo",
        defaultBranch: "main",
        headSha,
      });
      expect(observation.checks[0]?.url).toBe(
        trusted ? jobUrl : "https://github.com/owner/repo/runs/42",
      );
      const diagnostics = await github.getCiCheckRunDiagnostics({
        cwd,
        repository: "owner/repo",
        headSha,
        checks: observation.checks.filter((check) => check.source === "check-run"),
        project: { id: "p", repository: { github: "owner/repo" } } as ProjectConfig,
      });
      expect(diagnostics[0]?.available).toBe(trusted);
      expect(run.mock.calls.some(([, args]) => args.at(-1)?.endsWith("/logs"))).toBe(trusted);
      if (trusted) expect(diagnostics[0]?.diagnostic).toContain("GameJoinAvatar.spec.ts:197");
    },
  );

  it.each(["static-new-check", "undiscovered-workflow", "latest-run"] as const)(
    "evaluates exact-revision workflow contracts without substituting unrelated runtime coverage: %s",
    async (scenario) => {
      const cwd = workingDirectory();
      fs.mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".github", "workflows", "old.yml"),
        "on: [pull_request]\njobs:\n  OldCheckoutCheck: {}\n",
      );
      const dynamic = "on: [pull_request]\njobs:\n  Build:\n    if: always()\n";
      const documents: Record<string, string> =
        scenario === "static-new-check"
          ? {
              "ci.yml": "on: [pull_request]\njobs:\n  Build: {}\n  RequiredNewCheck: {}\n",
            }
          : scenario === "undiscovered-workflow"
            ? { "first.yml": dynamic, "second.yml": dynamic }
            : { "first.yml": dynamic };
      const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
        const endpoint = args.at(-1)!;
        if (endpoint.includes("/check-runs?"))
          return JSON.stringify([
            {
              check_runs: [
                {
                  id: 1,
                  name: "Build",
                  head_sha: headSha,
                  status: "completed",
                  conclusion: "success",
                  html_url: null,
                },
              ],
            },
          ]);
        if (endpoint.includes("/statuses?")) return JSON.stringify([[]]);
        if (endpoint.includes("/protection/")) throw new Error("HTTP 404: not found");
        if (endpoint.includes("/contents/")) {
          expect(endpoint).toContain(`ref=${headSha}`);
          if (endpoint.includes("/workflows?"))
            return JSON.stringify(
              Object.keys(documents).map((name) => ({
                name,
                path: `.github/workflows/${name}`,
                type: "file",
              })),
            );
          const name = decodeURIComponent(endpoint.split("?")[0]!.split("/").at(-1)!);
          return JSON.stringify({
            encoding: "base64",
            content: Buffer.from(documents[name]!).toString("base64"),
          });
        }
        if (endpoint.includes("/actions/runs?"))
          return JSON.stringify([
            {
              workflow_runs: [
                {
                  id: 2,
                  path: ".github/workflows/first.yml",
                  event: "pull_request",
                  head_sha: headSha,
                  status: "completed",
                  pull_requests: [{ number: 7 }],
                },
                ...(scenario === "latest-run"
                  ? [
                      {
                        id: 1,
                        path: ".github/workflows/first.yml",
                        event: "pull_request",
                        head_sha: headSha,
                        status: "in_progress",
                        pull_requests: [{ number: 7 }],
                      },
                    ]
                  : []),
              ],
            },
          ]);
        if (endpoint.includes("/actions/runs/2/jobs?"))
          return JSON.stringify([
            {
              jobs: [{ name: "Build", status: "completed", conclusion: "success" }],
            },
          ]);
        throw new Error(`Unexpected query: ${endpoint}`);
      });
      const observation = await new GitHubClient(command).getCiObservations({
        cwd,
        repository: "owner/repo",
        defaultBranch: "main",
        headSha,
        pullRequestNumber: 7,
      });
      const expectations = establishCiCheckExpectations(observation.expectationSources);
      const evaluated = evaluateCiChecks({
        expectedHeadSha: headSha,
        observedHeadSha: observation.headSha,
        checks: observation.checks,
        expectations,
      });
      expect(JSON.stringify(observation.expectationSources)).not.toContain("OldCheckoutCheck");
      if (scenario === "static-new-check")
        expect(evaluated).toMatchObject({
          status: "waiting",
          missingChecks: ["RequiredNewCheck"],
        });
      else if (scenario === "undiscovered-workflow") {
        expect(evaluated.status).toBe("uncertain");
        expect(observation.expectationSources).toContainEqual(
          expect.objectContaining({
            sourceId: "workflow:.github/workflows/second.yml",
            complete: false,
          }),
        );
      } else {
        expect(evaluated.status).toBe("passed");
        expect(
          command.mock.calls.some(([, args]) => args.some((arg) => arg.includes("/runs/1/jobs"))),
        ).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "collects paginated check runs and commit-scoped statuses (optional SHA=%s)",
    async (includeSha) => {
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
                ...(includeSha ? { sha: headSha } : {}),
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
                ...(includeSha ? { sha: headSha } : {}),
                state: "failure",
                created_at: "2026-10-24T10:01:00Z",
                updated_at: "2026-10-24T10:02:00Z",
                target_url: "https://example.test/status/22",
                description: null,
              },
              {
                id: 23,
                context: "External / security",
                ...(includeSha ? { sha: headSha } : {}),
                state: "success",
                created_at: "2026-10-24T10:03:00Z",
                updated_at: "2026-10-24T10:03:00Z",
                target_url: null,
                description: "Scanner completed",
              },
            ],
          ]);
        }
        if (args.some((arg) => arg.includes("/protection/required_status_checks"))) {
          return JSON.stringify({
            contexts: ["Build"],
            checks: [{ context: "Tests", app_id: 42 }],
          });
        }
        throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
      });
      const github = new GitHubClient(withWorkflowApi(command));

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
          (check) => check.source === "commit-status" && check.context === "External / security",
        ),
      ).toHaveLength(2);
      expect(
        observation.checks
          .filter((check) => check.source === "check-run")
          .map((check) => (check.source === "check-run" ? check.conclusion : null)),
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
      expect(
        command.mock.calls.find(([, args]) => args.some((arg) => arg.includes("/statuses?")))?.[1],
      ).toContain(`repos/owner/repo/commits/${headSha}/statuses?per_page=100`);
    },
  );

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
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      return JSON.stringify({ contexts: [], checks: [] });
    });
    const github = new GitHubClient(withWorkflowApi(command));

    await expect(
      github.getCiObservations({
        cwd,
        repository: "owner/repo",
        defaultBranch: "main",
        headSha,
      }),
    ).rejects.toThrow("different commit SHA");
  });

  it.each(["b".repeat(40), null, 123])(
    "rejects a stale or malformed optional status SHA (%s)",
    async (sha) => {
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
                sha,
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
        new GitHubClient(withWorkflowApi(command)).getCiObservations({
          cwd,
          repository: "owner/repo",
          defaultBranch: "main",
          headSha,
        }),
      ).rejects.toThrow(
        typeof sha === "string" ? "different commit SHA" : "invalid commit statuses",
      );
    },
  );

  it("records unavailable branch rules as incomplete evidence", async () => {
    const cwd = workingDirectory();
    const command = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("/check-runs?")))
        return JSON.stringify([{ total_count: 0, check_runs: [] }]);
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      throw new Error("HTTP 403: resource not accessible by integration");
    });
    const github = new GitHubClient(withWorkflowApi(command));

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
    const result = await new GitHubClient(withWorkflowApi(command)).getCiObservations({
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
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      if (args.some((arg) => arg.includes("/protection/required_status_checks")))
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 2,
            workflow_runs: [
              {
                id: 100,
                path: ".github/workflows/ci.yml",
                event: "pull_request",
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

    const result = await new GitHubClient(withWorkflowApi(command)).getCiObservations({
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
        checkNames: ["CI / test (ubuntu, 20)", "CI / test (ubuntu, 22)", "CI / reusable / build"],
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
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      if (args.some((arg) => arg.includes("/protection/required_status_checks")))
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 101,
                path: ".github/workflows/ci.yml",
                event: "pull_request",
                head_sha: headSha,
                status: "completed",
                pull_requests: [{ number: 8 }],
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(withWorkflowApi(command)).getCiObservations({
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
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      if (args.some((arg) => arg.includes("/protection/required_status_checks")))
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 102,
                path: ".github/workflows/ci.yml",
                event: "pull_request",
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

    const result = await new GitHubClient(withWorkflowApi(command)).getCiObservations({
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
      if (args.some((arg) => arg.includes("/statuses?"))) return JSON.stringify([[]]);
      if (args.some((arg) => arg.includes("/protection/required_status_checks")))
        throw new Error("HTTP 404: not found");
      if (args.some((arg) => arg.includes("/actions/runs?")))
        return JSON.stringify([
          {
            total_count: 1,
            workflow_runs: [
              {
                id: 103,
                path: ".github/workflows/ci.yml",
                event: "pull_request",
                head_sha: "b".repeat(40),
                status: "completed",
                pull_requests: [{ number: 7 }],
              },
            ],
          },
        ]);
      throw new Error(`Unexpected GitHub query: ${args.join(" ")}`);
    });

    const result = await new GitHubClient(withWorkflowApi(command)).getCiObservations({
      cwd,
      repository: "owner/repo",
      defaultBranch: "main",
      headSha,
      pullRequestNumber: 7,
    });

    expect(
      result.expectationSources.some((source) => source.sourceId.startsWith("workflow-runs:")),
    ).toBe(false);
    expect(result.expectationSources.some((source) => !source.complete)).toBe(true);
    expect(
      command.mock.calls.some(([, args]) =>
        args.some((arg) => arg.includes("/actions/runs/103/jobs")),
      ),
    ).toBe(false);
  });
});
