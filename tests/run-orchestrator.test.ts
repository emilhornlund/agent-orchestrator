import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import type { CommandRunner } from "../src/process/command-runner.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

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
});
