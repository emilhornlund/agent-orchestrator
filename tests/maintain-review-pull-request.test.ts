import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type GitRebaseState } from "../src/git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../src/github/github-client.js";
import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { maintainReviewPullRequest } from "../src/orchestrator/maintain-review-pull-request.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import { getPreparedConflictPath } from "../src/orchestrator/prepared-conflict-state.js";
import { getFailureContext } from "../src/orchestrator/failure-diagnostic.js";
import { readReviewMaintenanceState } from "../src/orchestrator/review-maintenance-state.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const temporaryDirectories: string[] = [];
const taskSha = "a".repeat(40);
const defaultSha = "b".repeat(40);
const sameSha = "c".repeat(40);
const changedSha = "d".repeat(40);

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "maintain-review-pull-request-test",
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
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
  };
}

function getDailyLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);

  return path.join(process.cwd(), "logs", `test-orchestrator-${date}.log`);
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
  options: {
    rebase?: () => Promise<void>;
    push?: () => Promise<void>;
    rebaseState?: GitRebaseState | null;
    conflictedPaths?: string[];
  } = {},
): GitClient {
  const getRemoteBranchSha = vi
    .fn()
    .mockImplementation(async () => remoteTaskShas.shift() ?? taskSha);
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
    getRebaseState: vi.fn().mockResolvedValue(options.rebaseState ?? null),
    getConflictedPaths: vi
      .fn()
      .mockResolvedValue(options.conflictedPaths ?? []),
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
    updatePullRequestDescriptionStatus: vi.fn().mockResolvedValue(false),
  } as unknown as GitHubClient;
}

afterEach(() => {
  removeSessionLog("maintain-review-pull-request-test", "card-1");

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
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "contributor" },
      mergeable: "CONFLICTING" as const,
      mergeStateStatus: "DIRTY" as const,
    };
    const git = createGit([taskSha, defaultSha]);

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
    delete pullRequest.headRepository;
    const git = createGit([taskSha, defaultSha]);

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
    const git = createGit([taskSha, defaultSha, taskSha]);
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
      taskSha,
      scenario.project,
    );
    expect(scenario.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(scenario.project.repository.worktreeRoot, "card-1"),
        command: "yarn validate",
        sessionLogPath: getSessionLogPath(
          scenario.project.id,
          scenario.card.id,
        ),
        sessionLabel: "Repository validation",
      }),
    );
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "rebasing" }),
    );
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "validating" }),
    );
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ status: "updating-remote" }),
    );
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ status: null }),
    );
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("runs repository setup before Human Review validation", async () => {
    const scenario = setup();
    scenario.project.repository.setupCommand = "repository-setup";
    const git = createGit([taskSha, defaultSha]);
    let setupFinished = false;
    scenario.runCommand.mockImplementation(async ({ command }) => {
      if (command === "repository-setup") {
        setupFinished = true;
        return { exitCode: 0 };
      }

      expect(setupFinished).toBe(true);
      return { exitCode: 0 };
    });

    await reconcileReviewCards(
      scenario.trello,
      git,
      createGithub(),
      scenario.project,
      {
        maintenance: { commands: scenario.commands },
      },
    );

    expect(scenario.runCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: "repository-setup",
        sessionLabel: "Repository setup for Human Review",
      }),
    );
    expect(scenario.runCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: "yarn validate",
        sessionLabel: "Repository validation",
      }),
    );
  });

  it("reports setup failure without running validation or pushing", async () => {
    const scenario = setup();
    scenario.project.repository.setupCommand = "repository-setup";
    scenario.runCommand.mockResolvedValue({ exitCode: 2 });
    const git = createGit([taskSha, defaultSha]);

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        {
          maintenance: { commands: scenario.commands },
        },
      ),
    ).rejects.toThrow("Repository setup exited with code 2");

    expect(scenario.runCommand).toHaveBeenCalledOnce();
    expect(git.pushWithLease).not.toHaveBeenCalled();
  });

  it("reloads successful maintenance state across a fresh invocation", async () => {
    const scenario = setup();
    scenario.project.repository.setupCommand = "repository-setup";
    const git = createGit([taskSha, defaultSha, taskSha, defaultSha]);
    const push = vi.mocked(git.pushWithLease);
    push.mockRejectedValueOnce(new Error("temporary push failure"));

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        {
          maintenance: { commands: scenario.commands },
        },
      ),
    ).rejects.toThrow("force-with-lease update");
    fs.mkdirSync(path.join(scenario.project.repository.worktreeRoot, "card-1"));

    const restartedRunCommand = vi.fn<RunCommand>().mockResolvedValue({
      exitCode: 0,
    });
    const restartedGit = createGit([taskSha, defaultSha]);
    const restartedTrello = createTrello(scenario.card);

    await expect(
      reconcileReviewCards(
        restartedTrello,
        restartedGit,
        createGithub(),
        scenario.project,
        {
          maintenance: {
            commands: new CommandRunner(restartedRunCommand),
          },
        },
      ),
    ).resolves.toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "up-to-date",
    });

    expect(scenario.runCommand).toHaveBeenCalledTimes(2);
    expect(restartedRunCommand).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledOnce();
    expect(restartedGit.pushWithLease).toHaveBeenCalledOnce();
  });

  it("reloads an unchanged deterministic validation failure across a fresh invocation", async () => {
    const scenario = setup();
    const git = createGit([taskSha, defaultSha, taskSha, defaultSha]);
    scenario.runCommand.mockResolvedValue({ exitCode: 1 });

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        {
          maintenance: { commands: scenario.commands },
        },
      ),
    ).rejects.toThrow("repository validation");
    expect(
      readReviewMaintenanceState(scenario.project, scenario.card.id),
    ).toMatchObject({
      remoteTaskSha: taskSha,
      remoteDefaultSha: defaultSha,
      effectiveHeadSha: "rebased-sha",
      setupCompleted: true,
      validationCommand: "yarn validate",
      validation: { outcome: "failed" },
    });
    fs.mkdirSync(path.join(scenario.project.repository.worktreeRoot, "card-1"));

    const restartedRunCommand = vi.fn<RunCommand>().mockResolvedValue({
      exitCode: 0,
    });
    const restartedGit = createGit([taskSha, defaultSha]);
    const restartedTrello = createTrello(scenario.card);

    await expect(
      reconcileReviewCards(
        restartedTrello,
        restartedGit,
        createGithub(),
        scenario.project,
        {
          maintenance: {
            commands: new CommandRunner(restartedRunCommand),
          },
        },
      ),
    ).resolves.toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "behind",
    });

    expect(scenario.runCommand).toHaveBeenCalledTimes(1);
    expect(restartedRunCommand).not.toHaveBeenCalled();
    expect(restartedGit.rebase).not.toHaveBeenCalled();
    expect(restartedGit.pushWithLease).not.toHaveBeenCalled();
    expect(restartedTrello.moveCard).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
  });

  it("retries setup and validation after the pull-request head changes", async () => {
    const scenario = setup();
    scenario.project.repository.setupCommand = "repository-setup";
    const git = createGit([taskSha, defaultSha, changedSha, defaultSha]);
    scenario.runCommand.mockImplementation(async ({ command }) => ({
      exitCode: command === "yarn validate" ? 1 : 0,
    }));

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        {
          maintenance: { commands: scenario.commands },
        },
      ),
    ).rejects.toThrow("repository validation");
    fs.mkdirSync(path.join(scenario.project.repository.worktreeRoot, "card-1"));

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        {
          maintenance: { commands: scenario.commands },
        },
      ),
    ).rejects.toThrow("repository validation");

    expect(scenario.runCommand).toHaveBeenCalledTimes(4);
    expect(git.rebase).toHaveBeenCalledTimes(2);
  });

  it("does not touch Git when the initial managed status presentation fails", async () => {
    const scenario = setup();
    const git = createGit([taskSha, defaultSha]);
    const github = createGithub();
    const presentationError = new Error("description update failed");
    vi.mocked(github.updatePullRequestDescriptionStatus).mockRejectedValue(
      presentationError,
    );

    await expect(
      reconcileReviewCards(scenario.trello, git, github, scenario.project, {
        maintenance: { commands: scenario.commands },
      }),
    ).rejects.toThrow("managed status");

    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.resetHardTo).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it.each([
    ["CONFLICTING", "CLEAN"],
    ["MERGEABLE", "DIRTY"],
  ] as const)(
    "rebases and updates an owned conflicting branch (%s/%s) without replacing its pull request",
    async (mergeable, mergeStateStatus) => {
      const scenario = setup();
      const pullRequest = {
        ...createPullRequest(),
        mergeable,
        mergeStateStatus,
      };
      const git = createGit([taskSha, defaultSha]);
      const github = createGithub(pullRequest);

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
        taskSha,
        scenario.project,
      );
      expect(scenario.runCommand).toHaveBeenCalled();
      expect(scenario.trello.moveCard).not.toHaveBeenCalled();
      expect(
        fs.existsSync(
          getPreparedConflictPath(scenario.project, scenario.card.id),
        ),
      ).toBe(false);
    },
  );

  it("does not touch an already-current branch", async () => {
    const scenario = setup();
    const git = createGit([sameSha, sameSha]);

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
    const git = createGit([taskSha, defaultSha, changedSha], {
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
    const git = createGit([taskSha, defaultSha]);

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
    const git = createGit([taskSha, defaultSha]);
    const github = createGithub();

    await expect(
      reconcileReviewCards(scenario.trello, git, github, scenario.project, {
        maintenance: { commands: scenario.commands },
      }),
    ).rejects.toThrow("repository validation");

    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("retains failed validation output in the card session log without service output", async () => {
    const scenario = setup();
    const validationExitCode = 23;
    scenario.runCommand.mockImplementation(async ({ sessionLogPath }) => {
      appendSessionLog(
        sessionLogPath!,
        "representative test-suite stdout\nrepresentative application stderr\n",
      );

      return { exitCode: validationExitCode };
    });
    const git = createGit([taskSha, defaultSha]);
    const github = createGithub();

    const error = await reconcileReviewCards(
      scenario.trello,
      git,
      github,
      scenario.project,
      { maintenance: { commands: scenario.commands } },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `Validation command exited with code ${validationExitCode}`,
    );
    expect(getFailureContext(error)).toMatchObject({
      projectId: scenario.project.id,
      cardId: scenario.card.id,
      sessionLogPath: getSessionLogPath(scenario.project.id, scenario.card.id),
    });
    expect(
      fs.readFileSync(
        getSessionLogPath(scenario.project.id, scenario.card.id),
        "utf8",
      ),
    ).toContain(
      "representative test-suite stdout\nrepresentative application stderr\n",
    );
    const dailyLog = fs.readFileSync(getDailyLogPath(), "utf8");

    expect(dailyLog).toContain("Rebasing agent/card-1 onto origin/main");
    expect(dailyLog).not.toContain("representative test-suite stdout");
    expect(dailyLog).not.toContain("representative application stderr");
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(github.updatePullRequestDescriptionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("uses the normal attention failure path for malformed remote SHA data", async () => {
    const scenario = setup();
    const git = createGit(["not-a-sha", defaultSha]);

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).rejects.toThrow("malformed authoritative remote SHA");

    expect(git.rebase).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("preserves a rebase conflict without validation or cleanup", async () => {
    const scenario = setup();
    const git = createGit([taskSha, defaultSha], {
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

  it("rejects a malformed persisted conflict handoff without touching Git or Trello", async () => {
    const scenario = setup();
    const handoffPath = getPreparedConflictPath(
      scenario.project,
      scenario.card.id,
    );
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, "{}");
    const git = createGit([taskSha, defaultSha]);

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).rejects.toThrow("Prepared conflict handoff is invalid");

    expect(git.rebase).not.toHaveBeenCalled();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });

  it("reloads a prepared-conflict handoff across a fresh reconciliation invocation", async () => {
    const scenario = setup();
    const rebaseState: GitRebaseState = {
      active: true,
      backend: "merge",
      headName: "refs/heads/agent/card-1",
      onto: defaultSha,
      originalHead: taskSha,
      currentStep: 2,
      totalSteps: 4,
    };
    const git = createGit([taskSha, defaultSha], {
      rebase: vi.fn().mockRejectedValue(new Error("conflict")),
      rebaseState,
      conflictedPaths: ["src/changed.ts", "src/other.ts"],
    });

    const firstResult = await reconcileReviewCards(
      scenario.trello,
      git,
      createGithub(),
      scenario.project,
      {
        maintenance: { commands: scenario.commands },
      },
    );

    await expect(firstResult).toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "prepared-conflict",
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });

    const restartedGit = createGit([taskSha, defaultSha]);
    const restartedTrello = createTrello(scenario.card);

    await expect(
      reconcileReviewCards(
        restartedTrello,
        restartedGit,
        createGithub(),
        scenario.project,
        {
          maintenance: {
            commands: new CommandRunner(vi.fn<RunCommand>()),
          },
        },
      ),
    ).resolves.toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "prepared-conflict",
      preparedConflict: {
        projectId: "maintain-review-pull-request-test",
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: "main",
        expectedRemoteTaskSha: taskSha,
        conflictedPaths: ["src/changed.ts", "src/other.ts"],
        rebase: rebaseState,
      },
    });

    expect(scenario.runCommand).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(git.rebase).toHaveBeenCalledTimes(1);
    expect(restartedGit.rebase).not.toHaveBeenCalled();
    expect(restartedGit.getRemoteBranchSha).not.toHaveBeenCalled();
    expect(restartedTrello.moveCard).not.toHaveBeenCalled();
    expect(
      fs.existsSync(getPreparedConflictPath(scenario.project, "card-1")),
    ).toBe(true);
    expect(scenario.card.idList).toBe("review");
  });

  it("creates a prepared-conflict handoff when an owned conflicting PR hits real Git conflicts", async () => {
    const scenario = setup();
    const pullRequest = {
      ...createPullRequest(),
      mergeable: "CONFLICTING" as const,
      mergeStateStatus: "DIRTY" as const,
    };
    const rebaseState: GitRebaseState = {
      active: true,
      backend: "merge",
      headName: "refs/heads/agent/card-1",
      onto: defaultSha,
      originalHead: taskSha,
    };
    const git = createGit([taskSha, defaultSha], {
      rebase: vi.fn().mockRejectedValue(new Error("CONFLICT (content)")),
      rebaseState,
      conflictedPaths: ["src/conflicted.ts"],
    });

    await expect(
      reconcileReviewCards(
        scenario.trello,
        git,
        createGithub(pullRequest),
        scenario.project,
        { maintenance: { commands: scenario.commands } },
      ),
    ).resolves.toMatchObject({
      card: scenario.card,
      active: true,
      maintenanceState: "prepared-conflict",
      preparedConflict: {
        expectedRemoteTaskSha: taskSha,
        conflictedPaths: ["src/conflicted.ts"],
        rebase: rebaseState,
      },
    });

    expect(scenario.runCommand).not.toHaveBeenCalled();
    expect(git.pushWithLease).not.toHaveBeenCalled();
    expect(git.rebase).toHaveBeenCalledOnce();
    expect(scenario.trello.moveCard).not.toHaveBeenCalled();
  });
});
