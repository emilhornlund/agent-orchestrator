import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../src/github/github-client.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { maintainReviewPullRequest } from "../src/orchestrator/maintain-review-pull-request.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const temporaryDirectories: string[] = [];

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "project",
    autoMerge: false,
    repository: {
      path: "/repo",
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent@example.com",
      },
      validationCommand: "yarn validate",
    },
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
    opencode: {
      refinement: { model: "model", variant: "variant" },
      implementation: { model: "model", variant: "variant" },
      review: { model: "model", variant: "variant" },
      remediation: { model: "model", variant: "variant", maxPasses: 1 },
      commit: { model: "model", variant: "variant" },
      timeoutMinutes: 5,
    },
  };
}

function createCard(): TrelloCard {
  return {
    id: "card-1",
    name: "Task",
    desc: "",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card-1",
  };
}

function createPullRequest(): PullRequestState {
  return {
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    mergedAt: null,
    baseRefName: "main",
    headRefName: "agent/card-1",
    headRepositoryNameWithOwner: "owner/repo",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
  };
}

function createTrello(card: TrelloCard): TrelloClient {
  return {
    getCards: vi.fn().mockResolvedValue([card]),
    moveCard: vi.fn(),
    addComment: vi.fn(),
  } as unknown as TrelloClient;
}

function createGit(
  remoteTaskShas: string[],
  options: { rebase?: () => Promise<void>; push?: () => Promise<void> } = {},
): GitClient {
  const getRemoteBranchSha = vi
    .fn()
    .mockImplementation(async () => remoteTaskShas.shift() ?? "task-sha");
  const git = {
    fetch: vi.fn(),
    pruneWorktrees: vi.fn(),
    branchExists: vi.fn().mockResolvedValue(false),
    addWorktreeWithNewBranch: vi.fn(),
    getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
    getStatus: vi.fn().mockResolvedValue(""),
    resetHardTo: vi.fn(),
    isAncestor: vi.fn().mockResolvedValue(false),
    rebase: vi.fn(options.rebase ?? (async () => undefined)),
    getHeadSha: vi.fn().mockResolvedValue("rebased-sha"),
    getRemoteBranchSha,
    pushWithLease: vi.fn(options.push ?? (async () => undefined)),
  } as unknown as GitClient;

  return git;
}

function createGithub(
  pullRequest: PullRequestState = createPullRequest(),
  changesRequested = false,
): GitHubClient {
  return {
    findPullRequestState: vi.fn().mockResolvedValue(pullRequest),
    findChangesRequestedPullRequest: vi
      .fn()
      .mockResolvedValue(
        changesRequested ? { url: pullRequest.url, feedback: "Fix" } : null,
      ),
  } as unknown as GitHubClient;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("owned Human Review pull-request maintenance", () => {
  function setup() {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-maintenance-"),
    );
    temporaryDirectories.push(worktreeRoot);
    const card = createCard();
    const project = createProject(worktreeRoot);
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0 });

    return {
      card,
      project,
      trello: createTrello(card),
      commands: new CommandRunner(runCommand),
      runCommand,
    };
  }

  it("does not maintain a pull request from a fork with the task branch name", async () => {
    const scenario = setup();
    const pullRequest = {
      ...createPullRequest(),
      headRepositoryNameWithOwner: "contributor/repo",
    };
    const git = createGit(["task-sha", "default-sha"]);

    await expect(
      maintainReviewPullRequest({
        git,
        github: createGithub(pullRequest),
        commands: scenario.commands,
        project: scenario.project,
        card: scenario.card,
        pullRequest,
      }),
    ).resolves.toBe("not-eligible");

    expect(git.getRemoteBranchSha).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
  });

  it("does not maintain a pull request when its head repository identity is missing", async () => {
    const scenario = setup();
    const pullRequest = createPullRequest();
    delete pullRequest.headRepositoryNameWithOwner;
    const git = createGit(["task-sha", "default-sha"]);

    await expect(
      maintainReviewPullRequest({
        git,
        github: createGithub(pullRequest),
        commands: scenario.commands,
        project: scenario.project,
        card: scenario.card,
        pullRequest,
      }),
    ).resolves.toBe("not-eligible");

    expect(git.getRemoteBranchSha).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
  });

  it("rebases and updates a clean stale branch while retaining its pull request", async () => {
    const scenario = setup();
    const git = createGit(["task-sha", "default-sha", "task-sha"]);
    const github = createGithub();

    await expect(
      reconcileReviewCards(scenario.trello, git, github, scenario.project, {
        maintenance: { commands: scenario.commands },
      }),
    ).resolves.toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "up-to-date",
    });

    expect(git.rebase).toHaveBeenCalledWith(
      path.join(scenario.project.repository.worktreeRoot, "card-1"),
      "origin/main",
      scenario.project.repository.gitIdentity,
    );
    expect(git.pushWithLease).toHaveBeenCalledWith(
      path.join(scenario.project.repository.worktreeRoot, "card-1"),
      "origin",
      "agent/card-1",
      "task-sha",
      scenario.project,
    );
    expect(scenario.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(scenario.project.repository.worktreeRoot, "card-1"),
        command: "yarn validate",
      }),
    );
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not touch an already-current branch", async () => {
    const scenario = setup();
    const git = createGit(["same-sha", "same-sha"]);

    await reconcileReviewCards(
      scenario.trello,
      git,
      createGithub(),
      scenario.project,
      { maintenance: { commands: scenario.commands } },
    );

    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(scenario.runCommand).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent remote update", async () => {
    const scenario = setup();
    const git = createGit(["task-sha", "default-sha", "changed-sha"], {
      push: vi.fn().mockRejectedValue(new Error("stale info")),
    });

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).rejects.toThrow("force-with-lease update");

    expect(git.pushWithLease).toHaveBeenCalledTimes(1);
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not maintain a branch when requested changes appear on its current head", async () => {
    const scenario = setup();
    const github = createGithub();
    vi.mocked(github.findChangesRequestedPullRequest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        feedback: "Fix",
      });
    const git = createGit(["task-sha", "default-sha"]);

    await reconcileReviewCards(scenario.trello, git, github, scenario.project, {
      maintenance: { commands: scenario.commands },
    });

    expect(git.getRemoteBranchSha).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(scenario.runCommand).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not push after validation fails", async () => {
    const scenario = setup();
    scenario.runCommand.mockResolvedValue({ exitCode: 1 });
    const git = createGit(["task-sha", "default-sha"]);

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).rejects.toThrow("repository validation");

    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("preserves a rebase conflict without validation or cleanup", async () => {
    const scenario = setup();
    const git = createGit(["task-sha", "default-sha"], {
      rebase: vi.fn().mockRejectedValue(new Error("CONFLICT (content)")),
    });

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).rejects.toThrow("conflict state was preserved");

    expect(scenario.runCommand).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });
});
