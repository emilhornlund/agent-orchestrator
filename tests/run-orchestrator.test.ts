import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import type { CommandRunner } from "../src/process/command-runner.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import * as logRetention from "../src/logging/log-retention.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { OpenCodeRunAbortedError } from "../src/opencode/opencode-client.js";
import { TrelloRequestAbortedError } from "../src/trello/trello-client.js";
import {
  annotateFailure,
  getFailureContext,
} from "../src/orchestrator/failure-diagnostic.js";
import { failCard } from "../src/orchestrator/fail-card.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";

const pollProject = vi.fn();

vi.mock("../src/orchestrator/poll-project.js", () => ({
  pollProject,
}));

const { runOrchestrator } =
  await import("../src/orchestrator/run-orchestrator.js");

function createProject(id: string): ProjectConfig {
  return {
    id,
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
    },
    projects,
  };
}

describe("runOrchestrator", () => {
  beforeEach(() => {
    pollProject.mockReset();
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

      controller.abort();
      resolvePoll?.();
      await orchestrator;
    } finally {
      vi.useRealTimers();
    }
  });
});
