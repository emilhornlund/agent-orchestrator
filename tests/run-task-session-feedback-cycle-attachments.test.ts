import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import {
  persistQualityEvidence,
  runTaskSessionFeedbackCycle,
} from "../src/orchestrator/run-task-session-feedback-cycle.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { actionableFeedbackResponse } from "./support/feedback-classification-response.js";

let root: string;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-cycle-attachments-"));
  const project = {
    id: "project",
    trello: { reviewListId: "review", workingListId: "working" },
    repository: {
      path: path.join(root, "repo"),
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot: path.join(root, "worktrees"),
      validationCommand: "yarn validate",
    },
    opencode: { timeoutMinutes: 1, review: {} },
  } as ProjectConfig;
  const stateRoot = path.join(root, "state");
  const card: TrelloCard = {
    id: "card",
    name: "Task",
    desc: "Task description",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card",
  };
  const taskStore = new TaskExecutionStore(stateRoot, project);
  taskStore.create({
    version: 1,
    projectId: project.id,
    cardId: card.id,
    phase: "human-feedback",
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    pullRequest: {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      headSha: "a".repeat(40),
    },
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  });
  const planStore = new TaskPlanStore(stateRoot, project);
  planStore.create(
    {
      version: 1,
      projectId: project.id,
      cardId: card.id,
      requirements: [{ id: "REQ-1", text: "Task", verification: "Check it" }],
      steps: [
        {
          id: "STEP-1",
          description: "Implement task",
          requirementIds: ["REQ-1"],
          verification: "Run validation",
        },
      ],
      assumptions: [],
      blockers: [],
    },
    1,
  );
  planStore.storeVerification(card.id, 1, {
    version: 1,
    projectId: project.id,
    cardId: card.id,
    planRevision: 1,
    verdict: "pass",
    findings: [],
  });
  const common = {
    project,
    card,
    taskStore,
    planStore,
    ledgerStore: new FeedbackLedgerStore(stateRoot, project),
    mutationQueue: new TaskMutationQueue(stateRoot, project),
    trello: {} as never,
    git: {} as never,
    github: { ensurePullRequestDraft: vi.fn(async () => undefined) } as never,
    openCode: new OpenCodeClient(async ({ prompt }) => ({
      exitCode: 0,
      output: actionableFeedbackResponse(prompt),
      errorOutput: "",
    })),
    commands: {} as never,
    worktreePath: path.join(root, "worktrees", card.id),
    signal: new AbortController().signal,
  };
  const observation = {
    state: "OPEN" as const,
    cardId: card.id,
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
    headSha: "a".repeat(40),
    ciEvaluation: { status: "passed" },
    expectedCheckNames: [],
    feedbackIds: [],
    requestedChanges: null,
    conversationComments: [],
  };
  return { common, observation };
}

describe("Human Review attachment preparation", () => {
  it("preserves both operation and cleanup failures when managed activity cannot be reconciled", async () => {
    const f = fixture();
    const startFailure = new Error("status start unavailable");
    const clearFailure = new Error("status clear unavailable");
    const updateStatus = vi
      .fn()
      .mockRejectedValueOnce(startFailure)
      .mockRejectedValueOnce(clearFailure);
    const result = runTaskSessionFeedbackCycle({
      ...f.common,
      github: {
        ensurePullRequestDraft: vi.fn(async () => undefined),
        updatePullRequestDescriptionStatus: updateStatus,
      } as never,
      observation: {
        ...f.observation,
        conversationComments: [
          {
            id: 10,
            author: "human",
            body: "Please fix this",
            createdAt: "2026-10-24T09:00:00.000Z",
            updatedAt: null,
          },
        ],
      } as never,
    });
    await expect(result).rejects.toMatchObject({
      errors: [{ cause: startFailure }, { cause: clearFailure }],
      cause: { cause: clearFailure },
    });
    expect(f.common.mutationQueue.getActive()?.status).toBe("failed");
    expect(f.common.taskStore.read("card")?.phase).toBe("human-feedback");
  });

  it("does not trigger classification or correction from self, bot, or managed-status comments", async () => {
    const f = fixture();
    const classify = vi.spyOn(f.common.openCode, "run");
    const prepareAttachmentContext = vi.fn(async () => undefined);
    const comments = [
      { id: 1, author: "automation", body: "Fix something" },
      {
        id: 2,
        author: "other-bot",
        authorIsBot: true,
        body: "Fix something else",
      },
      {
        id: 3,
        author: "human",
        body: "<!-- agent-orchestrator-feedback:status --> work complete",
      },
    ].map((item) => ({
      ...item,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: null,
    }));
    await expect(
      runTaskSessionFeedbackCycle({
        ...f.common,
        observation: {
          ...f.observation,
          automationActor: "automation",
          conversationComments: comments,
        } as never,
        prepareAttachmentContext,
      }),
    ).resolves.toBe("idle");
    expect(classify).not.toHaveBeenCalled();
    expect(prepareAttachmentContext).not.toHaveBeenCalled();
    expect(f.common.mutationQueue.list()).toEqual([]);
  });

  it("persists semantic discussion classification instead of parking a general PR comment for attention", async () => {
    const f = fixture();
    vi.spyOn(f.common.openCode, "run").mockImplementation(async ({ prompt }) => ({
      exitCode: 0,
      errorOutput: "",
      output: actionableFeedbackResponse(prompt).replaceAll('"actionable"', '"discussion"'),
    }));
    const observation = {
      ...f.observation,
      conversationComments: [
        {
          id: 1,
          author: "human",
          body: "Why was this approach chosen?",
          createdAt: "2026-10-24T09:00:00.000Z",
          updatedAt: null,
        },
      ],
    };
    await expect(
      runTaskSessionFeedbackCycle({
        ...f.common,
        observation: observation as never,
      }),
    ).resolves.toBe("idle");
    await expect(
      runTaskSessionFeedbackCycle({
        ...f.common,
        observation: observation as never,
      }),
    ).resolves.toBe("idle");
    expect(f.common.openCode.run).toHaveBeenCalledOnce();
    expect(f.common.ledgerStore.read("card")?.entries).toMatchObject([
      { actionability: "discussion" },
    ]);
    expect(f.common.taskStore.read("card")?.phase).toBe("human-feedback");
  });

  it("preserves a higher validation budget and used attempts when feedback publication stores fresh evidence", () => {
    const f = fixture();
    const current = f.common.taskStore.read(f.common.card.id);
    if (current === null) throw new Error("Expected task record");
    const identity = `sha256:${"c".repeat(64)}`;
    const withPriorValidation = f.common.taskStore.compareAndSwap(
      f.common.card.id,
      current.revision,
      {
        ...current,
        retryCounters: { ...current.retryCounters, validation: 3 },
        validationRepair: {
          cycleId: "operation",
          status: "exhausted",
          maxAttempts: 4,
          stopReason: "no-change",
          evidence: {
            command: "yarn validate",
            startedAt: "2026-10-24T09:00:00.000Z",
            completedAt: "2026-10-24T09:01:00.000Z",
            exitCode: 1,
            status: "failed",
            diagnostic: "Prior validation failure",
            contentIdentity: identity,
          },
          coverageEvidence: {
            command: "",
            startedAt: "2026-10-24T09:00:00.000Z",
            completedAt: "2026-10-24T09:00:00.000Z",
            exitCode: null,
            status: "skipped",
            diagnostic: "Coverage is not configured",
            contentIdentity: identity,
          },
        },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      },
    );
    const validation = {
      command: "yarn validate",
      startedAt: "2026-10-24T09:02:00.000Z",
      completedAt: "2026-10-24T09:03:00.000Z",
      exitCode: 0,
      status: "passed" as const,
      timedOut: false,
      aborted: false,
      diagnostic: "Prepared feedback content passes validation",
      contentIdentity: identity,
    };
    const coverage = {
      command: "",
      startedAt: "2026-10-24T09:03:00.000Z",
      completedAt: "2026-10-24T09:03:00.000Z",
      exitCode: null,
      status: "skipped" as const,
      timedOut: false,
      aborted: false,
      diagnostic: "Coverage is not configured",
      contentIdentity: identity,
    };

    const persisted = persistQualityEvidence(
      f.common.taskStore,
      withPriorValidation,
      "feedback-operation",
      validation,
      coverage,
    );

    expect(persisted.retryCounters.validation).toBe(3);
    expect(persisted.validationRepair).toMatchObject({
      cycleId: "operation",
      maxAttempts: 4,
      status: "passed",
      evidence: {
        status: "passed",
        diagnostic: "Prepared feedback content passes validation",
      },
    });
  });

  it("skips attachment reconciliation across repeated idle polls", async () => {
    const f = fixture();
    const prepareAttachmentContext = vi.fn(async () => undefined);

    for (let poll = 0; poll < 3; poll += 1) {
      await expect(
        runTaskSessionFeedbackCycle({
          ...f.common,
          observation: f.observation as never,
          prepareAttachmentContext,
        }),
      ).resolves.toBe("idle");
    }

    expect(prepareAttachmentContext).not.toHaveBeenCalled();
    expect(f.common.mutationQueue.list()).toEqual([]);
  });

  it("refreshes attachments for actionable feedback before remediation", async () => {
    const f = fixture();
    const refreshFailure = new Error("attachment refresh failed");
    const prepareAttachmentContext = vi.fn(async () => {
      throw refreshFailure;
    });
    const observation = {
      ...f.observation,
      feedbackIds: ["review:2"],
      requestedChanges: {
        headSha: "a".repeat(40),
        feedback: {
          reviews: [
            {
              id: 2,
              commitSha: "a".repeat(40),
              body: "Please fix the edge case.",
              author: "reviewer",
              submittedAt: "2026-10-24T09:01:00.000Z",
              inlineComments: [],
              source: "current-head" as const,
            },
          ],
        },
      },
    };

    await expect(
      runTaskSessionFeedbackCycle({
        ...f.common,
        observation: observation as never,
        prepareAttachmentContext,
      }),
    ).rejects.toBe(refreshFailure);

    expect(prepareAttachmentContext).toHaveBeenCalledOnce();
    expect(f.common.mutationQueue.getActive()?.status).toBe("failed");
  });
});
