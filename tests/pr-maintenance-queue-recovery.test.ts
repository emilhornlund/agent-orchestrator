import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { retireFailedUnpublishedPrMaintenance } from "../src/orchestrator/maintain-outdated-pr.js";
import { reconcileUnobservedTerminalPrEvents } from "../src/orchestrator/reconcile-unobserved-terminal-pr.js";
import { returnClosedTaskSessionPullRequestToBacklog } from "../src/orchestrator/reconcile-terminal-task-session-pr.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";

const cardId = "6adde9527d050aac6da503da";
const nextCardId = "6ade50875f11ba4e356100c7";
const originalHead = "a6143f17211d8fa0e18b2f07307963f9941b3e26";
const preparedHead = "1797fa6c2bfce50f547e05d993923e046fc8796d";
const baseHead = "f9b7b132eca9d9484c24d273630a057cbb066ed6";
const operationId = "7d7d0a40-fa6b-49a1-9054-d4a2d04fd140";
const originalOperationKey =
  "task-session:6adde9527d050aac6da503da:73e8283eecaf4778";
const prUrl = "https://github.com/emilhornlund/agent-orchestrator/pull/142";
const date = "2026-10-25T17:37:28.178Z";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function fixture() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-maintenance-recovery-"));
  const project = {
    id: "agent-orchestrator",
    trello: { backlogListId: "backlog", doneListId: "done" },
    repository: {
      path: path.join(tmp, "repo"),
      worktreeRoot: path.join(tmp, "worktrees"),
      github: "emilhornlund/agent-orchestrator",
      defaultBranch: "main",
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path, { recursive: true });
  fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
  const context = path.join(tmp, "context");
  const queue = new TaskMutationQueue(context, project);
  const store = new PrMaintenanceStore(context, project);
  const taskStore = new TaskExecutionStore(context, project);
  const identity = {
    projectId: project.id,
    cardId,
    pullRequest: { number: 142, url: prUrl },
    expectedRemoteHead: originalHead,
    targetBaseHead: baseHead,
  };
  store.create({ ...identity, operationId, createdAt: date, updatedAt: date });
  store.advance(operationId, "prepared", "active", identity);
  store.recordLocalPreparation(operationId, identity, {
    status: "prepared",
    originalHead,
    baseHead,
    resultingHead: preparedHead,
    backupRef: "refs/orchestrator/pr-maintenance/test/original",
    updatedAt: date,
  });
  store.recordQualityVerification(operationId, identity, {
    status: "failed",
    preparedHead,
    contentIdentity: `sha256:${"a".repeat(64)}`,
    startedAt: date,
    completedAt: "2026-10-25T17:39:19.234Z",
    diagnostic: "blockingFindings expected object, received string",
  });
  store.advance(operationId, "active", "uncertain", identity);
  const maintenanceId = `pr-maintenance:${cardId}:${operationId}`;
  queue.enqueue({
    eventId: maintenanceId,
    projectId: project.id,
    cardId,
    kind: "pr-maintenance",
    operationKey: operationId,
    enqueuedAt: date,
  });
  queue.claimNext();
  queue.fail(maintenanceId);
  const implementationId = `implementation:${cardId}:73e8283eecaf4778`;
  queue.enqueue({
    eventId: implementationId,
    projectId: project.id,
    cardId,
    kind: "implementation",
    operationKey: originalOperationKey,
    enqueuedAt: "2026-10-25T11:35:13.753Z",
  });
  // The original implementation is already finished before maintenance begins.
  // Complete it in the persisted queue fixture without changing the failed owner.
  const queueFile = path.join(
    context,
    "task-mutation-queues",
    `${project.id}.json`,
  );
  const queueJson = JSON.parse(fs.readFileSync(queueFile, "utf8")) as {
    events: Array<{ eventId: string; status: string }>;
  };
  queueJson.events.find((e) => e.eventId === implementationId)!.status =
    "completed";
  fs.writeFileSync(queueFile, JSON.stringify(queueJson), "utf8");
  const terminalId = `terminal-pr:${cardId}:CLOSED:${originalHead}`;
  queue.enqueue({
    eventId: terminalId,
    projectId: project.id,
    cardId,
    kind: "terminal-pr",
    operationKey: `${originalOperationKey}:CLOSED:${originalHead}`,
    enqueuedAt: "2026-10-25T18:52:33.185Z",
  });
  queue.enqueue({
    eventId: `implementation:${nextCardId}:73e8283eecaf4778`,
    projectId: project.id,
    cardId: nextCardId,
    kind: "implementation",
    operationKey: `task-session:${nextCardId}:73e8283eecaf4778`,
    enqueuedAt: "2026-10-25T18:56:17.631Z",
  });
  const github = {
    getPullRequestStateByNumber: vi.fn().mockResolvedValue({
      url: prUrl,
      state: "CLOSED",
      mergedAt: null,
      headRefOid: originalHead,
      headRefName: `agent/${cardId}`,
      baseRefName: "main",
    }),
  } as unknown as Pick<GitHubClient, "getPullRequestStateByNumber">;
  return {
    project,
    context,
    queue,
    store,
    taskStore,
    github,
    maintenanceId,
    terminalId,
  };
}

describe("failed PR-maintenance queue recovery", () => {
  it("releases a failed review without a publication attempt and survives restart", () => {
    const f = fixture();
    expect(f.queue.claimNext()).toBeNull();

    retireFailedUnpublishedPrMaintenance({
      project: f.project,
      maintenanceStore: f.store,
      mutationQueue: f.queue,
    });

    const restartedQueue = new TaskMutationQueue(f.context, f.project);
    const restartedStore = new PrMaintenanceStore(f.context, f.project);
    expect(restartedStore.inspect(operationId)?.status).toBe("cancelled");
    expect(
      restartedStore.inspect(operationId)?.localPreparation?.resultingHead,
    ).toBe(preparedHead);
    expect(restartedQueue.getActive()).toBeNull();
    expect(
      restartedQueue.list().find((e) => e.eventId === f.maintenanceId)?.status,
    ).toBe("completed");
    retireFailedUnpublishedPrMaintenance({
      project: f.project,
      maintenanceStore: restartedStore,
      mutationQueue: restartedQueue,
    });
    expect(restartedQueue.getActive()).toBeNull();
  });

  it("retires a closed PR event after its Trello task was removed, then claims new work", async () => {
    const f = fixture();
    retireFailedUnpublishedPrMaintenance({
      project: f.project,
      maintenanceStore: f.store,
      mutationQueue: f.queue,
    });
    // There is no live task-execution record or Trello review card.
    await reconcileUnobservedTerminalPrEvents({
      project: f.project,
      queue: f.queue,
      taskStore: f.taskStore,
      maintenanceStore: f.store,
      github: f.github,
      trello: { getCards: vi.fn(async () => []) } as never,
      signal: new AbortController().signal,
      observedReviewCardIds: [],
    });
    expect(f.queue.list().find((e) => e.eventId === f.terminalId)?.status).toBe(
      "completed",
    );
    expect(f.queue.claimNext()?.cardId).toBe(nextCardId);
    expect(f.store.inspect(operationId)?.localPreparation?.resultingHead).toBe(
      preparedHead,
    );
  });

  it("retires a removed-card event when the closed PR branch was deleted", async () => {
    const f = fixture();
    retireFailedUnpublishedPrMaintenance({
      project: f.project,
      maintenanceStore: f.store,
      mutationQueue: f.queue,
    });
    vi.mocked(f.github.getPullRequestStateByNumber).mockResolvedValue({
      url: prUrl,
      state: "CLOSED",
      mergedAt: null,
      headRefName: `agent/${cardId}`,
      baseRefName: "main",
    });
    await reconcileUnobservedTerminalPrEvents({
      project: f.project,
      queue: f.queue,
      taskStore: f.taskStore,
      maintenanceStore: f.store,
      github: f.github,
      trello: { getCards: vi.fn(async () => []) } as never,
      signal: new AbortController().signal,
      observedReviewCardIds: [],
    });
    expect(f.queue.list().find((e) => e.eventId === f.terminalId)?.status).toBe(
      "completed",
    );
    expect(f.queue.claimNext()?.cardId).toBe(nextCardId);
  });

  it("does not retire an orphan event on a mismatched GitHub PR head", async () => {
    const f = fixture();
    retireFailedUnpublishedPrMaintenance({
      project: f.project,
      maintenanceStore: f.store,
      mutationQueue: f.queue,
    });
    vi.mocked(f.github.getPullRequestStateByNumber).mockResolvedValue({
      url: prUrl,
      state: "CLOSED",
      mergedAt: null,
      headRefOid: baseHead,
      headRefName: `agent/${cardId}`,
      baseRefName: "main",
    });
    await expect(
      reconcileUnobservedTerminalPrEvents({
        project: f.project,
        queue: f.queue,
        taskStore: f.taskStore,
        maintenanceStore: f.store,
        github: f.github,
        trello: { getCards: vi.fn(async () => []) } as never,
        signal: new AbortController().signal,
        observedReviewCardIds: [],
      }),
    ).rejects.toThrow(/could not be verified/);
    expect(f.queue.list().find((e) => e.eventId === f.terminalId)?.status).toBe(
      "queued",
    );
  });

  it("does not delete the rebased worktree when a closed PR card is returned to Backlog", async () => {
    const f = fixture();
    const card = {
      id: cardId,
      name: "Removed task",
      desc: "",
      idList: "backlog",
      idLabels: [],
      url: "https://trello.com/c/example",
    } satisfies TrelloCard;
    const git = {
      getStatus: vi.fn(() => {
        throw new Error("worktree must be preserved");
      }),
    };
    await returnClosedTaskSessionPullRequestToBacklog({
      project: {
        ...f.project,
        trello: { backlogListId: "backlog" },
      } as ProjectConfig,
      card,
      git: git as never,
      trello: { moveCard: vi.fn() } as never,
      pullRequest: { url: prUrl, state: "CLOSED", mergedAt: null },
      preserveWorktree: true,
      signal: new AbortController().signal,
    });
    expect(git.getStatus).not.toHaveBeenCalled();
  });
});
