import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../src/opencode/opencode-client.js";
import {
  getRefinementResultPath,
  refinementResultRelativePath,
} from "../src/refinement/refinement-result.js";
import { runRefinement } from "../src/refinement/run-refinement.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const temporaryDirectories: string[] = [];

function createWorktree(): string {
  const worktreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-refinement-run-"),
  );

  temporaryDirectories.push(worktreePath);

  return worktreePath;
}

function createProject(): ProjectConfig {
  return {
    id: "project",
    autoMerge: false,
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
      path: "/tmp/repository",
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot: "/tmp/worktrees",
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
        model: "openai/implementation-model",
        variant: "xhigh",
      },
      review: {
        model: "openai/review-model",
        variant: "high",
      },
      remediation: {
        model: "openai/remediation-model",
        variant: "xhigh",
      },
      commit: {
        model: "openai/commit-model",
        variant: "low",
      },
      timeoutMinutes: 360,
    },
  };
}

function createCard(): TrelloCard {
  return {
    id: "card-123",
    name: "Inventory thing",
    desc: "Players need inventory support.",
    idList: "working",
    idLabels: ["refinement"],
    url: "https://trello.example/card-123",
  };
}

function writeResult(worktreePath: string): void {
  const resultPath = getRefinementResultPath(worktreePath);

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });

  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      title: "Add inventory support",
      type: "feature",
      description:
        "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

describe("runRefinement", () => {
  it("runs the configured refinement model and returns the validated result", async () => {
    const worktreePath = createWorktree();

    const runOpenCode = vi.fn(
      async (options: OpenCodeRunOptions): Promise<OpenCodeRunResult> => {
        writeResult(options.cwd);

        return {
          exitCode: 0,
          output: "done",
          errorOutput: "",
        };
      },
    );

    const git = new GitClient(async (_cwd, args) => {
      if (args[0] === "status") {
        return `?? ${refinementResultRelativePath}`;
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const opencode = new OpenCodeClient(runOpenCode);

    const result = await runRefinement(
      git,
      opencode,
      createProject(),
      createCard(),
      worktreePath,
      new AbortController().signal,
    );

    expect(result).toEqual({
      title: "Add inventory support",
      type: "feature",
      description:
        "# Add inventory support\n\n## Description\n\nAdd inventory support.",
    });

    expect(runOpenCode).toHaveBeenCalledOnce();

    expect(runOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: worktreePath,
        model: "openai/refinement-model",
        variant: "xhigh",
        timeoutMilliseconds: 360 * 60_000,
        sessionLabel: "OpenCode refinement",
      }),
    );
  });

  it("clears a stale result before starting OpenCode", async () => {
    const worktreePath = createWorktree();
    const resultPath = getRefinementResultPath(worktreePath);

    writeResult(worktreePath);

    const runOpenCode = vi.fn(async (): Promise<OpenCodeRunResult> => {
      expect(fs.existsSync(resultPath)).toBe(false);

      return {
        exitCode: 0,
        output: "",
        errorOutput: "",
      };
    });

    const git = new GitClient(async (_cwd, args) => {
      if (args[0] === "status") {
        return "";
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const opencode = new OpenCodeClient(runOpenCode);

    await expect(
      runRefinement(
        git,
        opencode,
        createProject(),
        createCard(),
        worktreePath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Refinement result file not found");
  });

  it("rejects a non-zero OpenCode exit code", async () => {
    const worktreePath = createWorktree();

    const opencode = new OpenCodeClient(async () => ({
      exitCode: 7,
      output: "",
      errorOutput: "failed",
    }));

    const git = new GitClient(async () => {
      throw new Error("Git should not be called");
    });

    await expect(
      runRefinement(
        git,
        opencode,
        createProject(),
        createCard(),
        worktreePath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("OpenCode refinement exited with code 7");
  });

  it("reports OpenCode permission denials separately", async () => {
    const worktreePath = createWorktree();

    const opencode = new OpenCodeClient(async () => ({
      exitCode: 1,
      output: "",
      errorOutput: "Permission denied",
    }));

    const git = new GitClient(async () => {
      throw new Error("Git should not be called");
    });

    await expect(
      runRefinement(
        git,
        opencode,
        createProject(),
        createCard(),
        worktreePath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("OpenCode was denied permission during refinement");
  });

  it("rejects repository changes outside the result artifact", async () => {
    const worktreePath = createWorktree();

    const opencode = new OpenCodeClient(async (options) => {
      writeResult(options.cwd);

      return {
        exitCode: 0,
        output: "",
        errorOutput: "",
      };
    });

    const git = new GitClient(async (_cwd, args) => {
      if (args[0] === "status") {
        return [`?? ${refinementResultRelativePath}`, " M src/example.ts"].join(
          "\n",
        );
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      runRefinement(
        git,
        opencode,
        createProject(),
        createCard(),
        worktreePath,
        new AbortController().signal,
      ),
    ).rejects.toThrow("OpenCode refinement modified repository files");
  });

  it("accepts only the refinement result as an untracked change", async () => {
    const worktreePath = createWorktree();

    const opencode = new OpenCodeClient(async (options) => {
      writeResult(options.cwd);

      return {
        exitCode: 0,
        output: "",
        errorOutput: "",
      };
    });

    const git = new GitClient(async (_cwd, args) => {
      if (args[0] === "status") {
        return `?? ${refinementResultRelativePath}`;
      }

      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      runRefinement(
        git,
        opencode,
        createProject(),
        createCard(),
        worktreePath,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      type: "feature",
    });
  });
});
