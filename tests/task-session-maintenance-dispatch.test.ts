import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { runTaskSessionFeedbackCycle } from "../src/orchestrator/run-task-session-feedback-cycle.js";
import { observeTaskSessionReviewCards } from "../src/orchestrator/observe-task-session-review-cards.js";
import { maintainOutdatedPr } from "../src/orchestrator/maintain-outdated-pr.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { runTaskSessionCiRepairs } from "../src/task-session/run-task-session-ci-repairs.js";

vi.mock("../src/orchestrator/observe-task-session-review-cards.js", () => ({
  observeTaskSessionReviewCards: vi.fn(),
}));
vi.mock("../src/orchestrator/maintain-outdated-pr.js", () => ({
  maintainOutdatedPr: vi.fn(async () => "deferred"),
  reconcileInterruptedPrMaintenance: vi.fn(async () => undefined),
  retireFailedUnpublishedPrMaintenance: vi.fn(),
  requeueInterruptedPreparedPrMaintenance: vi.fn(() => false),
}));
vi.mock("../src/orchestrator/run-task-session-feedback-cycle.js", () => ({
  runTaskSessionFeedbackCycle: vi.fn(async () => "idle"),
}));
vi.mock("../src/task-session/run-task-session-ci-repairs.js", () => ({
  runTaskSessionCiRepairs: vi.fn(async () => ({ status: "idle" })),
}));
vi.mock("../src/orchestrator/publish-card.js", () => ({
  publishCard: vi.fn(),
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
  feedbackIds: string[] = [],
  emailNotifier?: {
    send: (message: { subject: string; text: string }) => Promise<void>;
  },
  legacyCardId?: string,
  readyCard?: {
    id: string;
    name: string;
    desc: string;
    idList: string;
    idLabels: string[];
    url: string;
  },
  workingCard?: {
    id: string;
    name: string;
    desc: string;
    idList: string;
    idLabels: string[];
    url: string;
  },
  taskPhase: "human-feedback" | "ci" | "implementation" = "human-feedback",
  ciStatus: "passed" | "failed" = "passed",
): Promise<{
  git: {
    addWorktreeWithNewBranch: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
    getCurrentBranch: ReturnType<typeof vi.fn>;
  };
  openCodeRun: ReturnType<typeof vi.fn>;
  project: ProjectConfig & { contextRoot: string };
}> {
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
    phase: taskPhase,
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
  if (legacyCardId !== undefined) {
    new PrMaintenanceStore(project.contextRoot, project).create({
      projectId: project.id,
      cardId: legacyCardId,
      pullRequest: {
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
      },
      expectedRemoteHead: "b".repeat(40),
      targetBaseHead: "c".repeat(40),
      operationId: "00000000-0000-4000-8000-000000000007",
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
  }
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
      ciEvaluation: {
        status: ciStatus,
        ...(ciStatus === "failed" ? { failures: [] } : {}),
      },
      feedbackIds,
      requestedChanges: null,
      conversationComments: [],
    },
  ] as never);

  const trello = {
    getCards: vi.fn(async (listId: string) =>
      listId === "review"
        ? [card]
        : listId === "ready" && readyCard !== undefined
          ? [readyCard]
          : listId === "working" && workingCard !== undefined
            ? [workingCard]
            : [],
    ),
  };
  const git = {
    addWorktreeWithNewBranch: vi.fn(),
    fetch: vi.fn(),
    push: vi.fn(),
    getCurrentBranch: vi.fn(),
  };
  const openCode = { run: vi.fn() };
  await runTaskSessionWorkflow({
    project,
    trello: trello as never,
    git: git as never,
    github: {} as never,
    openCode: openCode as never,
    commands: {} as never,
    signal: new AbortController().signal,
    prepareAttachmentContext: async () => undefined,
    ...(emailNotifier === undefined ? {} : { emailNotifier }),
  });
  return { git, project, openCodeRun: openCode.run };
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

  it("does not let routine maintenance deferral suppress actionable feedback", async () => {
    await pollReview("behind", { enabled: true }, true, ["review-1"]);
    expect(maintainOutdatedPr).toHaveBeenCalledOnce();
    expect(runTaskSessionFeedbackCycle).toHaveBeenCalledOnce();
    expect(
      vi.mocked(runTaskSessionFeedbackCycle).mock.calls[0]?.[0],
    ).toMatchObject({
      observation: { feedbackIds: ["review-1"] },
    });
  });

  it("blocks failed-CI branch writers when an unresolved legacy effect has no queue owner", async () => {
    const { git, openCodeRun, project } = await pollReview(
      "current",
      undefined,
      true,
      [],
      undefined,
      "legacy-card-absent-from-trello",
      undefined,
      undefined,
      "ci",
      "failed",
    );

    expect(runTaskSessionCiRepairs).not.toHaveBeenCalled();
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(git.addWorktreeWithNewBranch).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(
      new PrMaintenanceStore(project.contextRoot, project).inspect(),
    ).toHaveLength(1);
  });

  it("blocks a different Ready card project-wide when a legacy card is absent from active Trello lists", async () => {
    const readyCard = {
      id: "different-ready-card",
      name: "New task",
      desc: "Implement this task",
      idList: "ready",
      idLabels: ["feature"],
      url: "https://trello.example/new-task",
    };
    const { git, openCodeRun } = await pollReview(
      "current",
      undefined,
      true,
      [],
      undefined,
      "legacy-card-absent-from-active-lists",
      readyCard,
    );

    expect(git.addWorktreeWithNewBranch).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(runTaskSessionCiRepairs).not.toHaveBeenCalled();
  });

  it("does not resume an existing Working implementation under unresolved maintenance", async () => {
    const workingCard = {
      id: "working-task",
      name: "Existing implementation",
      desc: "Continue implementation",
      idList: "working",
      idLabels: ["feature"],
      url: "https://trello.example/working-task",
    };
    const { git, openCodeRun } = await pollReview(
      "current",
      undefined,
      true,
      [],
      undefined,
      "legacy-card-absent-from-active-lists",
      undefined,
      workingCard,
      "implementation",
    );

    expect(git.getCurrentBranch).not.toHaveBeenCalled();
    expect(git.addWorktreeWithNewBranch).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(openCodeRun).not.toHaveBeenCalled();
  });

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

  it("safely defers maintenance without treating it as publication", async () => {
    await pollReview("diverged", { enabled: true });
    await expect(
      vi.mocked(maintainOutdatedPr).mock.results[0]?.value,
    ).resolves.toBe("deferred");
  });

  it("honors an explicit maintenance opt-out", async () => {
    await pollReview("diverged", { enabled: false });
    expect(maintainOutdatedPr).not.toHaveBeenCalled();
  });

  it("forwards the configured notifier to feedback correction through the coordinator", async () => {
    const emailNotifier = { send: vi.fn(async () => undefined) };
    await pollReview("current", undefined, true, [], emailNotifier);
    expect(runTaskSessionFeedbackCycle).toHaveBeenCalledOnce();
    expect(
      vi.mocked(runTaskSessionFeedbackCycle).mock.calls[0]?.[0],
    ).toMatchObject({ emailNotifier });
  });
});
