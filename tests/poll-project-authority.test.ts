import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { RunStore } from "../src/task-session/run-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";

const { runWorkflow } = vi.hoisted(() => ({ runWorkflow: vi.fn() }));
vi.mock("../src/orchestrator/run-task-session-workflow.js", () => ({
  runTaskSessionWorkflow: runWorkflow,
}));

let root = "";
afterEach(() => {
  vi.clearAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("pollProject authority routing", () => {
  it("executes workflow store writes against the active envelope without touching the legacy queue file", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "poll-project-authority-"));
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(repository);
    fs.mkdirSync(worktrees);
    const project = {
      id: "project-one",
      trello: { boardId: "board", readyListId: "ready" },
      repository: {
        path: repository,
        worktreeRoot: worktrees,
        github: "owner/repository",
        defaultBranch: "main",
      },
    } as ProjectConfig;
    const integrationId = JSON.stringify({
      trelloBoardId: "board",
      githubRepository: "owner/repository",
    });
    const pinned = {
      integrationId,
      projectId: project.id,
      boardId: "board",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        failed: "failed",
        done: "done",
        backlog: "backlog",
      },
      repository: "owner/repository",
      repositoryPath: repository,
      worktreeRoot: worktrees,
      storageRoot: runtime,
    };
    const lease = {
      integrationId,
      instanceId: "instance",
      token: "token",
      assertHeld: vi.fn(),
    };
    const store = new RunStore(runtime, "attempt-one", pinned, lease);
    store.create({
      version: 1,
      revision: 1,
      projectId: project.id,
      cardId: "card-one",
      attemptId: "attempt-one",
      taskKind: "implementation",
      pinned,
      lifecycle: "implementation",
      checkpoint: "implementation",
      publicationState: "none",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {},
      sessions: {},
      artifacts: [],
      expectedTrelloListId: null,
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    });
    const authority = new ProjectRunAuthority(project.id, store, 1);
    const legacyQueuePath = path.join(runtime, "task-mutation-queues", `${project.id}.json`);
    fs.mkdirSync(path.dirname(legacyQueuePath), { recursive: true });
    fs.writeFileSync(legacyQueuePath, "preserve legacy bytes");
    runWorkflow.mockImplementation(async () => {
      const queue = new TaskMutationQueue(runtime, project);
      queue.enqueue({
        projectId: project.id,
        cardId: "card-one",
        eventId: "event-one",
        operationKey: "operation-one",
        kind: "implementation",
        enqueuedAt: new Date().toISOString(),
      });
    });

    await pollProject(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { ...project, contextRoot: runtime },
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      authority,
    );

    expect(runWorkflow).toHaveBeenCalledOnce();
    expect(store.readCompatibility(1, "project-queue-project-one", (value) => value)).toMatchObject(
      {
        events: [expect.objectContaining({ eventId: "event-one" })],
      },
    );
    expect(fs.readFileSync(legacyQueuePath, "utf8")).toBe("preserve legacy bytes");
  });
});
