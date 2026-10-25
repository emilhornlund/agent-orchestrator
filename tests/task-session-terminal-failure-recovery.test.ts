import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { Logger } from "../src/logging/logger.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("terminal failure recovery", () => {
  it("reconciles implementation failures and retires only after Failed is confirmed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-failure-recovery-"));
    const projectId = "agent-orchestrator";
    const cardId = "6addc5c65599982e28a0c6b9";
    const contextRoot = path.join(root, "state");
    const project = {
      id: projectId,
      autoMerge: false,
      contextRoot,
      trello: {
        boardId: "board",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
      },
      repository: {
        path: path.join(root, "repo"),
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot: path.join(root, "worktrees"),
        validationCommand: "yarn validate",
      },
      opencode: { timeoutMinutes: 1 },
    } as unknown as ProjectConfig & { contextRoot: string };
    fs.mkdirSync(project.repository.path, { recursive: true });
    fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
    const card: TrelloCard = {
      id: cardId,
      name: "Implementation failure",
      desc: "Saved failure fixture",
      idList: project.trello.workingListId,
      idLabels: [],
      url: "https://trello.example/card",
    };
    let currentList = project.trello.workingListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_id: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
    } as unknown as TrelloClient;
    const store = new TaskExecutionStore(contextRoot, project);
    store.create({
      version: 1,
      projectId,
      cardId,
      phase: "attention-required",
      primarySessionId: "session-preserved",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${cardId}`,
      operationKey: "implementation-operation",
      terminalFailure: {
        kind: "implementation",
        reason: "Implementation exited unsuccessfully",
        outcome: "pending",
      },
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId,
      cardId,
      eventId: "implementation:failure",
      operationKey: "implementation-operation",
      kind: "implementation",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    queue.claimNext();
    queue.fail("implementation:failure");

    await runTaskSessionWorkflow({
      project,
      trello,
      git: {} as GitClient,
      github: {} as GitHubClient,
      openCode: new OpenCodeClient(vi.fn()),
      commands: new CommandRunner(vi.fn()),
      signal: new AbortController().signal,
      prepareAttachmentContext: async () => undefined,
    });

    expect(trello.moveCard).toHaveBeenCalledWith(
      cardId,
      project.trello.failedListId,
    );
    expect(queue.getActive()).toBeNull();
    expect(store.read(cardId)).toMatchObject({
      primarySessionId: "session-preserved",
      terminalFailure: { outcome: "confirmed" },
    });
  });

  it("leaves a legacy failed mutation untouched until Trello authorizes retirement", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-failure-recovery-"));
    const projectId = "agent-orchestrator";
    const cardId = "6addc5c65599982e28a0c6b9";
    const contextRoot = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktrees");
    const project = {
      id: projectId,
      autoMerge: false,
      contextRoot,
      trello: {
        boardId: "board",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
      },
      repository: {
        path: path.join(root, "repo"),
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
      },
      opencode: { timeoutMinutes: 1 },
    } as unknown as ProjectConfig & { contextRoot: string };
    fs.mkdirSync(project.repository.path, { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const worktree = path.join(worktreeRoot, cardId);
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, "preserved.txt"), "keep me", "utf8");

    const card: TrelloCard = {
      id: cardId,
      name: "Pilot task",
      desc: "Saved pilot fixture",
      idList: project.trello.workingListId,
      idLabels: [],
      url: "https://trello.example/card",
    };
    let currentList = project.trello.workingListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_id: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
    } as unknown as TrelloClient;
    const store = new TaskExecutionStore(contextRoot, project);
    store.create({
      version: 1,
      projectId,
      cardId,
      phase: "attention-required",
      primarySessionId: "ses_e8db2e6edffezePNR3A6EPnlR5",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${cardId}`,
      operationKey: "pilot-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    for (let revision = 1; revision < 12; revision += 1) {
      const current = store.read(cardId)!;
      store.compareAndSwap(cardId, current.revision, {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000,
        ).toISOString(),
      });
    }
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId,
      cardId,
      eventId: "implementation:pilot",
      operationKey: "pilot-operation",
      kind: "implementation",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    queue.claimNext();
    queue.fail("implementation:pilot");

    const poll = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git: {} as GitClient,
        github: {} as GitHubClient,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
      });
    const lifecycleEvent = vi.spyOn(Logger.prototype, "event");
    await expect(poll()).resolves.toBeUndefined();
    await expect(poll()).resolves.toBeUndefined();
    expect(queue.getActive()).toMatchObject({
      eventId: "implementation:pilot",
      status: "failed",
    });
    expect(queue.getActive()?.ownerToken).toBeUndefined();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(currentList).toBe(project.trello.workingListId);

    // The operator's move is the authorization for retiring this legacy event.
    currentList = project.trello.failedListId;
    await poll();

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(lifecycleEvent).not.toHaveBeenCalledWith(
      "Card claimed; transition to Working succeeded",
    );
    expect(queue.getActive()).toBeNull();
    expect(store.read(cardId)).toMatchObject({
      phase: "attention-required",
      primarySessionId: "ses_e8db2e6edffezePNR3A6EPnlR5",
    });
    expect(fs.readFileSync(path.join(worktree, "preserved.txt"), "utf8")).toBe(
      "keep me",
    );
    await poll();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
