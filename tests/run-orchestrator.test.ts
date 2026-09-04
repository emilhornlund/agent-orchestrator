import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  GitHubMergeStateUnknownError,
  type GitHubClient,
} from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import type { CommandRunner } from "../src/process/command-runner.js";
import {
  TrelloRequestError,
  type TrelloCard,
  type TrelloClient,
} from "../src/trello/trello-client.js";
import * as cardContextRetention from "../src/context/card-context-retention.js";
import * as logRetention from "../src/logging/log-retention.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { OpenCodeRunAbortedError } from "../src/opencode/opencode-client.js";
import { TrelloRequestAbortedError } from "../src/trello/trello-client.js";
import {
  annotateFailure,
  getFailureContext,
} from "../src/orchestrator/failure-diagnostic.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import {
  githubReconciliationError,
  MAX_GITHUB_RECONCILIATION_ATTEMPTS,
} from "../src/orchestrator/github-reconciliation-error.js";
import {
  MAX_TRELLO_RECONCILIATION_ATTEMPTS,
  trelloReconciliationError,
} from "../src/orchestrator/trello-reconciliation-error.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import {
  MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS,
  PreparedConflictRemediationError,
} from "../src/orchestrator/remediate-prepared-conflict.js";
import {
  getPreparedConflictPath,
  writePreparedConflict,
} from "../src/orchestrator/prepared-conflict-state.js";
import { RETRY_BACKOFF_BASE_MILLISECONDS } from "../src/orchestrator/retry-backoff.js";
import { getReconciliationBlockPath } from "../src/orchestrator/reconciliation-block-storage.js";

const pollProject = vi.fn();

vi.mock("../src/orchestrator/poll-project.js", () => ({
  pollProject,
}));

const { runOrchestrator } =
  await import("../src/orchestrator/run-orchestrator.js");

let runtimeStorageRoot: string;

function createProject(id: string): ProjectConfig {
  return {
    id,
    autoMerge: false,
    trello: {
      boardId: `board-${id}`,
      backlogListId: `backlog-${id}`,
      readyListId: `ready-${id}`,
      workingListId: `working-${id}`,
      reviewListId: `review-${id}`,
      failedListId: `failed-${id}`,
      doneListId: `done-${id}`,
      refinementLabelId: `refinement-${id}`,
      featureLabelId: `feature-${id}`,
      improvementLabelId: `improvement-${id}`,
      bugLabelId: `bug-${id}`,
    },
    repository: {
      path: `/repos/${id}`,
      github: `example/${id}`,
      defaultBranch: "main",
      worktreeRoot: `/worktrees/${id}`,
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    opencode: {
      refinement: {
        model: "openai/refinement-model",
        variant: "xhigh",
      },
      implementation: {
        model: "implementation-model",
        variant: "implementation-variant",
      },
      review: {
        model: "review-model",
        variant: "review-variant",
      },
      remediation: {
        model: "remediation-model",
        variant: "remediation-variant",
        maxPasses: 1,
      },
      commit: {
        model: "commit-model",
        variant: "commit-variant",
      },
      timeoutMinutes: 360,
    },
  };
}

function createConfig(
  projects: ProjectConfig[],
  pollIntervalSeconds = 1,
): Config {
  return {
    workflow: {
      pollIntervalSeconds,
      logRetentionDays: 14,
      contextRetentionDays: 14,
      contextRoot: runtimeStorageRoot,
    },
    projects,
  };
}

function prepareConflict(project: ProjectConfig): void {
  const worktreePath = path.join(project.repository.worktreeRoot, "card-1");

  fs.mkdirSync(worktreePath, { recursive: true });
  writePreparedConflict(
    project,
    "card-1",
    "a".repeat(40),
    ["src/conflicted.ts"],
    {
      active: true,
      backend: "merge",
      headName: "refs/heads/agent/card-1",
      onto: "b".repeat(40),
      originalHead: "a".repeat(40),
    },
  );
}

describe("runOrchestrator", () => {
  beforeEach(() => {
    pollProject.mockReset();
    runtimeStorageRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-run-runtime-"),
    );
  });

  afterEach(() => {
    fs.rmSync(runtimeStorageRoot, { recursive: true, force: true });
  });

  it("runs project workers concurrently", async () => {
    const controller = new AbortController();

    let resolveProjectA: (() => void) | undefined;

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          await new Promise<void>((resolve) => {
            resolveProjectA = resolve;
          });
          return;
        }

        if (project.id === "project-b") {
          controller.abort();
          resolveProjectA?.();
        }
      },
    );

    const config = createConfig([
      createProject("project-a"),
      createProject("project-b"),
    ]);

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      controller.signal,
    );

    expect(pollProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: "project-a" }),
      expect.anything(),
    );

    expect(pollProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: "project-b" }),
      expect.anything(),
    );
  });

  it("runs only one poll at a time for each project", async () => {
    const controller = new AbortController();

    let resolvePoll: (() => void) | undefined;

    pollProject.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolvePoll = resolve;
      });
    });

    const config = createConfig([createProject("project-a")]);

    const orchestrator = runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(pollProject).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pollProject).toHaveBeenCalledTimes(1);

    controller.abort();
    resolvePoll?.();

    await orchestrator;
  });

  it("keeps other project workers running when one project fails", async () => {
    const controller = new AbortController();

    const projectACalls: string[] = [];
    const projectBCalls: string[] = [];

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          projectACalls.push(project.id);
          throw new Error("project-a failed");
        }

        if (project.id === "project-b") {
          projectBCalls.push(project.id);
          controller.abort();
        }
      },
    );

    const config = createConfig([
      createProject("project-a"),
      createProject("project-b"),
    ]);

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      controller.signal,
    );

    expect(projectACalls).toHaveLength(1);
    expect(projectBCalls).toHaveLength(1);
  });

  it("bounds repeated prepared-conflict remediation attempts and then blocks the project", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    let calls = 0;
    const failure = new PreparedConflictRemediationError(
      "OpenCode",
      "conflict remediation did not complete",
    );

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls === MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
        controller.abort();
      }

      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it("keeps normal processing suspended while an exhausted prepared conflict remains active", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-blocked-prepared-conflict-"),
    );
    project.repository.worktreeRoot = worktreeRoot;
    prepareConflict(project);

    const failure = new PreparedConflictRemediationError(
      "OpenCode",
      "conflict remediation did not complete",
    );
    annotateFailure(failure, {
      projectId: project.id,
      cardId: "card-1",
    });
    let pollCalls = 0;
    let recoveryChecks = 0;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue(""),
      isValidRepository: vi.fn().mockResolvedValue(true),
      getRebaseState: vi.fn().mockImplementation(async () => {
        recoveryChecks += 1;

        if (recoveryChecks === 2) {
          controller.abort();
        }

        return {
          active: true,
          backend: "merge",
          headName: "refs/heads/agent/card-1",
          onto: "b".repeat(40),
          originalHead: "a".repeat(40),
        };
      }),
      getConflictedPaths: vi.fn(),
    } as unknown as GitClient;

    pollProject.mockImplementation(async () => {
      pollCalls += 1;
      throw failure;
    });

    try {
      await runOrchestrator(
        {} as TrelloClient,
        git,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([project], 0),
        controller.signal,
        notifier,
      );

      expect(pollCalls).toBe(MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS);
      expect(recoveryChecks).toBe(2);
      expect(git.getCurrentBranch).not.toHaveBeenCalled();
      expect(notifier.send).toHaveBeenCalledOnce();
      expect(fs.existsSync(getPreparedConflictPath(project, "card-1"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("keeps the project blocked when the prepared-conflict handoff is removed before publication", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-recover-prepared-conflict-"),
    );
    project.repository.worktreeRoot = worktreeRoot;
    prepareConflict(project);

    const failure = new PreparedConflictRemediationError(
      "OpenCode",
      "conflict remediation did not complete",
    );
    annotateFailure(failure, {
      projectId: project.id,
      cardId: "card-1",
    });
    let pollCalls = 0;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      isValidRepository: vi.fn().mockResolvedValue(true),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue([]),
    } as unknown as GitClient;

    const abortTimer = setTimeout(() => controller.abort(), 25);

    pollProject.mockImplementation(async () => {
      pollCalls += 1;

      if (pollCalls <= MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
        if (pollCalls === MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
          fs.rmSync(getPreparedConflictPath(project, "card-1"));
        }

        throw failure;
      }
    });

    try {
      await runOrchestrator(
        {} as TrelloClient,
        git,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([project], 0),
        controller.signal,
        notifier,
      );

      expect(pollCalls).toBe(MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS);
      expect(git.getRebaseState).not.toHaveBeenCalled();
      expect(git.getConflictedPaths).not.toHaveBeenCalled();
      expect(notifier.send).toHaveBeenCalledOnce();
      expect(fs.existsSync(getPreparedConflictPath(project, "card-1"))).toBe(
        false,
      );
    } finally {
      clearTimeout(abortTimer);
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("releases a completed local rebase while preserving its handoff for remediation", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-complete-prepared-conflict-"),
    );
    project.repository.worktreeRoot = worktreeRoot;
    prepareConflict(project);

    const failure = new PreparedConflictRemediationError(
      "OpenCode",
      "conflict remediation did not complete",
    );
    annotateFailure(failure, {
      projectId: project.id,
      cardId: "card-1",
    });
    let pollCalls = 0;
    const resolvedHead = "c".repeat(40);
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
      isValidRepository: vi.fn().mockResolvedValue(true),
      getRebaseState: vi.fn().mockResolvedValue(null),
      getConflictedPaths: vi.fn().mockResolvedValue([]),
      getHeadSha: vi.fn().mockResolvedValue(resolvedHead),
      isAncestor: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue(""),
    } as unknown as GitClient;

    pollProject.mockImplementation(async () => {
      pollCalls += 1;

      if (pollCalls <= MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS) {
        throw failure;
      }

      expect(fs.existsSync(getPreparedConflictPath(project, "card-1"))).toBe(
        true,
      );
      controller.abort();
    });

    try {
      await runOrchestrator(
        {} as TrelloClient,
        git,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([project], 0),
        controller.signal,
        notifier,
      );

      expect(pollCalls).toBe(MAX_PREPARED_CONFLICT_REMEDIATION_ATTEMPTS + 1);
      expect(git.getHeadSha).toHaveBeenCalledWith(
        path.join(worktreeRoot, "card-1"),
      );
      expect(fs.existsSync(path.join(worktreeRoot, "card-1"))).toBe(true);
      expect(fs.existsSync(getPreparedConflictPath(project, "card-1"))).toBe(
        true,
      );
      expect(notifier.send).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("emails an Attention Required alert for an unreconciled project failure", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const failure = new WorkflowError(
      "Workflow",
      "Multiple active cards are in Working: card-1, card-2",
    );

    annotateFailure(failure, {
      projectId: "project-a",
      cardIds: ["card-1", "card-2"],
      sessionLogPaths: ["logs/sessions/project-a/card-1.log"],
      handlingOutcome: "project remains blocked for operator investigation",
    });

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          throw failure;
        }

        controller.abort();
      },
    );

    await runOrchestrator(
      trello,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a"), createProject("project-b")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledWith({
      subject: "[Agent Orchestrator] Attention Required: project-a",
      text: [
        "Event: Attention Required",
        "Project: project-a",
        "Failure category: Workflow",
        "Failure reason: Multiple active cards are in Working: card-1, card-2",
        "Affected card IDs: card-1, card-2",
        "Session logs:",
        "- logs/sessions/project-a/card-1.log",
        "Failure handling: project remains blocked for operator investigation",
        "",
        "Project processing cannot safely continue until the failure is resolved.",
      ].join("\n"),
    });
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not repeat an Attention Required alert for the same unresolved failure", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;
      const failure = new WorkflowError(
        "Workflow",
        "Multiple active cards are in Human Review: card-1, card-2",
      );

      annotateFailure(failure, {
        projectId: "project-a",
        cardIds: ["card-1", "card-2"],
      });

      if (calls === 2) {
        controller.abort();
      }

      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(2);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it("clears an unresolved failure alert after success so a later failure can notify", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls === 2) {
        return;
      }

      const failure = new WorkflowError(
        "Workflow",
        calls === 1
          ? "Multiple active cards are in Human Review: card-1, card-2"
          : "Multiple active cards are in Human Review: card-3, card-4",
      );

      annotateFailure(failure, {
        projectId: "project-a",
        cardIds: calls === 1 ? ["card-1", "card-2"] : ["card-3", "card-4"],
      });

      if (calls === 3) {
        controller.abort();
      }
      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(3);
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(notifier.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: expect.stringContaining("Affected card IDs: card-3, card-4"),
      }),
    );
  });

  it("retries temporary UNKNOWN mergeability and recovers without escalation", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = githubReconciliationError(
      "project-a",
      "card-1",
      "pull request state",
      new GitHubMergeStateUnknownError("UNKNOWN", "CLEAN"),
      "reconciliation failed",
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls < MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
        throw failure;
      }

      controller.abort();
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("uses increasing backoff delays for temporary UNKNOWN mergeability retries", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const controller = new AbortController();
      const failure = githubReconciliationError(
        "project-a",
        "card-1",
        "pull request state",
        new GitHubMergeStateUnknownError("MERGEABLE", "UNKNOWN"),
        "reconciliation failed",
      );
      let calls = 0;

      pollProject.mockImplementation(async () => {
        calls += 1;

        if (calls < 3) {
          throw failure;
        }

        controller.abort();
      });

      const orchestrator = runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([createProject("project-a")], 0),
        controller.signal,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      expect(random).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BASE_MILLISECONDS - 1);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(
        RETRY_BACKOFF_BASE_MILLISECONDS * 2 - 1,
      );
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);
      await orchestrator;
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("escalates persistent UNKNOWN mergeability at the retry threshold", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = githubReconciliationError(
      "project-a",
      "card-1",
      "requested changes",
      new GitHubMergeStateUnknownError("UNKNOWN", "UNKNOWN"),
      "reconciliation failed: GitHub returned a temporary unresolved pull request merge state while recalculating",
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls === MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
        controller.abort();
      }

      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[Agent Orchestrator] Attention Required: project-a",
        text: expect.stringContaining("temporary unresolved"),
      }),
    );
  });

  it("blocks an exhausted GitHub reconciliation instead of polling it again", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = githubReconciliationError(
      "project-a",
      "card-1",
      "pull request state",
      new Error("GitHub API returned HTTP 503"),
      "reconciliation failed",
      { reconciliationListId: "review-project-a" },
    );
    let pollCalls = 0;
    const getCards = vi.fn().mockImplementation(async () => {
      controller.abort();
      return [] as TrelloCard[];
    });

    pollProject.mockImplementation(async () => {
      pollCalls += 1;
      throw failure;
    });

    await runOrchestrator(
      { getCards } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(pollCalls).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);
    expect(getCards).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "blocked pull request state reconciliation",
        ),
      }),
    );
  });

  it("restores an exhausted GitHub block without rerunning or notifying it", async () => {
    const firstController = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const failure = githubReconciliationError(
      project.id,
      "card-1",
      "pull request state",
      new Error("GitHub API returned HTTP 503"),
      "reconciliation failed",
      { reconciliationListId: project.trello.reviewListId },
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;
      if (calls === MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
        firstController.abort();
      }
      throw failure;
    });

    const config = createConfig([project], 0);
    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      firstController.signal,
      notifier,
    );

    expect(
      fs.existsSync(getReconciliationBlockPath(runtimeStorageRoot, project.id)),
    ).toBe(true);
    expect(calls).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS);

    const secondController = new AbortController();
    const getCards = vi.fn().mockImplementation(async () => {
      secondController.abort();
      return [] as TrelloCard[];
    });
    pollProject.mockReset();

    await runOrchestrator(
      { getCards } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      secondController.signal,
      notifier,
    );

    expect(pollProject).not.toHaveBeenCalled();
    expect(getCards).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it("keeps an unrelated project polling while another project is blocked", async () => {
    const controller = new AbortController();
    const failure = githubReconciliationError(
      "project-a",
      "card-a",
      "pull request",
      new Error("GitHub API returned HTTP 503"),
      "reconciliation failed",
      { reconciliationListId: "review-project-a" },
    );
    let projectACalls = 0;
    let projectBCalls = 0;

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          projectACalls += 1;
          throw failure;
        }

        projectBCalls += 1;
        if (projectBCalls === 4) {
          controller.abort();
        }
      },
    );

    await runOrchestrator(
      { getCards: vi.fn().mockResolvedValue([]) } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a"), createProject("project-b")], 0),
      controller.signal,
    );

    expect(projectACalls).toBeGreaterThan(0);
    expect(projectBCalls).toBe(4);
  });

  it("clears a reconciliation block after the affected card is moved to Ready for Agent", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = githubReconciliationError(
      "project-a",
      "card-1",
      "requested changes",
      new Error("GitHub API returned HTTP 503"),
      "reconciliation failed",
      { reconciliationListId: "review-project-a" },
    );
    let pollCalls = 0;
    let recoveryChecks = 0;
    const getCards = vi.fn().mockImplementation(async () => {
      recoveryChecks += 1;

      if (recoveryChecks === 1) {
        return [] as TrelloCard[];
      }

      return [
        {
          id: "card-1",
          name: "Task",
          desc: "",
          idList: "ready-project-a",
          idLabels: [],
          url: "https://trello.example/card-1",
        },
      ] satisfies TrelloCard[];
    });

    pollProject.mockImplementation(async () => {
      pollCalls += 1;

      if (pollCalls <= MAX_GITHUB_RECONCILIATION_ATTEMPTS) {
        throw failure;
      }

      controller.abort();
    });

    await runOrchestrator(
      { getCards } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(pollCalls).toBe(MAX_GITHUB_RECONCILIATION_ATTEMPTS + 1);
    expect(getCards).toHaveBeenCalledTimes(2);
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(
      fs.existsSync(
        getReconciliationBlockPath(runtimeStorageRoot, "project-a"),
      ),
    ).toBe(false);
  });

  it("resets transient GitHub reconciliation attempts after a successful poll", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = githubReconciliationError(
      "project-a",
      "card-1",
      "pull request",
      new Error("temporary connectivity failure"),
      "reconciliation failed",
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls === 1 || calls >= 3) {
        if (calls === 5) {
          controller.abort();
        }

        throw failure;
      }
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(5);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("retries a transient Trello operation in a later poll without escalation", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const controller = new AbortController();
      const notifier: EmailNotifier = { send: vi.fn() };
      const failure = trelloReconciliationError(
        "project-a",
        "card-1",
        "transition history",
        new TrelloRequestError(
          "transition history",
          "Trello request failed: 503 Unavailable",
          { status: 503, retryable: true },
        ),
        "Could not read Trello transition history",
      );
      let calls = 0;

      pollProject.mockImplementation(async () => {
        calls += 1;

        if (calls < MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
          throw failure;
        }

        controller.abort();
      });

      const orchestrator = runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([createProject("project-a")], 0),
        controller.signal,
        notifier,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BASE_MILLISECONDS);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BASE_MILLISECONDS * 2);
      expect(calls).toBe(MAX_TRELLO_RECONCILIATION_ATTEMPTS);
      await orchestrator;

      expect(notifier.send).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps non-retryable failures on the normal polling interval", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random");

    try {
      const controller = new AbortController();
      let calls = 0;

      pollProject.mockImplementation(async () => {
        calls += 1;

        if (calls === 2) {
          controller.abort();
        }

        throw new WorkflowError("Workflow", "deterministic workflow failure");
      });

      const orchestrator = runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([createProject("project-a")], 10),
        controller.signal,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      expect(random).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      expect(random).not.toHaveBeenCalled();
      await orchestrator;
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("interrupts a pending transient retry backoff during shutdown", async () => {
    vi.useFakeTimers();

    try {
      const controller = new AbortController();
      const failure = githubReconciliationError(
        "project-a",
        "card-1",
        "pull request state",
        new Error("GitHub API returned HTTP 503"),
        "reconciliation failed",
      );
      let calls = 0;

      pollProject.mockImplementation(async () => {
        calls += 1;
        throw failure;
      });

      const orchestrator = runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([createProject("project-a")], 0),
        controller.signal,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      controller.abort();
      await orchestrator;

      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries deferred startup Trello validation in the project worker", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const validationFailure = new TrelloRequestError(
      "label lookup",
      "Trello request failed: 503 Unavailable",
      { status: 503, retryable: true },
    );
    const validateProjectTrello = vi
      .fn()
      .mockRejectedValueOnce(validationFailure)
      .mockRejectedValueOnce(validationFailure)
      .mockResolvedValue(undefined);

    pollProject.mockImplementation(async () => {
      controller.abort();
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
      validateProjectTrello,
    );

    expect(validateProjectTrello).toHaveBeenCalledTimes(3);
    expect(pollProject).toHaveBeenCalledOnce();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("escalates a persistent transient Trello operation only after the retry bound", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = trelloReconciliationError(
      "project-a",
      "card-1",
      "card move",
      new TrelloRequestError(
        "card move",
        "Trello request failed: 504 Gateway Timeout",
        { status: 504, retryable: true },
      ),
      "Could not move card to Working",
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;

      if (calls === MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
        controller.abort();
      }

      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(calls).toBe(MAX_TRELLO_RECONCILIATION_ATTEMPTS);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[Agent Orchestrator] Attention Required: project-a",
        text: expect.stringContaining("Could not move card to Working"),
      }),
    );
  });

  it("blocks an exhausted Trello reconciliation instead of polling it again", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const failure = trelloReconciliationError(
      "project-a",
      "card-1",
      "card move",
      new TrelloRequestError(
        "card move",
        "Trello request failed: 504 Gateway Timeout",
        { status: 504, retryable: true },
      ),
      "reconciliation failed",
      { reconciliationListId: "working-project-a" },
    );
    let pollCalls = 0;
    const getCards = vi.fn().mockImplementation(async () => {
      controller.abort();
      return [] as TrelloCard[];
    });

    pollProject.mockImplementation(async () => {
      pollCalls += 1;
      throw failure;
    });

    await runOrchestrator(
      { getCards } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")], 0),
      controller.signal,
      notifier,
    );

    expect(pollCalls).toBe(MAX_TRELLO_RECONCILIATION_ATTEMPTS);
    expect(getCards).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it("restores an exhausted Trello block without rerunning or notifying it", async () => {
    const firstController = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const failure = trelloReconciliationError(
      project.id,
      "card-1",
      "card move",
      new TrelloRequestError(
        "card move",
        "Trello request failed: 504 Gateway Timeout",
        { status: 504, retryable: true },
      ),
      "reconciliation failed",
      { reconciliationListId: project.trello.workingListId },
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;
      if (calls === MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
        firstController.abort();
      }
      throw failure;
    });

    const config = createConfig([project], 0);
    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      firstController.signal,
      notifier,
    );

    const secondController = new AbortController();
    const getCards = vi.fn().mockImplementation(async () => {
      secondController.abort();
      return [] as TrelloCard[];
    });
    pollProject.mockReset();

    await runOrchestrator(
      { getCards } as unknown as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      secondController.signal,
      notifier,
    );

    expect(pollProject).not.toHaveBeenCalled();
    expect(getCards).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(
      fs.existsSync(getReconciliationBlockPath(runtimeStorageRoot, project.id)),
    ).toBe(true);
  });

  it("uses an explicit restart to recover a cardless Trello block", async () => {
    const firstController = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const project = createProject("project-a");
    const failure = trelloReconciliationError(
      project.id,
      undefined,
      "label lookup",
      new TrelloRequestError(
        "label lookup",
        "Trello request failed: 503 Unavailable",
        { status: 503, retryable: true },
      ),
      "project Trello reconciliation failed",
      { reconciliationListId: project.trello.readyListId },
    );
    let calls = 0;

    pollProject.mockImplementation(async () => {
      calls += 1;
      if (calls === MAX_TRELLO_RECONCILIATION_ATTEMPTS) {
        firstController.abort();
      }
      throw failure;
    });

    const config = createConfig([project], 0);
    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      firstController.signal,
      notifier,
    );

    const persistedBlock = JSON.parse(
      fs.readFileSync(
        getReconciliationBlockPath(runtimeStorageRoot, project.id),
        "utf8",
      ),
    );

    expect(persistedBlock).not.toHaveProperty("cardId");
    expect(persistedBlock).toMatchObject({
      reconciliationListId: project.trello.readyListId,
      recoveryCondition: "worker-restart",
    });

    const secondController = new AbortController();
    pollProject.mockReset();
    pollProject.mockImplementation(async () => {
      secondController.abort();
      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      secondController.signal,
      notifier,
    );

    expect(pollProject).toHaveBeenCalledOnce();
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(
      fs.existsSync(getReconciliationBlockPath(runtimeStorageRoot, project.id)),
    ).toBe(false);
  });

  it("fails closed on malformed persisted reconciliation state", async () => {
    const project = createProject("project-a");
    const filePath = getReconciliationBlockPath(runtimeStorageRoot, project.id);
    const malformed = '{"version":1,"projectId":"project-a"}';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, malformed, "utf8");

    const controller = new AbortController();
    const notifier: EmailNotifier = { send: vi.fn() };
    const abortTimer = setTimeout(() => controller.abort(), 10);
    pollProject.mockReset();
    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, currentProject) => {
        if (currentProject.id === "project-b") {
          controller.abort();
        }
      },
    );

    try {
      await runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([project, createProject("project-b")], 1),
        controller.signal,
        notifier,
      );
    } finally {
      clearTimeout(abortTimer);
    }

    expect(pollProject).toHaveBeenCalledOnce();
    expect(pollProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: "project-b" }),
      expect.anything(),
      expect.anything(),
    );
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(fs.readFileSync(filePath, "utf8")).toBe(malformed);
  });

  it("skips a disabled Attention Required event without changing project failure handling", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
      isEventEnabled: (event) => event !== "attentionRequired",
    };
    const failure = new WorkflowError("Git/GitHub", "GitHub unavailable");

    pollProject.mockImplementation(async () => {
      controller.abort();
      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("sends only the Failed email after card failure handling moves the card", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const failure = new WorkflowError("OpenCode", "implementation failed");
    const trello = {
      moveCard: vi.fn().mockResolvedValue({ id: "card-1", idList: "failed" }),
      addComment: vi.fn().mockResolvedValue({}),
    } as unknown as TrelloClient;

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          try {
            await failCard(trello, project, "card-1", failure, notifier, {
              name: "Example task",
              url: "https://trello.example/card-1",
            });
          } finally {
            controller.abort();
          }
        }
      },
    );

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a"), createProject("project-b")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[Agent Orchestrator] Failed: project-a / Example task",
      }),
    );
    expect(notifier.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("Attention Required"),
      }),
    );
    expect(getFailureContext(failure)?.cardFailureHandled).toBe(true);
  });

  it("sends Attention Required when card failure handling cannot move the card", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const failure = new WorkflowError("OpenCode", "implementation failed");
    const trello = {
      moveCard: vi.fn().mockRejectedValue(new Error("Trello unavailable")),
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        try {
          await failCard(trello, project, "card-1", failure, notifier, {
            name: "Example task",
            url: "https://trello.example/card-1",
          });
        } finally {
          controller.abort();
        }
      },
    );

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[Agent Orchestrator] Attention Required: project-a",
        text: expect.stringContaining("Trello unavailable"),
      }),
    );
    expect(notifier.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("Failed"),
      }),
    );
    expect(getFailureContext(failure)?.cardFailureHandled).toBe(false);
  });

  it("does not infer completed card failure handling from diagnostic text", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const failure = new WorkflowError("OpenCode", "implementation failed");

    annotateFailure(failure, {
      projectId: "project-a",
      cardId: "card-1",
      handlingOutcome: "card moved to Failed and failure comment added",
    });

    pollProject.mockImplementation(async () => {
      controller.abort();
      throw failure;
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[Agent Orchestrator] Attention Required: project-a",
      }),
    );
  });

  it("does not email shutdown cancellation", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };

    pollProject.mockImplementation(async () => {
      controller.abort();
      throw new OpenCodeRunAbortedError();
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("does not email a shutdown cancellation wrapped in a workflow error", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };

    pollProject.mockImplementation(async () => {
      controller.abort();
      throw new WorkflowError("Workflow", "Trello request failed", {
        cause: new TrelloRequestAbortedError(),
      });
    });

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a")]),
      controller.signal,
      notifier,
    );

    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("keeps independent workers running when Attention Required delivery fails", async () => {
    const controller = new AbortController();
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const projectACalls: string[] = [];
    const projectBCalls: string[] = [];

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          projectACalls.push(project.id);

          const failure = new WorkflowError(
            "Git/GitHub",
            "Could not reconcile Human Review card: GitHub unavailable",
          );
          annotateFailure(failure, {
            projectId: project.id,
            cardId: "card-a",
          });
          throw failure;
        }

        projectBCalls.push(project.id);
        controller.abort();
      },
    );

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a"), createProject("project-b")]),
      controller.signal,
      notifier,
    );

    expect(projectACalls).toHaveLength(1);
    expect(projectBCalls).toHaveLength(1);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("logs a failed card with its category, card context, and handling outcome", async () => {
    const controller = new AbortController();
    const failure = new WorkflowError(
      "Git/GitHub",
      "push failed while publishing the task",
    );

    annotateFailure(failure, {
      projectId: "project-a",
      cardId: "card-123",
      cardFailureHandled: true,
      handlingOutcome: "card moved to Failed and failure comment added",
    });

    expect(getFailureContext(failure)?.cardId).toBe("card-123");

    pollProject.mockImplementation(
      async (_trello, _git, _github, _opencode, _commands, project) => {
        if (project.id === "project-a") {
          throw failure;
        }

        controller.abort();
      },
    );

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      createConfig([createProject("project-a"), createProject("project-b")]),
      controller.signal,
    );

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${date}.log`,
    );

    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "[project-a] [card:card-123] Task failed. Category: Git/GitHub; Reason: push failed while publishing the task; Failure handling: card moved to Failed and failure comment added",
    );
  });

  it("stops sleeping project workers when the orchestrator is aborted", async () => {
    const controller = new AbortController();

    pollProject.mockImplementation(async () => {
      controller.abort();
    });

    const config = createConfig([createProject("project-a")], 60);

    await runOrchestrator(
      {} as TrelloClient,
      {} as GitClient,
      {} as GitHubClient,
      {} as OpenCodeClient,
      {} as CommandRunner,
      config,
      controller.signal,
    );

    expect(pollProject).toHaveBeenCalledTimes(1);
  });

  it("runs log retention during continued operation", async () => {
    vi.useFakeTimers();

    try {
      const controller = new AbortController();
      let resolvePoll: (() => void) | undefined;
      const cleanupLogRetention = vi.spyOn(logRetention, "cleanupLogRetention");
      const cleanupCardContextRetention = vi.spyOn(
        cardContextRetention,
        "cleanupCardContextRetention",
      );

      pollProject.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePoll = resolve;
          }),
      );

      const orchestrator = runOrchestrator(
        {} as TrelloClient,
        {} as GitClient,
        {} as GitHubClient,
        {} as OpenCodeClient,
        {} as CommandRunner,
        createConfig([createProject("project-a")]),
        controller.signal,
      );

      await vi.advanceTimersByTimeAsync(
        logRetention.logRetentionIntervalMilliseconds,
      );

      expect(cleanupLogRetention).toHaveBeenCalledWith(14);
      expect(cleanupCardContextRetention).toHaveBeenCalledWith(
        runtimeStorageRoot,
        14,
        expect.any(Date),
        ["project-a"],
      );

      controller.abort();
      resolvePoll?.();
      await orchestrator;

      const contextCleanupCalls = cleanupCardContextRetention.mock.calls.length;
      await vi.advanceTimersByTimeAsync(
        logRetention.logRetentionIntervalMilliseconds,
      );
      expect(cleanupCardContextRetention).toHaveBeenCalledTimes(
        contextCleanupCalls,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
