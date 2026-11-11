import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { expectedTaskTrelloList } from "../src/task-session/reconcile-task-session.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import {
  ensureFeedbackCardLocation,
  prepareFeedbackCardMove,
  reconcilePendingFeedbackCardMove,
} from "../src/orchestrator/feedback-card-location.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-location-"));
  const project = {
    id: "project",
    trello: {
      reviewListId: "review",
      workingListId: "working",
      doneListId: "done",
    },
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
      github: "owner/repo",
      defaultBranch: "main",
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  const state = path.join(root, "state");
  const taskStore = new TaskExecutionStore(state, project);
  taskStore.create({
    version: 1,
    projectId: project.id,
    cardId: "card",
    phase: "human-feedback",
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    operationKey: "task",
    revision: 1,
    pullRequest: {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      headSha: "a".repeat(40),
    },
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let list = "review";
  let loseAck = false;
  const trello = {
    getCard: vi.fn(async () => ({ id: "card", idList: list })),
    moveCard: vi.fn(async (_id: string, to: string) => {
      list = to;
      if (loseAck) {
        loseAck = false;
        throw new Error("lost acknowledgment");
      }
      return { id: "card", idList: list };
    }),
  } as unknown as TrelloClient;
  const github = {
    findPullRequestState: vi.fn(async () => ({
      url: "https://github.com/owner/repo/pull/1",
      state: "OPEN",
    })),
  } as unknown as GitHubClient;
  return {
    project,
    taskStore,
    trello,
    github,
    state,
    cardId: "card",
    move: (to: string) => {
      list = to;
    },
    loseAck: () => {
      loseAck = true;
    },
  };
}

it("reconciles a verified Working move after acknowledgment loss without repeating it or inferring location from phase", async () => {
  const f = fixture();
  f.loseAck();
  await expect(
    ensureFeedbackCardLocation(f, "working", "correction:working"),
  ).rejects.toThrow("lost acknowledgment");
  expect(f.taskStore.read("card")?.feedbackCardMove).toMatchObject({
    fromListId: "review",
    toListId: "working",
  });
  const restarted = new TaskExecutionStore(f.state, f.project);
  await reconcilePendingFeedbackCardMove({ ...f, taskStore: restarted });
  expect(f.trello.moveCard).toHaveBeenCalledTimes(1);
  const working = restarted.read("card")!;
  expect(expectedTaskTrelloList(f.project, working)).toBe("working");
  const implementation = transitionTaskExecutionRecord(working, {
    type: "feedback-received",
    eventId: "feedback",
    projectId: f.project.id,
    cardId: "card",
    operationKey: "task",
    occurredAt: new Date(Date.parse(working.updatedAt) + 1).toISOString(),
  });
  expect(expectedTaskTrelloList(f.project, implementation)).toBe("working");
  await ensureFeedbackCardLocation(
    { ...f, taskStore: restarted },
    "review",
    "correction:review",
  );
  expect(restarted.read("card")?.expectedTrelloListId).toBe("review");
});

it("preserves an unexpected manual move instead of treating it as the pending transition", async () => {
  const f = fixture();
  await prepareFeedbackCardMove(f, "working", "correction:working");
  f.move("backlog");
  await expect(reconcilePendingFeedbackCardMove(f)).rejects.toThrow(
    "unexpectedly",
  );
  expect(f.trello.moveCard).not.toHaveBeenCalled();
  expect(f.taskStore.read("card")?.expectedTrelloListId).toBe("review");
  f.move("review");
  await reconcilePendingFeedbackCardMove(f);
  expect(f.taskStore.read("card")?.expectedTrelloListId).toBe("working");
});

it("retains the old published-correction Review expectation until a verified explicit transition", () => {
  const f = fixture();
  const current = f.taskStore.read("card")!;
  expect(
    expectedTaskTrelloList(f.project, {
      ...current,
      phase: "validation",
      feedbackRemediation: {
        operationId: "old-correction",
        status: "changed",
        ledgerRevision: 1,
        headSha: "a".repeat(40),
      },
    }),
  ).toBe("review");
});

it("refuses a mismatched external card identity before recording or dispatching a move", async () => {
  const f = fixture();
  vi.mocked(f.trello.getCard).mockResolvedValueOnce({
    id: "other",
    idList: "review",
    name: "Other",
    desc: "",
    idLabels: [],
    url: "https://trello.test/other",
  });
  await expect(
    ensureFeedbackCardLocation(f, "working", "correction:working"),
  ).rejects.toThrow("identity");
  expect(f.trello.moveCard).not.toHaveBeenCalled();
  expect(f.taskStore.read("card")?.feedbackCardMove).toBeUndefined();
});
