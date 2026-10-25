import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { observeTaskSessionReviewCards } from "../src/orchestrator/observe-task-session-review-cards.js";
import { maintainOutdatedPr } from "../src/orchestrator/maintain-outdated-pr.js";
import { enrichMaintainedPullRequestDescription } from "../src/orchestrator/publish-card.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";

vi.mock("../src/orchestrator/observe-task-session-review-cards.js", () => ({
  observeTaskSessionReviewCards: vi.fn(),
}));
vi.mock("../src/orchestrator/maintain-outdated-pr.js", () => ({
  maintainOutdatedPr: vi.fn(async () => "deferred"),
  reconcileInterruptedPrMaintenance: vi.fn(async () => undefined),
}));
vi.mock("../src/orchestrator/run-task-session-feedback-cycle.js", () => ({
  runTaskSessionFeedbackCycle: vi.fn(async () => "idle"),
}));
vi.mock("../src/orchestrator/publish-card.js", () => ({
  publishCard: vi.fn(),
  enrichMaintainedPullRequestDescription: vi.fn(async () => true),
}));

const sha = "a".repeat(40);
let root: string | undefined;

afterEach(() => {
  vi.clearAllMocks();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function pollReview(
  relation: "current" | "behind" | "diverged" | "uncertain",
  maintenance?: { enabled: boolean },
  withPlan = true,
): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-maintenance-dispatch-"));
  const project = {
    id: "project",
    autoMerge: false,
    ...(maintenance === undefined ? {} : { maintenance }),
    contextRoot: path.join(root, "context"),
    trello: {
      boardId: "board",
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      refinementLabelId: "refinement",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    repository: {
      path: path.join(root, "repository"),
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot: path.join(root, "worktrees"),
      validationCommand: "yarn validate",
      gitIdentity: { name: "Bot", email: "bot@example.test" },
    },
    opencode: {
      timeoutMinutes: 1,
      refinement: { model: "test", variant: "high" },
      implementation: { model: "test", variant: "high" },
      review: { model: "test", variant: "high" },
      remediation: { model: "test", variant: "high", maxPasses: 1 },
      commit: { model: "test", variant: "low" },
    },
  } as ProjectConfig & { contextRoot: string };
  const card = {
    id: "card",
    name: "Task",
    desc: "",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card",
  };
  new TaskExecutionStore(project.contextRoot, project).create({
    version: 1,
    projectId: project.id,
    cardId: card.id,
    phase: "human-feedback",
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    pullRequest: {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      headSha: sha,
    },
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });
  if (withPlan) {
    new TaskPlanStore(project.contextRoot, project).create(
      {
        version: 1,
        projectId: project.id,
        cardId: card.id,
        requirements: [
          { id: "REQ-1", text: "Task", verification: "Check task" },
        ],
        steps: [
          {
            id: "STEP-1",
            description: "Implement the requirement",
            requirementIds: ["REQ-1"],
            verification: "Run checks",
          },
        ],
        assumptions: [],
        blockers: [],
      },
      1,
    );
  }
  vi.mocked(observeTaskSessionReviewCards).mockResolvedValue([
    {
      cardId: card.id,
      state: "OPEN",
      headSha: sha,
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      baseRelation: relation,
      ciEvaluation: { status: "passed" },
      feedbackIds: [],
      requestedChanges: null,
      conversationComments: [],
    },
  ] as never);

  await runTaskSessionWorkflow({
    project,
    trello: {
      getCards: vi.fn(async (listId: string) =>
        listId === "review" ? [card] : [],
      ),
    } as never,
    git: {} as never,
    github: {} as never,
    openCode: {} as never,
    commands: {} as never,
    signal: new AbortController().signal,
    prepareAttachmentContext: async () => undefined,
  });
}

describe("opt-in maintenance in the production Human Review polling path", () => {
  it.each(["behind", "diverged"] as const)(
    "dispatches %s owned PRs when maintenance is explicitly enabled",
    async (relation) => {
      await pollReview(relation, { enabled: true });
      expect(maintainOutdatedPr).toHaveBeenCalledOnce();
      expect(vi.mocked(maintainOutdatedPr).mock.calls[0]?.[0]).toMatchObject({
        eligible: true,
        hasRequestedChanges: false,
        hasUnresolvedFeedback: false,
      });
    },
  );

  it.each(["current", "uncertain"] as const)(
    "does not dispatch %s PRs",
    async (relation) => {
      await pollReview(relation);
      expect(maintainOutdatedPr).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch when maintenance is omitted", async () => {
    await pollReview("diverged");
    expect(maintainOutdatedPr).not.toHaveBeenCalled();
  });

  it("does not schedule maintenance when the approved plan is missing", async () => {
    await pollReview("diverged", { enabled: true }, false);
    expect(maintainOutdatedPr).not.toHaveBeenCalled();
  });

  it("enriches the same PR only after successful maintenance publication", async () => {
    const newHead = "b".repeat(40);
    vi.mocked(maintainOutdatedPr).mockImplementationOnce(async (options) => {
      const current = options.taskStore.read(options.card.id)!;
      options.taskStore.compareAndSwap(current.cardId, current.revision, {
        ...current,
        pullRequest: { ...current.pullRequest!, headSha: newHead },
        revision: current.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
        ).toISOString(),
      });
      return "published";
    });
    await pollReview("diverged", { enabled: true });
    expect(enrichMaintainedPullRequestDescription).toHaveBeenCalledOnce();
    expect(
      vi.mocked(enrichMaintainedPullRequestDescription).mock.calls[0]?.[0],
    ).toMatchObject({
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      commitSha: newHead,
    });
  });

  it("honors an explicit maintenance opt-out", async () => {
    await pollReview("diverged", { enabled: false });
    expect(maintainOutdatedPr).not.toHaveBeenCalled();
  });
});
