import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { runTaskSessionFeedbackRemediation } from "../src/task-session/run-task-session-feedback-remediation.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-remediation-"));
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "source.ts"), "original\n");
  const project = {
    id: "project",
    repository: {
      path: repo,
      worktreeRoot,
      validationCommand: "yarn validate",
    },
  } as ProjectConfig;
  const card: TrelloCard = {
    id: "card",
    name: "Fix feature",
    desc: "Implement feature",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card",
  };
  const taskRecordStore = new TaskExecutionStore(
    path.join(root, "state"),
    project,
  );
  const planStore = new TaskPlanStore(path.join(root, "state"), project);
  const feedbackLedgerStore = new FeedbackLedgerStore(
    path.join(root, "state"),
    project,
  );
  const expectedBranch = "agent/card";
  const operationKey = "operation";
  const expectedPrimarySessionId = "primary-session";
  const expectedPullRequestHeadSha = "a".repeat(40);
  taskRecordStore.create({
    version: 1,
    projectId: project.id,
    cardId: card.id,
    phase: "human-feedback",
    primarySessionId: expectedPrimarySessionId,
    sessionCreationStatus: "bound",
    expectedBranch,
    pullRequest: {
      number: 1,
      url: "https://github.com/o/r/pull/1",
      headSha: expectedPullRequestHeadSha,
    },
    operationKey,
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });
  const plan: TaskPlan = {
    version: 1,
    projectId: project.id,
    cardId: card.id,
    requirements: [
      { id: "REQ-1", text: "Fix feature", verification: "Test the feature" },
    ],
    steps: [
      {
        id: "STEP-1",
        description: "Fix code",
        requirementIds: ["REQ-1"],
        verification: "Run tests",
      },
    ],
    assumptions: [],
    blockers: [],
  };
  planStore.create(plan, 1);
  planStore.storeVerification(card.id, 1, {
    version: 1,
    projectId: project.id,
    cardId: card.id,
    planRevision: 1,
    verdict: "pass",
    findings: [],
  } satisfies PlanVerificationResult);
  const entry = {
    kind: "inline-comment" as const,
    id: "comment-1",
    author: "reviewer",
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: null,
    body: "Handle the empty case.",
    actionability: "actionable" as const,
    status: "pending" as const,
    verificationEvidence: [],
  };
  feedbackLedgerStore.create(card.id, [entry]);
  const git = {
    getCurrentBranch: vi.fn(async () => expectedBranch),
    getHeadSha: vi.fn(async () => "b".repeat(40)),
    getHeadTrackedFiles: vi.fn(async () => ["source.ts"]),
    getIndexEntries: vi.fn(
      async () =>
        "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsource.ts\0",
    ),
    getUntrackedFiles: vi.fn(async () => []),
  };
  const base = {
    project,
    card,
    expectedBranch,
    operationKey,
    operationId: "feedback-op-1",
    expectedPrimarySessionId,
    expectedPullRequestHeadSha,
    worktreePath,
    taskRecordStore,
    planStore,
    feedbackLedgerStore,
    git: git as never,
    runOptions: {
      model: "model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  };
  return { base, taskRecordStore, feedbackLedgerStore, git };
}

describe("runTaskSessionFeedbackRemediation", () => {
  it("resumes the exact primary session with all pending items and preserves no-op status", async () => {
    const f = fixture();
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "No changes needed",
      errorOutput: "",
    });
    const result = await runTaskSessionFeedbackRemediation({
      ...f.base,
      openCode: new OpenCodeClient(runOpenCode),
    });
    expect(result.status).toBe("no-op");
    expect(result.remainingActionableFeedback).toBe(1);
    expect(runOpenCode.mock.calls[0]?.[0].sessionId).toBe("primary-session");
    expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(
      "Handle the empty case.",
    );
    expect(f.taskRecordStore.read("card")?.feedbackRemediation?.status).toBe(
      "no-op",
    );
    expect(f.feedbackLedgerStore.read("card")?.entries[0]?.status).toBe(
      "pending",
    );
  });

  it("rejects a mismatched primary session before invoking OpenCode", async () => {
    const f = fixture();
    const runOpenCode = vi.fn<RunOpenCode>();
    await expect(
      runTaskSessionFeedbackRemediation({
        ...f.base,
        expectedPrimarySessionId: "another-session",
        openCode: new OpenCodeClient(runOpenCode),
      }),
    ).rejects.toThrow("phase, primary session, or PR head");
    expect(runOpenCode).not.toHaveBeenCalled();
  });

  it("detects a source edit and leaves new feedback items in the ledger", async () => {
    const f = fixture();
    const runOpenCode = vi.fn<RunOpenCode>().mockImplementation(async () => {
      fs.writeFileSync(
        path.join(f.base.worktreePath, "source.ts"),
        "changed\n",
      );
      f.feedbackLedgerStore.mergeIncoming("card", [
        {
          ...f.feedbackLedgerStore.read("card")!.entries[0]!,
          id: "comment-2",
          body: "Also update docs.",
        },
      ]);
      return { exitCode: 0, output: "Changed", errorOutput: "" };
    });
    const result = await runTaskSessionFeedbackRemediation({
      ...f.base,
      openCode: new OpenCodeClient(runOpenCode),
    });
    expect(result.status).toBe("changed");
    expect(result.feedbackChangedDuringRun).toBe(true);
    expect(result.remainingActionableFeedback).toBe(2);
  });
});
