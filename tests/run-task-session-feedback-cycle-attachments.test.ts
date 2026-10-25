import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { runTaskSessionFeedbackCycle } from "../src/orchestrator/run-task-session-feedback-cycle.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-cycle-attachments-"));
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot: path.join(root, "worktrees"),
      validationCommand: "yarn validate",
    },
    opencode: { timeoutMinutes: 1 },
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
    github: {} as never,
    openCode: {} as never,
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
