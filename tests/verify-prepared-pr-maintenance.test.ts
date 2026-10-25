import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { CommandRunAbortedError } from "../src/process/command-runner.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { verifyPreparedPrMaintenance } from "../src/task-session/verify-prepared-pr-maintenance.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";

const sha = (char: string) => char.repeat(40);
function fixture(
  options: {
    coverage?: boolean;
    mutate?: boolean;
    validationFails?: boolean;
    coverageFails?: boolean;
    reviewFails?: boolean;
    interrupted?: boolean;
    stale?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "prepared-maintenance-quality-"),
  );
  const repository = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const context = path.join(root, "context");
  fs.mkdirSync(repository);
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, "source.txt"), "initial");
  const project = {
    id: "project",
    repository: {
      path: repository,
      worktreeRoot: path.join(root, "trees"),
      github: "owner/repo",
      defaultBranch: "main",
      validationCommand: "validate",
      ...(options.coverage ? { coverageCommand: "coverage" } : {}),
    },
  } as ProjectConfig;
  const store = new PrMaintenanceStore(context, project);
  const identity = {
    projectId: "project",
    cardId: "card",
    pullRequest: { number: 12, url: "https://github.com/owner/repo/pull/12" },
    expectedRemoteHead: sha("a"),
    targetBaseHead: sha("b"),
  };
  store.create({
    ...identity,
    operationId: "maintenance",
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
  });
  store.advance("maintenance", "prepared", "active", identity);
  store.recordLocalPreparation("maintenance", identity, {
    status: "fetching-base",
    originalHead: sha("a"),
    updatedAt: "2026-10-25T10:00:01.000Z",
  });
  store.recordLocalPreparation("maintenance", identity, {
    status: "base-fetched",
    originalHead: sha("a"),
    baseHead: sha("b"),
    updatedAt: "2026-10-25T10:00:02.000Z",
  });
  store.recordLocalPreparation("maintenance", identity, {
    status: "prepared",
    originalHead: sha("a"),
    baseHead: sha("b"),
    resultingHead: sha("c"),
    updatedAt: "2026-10-25T10:00:03.000Z",
  });
  const operation = store.inspect("maintenance")!;
  const git = {
    getHeadSha: vi.fn(async () => sha("c")),
    getHeadTrackedFiles: vi.fn(async () => ["source.txt"]),
    getIndexEntries: vi.fn(async () => ""),
    getUntrackedFiles: vi.fn(async () => []),
  };
  const commands = {
    run: vi.fn(async ({ command }: { command: string }) => {
      if (options.interrupted && command === "validate")
        throw new CommandRunAbortedError();
      return {
        exitCode:
          command === "validate"
            ? options.validationFails
              ? 1
              : 0
            : options.coverageFails
              ? 1
              : 0,
        output: "",
        errorOutput: "gate diagnostic",
      };
    }),
  };
  const review: ImplementationReviewResult = {
    version: 1,
    projectId: "project",
    cardId: "card",
    verdict: options.reviewFails ? "fail" : "pass",
    requirementAssessments: [
      {
        requirementId: "R1",
        status: "satisfied",
        details: "present",
        evidence: ["verified"],
      },
    ],
    blockingFindings: options.reviewFails
      ? [{ kind: "defect", summary: "failure", detail: "review failed" }]
      : [],
    reviewedContentIdentity: options.stale ? `sha256:${"0".repeat(64)}` : "",
  };
  let changed = false;
  const run = () =>
    verifyPreparedPrMaintenance({
      project,
      operation,
      worktreePath: worktree,
      maintenanceStore: store,
      git,
      commands: commands as never,
      signal: new AbortController().signal,
      timeoutMilliseconds: 1000,
      requirementIds: ["R1"],
      review: async ({ contentIdentity }) => {
        review.reviewedContentIdentity = contentIdentity;
        if (options.stale)
          review.reviewedContentIdentity = `sha256:${"0".repeat(64)}`;
        if (options.mutate && !changed) {
          fs.writeFileSync(path.join(worktree, "source.txt"), "changed");
          changed = true;
        }
        return review;
      },
    });
  return { run, store, commands, root };
}

describe("verifyPreparedPrMaintenance", () => {
  it("passes all configured gates and persists evidence for the prepared content", async () => {
    const f = fixture({ coverage: true });
    const result = await f.run();
    expect(result.coverage?.status).toBe("passed");
    expect(f.store.inspect("maintenance")?.qualityVerification?.status).toBe(
      "passed",
    );
    expect(
      f.store.inspect("maintenance")?.qualityVerification?.preparedHead,
    ).toBe(sha("c"));
  });
  it.each([
    ["validation fails", { validationFails: true }],
    ["coverage fails", { coverage: true, coverageFails: true }],
    ["independent review fails", { reviewFails: true }],
    ["source identity changes", { mutate: true }],
    ["interrupted verification", { interrupted: true }],
    ["review evidence is stale", { stale: true }],
  ] as const)("rejects when %s", async (_label, options) => {
    const f = fixture(options);
    await expect(f.run()).rejects.toThrow();
    expect(["failed", "uncertain"]).toContain(
      f.store.inspect("maintenance")?.qualityVerification?.status,
    );
    expect(
      f.store.inspect("maintenance")?.qualityVerification?.diagnostic,
    ).toBeTruthy();
    if (_label === "interrupted verification")
      expect(f.store.inspect("maintenance")?.qualityVerification?.status).toBe(
        "uncertain",
      );
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});
