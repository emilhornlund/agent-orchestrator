import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const listIds = {
  backlog: "backlog-list",
  ready: "ready-list",
  working: "working-list",
  review: "review-list",
  failed: "failed-list",
  done: "done-list",
} as const;

type ListName = keyof typeof listIds;
type PullRequestState = "none" | "open" | "requested" | "merged";

interface HarnessOptions {
  initialList?: ListName;
  cardLabels?: string[];
  initialWorktree?: boolean;
  pullRequestState?: PullRequestState;
  feedback?: string;
  initialRemoteSha?: string | null;
  createPullRequestError?: Error;
}

const temporaryRoots: string[] = [];

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "characterization-project",
    trello: {
      boardId: "board",
      backlogListId: listIds.backlog,
      readyListId: listIds.ready,
      workingListId: listIds.working,
      reviewListId: listIds.review,
      failedListId: listIds.failed,
      doneListId: listIds.done,
      refinementLabelId: "refinement-label",
      featureLabelId: "feature-label",
      improvementLabelId: "improvement-label",
      bugLabelId: "bug-label",
    },
    repository: {
      path: "/configured/source-checkout",
      github: "example/repository",
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    opencode: {
      refinement: { model: "refinement-model", variant: "xhigh" },
      implementation: { model: "implementation-model", variant: "xhigh" },
      review: { model: "review-model", variant: "high" },
      remediation: { model: "remediation-model", variant: "xhigh" },
      commit: { model: "commit-model", variant: "low" },
      timeoutMinutes: 360,
    },
  };
}

function createHarness(options: HarnessOptions = {}) {
  const worktreeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-characterization-"),
  );
  temporaryRoots.push(worktreeRoot);

  const project = createProject(worktreeRoot);
  const cardId = "card-1";
  const worktreePath = path.join(worktreeRoot, cardId);
  let currentList = options.initialList ?? "ready";
  let pullRequestState = options.pullRequestState ?? "none";
  let createPullRequestError = options.createPullRequestError;
  let branchExists =
    options.initialWorktree === true || currentList === "review";
  let dirty = false;
  let headSha = "base-commit";
  let remoteSha =
    options.initialRemoteSha ??
    (pullRequestState === "none" ? null : "previous-commit");

  const card: TrelloCard = {
    id: cardId,
    name: "Example task",
    desc: "Implement the example task",
    idList: listIds[currentList],
    idLabels: options.cardLabels ?? [project.trello.featureLabelId],
    url: "https://trello.com/c/card-1",
  };

  if (options.initialWorktree === true) {
    fs.mkdirSync(worktreePath);
  }

  const events: string[] = [];
  const transitions = [] as Array<{
    id: string;
    date: string;
    listBeforeId: string;
    listAfterId: string;
  }>;
  let transitionNumber = 0;

  function addTransition(listBefore: string, listAfter: string): void {
    transitionNumber += 1;
    transitions.push({
      id: `transition-${transitionNumber}`,
      date: `2026-08-30T10:0${transitionNumber}:00.000Z`,
      listBeforeId: listBefore,
      listAfterId: listAfter,
    });
  }

  const getCards = vi.fn(async (listId: string) =>
    listIds[currentList] === listId ? [card] : [],
  );
  const getLatestListTransition = vi.fn(async (...args: [string, string]) => {
    const destinationListId = args[1];

    return (
      [...transitions]
        .reverse()
        .find((transition) => transition.listAfterId === destinationListId) ??
      null
    );
  });
  const moveCard = vi.fn(
    async (...args: [string, string, { dueComplete?: boolean }?]) => {
      const cardId = args[0];
      const listId = args[1];

      if (cardId !== card.id) {
        throw new Error(`Unexpected card ${cardId}`);
      }

      addTransition(listIds[currentList], listId);
      currentList = (Object.keys(listIds) as ListName[]).find(
        (name) => listIds[name] === listId,
      ) as ListName;
      card.idList = listId;
      events.push(`trello:move:${listId}`);

      return { ...card };
    },
  );
  const updateCardContent = vi.fn(async (...args: [string, string, string]) => {
    const title = args[1];
    const description = args[2];
    card.name = title;
    card.desc = description;
    events.push("trello:update-card");

    return { ...card };
  });
  const addLabel = vi.fn(async (...args: [string, string]) => {
    const labelId = args[1];

    if (!card.idLabels.includes(labelId)) {
      card.idLabels.push(labelId);
    }

    events.push(`trello:add-label:${labelId}`);
  });
  const removeLabel = vi.fn(async (...args: [string, string]) => {
    const labelId = args[1];

    card.idLabels = card.idLabels.filter(
      (existingId) => existingId !== labelId,
    );
    events.push(`trello:remove-label:${labelId}`);
  });
  const addComment = vi.fn(async () => ({
    id: "comment-1",
    type: "commentCard",
    date: "2026-08-30T10:00:00.000Z",
  }));
  const trello = {
    getCards,
    getLatestListTransition,
    moveCard,
    updateCardContent,
    addLabel,
    removeLabel,
    addComment,
  } as unknown as TrelloClient;

  const getCurrentBranch = vi.fn(async () => {
    events.push("git:inspect-worktree");

    return `agent/${card.id}`;
  });
  const fetch = vi.fn(async (...args: [string, string, string]) => {
    const branch = args[2];
    events.push(`git:fetch:${branch}`);
  });
  const branchExistsMethod = vi.fn(async () => branchExists);
  const addWorktree = vi.fn(async () => {
    branchExists = true;
    fs.mkdirSync(worktreePath);
    events.push("git:prepare-worktree");
  });
  const addWorktreeWithNewBranch = vi.fn(
    async (...args: [string, string, string, string]) => {
      const startPoint = args[3];
      branchExists = true;
      fs.mkdirSync(worktreePath);
      events.push(
        startPoint === `origin/agent/${card.id}`
          ? "git:prepare-review-worktree"
          : "git:prepare-worktree",
      );
    },
  );
  const getStatus = vi.fn(async () => {
    if (fs.existsSync(getRefinementResultPath(worktreePath))) {
      return "?? .agent-orchestrator/refinement-result.json";
    }

    return dirty ? " M src/example.ts" : "";
  });
  const getHeadSha = vi.fn(async () => {
    events.push("git:head");

    return headSha;
  });
  const getChangedFiles = vi.fn(async () => {
    events.push("git:changed-files");

    return "src/example.ts";
  });
  const getRemoteBranchSha = vi.fn(async () => remoteSha);
  const rebase = vi.fn(async () => undefined);
  const push = vi.fn(async () => {
    remoteSha = headSha;
    events.push("git:push");
  });
  const removeWorktree = vi.fn(async () => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    events.push("git:cleanup-worktree");
  });
  const pruneWorktrees = vi.fn(async () => undefined);
  const deleteBranch = vi.fn(async () => {
    branchExists = false;
  });
  const resetHard = vi.fn(async () => undefined);
  const cleanUntracked = vi.fn(async () => undefined);
  const resetHardTo = vi.fn(async () => undefined);
  const deleteRemoteBranch = vi.fn(async () => {
    remoteSha = null;
    events.push("git:delete-remote-branch");
  });
  const forcePush = vi.fn();
  const git = {
    getCurrentBranch,
    fetch,
    branchExists: branchExistsMethod,
    addWorktree,
    addWorktreeWithNewBranch,
    getStatus,
    getHeadSha,
    getChangedFiles,
    getRemoteBranchSha,
    rebase,
    isAncestor: vi.fn(async () => true),
    push,
    removeWorktree,
    pruneWorktrees,
    deleteBranch,
    resetHard,
    cleanUntracked,
    resetHardTo,
    remoteBranchExists: vi.fn(async () => remoteSha !== null),
    deleteRemoteBranch,
    forcePush,
  } as unknown as GitClient;

  const pullRequest = {
    url: "https://github.com/example/repository/pull/123",
  };
  const findPullRequest = vi.fn(async () => {
    events.push("github:find-open-pr");

    return pullRequestState === "none" ? null : pullRequest;
  });
  const findMergedPullRequest = vi.fn(async () => {
    events.push("github:find-merged-pr");

    return pullRequestState === "merged" ? pullRequest : null;
  });
  const findClosedPullRequest = vi.fn(async () => null);
  const findChangesRequestedPullRequest = vi.fn(async () => {
    if (pullRequestState !== "requested") {
      return null;
    }

    return {
      ...pullRequest,
      feedback: options.feedback ?? "Please fix the regression.",
    };
  });
  const createPullRequest = vi.fn(async () => {
    events.push("github:create-pr");

    if (createPullRequestError !== undefined) {
      const error = createPullRequestError;
      createPullRequestError = undefined;
      throw error;
    }

    pullRequestState = "open";

    return pullRequest;
  });
  const mergePullRequest = vi.fn();
  const github = {
    findPullRequest,
    findMergedPullRequest,
    findClosedPullRequest,
    findChangesRequestedPullRequest,
    createPullRequest,
    mergePullRequest,
  } as unknown as GitHubClient;

  const runOpenCode = vi.fn<RunOpenCode>(
    async (runOptions: OpenCodeRunOptions) => {
      const label = runOptions.sessionLabel;

      if (label === "OpenCode refinement") {
        const resultPath = getRefinementResultPath(runOptions.cwd);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            title: "Refined task",
            type: "feature",
            description: "# Refined task\n\n## Description\n\nRefined.",
          }),
        );
        events.push("opencode:refinement");
      } else if (label === "OpenCode implementation") {
        dirty = true;
        events.push("opencode:implementation");
      } else if (label === "OpenCode review feedback implementation") {
        dirty = true;
        events.push("opencode:review-feedback-implementation");
      } else if (label === "OpenCode review") {
        events.push("opencode:review");
      } else if (label === "OpenCode remediation") {
        dirty = true;
        events.push("opencode:remediation");
      } else if (label === "OpenCode commit") {
        dirty = false;
        headSha = "implementation-commit";
        events.push("opencode:commit");
      } else {
        throw new Error(`Unexpected OpenCode session ${label ?? "unknown"}`);
      }

      return {
        exitCode: 0,
        output: label === "OpenCode review" ? "REVIEW_PASS" : "",
        errorOutput: "",
      };
    },
  );
  const openCode = new OpenCodeClient(runOpenCode);
  const runCommand = vi.fn<RunCommand>(async () => ({ exitCode: 0 }));
  const commands = new CommandRunner(runCommand);

  function moveCardManually(destination: ListName): void {
    addTransition(listIds[currentList], listIds[destination]);
    currentList = destination;
    card.idList = listIds[destination];
    events.push(`human:move:${listIds[destination]}`);
  }

  function setPullRequestState(state: PullRequestState): void {
    pullRequestState = state;
  }

  return {
    card,
    commands,
    createPullRequest,
    deleteRemoteBranch,
    events,
    fetch,
    forcePush,
    getChangedFiles,
    getCards,
    getCurrentBranch,
    findChangesRequestedPullRequest,
    findClosedPullRequest,
    findMergedPullRequest,
    findPullRequest,
    getLatestListTransition,
    getRemoteBranchSha,
    getStatus,
    github,
    mergePullRequest,
    moveCard,
    moveCardManually,
    openCode,
    project,
    push,
    addComment,
    removeWorktree,
    runCommand,
    runOpenCode,
    setPullRequestState,
    trello,
    git,
    worktreePath,
    cleanup: () => {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("orchestrator workflow characterization", () => {
  it("implements, publishes, waits for a human merge, and then completes", async () => {
    const harness = createHarness();

    try {
      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.review);
      expect(harness.runOpenCode).toHaveBeenCalledTimes(3);
      expect(harness.runOpenCode.mock.calls.map(([run]) => run.cwd)).toEqual([
        harness.worktreePath,
        harness.worktreePath,
        harness.worktreePath,
      ]);
      expect(harness.events).toEqual(
        expect.arrayContaining([
          "git:prepare-worktree",
          "trello:move:working-list",
          "opencode:implementation",
          "opencode:review",
          "opencode:commit",
          "git:push",
          "github:create-pr",
          "trello:move:review-list",
        ]),
      );
      expect(harness.events.indexOf("git:prepare-worktree")).toBeLessThan(
        harness.events.indexOf("trello:move:working-list"),
      );
      expect(harness.events.indexOf("opencode:commit")).toBeLessThan(
        harness.events.indexOf("git:push"),
      );
      expect(harness.events.indexOf("git:push")).toBeLessThan(
        harness.events.indexOf("github:create-pr"),
      );
      expect(harness.events.indexOf("github:create-pr")).toBeLessThan(
        harness.events.indexOf("trello:move:review-list"),
      );
      expect(harness.mergePullRequest).not.toHaveBeenCalled();
      expect(harness.forcePush).not.toHaveBeenCalled();

      harness.setPullRequestState("merged");

      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.done);
      expect(harness.moveCard).toHaveBeenCalledWith(
        harness.card.id,
        listIds.done,
        { dueComplete: true },
      );
      expect(harness.deleteRemoteBranch).toHaveBeenCalledWith(
        harness.project.repository.path,
        "origin",
        "agent/card-1",
      );
      expect(harness.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it("applies requested changes to the existing pull request without creating another", async () => {
    const harness = createHarness({
      initialList: "review",
      pullRequestState: "requested",
      feedback: "Please add a regression test.",
    });

    try {
      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.review);
      expect(harness.runOpenCode).toHaveBeenCalledTimes(3);
      expect(harness.runOpenCode.mock.calls[0]?.[0]).toMatchObject({
        cwd: harness.worktreePath,
        model: "implementation-model",
        sessionLabel: "OpenCode review feedback implementation",
      });
      expect(harness.runOpenCode.mock.calls[0]?.[0].prompt).toContain(
        "Human review feedback:\nPlease add a regression test.",
      );
      expect(harness.createPullRequest).not.toHaveBeenCalled();
      expect(harness.findPullRequest).toHaveBeenCalled();
      expect(harness.push).toHaveBeenCalledWith(
        harness.worktreePath,
        "origin",
        "agent/card-1",
      );
      expect(harness.moveCard).toHaveBeenNthCalledWith(
        1,
        harness.card.id,
        listIds.working,
      );
      expect(harness.moveCard).toHaveBeenNthCalledWith(
        2,
        harness.card.id,
        listIds.review,
      );
      expect(harness.events).toEqual(
        expect.arrayContaining([
          "trello:move:working-list",
          "git:prepare-review-worktree",
          "opencode:review-feedback-implementation",
          "opencode:review",
          "opencode:commit",
          "git:push",
          "trello:move:review-list",
        ]),
      );
      expect(harness.events.indexOf("trello:move:working-list")).toBeLessThan(
        harness.events.indexOf("git:prepare-review-worktree"),
      );
      expect(harness.mergePullRequest).not.toHaveBeenCalled();
      expect(harness.forcePush).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it("fails into Failed, does not auto-retry, and deliberately retries committed work", async () => {
    const publicationError = new Error("pull request creation failed");
    const harness = createHarness({
      createPullRequestError: publicationError,
    });

    try {
      await expect(
        pollProject(
          harness.trello,
          harness.git,
          harness.github,
          harness.openCode,
          harness.commands,
          harness.project,
          new AbortController().signal,
        ),
      ).rejects.toThrow("pull request creation failed");

      expect(harness.card.idList).toBe(listIds.failed);
      expect(harness.runOpenCode).toHaveBeenCalledTimes(3);
      expect(harness.createPullRequest).toHaveBeenCalledTimes(1);
      expect(harness.addComment).toHaveBeenCalledWith(
        harness.card.id,
        expect.stringContaining("To retry deliberately, move this card"),
      );
      expect(harness.moveCard).toHaveBeenCalledWith(
        harness.card.id,
        listIds.failed,
      );
      expect(harness.runCommand).not.toHaveBeenCalled();
      expect(harness.removeWorktree).not.toHaveBeenCalled();

      const eventsBeforePollingFailed = harness.events.length;

      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.failed);
      expect(harness.runOpenCode).toHaveBeenCalledTimes(3);
      expect(harness.createPullRequest).toHaveBeenCalledTimes(1);
      expect(harness.events).toHaveLength(eventsBeforePollingFailed);

      harness.moveCardManually("ready");

      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.review);
      expect(harness.runOpenCode).toHaveBeenCalledTimes(3);
      expect(harness.getChangedFiles).toHaveBeenCalledWith(
        harness.worktreePath,
        "origin/main",
      );
      expect(harness.createPullRequest).toHaveBeenCalledTimes(2);
      expect(harness.push).toHaveBeenCalledTimes(1);
      expect(harness.moveCard).toHaveBeenNthCalledWith(
        3,
        harness.card.id,
        listIds.working,
      );
      expect(harness.moveCard).toHaveBeenNthCalledWith(
        4,
        harness.card.id,
        listIds.review,
      );

      const retryEvents = harness.events.slice(
        harness.events.indexOf("human:move:ready-list"),
      );
      expect(retryEvents).toContain("git:inspect-worktree");
      expect(retryEvents).toContain("git:changed-files");
      expect(retryEvents).not.toContain("opencode:implementation");
      expect(retryEvents).not.toContain("opencode:review");
      expect(retryEvents).not.toContain("opencode:commit");
      expect(harness.forcePush).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it("refines a ready card in an isolated worktree and returns it to Backlog", async () => {
    const harness = createHarness({
      cardLabels: ["refinement-label"],
    });

    try {
      await pollProject(
        harness.trello,
        harness.git,
        harness.github,
        harness.openCode,
        harness.commands,
        harness.project,
        new AbortController().signal,
      );

      expect(harness.card.idList).toBe(listIds.backlog);
      expect(harness.card.idLabels).toEqual(["feature-label"]);
      expect(harness.runOpenCode).toHaveBeenCalledOnce();
      expect(harness.runOpenCode.mock.calls[0]?.[0]).toMatchObject({
        cwd: harness.worktreePath,
        model: "refinement-model",
        sessionLabel: "OpenCode refinement",
      });
      expect(harness.runCommand).not.toHaveBeenCalled();
      expect(harness.push).not.toHaveBeenCalled();
      expect(harness.createPullRequest).not.toHaveBeenCalled();
      expect(harness.findPullRequest).not.toHaveBeenCalled();
      expect(harness.findMergedPullRequest).not.toHaveBeenCalled();
      expect(harness.findClosedPullRequest).not.toHaveBeenCalled();
      expect(harness.findChangesRequestedPullRequest).not.toHaveBeenCalled();
      expect(harness.mergePullRequest).not.toHaveBeenCalled();
      expect(harness.events).toEqual(
        expect.arrayContaining([
          "git:prepare-worktree",
          "trello:move:working-list",
          "opencode:refinement",
          "trello:update-card",
          "trello:add-label:feature-label",
          "trello:remove-label:refinement-label",
          "trello:move:backlog-list",
        ]),
      );
      expect(harness.events.indexOf("git:prepare-worktree")).toBeLessThan(
        harness.events.indexOf("trello:move:working-list"),
      );
      expect(harness.events.indexOf("opencode:refinement")).toBeLessThan(
        harness.events.indexOf("trello:update-card"),
      );
      expect(harness.events.indexOf("trello:move:working-list")).toBeLessThan(
        harness.events.indexOf("opencode:refinement"),
      );
    } finally {
      harness.cleanup();
    }
  });

  it.each(["backlog", "failed", "done"] as const)(
    "corrects a manual move from %s to Working without starting work",
    async (source) => {
      const harness = createHarness({
        initialList: source,
        initialWorktree: true,
      });

      try {
        harness.moveCardManually("working");

        await pollProject(
          harness.trello,
          harness.git,
          harness.github,
          harness.openCode,
          harness.commands,
          harness.project,
          new AbortController().signal,
        );

        expect(harness.card.idList).toBe(listIds.backlog);
        expect(harness.moveCard).toHaveBeenCalledTimes(1);
        expect(harness.moveCard).toHaveBeenCalledWith(
          harness.card.id,
          listIds.backlog,
        );
        expect(harness.trello.addComment).toHaveBeenCalledWith(
          harness.card.id,
          expect.stringContaining("without starting or resuming agent work"),
        );
        expect(harness.runOpenCode).not.toHaveBeenCalled();
        expect(harness.runCommand).not.toHaveBeenCalled();
        expect(harness.fetch).not.toHaveBeenCalled();
        expect(harness.getCurrentBranch).not.toHaveBeenCalled();
        expect(harness.getStatus).not.toHaveBeenCalled();
        expect(harness.push).not.toHaveBeenCalled();
        expect(harness.createPullRequest).not.toHaveBeenCalled();
        expect(harness.getChangedFiles).not.toHaveBeenCalled();
        expect(harness.getRemoteBranchSha).not.toHaveBeenCalled();
        expect(harness.findPullRequest).not.toHaveBeenCalled();
        expect(harness.findMergedPullRequest).not.toHaveBeenCalled();
        expect(harness.findClosedPullRequest).not.toHaveBeenCalled();
        expect(harness.findChangesRequestedPullRequest).not.toHaveBeenCalled();
        expect(harness.events).toEqual([
          "human:move:working-list",
          "trello:move:backlog-list",
        ]);
      } finally {
        harness.cleanup();
      }
    },
  );
});
