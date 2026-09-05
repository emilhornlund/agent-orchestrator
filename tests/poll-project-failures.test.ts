import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
  type OpenCodeRunResult,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

interface ScenarioOptions {
  cards?: TrelloCard[];
  maxPasses?: number;
  setupCommand?: string;
  setupExitCodes?: number[];
  validationCommand?: string;
  statusOutputs?: string[];
  headOutputs?: string[];
  changedFilesOutputs?: string[];
  remoteBranchShaOutputs?: string[];
  openCodeResults?: TestOpenCodeRunResult[];
  writeRefinementResult?: boolean;
  refinementResult?: unknown;
  pushError?: Error;
  pushErrors?: Array<Error | undefined>;
  pullRequestError?: Error;
  pullRequestErrors?: Array<Error | undefined>;
  humanReviewError?: unknown;
  failureMoveError?: unknown;
}

type TestOpenCodeRunResult = Omit<OpenCodeRunResult, "errorOutput"> & {
  errorOutput?: string;
};

interface Scenario {
  card: TrelloCard;
  commands: CommandRunner;
  events: string[];
  git: GitClient;
  github: GitHubClient;
  openCode: OpenCodeClient;
  project: ProjectConfig;
  signal: AbortSignal;
  runCommand: ReturnType<typeof vi.fn<RunCommand>>;
  runGit: ReturnType<typeof vi.fn<RunGit>>;
  runGitHub: ReturnType<typeof vi.fn<RunGitHubCommand>>;
  runOpenCode: ReturnType<typeof vi.fn<RunOpenCode>>;
  trello: TrelloClient;
  worktreePath: string;
  cleanup: () => void;
}

function createScenario(options: ScenarioOptions = {}): Scenario {
  const worktreeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-"),
  );
  const card: TrelloCard = {
    id: "card-1",
    name: "Example task",
    desc: "Implement the example task",
    idList: "ready",
    idLabels: ["feature-label"],
    url: "https://trello.com/c/card-1",
  };
  const worktreePath = path.join(worktreeRoot, card.id);
  const events: string[] = [];
  const controller = new AbortController();

  fs.mkdirSync(worktreePath);

  const project: ProjectConfig = {
    id: "example",
    autoMerge: false,
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
    repository: {
      path: "/tmp/example-repository",
      github: "example/repository",
      defaultBranch: "main",
      worktreeRoot,
      ...(options.setupCommand === undefined
        ? {}
        : { setupCommand: options.setupCommand }),
      ...(options.validationCommand === undefined
        ? {}
        : { validationCommand: options.validationCommand }),
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
        maxPasses: options.maxPasses ?? 1,
      },
      commit: {
        model: "commit-model",
        variant: "commit-variant",
      },
      timeoutMinutes: 360,
    },
  };

  const trello = new TrelloClient({
    apiKey: "test-key",
    token: "test-token",
  });

  vi.spyOn(trello, "getCards").mockImplementation(async (listId) => {
    if (listId === project.trello.workingListId) {
      return [];
    }

    if (listId === project.trello.readyListId) {
      return options.cards ?? [card];
    }

    return [];
  });
  vi.spyOn(trello, "moveCard").mockImplementation(async (cardId, listId) => {
    events.push(`move:${listId}`);

    if (
      listId === project.trello.reviewListId &&
      options.humanReviewError !== undefined
    ) {
      throw options.humanReviewError;
    }

    if (
      listId === project.trello.failedListId &&
      options.failureMoveError !== undefined
    ) {
      throw options.failureMoveError;
    }

    return {
      ...card,
      id: cardId,
      idList: listId,
    };
  });
  vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

  const statusOutputs = options.statusOutputs ?? [" M src/example.ts", ""];
  let statusCall = 0;

  const headOutputs = options.headOutputs ?? ["before-commit", "after-commit"];
  let headCall = 0;
  const changedFilesOutputs = options.changedFilesOutputs ?? [];
  const remoteBranchShaOutputs = options.remoteBranchShaOutputs ?? [];

  const runGit = vi.fn<RunGit>(async (_cwd, args) => {
    if (args[0] === "branch" && args[1] === "--show-current") {
      return `agent/${card.id}`;
    }

    if (args[0] === "status") {
      if (statusCall === 0) {
        statusCall += 1;
        return "";
      }

      const output = statusOutputs[statusCall - 1];
      statusCall += 1;

      return output ?? "";
    }

    if (args[0] === "rev-parse") {
      const output = headOutputs[headCall];
      headCall += 1;

      return output ?? "";
    }

    if (args[0] === "diff") {
      return changedFilesOutputs.shift() ?? "";
    }

    if (args[0] === "ls-remote") {
      return remoteBranchShaOutputs.shift() ?? "";
    }

    if (args[0] === "push") {
      events.push("push");

      if (options.pushErrors !== undefined) {
        const pushError = options.pushErrors.shift();

        if (pushError !== undefined) {
          throw pushError;
        }
      } else if (options.pushError !== undefined) {
        throw options.pushError;
      }
    }

    return "";
  });

  const git = new GitClient(runGit);
  const openCodeResults: OpenCodeRunResult[] = (
    options.openCodeResults ?? [
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "REVIEW_PASS" },
      { exitCode: 0, output: "" },
    ]
  ).map((result) => ({
    ...result,
    errorOutput: result.errorOutput ?? "",
  }));
  let openCodeCall = 0;

  const runOpenCode = vi.fn<RunOpenCode>(async (runOptions) => {
    openCodeCall += 1;
    events.push(`opencode:${openCodeCall}`);

    if (options.writeRefinementResult === true) {
      const resultPath = getRefinementResultPath(runOptions.cwd);

      fs.mkdirSync(path.dirname(resultPath), {
        recursive: true,
      });

      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          options.refinementResult ?? {
            title: "Refined task",
            type: "feature",
            description: "# Refined task\n\n## Description\n\nRefined.",
          },
        ),
      );
    }

    const result = openCodeResults.shift();

    if (result === undefined) {
      throw new Error("Unexpected OpenCode call");
    }

    return result;
  });

  const openCode = new OpenCodeClient(runOpenCode);
  const setupExitCodes = options.setupExitCodes ?? [0];
  let setupCall = 0;

  const runCommand = vi.fn<RunCommand>(async ({ command }) => {
    if (
      project.repository.setupCommand !== undefined &&
      command === project.repository.setupCommand
    ) {
      events.push("setup");
      const exitCode = setupExitCodes[setupCall];
      setupCall += 1;

      return {
        exitCode: exitCode ?? 0,
      };
    }

    return {
      exitCode: 0,
    };
  });

  const commands = new CommandRunner(runCommand);
  const runGitHub = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return "";
    }

    events.push("pr");

    if (options.pullRequestErrors !== undefined) {
      const pullRequestError = options.pullRequestErrors.shift();

      if (pullRequestError !== undefined) {
        throw pullRequestError;
      }
    } else if (options.pullRequestError !== undefined) {
      throw options.pullRequestError;
    }

    return "https://github.com/example/repository/pull/123";
  });
  const github = new GitHubClient(runGitHub);

  return {
    card,
    commands,
    events,
    git,
    github,
    openCode,
    project,
    signal: controller.signal,
    runCommand,
    runGit,
    runGitHub,
    runOpenCode,
    trello,
    worktreePath,
    cleanup: () => {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    },
  };
}

async function withScenario(
  options: ScenarioOptions,
  test: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const scenario = createScenario(options);

  try {
    await test(scenario);
  } finally {
    scenario.cleanup();
  }
}

function expectNothingPublished(scenario: Scenario): void {
  expect(scenario.events).not.toContain("push");
  expect(scenario.events).not.toContain("pr");
  expect(scenario.events).not.toContain("move:review-list");
  expect(scenario.events).toContain("move:failed-list");
}

function createRefinementCard(scenario: Scenario): TrelloCard {
  return {
    ...scenario.card,
    idLabels: ["refinement-label"],
  };
}

describe("pollProject failure boundaries", () => {
  it("does not query or claim cards when already aborted", async () => {
    await withScenario({}, async (scenario) => {
      const controller = new AbortController();
      controller.abort();

      await pollProject(
        scenario.trello,
        scenario.git,
        scenario.github,
        scenario.openCode,
        scenario.commands,
        scenario.project,
        controller.signal,
      );

      expect(scenario.trello.getCards).not.toHaveBeenCalled();
      expect(scenario.trello.moveCard).not.toHaveBeenCalled();
    });
  });

  it("does not claim a Ready card when shutdown occurs during reconciliation", async () => {
    await withScenario({}, async (scenario) => {
      const controller = new AbortController();

      vi.mocked(scenario.trello.getCards).mockImplementationOnce(async () => {
        controller.abort();
        return [];
      });

      await pollProject(
        scenario.trello,
        scenario.git,
        scenario.github,
        scenario.openCode,
        scenario.commands,
        scenario.project,
        controller.signal,
      );

      expect(scenario.trello.getCards).toHaveBeenCalledTimes(1);
      expect(scenario.trello.moveCard).not.toHaveBeenCalled();
      expect(scenario.runOpenCode).not.toHaveBeenCalled();
    });
  });

  it("does nothing when no card is ready", async () => {
    await withScenario({ cards: [] }, async (scenario) => {
      const date = new Date().toISOString().slice(0, 10);
      const logPath = path.join(
        process.cwd(),
        "logs",
        `test-orchestrator-${date}.log`,
      );
      const countIdleEntries = (): number => {
        if (!fs.existsSync(logPath)) {
          return 0;
        }

        return fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.includes("[example] No cards ready")).length;
      };
      const initialIdleEntries = countIdleEntries();

      await pollProject(
        scenario.trello,
        scenario.git,
        scenario.github,
        scenario.openCode,
        scenario.commands,
        scenario.project,
        scenario.signal,
      );
      await pollProject(
        scenario.trello,
        scenario.git,
        scenario.github,
        scenario.openCode,
        scenario.commands,
        scenario.project,
        scenario.signal,
      );

      expect(scenario.runOpenCode).not.toHaveBeenCalled();
      expect(scenario.runGit).not.toHaveBeenCalled();
      expect(scenario.runGitHub).not.toHaveBeenCalled();
      expect(scenario.trello.moveCard).not.toHaveBeenCalled();
      expect(countIdleEntries()).toBe(initialIdleEntries);
    });
  });

  it("does not run repository validation through CommandRunner", async () => {
    await withScenario(
      { validationCommand: "yarn validate" },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runCommand).not.toHaveBeenCalled();
        expect(scenario.events).toEqual([
          "move:working-list",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review-list",
        ]);
      },
    );
  });

  it("runs setup in the card worktree before implementation", async () => {
    await withScenario(
      {
        setupCommand: "yarn install",
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runCommand).toHaveBeenNthCalledWith(1, {
          cwd: scenario.worktreePath,
          command: "yarn install",
          timeoutMilliseconds: 360 * 60_000,
          signal: scenario.signal,
          sessionLogPath: expect.stringMatching(
            /logs\/sessions\/example\/card-1\.log$/,
          ),
          sessionLabel: "Repository setup",
        });
        expect(scenario.events.indexOf("setup")).toBeLessThan(
          scenario.events.indexOf("opencode:1"),
        );
        expect(scenario.events).toEqual([
          "move:working-list",
          "setup",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review-list",
        ]);
      },
    );
  });

  it("moves the card to Failed and skips implementation when setup fails", async () => {
    await withScenario(
      {
        setupCommand: "yarn install",
        setupExitCodes: [1],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("Repository setup exited with code 1");

        expect(scenario.runCommand).toHaveBeenCalledTimes(1);
        expect(scenario.runOpenCode).not.toHaveBeenCalled();
        expectNothingPublished(scenario);
      },
    );
  });

  it("preserves structured setup failures in the failure comment", async () => {
    await withScenario({ setupCommand: "yarn install" }, async (scenario) => {
      const setupFailure = {
        code: "SETUP_FAILED",
        reason: "dependency installation failed",
      };

      scenario.runCommand.mockRejectedValueOnce(setupFailure);
      vi.spyOn(scenario.trello, "addComment").mockResolvedValue({
        id: "action-1",
        type: "commentCard",
        date: "2026-08-22T09:00:00.000Z",
      });

      await expect(
        pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        ),
      ).rejects.toThrow(JSON.stringify(setupFailure));

      expect(scenario.trello.addComment).toHaveBeenCalledWith(
        scenario.card.id,
        expect.stringContaining(`Reason: ${JSON.stringify(setupFailure)}`),
      );
    });
  });

  it("stops after an implementation failure", async () => {
    await withScenario(
      {
        openCodeResults: [{ exitCode: 1, output: "implementation failed" }],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode implementation exited with code 1");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(1);
        expectNothingPublished(scenario);
      },
    );
  });

  it("moves a refinement card to Failed when OpenCode refinement fails", async () => {
    await withScenario(
      {
        openCodeResults: [
          {
            exitCode: 1,
            output: "refinement failed",
          },
        ],
      },
      async (scenario) => {
        vi.mocked(scenario.trello.getCards).mockImplementation(
          async (listId) => {
            if (listId === scenario.project.trello.workingListId) {
              return [];
            }

            if (listId === scenario.project.trello.readyListId) {
              return [createRefinementCard(scenario)];
            }

            return [];
          },
        );

        const updateCardContent = vi.spyOn(
          scenario.trello,
          "updateCardContent",
        );
        const addLabel = vi.spyOn(scenario.trello, "addLabel");
        const removeLabel = vi.spyOn(scenario.trello, "removeLabel");

        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode refinement exited with code 1");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(1);

        expect(updateCardContent).not.toHaveBeenCalled();
        expect(addLabel).not.toHaveBeenCalled();
        expect(removeLabel).not.toHaveBeenCalled();

        expect(scenario.events).toContain("move:working-list");
        expect(scenario.events).toContain("move:failed-list");
        expect(scenario.events).not.toContain("move:backlog-list");

        expectNothingPublished(scenario);
      },
    );
  });

  it("moves a refinement card to Failed when the result artifact is missing", async () => {
    await withScenario(
      {
        openCodeResults: [
          {
            exitCode: 0,
            output: "refinement complete",
          },
        ],
        statusOutputs: [""],
      },
      async (scenario) => {
        vi.mocked(scenario.trello.getCards).mockImplementation(
          async (listId) => {
            if (listId === scenario.project.trello.workingListId) {
              return [];
            }

            if (listId === scenario.project.trello.readyListId) {
              return [createRefinementCard(scenario)];
            }

            return [];
          },
        );

        const updateCardContent = vi.spyOn(
          scenario.trello,
          "updateCardContent",
        );

        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("Refinement result file not found");

        expect(updateCardContent).not.toHaveBeenCalled();

        expect(scenario.events).toContain("move:failed-list");
        expect(scenario.events).not.toContain("move:backlog-list");

        expectNothingPublished(scenario);
      },
    );
  });

  it("moves a refinement card to Failed when the result artifact is invalid", async () => {
    await withScenario(
      {
        writeRefinementResult: true,
        refinementResult: {
          title: "Refined task",
          type: "unsupported",
          description: "Description",
        },
        openCodeResults: [
          {
            exitCode: 0,
            output: "refinement complete",
          },
        ],
        statusOutputs: ["?? .agent-orchestrator/refinement-result.json"],
      },
      async (scenario) => {
        vi.mocked(scenario.trello.getCards).mockImplementation(
          async (listId) => {
            if (listId === scenario.project.trello.workingListId) {
              return [];
            }

            if (listId === scenario.project.trello.readyListId) {
              return [createRefinementCard(scenario)];
            }

            return [];
          },
        );

        const updateCardContent = vi.spyOn(
          scenario.trello,
          "updateCardContent",
        );

        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("Invalid refinement result");

        expect(updateCardContent).not.toHaveBeenCalled();

        expect(scenario.events).toContain("move:failed-list");
        expect(scenario.events).not.toContain("move:backlog-list");

        expectNothingPublished(scenario);
      },
    );
  });

  it("moves a refinement card to Failed when refinement modifies repository files", async () => {
    await withScenario(
      {
        writeRefinementResult: true,
        openCodeResults: [
          {
            exitCode: 0,
            output: "refinement complete",
          },
        ],
        statusOutputs: [
          [
            "?? .agent-orchestrator/refinement-result.json",
            " M src/example.ts",
          ].join("\n"),
        ],
      },
      async (scenario) => {
        vi.mocked(scenario.trello.getCards).mockImplementation(
          async (listId) => {
            if (listId === scenario.project.trello.workingListId) {
              return [];
            }

            if (listId === scenario.project.trello.readyListId) {
              return [createRefinementCard(scenario)];
            }

            return [];
          },
        );

        const updateCardContent = vi.spyOn(
          scenario.trello,
          "updateCardContent",
        );

        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode refinement modified repository files");

        expect(updateCardContent).not.toHaveBeenCalled();

        expect(scenario.events).toContain("move:failed-list");
        expect(scenario.events).not.toContain("move:backlog-list");

        expectNothingPublished(scenario);
      },
    );
  });

  it("resets forbidden refinement changes before moving the card to Failed", async () => {
    await withScenario(
      {
        writeRefinementResult: true,
        openCodeResults: [
          {
            exitCode: 0,
            output: "refinement complete",
          },
        ],
        statusOutputs: [
          [
            "?? .agent-orchestrator/refinement-result.json",
            " M src/example.ts",
          ].join("\n"),
        ],
      },
      async (scenario) => {
        vi.mocked(scenario.trello.getCards).mockImplementation(
          async (listId) => {
            if (listId === scenario.project.trello.workingListId) {
              return [];
            }

            if (listId === scenario.project.trello.readyListId) {
              return [createRefinementCard(scenario)];
            }

            return [];
          },
        );

        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode refinement modified repository files");

        expect(scenario.runGit).toHaveBeenCalledWith(scenario.worktreePath, [
          "reset",
          "--hard",
          "HEAD",
        ]);

        expect(scenario.runGit).toHaveBeenCalledWith(scenario.worktreePath, [
          "clean",
          "-fd",
        ]);

        expect(scenario.events).toContain("move:failed-list");
        expect(scenario.events).not.toContain("move:backlog-list");
      },
    );
  });

  it("reports OpenCode permission denial during implementation", async () => {
    await withScenario(
      {
        statusOutputs: [""],
        openCodeResults: [
          {
            exitCode: 1,
            output: "",
            errorOutput:
              "permission requested: external_directory (/tmp/worktree/*); auto-rejecting",
          },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow(
          "OpenCode was denied permission during implementation",
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(1);
        expectNothingPublished(scenario);
      },
    );
  });

  it("stops when implementation produces no repository changes", async () => {
    await withScenario(
      {
        statusOutputs: [""],
        openCodeResults: [{ exitCode: 0, output: "" }],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode completed without repository changes");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(1);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not remediate or publish when the first review process fails", async () => {
    await withScenario(
      {
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 2, output: "review failed to start" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode review exited with code 2");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(2);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not continue after remediation fails", async () => {
    await withScenario(
      {
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 1, output: "remediation failed" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode remediation exited with code 1");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("stops when remediation leaves no repository changes", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", ""],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode remediation left no repository changes");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("publishes after a passing intermediate review without another remediation", async () => {
    await withScenario(
      {
        maxPasses: 2,
        statusOutputs: [" M src/example.ts", " M src/example.ts", ""],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          {
            exitCode: 0,
            output: "Review finding\nREVIEW_FAIL",
          },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(5);
        expect(
          scenario.runOpenCode.mock.calls.map(([run]) => run.sessionLabel),
        ).toEqual([
          "OpenCode implementation",
          "OpenCode review",
          "OpenCode remediation",
          "OpenCode review",
          "OpenCode commit",
        ]);

        const remediationPrompt =
          scenario.runOpenCode.mock.calls[2]?.[0].prompt ?? "";

        expect(remediationPrompt).toContain("Review finding");

        expect(scenario.trello.moveCard).toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.reviewListId,
        );
        expect(scenario.trello.moveCard).not.toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.failedListId,
        );
        expect(scenario.events).toContain("push");
        expect(scenario.events).toContain("pr");
      },
    );
  });

  it("uses the default single remediation pass without a final review", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", " M src/example.ts", ""],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          {
            exitCode: 0,
            output: "Potential blocking issue\nREVIEW_FAIL",
          },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(4);
        expect(
          scenario.runOpenCode.mock.calls.map(([run]) => run.sessionLabel),
        ).toEqual([
          "OpenCode implementation",
          "OpenCode review",
          "OpenCode remediation",
          "OpenCode commit",
        ]);

        expect(scenario.trello.moveCard).toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.reviewListId,
        );

        expect(scenario.trello.moveCard).not.toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.failedListId,
        );
        expect(scenario.events).toContain("push");
        expect(scenario.events).toContain("pr");
      },
    );
  });

  it("runs the initial review but no remediation or follow-up review at zero", async () => {
    await withScenario(
      {
        maxPasses: 0,
        statusOutputs: [" M src/example.ts", ""],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expect(
          scenario.runOpenCode.mock.calls.map(([run]) => run.sessionLabel),
        ).toEqual([
          "OpenCode implementation",
          "OpenCode review",
          "OpenCode commit",
        ]);
        expect(scenario.events).toContain("push");
        expect(scenario.events).toContain("pr");
        expect(scenario.events).toContain("move:review-list");
        expect(scenario.events).not.toContain("move:failed-list");
      },
    );
  });

  it("runs exactly the configured remediation passes with reviews only between them", async () => {
    await withScenario(
      {
        maxPasses: 2,
        statusOutputs: [
          " M src/example.ts",
          " M src/example.ts",
          " M src/example.ts",
          "",
        ],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
        ],
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(6);
        expect(
          scenario.runOpenCode.mock.calls.map(([run]) => run.sessionLabel),
        ).toEqual([
          "OpenCode implementation",
          "OpenCode review",
          "OpenCode remediation",
          "OpenCode review",
          "OpenCode remediation",
          "OpenCode commit",
        ]);
        expect(scenario.events).not.toContain("move:failed-list");
        expect(scenario.events).toContain("move:review-list");
        expect(scenario.events).toContain("push");
        expect(scenario.events).toContain("pr");
      },
    );
  });

  it("logs the current remediation pass and configured limit", async () => {
    await withScenario(
      {
        maxPasses: 3,
        statusOutputs: [" M src/example.ts", " M src/example.ts", ""],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        const date = new Date().toISOString().slice(0, 10);
        const logPath = path.join(
          process.cwd(),
          "logs",
          `test-orchestrator-${date}.log`,
        );

        expect(fs.readFileSync(logPath, "utf8")).toContain(
          "Starting remediation pass 1 of 3",
        );
      },
    );
  });

  it("does not publish when an intermediate review process fails", async () => {
    await withScenario(
      {
        maxPasses: 2,
        statusOutputs: [" M src/example.ts", " M src/example.ts"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 2, output: "follow-up review failed" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode review exited with code 2");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(4);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not publish when the commit session fails", async () => {
    await withScenario(
      {
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 1, output: "commit failed" },
        ],
        headOutputs: ["before-commit"],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode commit exited with code 1");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not publish when the commit session does not change HEAD", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", ""],
        headOutputs: ["same-commit", "same-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode commit session did not create a commit");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not publish when the commit session leaves changes", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", " M src/example.ts"],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 0, output: "" },
        ],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode commit left repository changes");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not create a PR or move the card when push fails", async () => {
    await withScenario(
      {
        pushError: new Error("push failed"),
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("push failed");

        expect(scenario.events).toContain("push");
        expect(scenario.runGitHub).toHaveBeenCalledTimes(1);
        expect(scenario.runGitHub).toHaveBeenCalledWith(
          "/tmp/example-repository",
          [
            "pr",
            "list",
            "--repo",
            "example/repository",
            "--head",
            "agent/card-1",
            "--state",
            "open",
            "--json",
            "url",
            "--limit",
            "1",
            "--jq",
            '.[0].url // ""',
          ],
        );
        expect(scenario.events).not.toContain("move:review-list");
        expect(scenario.events).toContain("move:failed-list");
      },
    );
  });

  it("reuses a committed implementation after a push failure", async () => {
    await withScenario(
      {
        changedFilesOutputs: ["", "src/example.ts"],
        headOutputs: [
          "before-commit",
          "after-commit",
          "after-commit",
          "after-commit",
          "after-commit",
        ],
        remoteBranchShaOutputs: ["", ""],
        pushErrors: [new Error("push failed"), undefined],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("push failed");

        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expect(scenario.events).toEqual([
          "move:working-list",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "move:failed-list",
          "move:working-list",
          "push",
          "pr",
          "move:review-list",
        ]);
        expect(scenario.trello.moveCard).toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.reviewListId,
        );
      },
    );
  });

  it("does not move the card when PR creation fails", async () => {
    await withScenario(
      {
        pullRequestError: new Error("PR creation failed"),
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("PR creation failed");

        expect(scenario.events).toContain("push");
        expect(scenario.runGitHub).toHaveBeenCalledTimes(3);
        expect(scenario.events).not.toContain("move:review-list");
        expect(scenario.events).toContain("move:failed-list");
      },
    );
  });

  it("retries PR creation after a successful push without duplicating implementation", async () => {
    await withScenario(
      {
        changedFilesOutputs: ["", "src/example.ts"],
        headOutputs: [
          "before-commit",
          "after-commit",
          "after-commit",
          "after-commit",
          "after-commit",
        ],
        remoteBranchShaOutputs: ["", "after-commit\trefs/heads/agent/card-1"],
        pullRequestErrors: [new Error("PR creation failed"), undefined],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("PR creation failed");

        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expect(scenario.events).toEqual([
          "move:working-list",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:failed-list",
          "move:working-list",
          "pr",
          "move:review-list",
        ]);
        expect(scenario.trello.moveCard).toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.reviewListId,
        );
      },
    );
  });

  it("restarts implementation for an incomplete dirty retry state", async () => {
    await withScenario(
      {
        changedFilesOutputs: ["", ""],
        headOutputs: ["before-commit", "after-commit"],
        openCodeResults: [
          { exitCode: 1, output: "implementation interrupted" },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_PASS" },
          { exitCode: 0, output: "" },
        ],
        statusOutputs: [" M src/example.ts", " M src/example.ts", ""],
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).rejects.toThrow("OpenCode implementation exited with code 1");

        await pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          scenario.signal,
        );

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(4);
        expect(scenario.runOpenCode.mock.calls[1]?.[0].model).toBe(
          "implementation-model",
        );
        expect(scenario.trello.moveCard).toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.reviewListId,
        );
      },
    );
  });

  it("leaves a published card in Working when moving to Human Review fails", async () => {
    await withScenario(
      {
        humanReviewError: new Error("Human Review move failed"),
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).resolves.toBeUndefined();

        expect(scenario.events).toEqual([
          "move:working-list",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review-list",
        ]);

        expect(scenario.trello.moveCard).not.toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.failedListId,
        );
      },
    );
  });

  it("logs the cause when a published card cannot move to Human Review", async () => {
    await withScenario(
      {
        humanReviewError: {
          code: "TRELLO_UNAUTHORIZED",
          reason: "token expired",
        },
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).resolves.toBeUndefined();

        const date = new Date().toISOString().slice(0, 10);
        const logPath = path.join(
          process.cwd(),
          "logs",
          `test-orchestrator-${date}.log`,
        );

        expect(fs.readFileSync(logPath, "utf8")).toContain(
          `[example] [card:card-1] Task failed. Category: Workflow; Reason: Pull request https://github.com/example/repository/pull/123 was published, but the Trello card could not be moved to Human Review; Cause: {"code":"TRELLO_UNAUTHORIZED","reason":"token expired"}; Failure handling: card left in Working for reconciliation`,
        );
      },
    );
  });

  it("does not attempt a Failed transition after publication succeeds", async () => {
    await withScenario(
      {
        humanReviewError: new Error("Human Review move failed"),
        failureMoveError: new Error("Failed move should not be attempted"),
      },
      async (scenario) => {
        await expect(
          pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          ),
        ).resolves.toBeUndefined();

        expect(scenario.events).toEqual([
          "move:working-list",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review-list",
        ]);

        expect(scenario.trello.moveCard).not.toHaveBeenCalledWith(
          scenario.card.id,
          scenario.project.trello.failedListId,
        );
      },
    );
  });

  it("leaves the card in Working when the workflow is aborted", async () => {
    await withScenario({}, async (scenario) => {
      const controller = new AbortController();

      scenario.runOpenCode.mockImplementationOnce(async () => {
        controller.abort();
        throw new OpenCodeRunAbortedError();
      });

      await pollProject(
        scenario.trello,
        scenario.git,
        scenario.github,
        scenario.openCode,
        scenario.commands,
        scenario.project,
        controller.signal,
      );

      expect(scenario.trello.moveCard).not.toHaveBeenCalledWith(
        scenario.card.id,
        scenario.project.trello.failedListId,
      );
    });
  });

  it("moves the card to Failed when a real workflow error happens while shutdown is also requested", async () => {
    await withScenario({}, async (scenario) => {
      const controller = new AbortController();

      scenario.runOpenCode.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("real implementation failure");
      });

      await expect(
        pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          controller.signal,
        ),
      ).rejects.toThrow("real implementation failure");

      expect(scenario.trello.moveCard).toHaveBeenCalledWith(
        scenario.card.id,
        scenario.project.trello.failedListId,
      );
    });
  });

  it("moves the card to Failed when OpenCode times out even if shutdown is also requested", async () => {
    await withScenario({}, async (scenario) => {
      const controller = new AbortController();

      scenario.runOpenCode.mockImplementationOnce(async () => {
        controller.abort();
        throw new OpenCodeTimeoutError(21_600_000);
      });

      await expect(
        pollProject(
          scenario.trello,
          scenario.git,
          scenario.github,
          scenario.openCode,
          scenario.commands,
          scenario.project,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(OpenCodeTimeoutError);

      expect(scenario.trello.moveCard).toHaveBeenCalledWith(
        scenario.card.id,
        scenario.project.trello.failedListId,
      );
    });
  });
});
