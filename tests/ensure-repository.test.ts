import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { ensureRepository } from "../src/git/ensure-repository.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-"),
  );

  temporaryDirectories.push(directory);

  return directory;
}

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

function createGit(runGit: RunGit): GitClient {
  return new GitClient(runGit);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ensureRepository", () => {
  it("clones a missing repository", async () => {
    const root = createTemporaryDirectory();
    const repositoryPath = path.join(root, "repository");
    const project = createProject(repositoryPath);
    const runGit = vi.fn<RunGit>().mockResolvedValue("true");
    const runCommand = vi
      .fn<RunCommand>()
      .mockImplementation(async (options) => {
        expect(options).toEqual({
          cwd: process.cwd(),
          command: `gh repo clone owner/repository ${repositoryPath}`,
        });

        fs.mkdirSync(repositoryPath);

        return { exitCode: 0 };
      });

    await ensureRepository(
      createGit(runGit),
      new CommandRunner(runCommand),
      project,
    );

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith(repositoryPath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
  });

  it("leaves an existing Git repository untouched", async () => {
    const root = createTemporaryDirectory();
    const repositoryPath = path.join(root, "repository");
    const markerPath = path.join(repositoryPath, "marker");
    fs.mkdirSync(repositoryPath);
    fs.writeFileSync(markerPath, "preserve me");

    const runGit = vi.fn<RunGit>().mockResolvedValue("true");
    const runCommand = vi.fn<RunCommand>();

    await ensureRepository(
      createGit(runGit),
      new CommandRunner(runCommand),
      createProject(repositoryPath),
    );

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve me");
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("fails for an existing non-Git directory", async () => {
    const root = createTemporaryDirectory();
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);

    const runGit = vi
      .fn<RunGit>()
      .mockRejectedValue(new Error("fatal: not a git repository"));
    const runCommand = vi.fn<RunCommand>();

    await expect(
      ensureRepository(
        createGit(runGit),
        new CommandRunner(runCommand),
        createProject(repositoryPath),
      ),
    ).rejects.toThrow(
      `Project "test-project" repository path "${repositoryPath}" exists but is not a valid Git repository`,
    );

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails when cloning fails", async () => {
    const root = createTemporaryDirectory();
    const repositoryPath = path.join(root, "repository");
    const runGit = vi.fn<RunGit>();
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 1 });

    await expect(
      ensureRepository(
        createGit(runGit),
        new CommandRunner(runCommand),
        createProject(repositoryPath),
      ),
    ).rejects.toThrow(
      `Failed to clone repository "owner/repository" into "${repositoryPath}": gh repo clone exited with code 1`,
    );

    expect(runGit).not.toHaveBeenCalled();
  });

  it("fails when the cloned destination is not a valid Git repository", async () => {
    const root = createTemporaryDirectory();
    const repositoryPath = path.join(root, "repository");
    const runGit = vi.fn<RunGit>().mockResolvedValue("false");
    const runCommand = vi.fn<RunCommand>().mockImplementation(async () => {
      fs.mkdirSync(repositoryPath);
      return { exitCode: 0 };
    });

    await expect(
      ensureRepository(
        createGit(runGit),
        new CommandRunner(runCommand),
        createProject(repositoryPath),
      ),
    ).rejects.toThrow(
      `Repository clone completed, but project "test-project" destination "${repositoryPath}" is not a valid Git repository`,
    );

    expect(runGit).toHaveBeenCalledWith(repositoryPath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
  });
});
