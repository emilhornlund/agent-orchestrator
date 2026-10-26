import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { RunOpenCode } from "../src/opencode/opencode-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { runTaskSessionFeedbackVerification } from "../src/task-session/run-task-session-feedback-verification.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";
import type { GitClient } from "../src/git/git-client.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-verification-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "source.ts"), "fixed\n");
  const project = {
    id: "project",
    repository: { path: repositoryPath, worktreeRoot },
  } as ProjectConfig;
  const card: TrelloCard = {
    id: "card",
    name: "Task",
    desc: "Original task",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card",
  };
  const plan: TaskPlan = {
    version: 1,
    projectId: "project",
    cardId: "card",
    requirements: [
      { id: "REQ-1", text: "Feature works", verification: "Test it" },
    ],
    steps: [
      {
        id: "STEP-1",
        description: "Implement feature",
        requirementIds: ["REQ-1"],
        verification: "Run tests",
      },
    ],
    assumptions: [],
    blockers: [],
  };
  const headSha = "a".repeat(40);
  const git = {
    getCurrentBranch: vi.fn(async () => "agent/card"),
    getHeadSha: vi.fn(async () => headSha),
    getHeadTrackedFiles: vi.fn(async () => ["source.ts"]),
    getIndexEntries: vi.fn(
      async () =>
        "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsource.ts\0",
    ),
    getUntrackedFiles: vi.fn(async () => []),
    getDiff: vi.fn(async (_cwd: string, staged = false) =>
      staged ? "staged" : "unstaged",
    ),
  } as unknown as Pick<
    GitClient,
    | "getCurrentBranch"
    | "getHeadSha"
    | "getHeadTrackedFiles"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getDiff"
  >;
  const feedback: FeedbackLedgerEntry[] = [
    {
      kind: "inline-comment",
      id: "comment-1",
      author: "reviewer",
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: null,
      body: "Fix the edge case.",
      actionability: "actionable",
      status: "pending",
      verificationEvidence: [],
    },
  ];
  const reviewResult = {
    version: 1 as const,
    projectId: "project",
    cardId: "card",
    verdict: "pass" as const,
    requirementAssessments: [
      {
        requirementId: "REQ-1",
        status: "satisfied" as const,
        details: "Implemented",
        evidence: ["source.ts"],
      },
    ],
    blockingFindings: [],
    reviewedContentIdentity: "",
  };
  return {
    project,
    card,
    plan,
    git,
    feedback,
    reviewResult,
    headSha,
    worktreePath,
  };
}

describe("runTaskSessionFeedbackVerification", () => {
  it("uses a separate read-only session and returns one disposition per feedback ID", async () => {
    const f = fixture();
    const identity = await getTaskSessionSourceSnapshotIdentity(
      f.git,
      f.worktreePath,
    );
    const response = {
      version: 1,
      projectId: "project",
      cardId: "card",
      headSha: f.headSha,
      contentIdentity: identity,
      dispositions: [
        {
          feedbackId: "inline-comment:comment-1",
          status: "verified-fixed",
          evidence: ["source.ts", "test.ts"],
        },
      ],
    };
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify(response),
      errorOutput: "",
    });
    const result = await runTaskSessionFeedbackVerification({
      project: f.project,
      card: f.card,
      expectedBranch: "agent/card",
      expectedHeadSha: f.headSha,
      worktreePath: f.worktreePath,
      approvedPlan: f.plan,
      actionableFeedback: f.feedback,
      qualityEvidence: {
        currentContentIdentity: identity,
        validationCommand: "yarn validate",
        validation: {
          command: "yarn validate",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:01:00.000Z",
          exitCode: 0,
          status: "passed",
          timedOut: false,
          aborted: false,
          diagnostic: "ok",
          contentIdentity: identity,
        },
        coverage: null,
        review: { ...f.reviewResult, reviewedContentIdentity: identity },
      },
      git: f.git,
      openCode: new OpenCodeClient(run),
      runOptions: {
        model: "reviewer",
        variant: "high",
        timeoutMilliseconds: 60_000,
        signal: new AbortController().signal,
      },
    });
    expect(result.dispositions[0]?.status).toBe("verified-fixed");
    expect(run.mock.calls[0]?.[0].readOnly).toBe(true);
    expect(run.mock.calls[0]?.[0].sessionId).toBeUndefined();
    expect(run.mock.calls[0]?.[0].prompt).toContain("Fix the edge case.");
    expect(run.mock.calls[0]?.[0].prompt).toContain("Approved plan:");
  });

  it("does not invoke an independent verifier when local gates are stale or failed", async () => {
    const f = fixture();
    const identity = await getTaskSessionSourceSnapshotIdentity(
      f.git,
      f.worktreePath,
    );
    const run = vi.fn<RunOpenCode>();
    await expect(
      runTaskSessionFeedbackVerification({
        project: f.project,
        card: f.card,
        expectedBranch: "agent/card",
        expectedHeadSha: f.headSha,
        worktreePath: f.worktreePath,
        approvedPlan: f.plan,
        actionableFeedback: f.feedback,
        qualityEvidence: {
          currentContentIdentity: identity,
          validationCommand: "yarn validate",
          validation: null,
          coverage: null,
          review: null,
        },
        git: f.git,
        openCode: new OpenCodeClient(run),
        runOptions: {
          model: "reviewer",
          variant: "high",
          timeoutMilliseconds: 60_000,
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow("quality gates failed");
    expect(run).not.toHaveBeenCalled();
  });
  it("runs verification with failed advisory AI review", async () => {
    const f = fixture();
    const identity = await getTaskSessionSourceSnapshotIdentity(
      f.git,
      f.worktreePath,
    );
    const run = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({
        version: 1,
        projectId: "project",
        cardId: "card",
        headSha: f.headSha,
        contentIdentity: identity,
        dispositions: [
          {
            feedbackId: "inline-comment:comment-1",
            status: "unresolved",
            reason: "Not verified",
          },
        ],
      }),
      errorOutput: "",
    });
    const result = await runTaskSessionFeedbackVerification({
      project: f.project,
      card: f.card,
      expectedBranch: "agent/card",
      expectedHeadSha: f.headSha,
      worktreePath: f.worktreePath,
      approvedPlan: f.plan,
      actionableFeedback: f.feedback,
      qualityEvidence: {
        currentContentIdentity: identity,
        validationCommand: "yarn validate",
        validation: {
          command: "yarn validate",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:01:00.000Z",
          exitCode: 0,
          status: "passed",
          timedOut: false,
          aborted: false,
          diagnostic: "ok",
          contentIdentity: identity,
        },
        coverage: null,
        review: {
          ...f.reviewResult,
          verdict: "fail",
          reviewedContentIdentity: identity,
        },
      },
      git: f.git,
      openCode: new OpenCodeClient(run),
      runOptions: {
        model: "reviewer",
        variant: "high",
        timeoutMilliseconds: 60000,
        signal: new AbortController().signal,
      },
    });
    expect(result.dispositions[0]?.status).toBe("unresolved");
  });
});
