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
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

interface ScenarioOptions {
  cards?: TrelloCard[];
  validationCommand?: string;
  validationExitCodes?: number[];
  statusOutputs?: string[];
  headOutputs?: string[];
  openCodeResults?: OpenCodeRunResult[];
  pushError?: Error;
  pullRequestError?: Error;
  humanReviewError?: Error;
  failureMoveError?: Error;
}

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
    url: "https://trello.com/c/card-1",
  };
  const worktreePath = path.join(worktreeRoot, card.id);
  const events: string[] = [];
  const controller = new AbortController();

  fs.mkdirSync(worktreePath);

  const project: ProjectConfig = {
    id: "example",
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
    },
    repository: {
      path: "/tmp/example-repository",
      github: "example/repository",
      defaultBranch: "main",
      worktreeRoot,
      ...(options.validationCommand === undefined
        ? {}
        : { validationCommand: options.validationCommand }),
    },
    opencode: {
      model: "test-model",
      variant: "test-variant",
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

  const statusOutputs = options.statusOutputs ?? [" M src/example.ts", ""];
  let statusCall = 0;

  const headOutputs = options.headOutputs ?? ["before-commit", "after-commit"];
  let headCall = 0;

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

    if (args[0] === "push") {
      events.push("push");

      if (options.pushError !== undefined) {
        throw options.pushError;
      }
    }

    return "";
  });

  const git = new GitClient(runGit);
  const openCodeResults = [
    ...(options.openCodeResults ?? [
      { exitCode: 0, output: "" },
      { exitCode: 0, output: "REVIEW_PASS" },
      { exitCode: 0, output: "" },
    ]),
  ];
  let openCodeCall = 0;

  const runOpenCode = vi.fn<RunOpenCode>(async () => {
    openCodeCall += 1;
    events.push(`opencode:${openCodeCall}`);

    const result = openCodeResults.shift();

    if (result === undefined) {
      throw new Error("Unexpected OpenCode call");
    }

    return result;
  });

  const openCode = new OpenCodeClient(runOpenCode);
  const validationExitCodes = options.validationExitCodes ?? [0, 0];
  let validationCall = 0;

  const runCommand = vi.fn<RunCommand>(async () => {
    events.push("validation");
    const exitCode = validationExitCodes[validationCall];
    validationCall += 1;

    return {
      exitCode: exitCode ?? 0,
    };
  });

  const commands = new CommandRunner(runCommand);
  const runGitHub = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return "";
    }

    events.push("pr");

    if (options.pullRequestError !== undefined) {
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
  expect(scenario.events).not.toContain("move:review");
  expect(scenario.events).toContain("move:failed");
}

describe("pollProject failure boundaries", () => {
  it("does nothing when no card is ready", async () => {
    await withScenario({ cards: [] }, async (scenario) => {
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

  it("does not review or publish when repository validation fails", async () => {
    await withScenario(
      {
        validationCommand: "yarn validate",
        validationExitCodes: [1],
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
        ).rejects.toThrow("Repository validation exited with code 1");

        expect(scenario.runCommand).toHaveBeenCalledWith({
          cwd: scenario.worktreePath,
          command: "yarn validate",
        });
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

  it("does not second-review when validation after remediation fails", async () => {
    await withScenario(
      {
        validationCommand: "yarn validate",
        validationExitCodes: [0, 1],
        statusOutputs: [" M src/example.ts", " M src/example.ts"],
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
        ).rejects.toThrow(
          "Repository validation after remediation exited with code 1",
        );

        expect(scenario.runCommand).toHaveBeenCalledTimes(2);
        expect(scenario.runOpenCode).toHaveBeenCalledTimes(3);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not commit or publish when the second review process fails", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", " M src/example.ts"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 2, output: "second review failed" },
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
        ).rejects.toThrow("Second OpenCode review exited with code 2");

        expect(scenario.runOpenCode).toHaveBeenCalledTimes(4);
        expectNothingPublished(scenario);
      },
    );
  });

  it("does not commit or publish after a second review failure result", async () => {
    await withScenario(
      {
        statusOutputs: [" M src/example.ts", " M src/example.ts"],
        openCodeResults: [
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
          { exitCode: 0, output: "" },
          { exitCode: 0, output: "REVIEW_FAIL" },
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
        ).rejects.toThrow("OpenCode review failed after remediation");

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
        expect(scenario.events).not.toContain("move:review");
        expect(scenario.events).toContain("move:failed");
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
        expect(scenario.events).not.toContain("move:review");
        expect(scenario.events).toContain("move:failed");
      },
    );
  });

  it("propagates a failed Human Review move", async () => {
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
        ).rejects.toThrow("Human Review move failed");

        expect(scenario.events).toEqual([
          "move:working",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review",
          "move:failed",
        ]);
      },
    );
  });

  it("preserves the workflow and Failed-move errors", async () => {
    const humanReviewError = new Error("Human Review move failed");
    const failureMoveError = new Error("Failed move failed");

    await withScenario(
      {
        humanReviewError,
        failureMoveError,
      },
      async (scenario) => {
        try {
          await pollProject(
            scenario.trello,
            scenario.git,
            scenario.github,
            scenario.openCode,
            scenario.commands,
            scenario.project,
            scenario.signal,
          );

          throw new Error("Expected pollProject to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(AggregateError);

          const aggregate = error as AggregateError;

          expect(aggregate.errors).toEqual([
            humanReviewError,
            failureMoveError,
          ]);
        }

        expect(scenario.events).toEqual([
          "move:working",
          "opencode:1",
          "opencode:2",
          "opencode:3",
          "push",
          "pr",
          "move:review",
          "move:failed",
        ]);
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
