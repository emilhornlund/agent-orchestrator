import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  runStartup,
  type StartupDependencies,
  type StartupOperations,
} from "../src/startup/run-startup.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

function createProject(repositoryPath: string): ProjectConfig {
  return {
    id: "test-project",
    autoMerge: false,
    repository: {
      path: repositoryPath,
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot: path.join(path.dirname(repositoryPath), "worktrees"),
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    trello: {
      boardId: "board",
      backlogListId: "backlog-list",
      readyListId: "ready-list",
      workingListId: "working-list",
      reviewListId: "review-list",
      failedListId: "failed-list",
      doneListId: "done-list",
      refinementLabelId: "refinement-label",
      featureLabelId: "feature-label",
      improvementLabelId: "improvement-label",
      bugLabelId: "bug-label",
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

function createConfig(project: ProjectConfig): Config {
  return {
    projects: [project],
    workflow: {
      pollIntervalSeconds: 1,
      logRetentionDays: 14,
      contextRoot: "/opt/.agent-context",
    },
  };
}

describe("runStartup", () => {
  it("prevents Trello validation and polling after bootstrap failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);

    try {
      const runGit = vi
        .fn<RunGit>()
        .mockRejectedValue(new Error("fatal: not a git repository"));
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(runGit),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };
      const operations: StartupOperations = {
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        runOrchestrator: vi.fn().mockResolvedValue(undefined),
      };

      await expect(
        runStartup(
          createConfig(createProject(repositoryPath)),
          dependencies,
          new AbortController().signal,
          operations,
        ),
      ).rejects.toThrow("is not a valid Git repository");

      expect(operations.validateProjectTrello).not.toHaveBeenCalled();
      expect(operations.runOrchestrator).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
