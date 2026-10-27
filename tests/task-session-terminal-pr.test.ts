import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { Logger } from "../src/logging/logger.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("task-session terminal PR reconciliation", () => {
  it("retires a card moved out of Ready after claim and creates one fresh re-entry attempt", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ready-card-reentry-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    fs.mkdirSync(repositoryPath);
    const project = {
      id: "ready-reentry",
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
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
      repository: {
        path: repositoryPath,
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
        gitIdentity: { name: "Agent", email: "agent@example.test" },
      },
      opencode: {
        refinement: { model: "refine", variant: "high" },
        implementation: { model: "implement", variant: "high" },
        review: { model: "review", variant: "high" },
        remediation: { model: "repair", variant: "high", maxPasses: 1 },
        commit: { model: "commit", variant: "low" },
        timeoutMinutes: 1,
      },
    } as ProjectConfig & { contextRoot: string };
    const card: TrelloCard = {
      id: "reentry-card",
      name: "Unchanged task",
      desc: "The same task details",
      idList: "ready",
      idLabels: ["feature"],
      url: "https://trello.example/reentry-card",
    };
    let currentList = "ready";
    let readyReads = 0;
    const trello = {
      getCards: vi.fn(async (listId: string) => {
        if (listId === "ready") {
          readyReads += 1;
          // On the first poll, move the card between discovery and the
          // post-claim authoritative eligibility check.
          if (readyReads === 2) currentList = "backlog";
        }
        return listId === currentList ? [{ ...card, idList: currentList }] : [];
      }),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const queue = new TaskMutationQueue(contextRoot, project);
    const fetch = vi.fn(async () => undefined);
    const implementationRun = vi.fn(async () => ({
      exitCode: 1,
      output: '{"type":"step_start","sessionID":"session-1"}',
      errorOutput: "",
      sessionId: "session-1",
    }));
    const poll = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git: {
          fetch,
          branchExists: vi.fn(async () => false),
          addWorktreeWithNewBranch: vi.fn(
            async (_repositoryPath: string, worktreePath: string) => {
              fs.mkdirSync(worktreePath, { recursive: true });
            },
          ),
        } as unknown as GitClient,
        github: {} as GitHubClient,
        openCode: new OpenCodeClient(implementationRun),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
      });

    await poll();
    expect(queue.list()).toMatchObject([
      {
        eventId: expect.stringMatching(/^implementation:reentry-card:/),
        status: "retired",
      },
    ]);
    expect(currentList).toBe("backlog");

    queue.enqueue({
      projectId: project.id,
      cardId: "queue-occupier",
      eventId: "queue-occupier",
      operationKey: "queue-occupier",
      kind: "feedback",
      enqueuedAt: "2026-10-27T09:00:00.000Z",
    });
    expect(queue.claimNext()?.eventId).toBe("queue-occupier");

    currentList = "ready";
    await poll();
    await poll(); // Simulate a restart/poll while the project queue is occupied.
    expect(
      queue.list().filter((event) => event.cardId === card.id),
    ).toHaveLength(2);
    expect(
      queue.list().find((event) => event.eventId.endsWith(":attempt:1")),
    ).toMatchObject({
      eventId: expect.stringMatching(
        /^implementation:reentry-card:.*:attempt:1$/,
      ),
      status: "queued",
    });

    currentList = "backlog";
    await poll();
    expect(
      queue.list().find((event) => event.eventId.endsWith(":attempt:1"))
        ?.status,
    ).toBe("retired");
    currentList = "ready";
    await poll();
    await poll();
    expect(
      queue.list().filter((event) => event.cardId === card.id),
    ).toHaveLength(3);
    expect(
      queue.list().find((event) => event.eventId.endsWith(":attempt:2")),
    ).toMatchObject({
      eventId: expect.stringMatching(
        /^implementation:reentry-card:.*:attempt:2$/,
      ),
      status: "queued",
    });

    currentList = "backlog";
    await poll();
    currentList = "ready";
    await poll();
    await poll();
    expect(
      queue.list().filter((event) => event.cardId === card.id),
    ).toHaveLength(4);
    expect(
      queue
        .list()
        .filter((event) => event.cardId === card.id)
        .filter((event) =>
          ["queued", "active", "failed"].includes(event.status),
        ),
    ).toHaveLength(1);
    expect(
      queue.list().find((event) => event.eventId.endsWith(":attempt:3")),
    ).toMatchObject({
      eventId: expect.stringMatching(
        /^implementation:reentry-card:.*:attempt:3$/,
      ),
      status: "queued",
    });

    queue.complete("queue-occupier");
    await expect(poll()).rejects.toThrow(
      "OpenCode planning exited with code 1",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(implementationRun).toHaveBeenCalledTimes(1);
    expect(
      queue.list().filter((event) => event.cardId === card.id),
    ).toHaveLength(4);
    expect(
      queue
        .list()
        .find((event) =>
          event.eventId.startsWith("implementation:reentry-card:"),
        )?.status,
    ).toBe("retired");
    expect(
      queue.list().find((event) => event.eventId.endsWith(":attempt:3")),
    ).toMatchObject({
      eventId: expect.stringMatching(
        /^implementation:reentry-card:.*:attempt:3$/,
      ),
      status: "failed",
    });
    expect(
      new TaskExecutionStore(contextRoot, project).read(card.id),
    ).not.toBeNull();
  });

  it("retires a persisted orphan implementation before recovering a queued merged PR", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-queue-deadlock-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    fs.mkdirSync(repositoryPath);
    const project = {
      id: "agent-orchestrator",
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
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
      repository: {
        path: repositoryPath,
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
        gitIdentity: { name: "Agent", email: "agent@example.test" },
      },
      opencode: {
        refinement: { model: "refine", variant: "high" },
        implementation: { model: "implement", variant: "high" },
        review: { model: "review", variant: "high" },
        remediation: { model: "repair", variant: "high", maxPasses: 1 },
        commit: { model: "commit", variant: "low" },
        timeoutMinutes: 1,
      },
    } as ProjectConfig & { contextRoot: string };
    let currentList = project.trello.reviewListId;
    const card: TrelloCard = {
      id: "merged-card",
      name: "Merged task",
      desc: "Task body",
      idList: currentList,
      idLabels: [],
      url: "https://trello.example/merged-card",
    };
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const headSha = "b".repeat(40);
    const github = {
      findPullRequestState: vi.fn(async () => ({
        url: "https://github.com/owner/repo/pull/203",
        state: "MERGED" as const,
        mergedAt: "2026-10-27T12:00:00Z",
        headRefOid: headSha,
        baseRefName: "main",
        headRefName: "agent/merged-card",
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "owner" },
      })),
      getPullRequestCommitShas: vi.fn(async () => [headSha]),
      isAncestorCommit: vi.fn(async () => true),
      getCiObservations: vi.fn(async () => {
        throw new Error("CI must not be queried");
      }),
    } as unknown as GitHubClient;
    const git = {
      remoteBranchExists: vi.fn(async () => false),
      pruneWorktrees: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
    } as unknown as GitClient;
    const taskStore = new TaskExecutionStore(contextRoot, project);
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "ci",
      primarySessionId: "session",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      pullRequest: {
        number: 203,
        url: "https://github.com/owner/repo/pull/203",
        headSha,
      },
      operationKey: "merged-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-27T09:00:00.000Z",
      updatedAt: "2026-10-27T09:00:00.000Z",
    });
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId: project.id,
      cardId: "orphan-card",
      eventId: "implementation:orphan-card:e84ba7c9750946cc",
      operationKey: "task-session:orphan-card:e84ba7c9750946cc",
      kind: "implementation",
      enqueuedAt: "2026-10-27T09:00:00.000Z",
    });
    queue.claimNext();
    const queuePath = path.join(
      contextRoot,
      "task-mutation-queues",
      `${project.id}.json`,
    );
    const persistedQueue = JSON.parse(fs.readFileSync(queuePath, "utf8")) as {
      events: Array<{
        eventId: string;
        ownerToken?: string;
        ownerPid?: number;
      }>;
    };
    const persistedOrphan = persistedQueue.events.find(
      (item) => item.eventId === "implementation:orphan-card:e84ba7c9750946cc",
    )!;
    // Model the persisted queue after process/container restart: a different
    // process instance may reuse its PID, but not the in-memory owner token.
    persistedOrphan.ownerToken = "00000000-0000-4000-8000-000000000001";
    persistedOrphan.ownerPid = process.pid;
    fs.writeFileSync(queuePath, JSON.stringify(persistedQueue), "utf8");
    queue.enqueue({
      projectId: project.id,
      cardId: card.id,
      eventId: `terminal-pr:${card.id}:MERGED:${headSha}`,
      operationKey: `merged-operation:MERGED:${headSha}`,
      kind: "terminal-pr",
      enqueuedAt: "2026-10-27T09:01:00.000Z",
    });
    const poll = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git,
        github,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
      });

    await poll();

    expect(
      queue.list().find((item) => item.cardId === "orphan-card")?.status,
    ).toBe("retired");
    expect(
      queue.list().find((item) => item.kind === "terminal-pr")?.status,
    ).toBe("completed");
    expect(currentList).toBe(project.trello.doneListId);
    expect(trello.moveCard).toHaveBeenCalledTimes(1);
    expect(taskStore.read(card.id)?.phase).toBe("done");
  });

  it("defers merged cleanup without callbacks or repeated warnings, then completes once the live owner releases", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-queue-defer-"));
    const repositoryPath = path.join(root, "repo");
    const contextRoot = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktrees");
    fs.mkdirSync(repositoryPath);
    const project = {
      id: "deferred-project",
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
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
      repository: {
        path: repositoryPath,
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
        gitIdentity: { name: "Agent", email: "agent@example.test" },
      },
      opencode: {
        refinement: { model: "refine", variant: "high" },
        implementation: { model: "implement", variant: "high" },
        review: { model: "review", variant: "high" },
        remediation: { model: "repair", variant: "high", maxPasses: 1 },
        commit: { model: "commit", variant: "low" },
        timeoutMinutes: 1,
      },
    } as ProjectConfig & { contextRoot: string };
    const card: TrelloCard = {
      id: "deferred-card",
      name: "Merged task",
      desc: "Task body",
      idList: "review",
      idLabels: [],
      url: "https://trello.example/deferred-card",
    };
    let currentList = "review";
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const headSha = "c".repeat(40);
    const github = {
      findPullRequestState: vi.fn(async () => ({
        url: "https://github.com/owner/repo/pull/8",
        state: "MERGED" as const,
        mergedAt: "2026-10-27T12:00:00Z",
        headRefOid: headSha,
        baseRefName: "main",
        headRefName: `agent/${card.id}`,
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "owner" },
      })),
      getPullRequestCommitShas: vi.fn(async () => [headSha]),
      isAncestorCommit: vi.fn(async () => true),
      getCiObservations: vi.fn(async () => {
        throw new Error("CI must not be queried");
      }),
    } as unknown as GitHubClient;
    const git = {
      remoteBranchExists: vi.fn(async () => false),
      pruneWorktrees: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
    } as unknown as GitClient;
    const taskStore = new TaskExecutionStore(contextRoot, project);
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "ci",
      primarySessionId: "session",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      pullRequest: {
        number: 8,
        url: "https://github.com/owner/repo/pull/8",
        headSha,
      },
      operationKey: "deferred-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-27T09:00:00.000Z",
      updatedAt: "2026-10-27T09:00:00.000Z",
    });
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId: project.id,
      cardId: "live-owner-card",
      eventId: "feedback:live-owner",
      operationKey: "live-owner-operation",
      kind: "feedback",
      enqueuedAt: "2026-10-27T08:00:00.000Z",
    });
    const owner = queue.claimNext();
    expect(owner?.status).toBe("active");
    const onCardLeft = vi.fn();
    const poll = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git,
        github,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
        onHumanReviewCardLeft: onCardLeft,
      });
    const warning = vi.spyOn(Logger.prototype, "warn");

    await poll();
    await poll();

    expect(onCardLeft).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(
      warning.mock.calls.filter(([message]) =>
        String(message).includes("Deferred merged PR cleanup"),
      ),
    ).toHaveLength(1);
    expect(
      queue.list().find((item) => item.kind === "terminal-pr")?.status,
    ).toBe("queued");

    queue.complete(owner!.eventId);
    await poll();
    await poll();

    expect(currentList).toBe(project.trello.doneListId);
    expect(trello.moveCard).toHaveBeenCalledTimes(1);
    expect(trello.addComment).not.toHaveBeenCalled();
    expect(onCardLeft).toHaveBeenCalledTimes(1);
    expect(taskStore.read(card.id)?.phase).toBe("done");
  });

  it.each([
    {
      state: "MERGED" as const,
      destination: "done",
      mergedAt: "2026-10-24T12:00:00Z",
    },
    { state: "CLOSED" as const, destination: "backlog", mergedAt: null },
  ])(
    "moves a $state PR card to $destination without consulting CI",
    async ({ state, destination, mergedAt }) => {
      root = fs.mkdtempSync(
        path.join(os.tmpdir(), "terminal-task-session-pr-"),
      );
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const contextRoot = path.join(root, "state");
      fs.mkdirSync(repositoryPath);
      const project = {
        id: "project",
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
          refinementLabelId: "refinement",
          featureLabelId: "feature",
          improvementLabelId: "improvement",
          bugLabelId: "bug",
        },
        repository: {
          path: repositoryPath,
          github: "owner/repo",
          defaultBranch: "main",
          worktreeRoot,
          validationCommand: "yarn validate",
          gitIdentity: { name: "Agent", email: "agent@example.test" },
        },
        opencode: {
          refinement: { model: "refine", variant: "high" },
          implementation: { model: "implement", variant: "high" },
          review: { model: "review", variant: "high" },
          remediation: { model: "repair", variant: "high", maxPasses: 1 },
          commit: { model: "commit", variant: "low" },
          timeoutMinutes: 1,
        },
      } as ProjectConfig & { contextRoot: string };
      let currentList = project.trello.reviewListId;
      const card: TrelloCard = {
        id: "task-card",
        name: "Task",
        desc: "Task body",
        idList: currentList,
        idLabels: [],
        url: "https://trello.example/task-card",
      };
      const trello = {
        getCards: vi.fn(async (listId: string) =>
          listId === currentList ? [{ ...card, idList: currentList }] : [],
        ),
        moveCard: vi.fn(async (_cardId: string, listId: string) => {
          currentList = listId;
          return { ...card, idList: listId };
        }),
        addComment: vi.fn(async () => undefined),
      } as unknown as TrelloClient;
      let failCleanupOnce = state === "MERGED";
      const headSha = "a".repeat(40);
      const mergedHeadSha = state === "MERGED" ? "b".repeat(40) : headSha;
      const github = {
        findPullRequestState: vi.fn(async () => ({
          url: "https://github.com/owner/repo/pull/7",
          state,
          mergedAt,
          headRefOid: mergedHeadSha,
          baseRefName: "main",
          headRefName: "agent/task-card",
          headRepository: { name: "repo" },
          headRepositoryOwner: { login: "owner" },
        })),
        getPullRequestCommitShas: vi.fn(async () => [headSha, mergedHeadSha]),
        isAncestorCommit: vi.fn(async () => true),
        getCiObservations: vi.fn(async () => {
          throw new Error("terminal PR reconciliation must not require CI");
        }),
      } as unknown as GitHubClient;
      const git = {
        remoteBranchExists: vi.fn(async () => false),
        pruneWorktrees: vi.fn(async () => {
          if (failCleanupOnce) {
            failCleanupOnce = false;
            throw new Error("simulated interruption during terminal cleanup");
          }
        }),
        branchExists: vi.fn(async () => false),
      } as unknown as GitClient;
      new TaskExecutionStore(contextRoot, project).create({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        phase: "ci",
        primarySessionId: "session",
        sessionCreationStatus: "bound",
        expectedBranch: `agent/${card.id}`,
        pullRequest: {
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          headSha,
        },
        operationKey: "operation",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: "2026-10-24T09:00:00.000Z",
        updatedAt: "2026-10-24T09:00:00.000Z",
      });

      const onCardLeft = vi.fn();
      const poll = () =>
        runTaskSessionWorkflow({
          project,
          trello,
          git,
          github,
          openCode: new OpenCodeClient(vi.fn()),
          commands: new CommandRunner(vi.fn()),
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => undefined,
          onHumanReviewCardLeft: onCardLeft,
        });
      const lifecycleEvent = vi.spyOn(Logger.prototype, "event");

      if (state === "MERGED") {
        await expect(poll()).rejects.toThrow(
          "simulated interruption during terminal cleanup",
        );
        expect(currentList).toBe(project.trello.doneListId);
      }
      await poll();
      await poll();

      const destinationEvent =
        state === "MERGED"
          ? "Merged pull request transitioned card to Done: https://github.com/owner/repo/pull/7"
          : "Closed pull request returned card to Backlog: https://github.com/owner/repo/pull/7";
      expect(
        lifecycleEvent.mock.calls.filter(
          ([message]) => message === destinationEvent,
        ),
      ).toHaveLength(1);

      expect(currentList).toBe(
        project.trello[destination === "done" ? "doneListId" : "backlogListId"],
      );
      expect(trello.moveCard).toHaveBeenCalledWith(
        card.id,
        destination === "done"
          ? project.trello.doneListId
          : project.trello.backlogListId,
        ...(destination === "done" ? [{ dueComplete: true }] : []),
      );
      expect(github.getCiObservations).not.toHaveBeenCalled();
      expect(onCardLeft).toHaveBeenCalledTimes(1);
      if (state === "MERGED") {
        expect(github.isAncestorCommit).toHaveBeenCalled();
      }
      if (state === "MERGED") {
        expect(
          new TaskExecutionStore(contextRoot, project).read(card.id)?.phase,
        ).toBe("done");
      }
    },
  );
});
