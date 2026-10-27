import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { requeueInterruptedPreparedPrMaintenance } from "../src/orchestrator/maintain-outdated-pr.js";
import { PrMaintenanceStore } from "../src/task-session/pr-maintenance-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-maintenance-"));
  const project = {
    id: "agent-orchestrator",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  const state = path.join(root, "state");
  const maintenanceStore = new PrMaintenanceStore(state, project);
  const mutationQueue = new TaskMutationQueue(state, project);
  const operationId = "4a41c50a-5c10-465d-912c-4144376db912";
  const cardId = "6adef30167237feb429ca598";
  const eventId = `pr-maintenance:${cardId}:${operationId}`;
  maintenanceStore.create({
    projectId: project.id,
    cardId,
    pullRequest: {
      number: 194,
      url: "https://github.com/emilhornlund/agent-orchestrator/pull/194",
    },
    expectedRemoteHead: "f2d2fd5c5dd085eda311304ac5598d4845bf5762",
    targetBaseHead: "d2c980b6e15222b720b168e7b977873fe25b10a3",
    operationId,
    createdAt: "2026-10-27T05:09:30.483Z",
    updatedAt: "2026-10-27T05:09:30.483Z",
  });
  mutationQueue.enqueue({
    projectId: project.id,
    cardId,
    eventId,
    kind: "pr-maintenance",
    operationKey: operationId,
    enqueuedAt: "2026-10-27T05:09:30.483Z",
  });
  return {
    project,
    maintenanceStore,
    mutationQueue,
    operationId,
    eventId,
    state,
  };
}

function staleQueue(f: ReturnType<typeof fixture>): TaskMutationQueue {
  f.mutationQueue.claimNext();
  const file = path.join(
    f.state,
    "task-mutation-queues",
    "agent-orchestrator.json",
  );
  const queue = JSON.parse(fs.readFileSync(file, "utf8")) as {
    events: Array<{
      ownerToken?: string;
      ownerPid?: number;
      operationKey: string;
    }>;
  };
  queue.events[0]!.ownerToken = "00000000-0000-4000-8000-000000000001";
  queue.events[0]!.ownerPid = process.pid;
  fs.writeFileSync(file, JSON.stringify(queue));
  return new TaskMutationQueue(f.state, f.project);
}

describe("interrupted prepared PR maintenance recovery", () => {
  it("requeues the exact persisted crash state after stale ownership", () => {
    const f = fixture();
    const restartedQueue = staleQueue(f);
    expect(
      requeueInterruptedPreparedPrMaintenance({
        project: f.project,
        maintenanceStore: new PrMaintenanceStore(f.state, f.project),
        mutationQueue: restartedQueue,
      }),
    ).toBe(true);
    expect(restartedQueue.getActive()).toBeNull();
    expect(restartedQueue.list()[0]?.status).toBe("queued");
    expect(f.maintenanceStore.inspect(f.operationId)?.status).toBe("prepared");
    expect(restartedQueue.claimForRecovery(f.eventId)?.status).toBe("active");
  });

  it("does not steal a live queue owner", () => {
    const f = fixture();
    f.mutationQueue.claimNext();
    expect(requeueInterruptedPreparedPrMaintenance(f)).toBe(false);
    expect(f.mutationQueue.getActive()?.status).toBe("active");
  });

  it("refuses mismatched ownership", () => {
    const f = fixture();
    const restartedQueue = staleQueue(f);
    const file = path.join(
      f.state,
      "task-mutation-queues",
      "agent-orchestrator.json",
    );
    const queue = JSON.parse(fs.readFileSync(file, "utf8")) as {
      events: Array<{ operationKey: string }>;
    };
    queue.events[0]!.operationKey = "wrong-operation";
    fs.writeFileSync(file, JSON.stringify(queue));
    expect(() =>
      requeueInterruptedPreparedPrMaintenance({
        project: f.project,
        maintenanceStore: f.maintenanceStore,
        mutationQueue: restartedQueue,
      }),
    ).toThrow("identities differ");
  });
});
