import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient, GitRebaseState } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunResult,
} from "../src/opencode/opencode-client.js";
import { buildConflictRemediationPrompt } from "../src/opencode/build-conflict-remediation-prompt.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  getPreparedConflictPath,
  readPreparedConflict,
  writePreparedConflict,
  type PreparedConflictHandoff,
} from "../src/orchestrator/prepared-conflict-state.js";
import { remediatePreparedConflict } from "../src/orchestrator/remediate-prepared-conflict.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const taskSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const changedSha = "c".repeat(40);
const temporaryDirectories: string[] = [];

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "project",
    autoMerge: false,
    repository: {
      path: "/configured/source",
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot,
      validationCommand: "yarn validate",
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent@example.com",
      },
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
      refinement: { model: "refinement", variant: "variant" },
      implementation: { model: "implementation", variant: "variant" },
      review: { model: "review", variant: "variant" },
      remediation: {
        model: "remediation-model",
        variant: "xhigh",
        maxPasses: 1,
      },
      commit: { model: "commit", variant: "variant" },
      timeoutMinutes: 5,
    },
  };
}

function createCard(): TrelloCard {
  return {
    id: "card-1",
    name: "Preserve player movement",
    desc: "Keep movement speed compatible with the new physics base.",
    idList: "review",
    idLabels: [],
    url: "https://trello.example/card-1",
  };
}

function createHandoff(project: ProjectConfig): PreparedConflictHandoff {
  return writePreparedConflict(
    project,
    "card-1",
    taskSha,
    ["src/player.ts", "src/physics.ts"],
    {
      active: true,
      backend: "merge",
      headName: "refs/heads/agent/card-1",
      onto: baseSha,
      originalHead: taskSha,
      currentStep: 2,
      totalSteps: 4,
    },
  );
}

interface ScenarioOptions {
  rebaseStates?: Array<GitRebaseState | null>;
  conflictedPaths?: string[];
  status?: string;
  headSha?: string;
  rebaseTargetIsAncestor?: boolean;
  remoteSha?: string | null;
  pushError?: Error;
  validationExitCode?: number;
  openCodeResult?: Partial<OpenCodeRunResult>;
}

function createScenario(options: ScenarioOptions = {}) {
  const worktreeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-conflict-remediation-"),
  );
  temporaryDirectories.push(worktreeRoot);
  const project = createProject(worktreeRoot);
  const card = createCard();
  const worktreePath = path.join(worktreeRoot, card.id);
  fs.mkdirSync(worktreePath);
  const handoff = createHandoff(project);
  const activeRebase = handoff.rebase;
  const rebaseStates = [activeRebase, ...(options.rebaseStates ?? [null])];
  const runOpenCode = vi.fn().mockResolvedValue({
    exitCode: 0,
    output: "",
    errorOutput: "",
    ...options.openCodeResult,
  });
  const runCommand = vi.fn<RunCommand>().mockResolvedValue({
    exitCode: options.validationExitCode ?? 0,
  });
  const pushWithLease = vi.fn();

  if (options.pushError === undefined) {
    pushWithLease.mockResolvedValue(undefined);
  } else {
    pushWithLease.mockRejectedValue(options.pushError);
  }

  const git = {
    getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
    isValidRepository: vi.fn().mockResolvedValue(true),
    getRebaseState: vi
      .fn()
      .mockImplementation(async () => rebaseStates.shift() ?? null),
    getConflictedPaths: vi
      .fn()
      .mockResolvedValue(options.conflictedPaths ?? []),
    getHeadSha: vi.fn().mockResolvedValue(options.headSha ?? changedSha),
    isAncestor: vi
      .fn()
      .mockResolvedValue(options.rebaseTargetIsAncestor ?? true),
    getStatus: vi.fn().mockResolvedValue(options.status ?? ""),
    getRemoteBranchSha: vi
      .fn()
      .mockResolvedValue(
        options.remoteSha === undefined ? taskSha : options.remoteSha,
      ),
    pushWithLease,
  } as unknown as GitClient;

  return {
    card,
    commands: new CommandRunner(runCommand),
    git,
    handoff,
    opencode: new OpenCodeClient(runOpenCode),
    project,
    runCommand,
    runOpenCode,
    worktreePath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildConflictRemediationPrompt", () => {
  it("focuses OpenCode on the original task and every rebase stop", () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-conflict-prompt-"),
    );
    temporaryDirectories.push(worktreeRoot);
    const project = createProject(worktreeRoot);
    const handoff = {
      ...createHandoff(project),
      conflictedPaths: ["src/player.ts"],
    };

    const prompt = buildConflictRemediationPrompt(
      createCard(),
      handoff,
      "yarn validate",
    );

    expect(prompt).toContain("Task: Preserve player movement");
    expect(prompt).toContain("Keep movement speed compatible");
    expect(prompt).toContain("Current task branch: agent/card-1");
    expect(prompt).toContain("Rebase target commit: ");
    expect(prompt).toContain("- src/player.ts");
    expect(prompt).toContain("a rebase is currently in progress");
    expect(prompt).toContain("more than once");
    expect(prompt).toContain("`yarn validate`");
  });
});

describe("remediatePreparedConflict", () => {
  it("completes, validates, publishes with the captured lease, and clears the handoff", async () => {
    const scenario = createScenario();

    await remediatePreparedConflict({
      ...scenario,
      signal: new AbortController().signal,
    });

    expect(scenario.runOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: scenario.worktreePath,
        model: "remediation-model",
        variant: "xhigh",
        sessionLabel: "OpenCode conflict remediation",
      }),
    );
    expect(scenario.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: scenario.worktreePath,
        command: "yarn validate",
      }),
    );
    expect(scenario.git.pushWithLease).toHaveBeenCalledWith(
      scenario.worktreePath,
      "origin",
      "agent/card-1",
      taskSha,
      scenario.project,
    );
    expect(readPreparedConflict(scenario.project, scenario.card.id)).toBeNull();
  });

  it("preserves the handoff when a later rebase stop remains active", async () => {
    const scenario = createScenario({
      rebaseStates: [
        {
          active: true,
          backend: "merge",
          headName: "refs/heads/agent/card-1",
          onto: baseSha,
          originalHead: taskSha,
          currentStep: 3,
          totalSteps: 4,
        },
      ],
    });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("still active");

    expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
    expect(
      readPreparedConflict(scenario.project, scenario.card.id),
    ).not.toBeNull();
    expect(
      fs.existsSync(
        getPreparedConflictPath(scenario.project, scenario.card.id),
      ),
    ).toBe(true);
  });

  it("does not clear or publish when OpenCode aborts the prepared rebase", async () => {
    const scenario = createScenario({ headSha: taskSha });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("may have been aborted");

    expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
    expect(
      readPreparedConflict(scenario.project, scenario.card.id),
    ).not.toBeNull();
  });

  it("does not publish a clean branch that does not contain the rebase target", async () => {
    const scenario = createScenario({ rebaseTargetIsAncestor: false });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not contain rebase target");

    expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
    expect(
      readPreparedConflict(scenario.project, scenario.card.id),
    ).not.toBeNull();
  });

  it("does not publish after validation failure", async () => {
    const scenario = createScenario({ validationExitCode: 1 });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("repository validation");

    expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
    expect(
      readPreparedConflict(scenario.project, scenario.card.id),
    ).not.toBeNull();
  });

  it("does not publish when the agent exits successfully with unresolved paths", async () => {
    const scenario = createScenario({ conflictedPaths: ["src/player.ts"] });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unmerged paths remain");

    expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["changed", changedSha],
    ["malformed", "not-a-sha"],
  ] as const)(
    "preserves state when the authoritative remote SHA is %s",
    async (_label, remoteSha) => {
      const scenario = createScenario({ remoteSha });

      await expect(
        remediatePreparedConflict({
          ...scenario,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("authoritative remote SHA verification");

      expect(scenario.git.pushWithLease).not.toHaveBeenCalled();
      expect(
        readPreparedConflict(scenario.project, scenario.card.id),
      ).not.toBeNull();
    },
  );

  it("preserves state after a rejected force-with-lease update", async () => {
    const scenario = createScenario({
      pushError: new Error("stale info"),
    });

    await expect(
      remediatePreparedConflict({
        ...scenario,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("prepared rebase conflict");

    expect(scenario.git.pushWithLease).toHaveBeenCalledTimes(1);
    expect(
      readPreparedConflict(scenario.project, scenario.card.id),
    ).not.toBeNull();
  });
});
