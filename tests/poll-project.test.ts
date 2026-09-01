import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  type OpenCodeRunOptions,
} from "../src/opencode/opencode-client.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

describe("pollProject", () => {
  it("does not claim another card while an active Human Review card is present", async () => {
    const project = {
      id: "project-1",
      repository: {
        path: "/repo",
        github: "owner/repo",
        worktreeRoot: "/worktrees",
      },
      trello: {
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        backlogListId: "backlog",
        failedListId: "failed",
        doneListId: "done",
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
    } as ProjectConfig;
    const card: TrelloCard = {
      id: "card-1",
      name: "Published task",
      desc: "",
      idList: "review",
      idLabels: ["feature"],
      url: "https://trello.com/c/card-1",
    };
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const getCards = vi
      .spyOn(trello, "getCards")
      .mockImplementation(async (listId) =>
        listId === "review" ? [card] : [],
      );
    vi.spyOn(trello, "moveCard");
    vi.spyOn(trello, "getLatestListTransition");
    const github = {
      findPullRequestState: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        state: "OPEN",
        mergedAt: null,
      }),
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await pollProject(
      trello,
      {} as GitClient,
      github,
      {} as OpenCodeClient,
      {} as CommandRunner,
      project,
      new AbortController().signal,
    );

    expect(getCards).toHaveBeenCalledTimes(2);
    expect(getCards).toHaveBeenCalledWith("working");
    expect(getCards).toHaveBeenCalledWith("review");
  });

  it("blocks requested-change processing when an active Human Review card is already present", async () => {
    const project = {
      id: "project-1",
      repository: {
        path: "/repo",
        github: "owner/repo",
        worktreeRoot: "/worktrees",
      },
      trello: {
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        backlogListId: "backlog",
        failedListId: "failed",
        doneListId: "done",
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
    } as ProjectConfig;
    const reviewCard: TrelloCard = {
      id: "review-card",
      name: "Published task",
      desc: "",
      idList: "review",
      idLabels: ["feature"],
      url: "https://trello.com/c/review-card",
    };
    const workingCard: TrelloCard = {
      id: "working-card",
      name: "Interrupted task",
      desc: "",
      idList: "working",
      idLabels: ["feature"],
      url: "https://trello.com/c/working-card",
    };
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const getCards = vi
      .spyOn(trello, "getCards")
      .mockImplementation(async (listId) => {
        if (listId === project.trello.workingListId) {
          return [workingCard];
        }

        if (listId === project.trello.reviewListId) {
          return [reviewCard];
        }

        return [];
      });
    const moveCard = vi.spyOn(trello, "moveCard");
    vi.spyOn(trello, "getLatestListTransition").mockResolvedValue({
      id: "action-1",
      date: "2026-08-30T10:00:00.000Z",
      listBeforeId: "review",
      listAfterId: "working",
    });
    const runOpenCode = vi.fn();
    const github = {
      findPullRequestState: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        state: "OPEN",
        mergedAt: null,
      }),
      findPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }) =>
          headBranch === "agent/working-card"
            ? { url: "https://github.com/owner/repo/pull/2" }
            : { url: "https://github.com/owner/repo/pull/1" },
        ),
      findChangesRequestedPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }) =>
          headBranch === "agent/working-card"
            ? {
                url: "https://github.com/owner/repo/pull/2",
                feedback: "Please fix the regression.",
              }
            : null,
        ),
    } as unknown as GitHubClient;

    await expect(
      pollProject(
        trello,
        {} as GitClient,
        github,
        new OpenCodeClient(runOpenCode),
        {} as CommandRunner,
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Cannot process workflow cards in both Human Review");

    expect(getCards).toHaveBeenNthCalledWith(1, "working");
    expect(getCards).toHaveBeenNthCalledWith(2, "review");
    expect(moveCard).not.toHaveBeenCalled();
    expect(runOpenCode).not.toHaveBeenCalled();
    expect(github.findChangesRequestedPullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/working-card",
    });
  });

  it("does not move a requested-change review card when a Working card is recoverable", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-concurrency-"),
    );
    const worktreePath = path.join(worktreeRoot, "working-card");
    fs.mkdirSync(worktreePath);

    const project = {
      id: "project-1",
      repository: {
        path: "/repo",
        github: "owner/repo",
        worktreeRoot,
      },
      trello: {
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        backlogListId: "backlog",
        failedListId: "failed",
        doneListId: "done",
        refinementLabelId: "refinement",
        featureLabelId: "feature",
        improvementLabelId: "improvement",
        bugLabelId: "bug",
      },
    } as ProjectConfig;
    const workingCard: TrelloCard = {
      id: "working-card",
      name: "Recoverable implementation",
      desc: "",
      idList: "working",
      idLabels: ["feature"],
      url: "https://trello.com/c/working-card",
    };
    const reviewCard: TrelloCard = {
      id: "review-card",
      name: "Requested changes",
      desc: "",
      idList: "review",
      idLabels: ["feature"],
      url: "https://trello.com/c/review-card",
    };
    const trello = {
      getCards: vi
        .fn()
        .mockImplementation(async (listId: string) =>
          listId === "working" ? [workingCard] : [reviewCard],
        ),
      getLatestListTransition: vi.fn().mockResolvedValue({
        id: "action-1",
        date: "2026-08-30T10:00:00.000Z",
        listBeforeId: "ready",
        listAfterId: "working",
      }),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn().mockResolvedValue("agent/working-card"),
    } as unknown as GitClient;
    const github = {
      findPullRequestState: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/review-card"
            ? {
                url: "https://github.com/owner/repo/pull/2",
                state: "OPEN",
                mergedAt: null,
              }
            : null,
        ),
      findPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/review-card"
            ? { url: "https://github.com/owner/repo/pull/2" }
            : null,
        ),
      findChangesRequestedPullRequest: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/review-card"
            ? {
                url: "https://github.com/owner/repo/pull/2",
                feedback: "Fix this.",
              }
            : null,
        ),
    } as unknown as GitHubClient;

    try {
      await expect(
        pollProject(
          trello,
          git,
          github,
          {} as OpenCodeClient,
          {} as CommandRunner,
          project,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Cannot process workflow cards in both Human Review");

      expect(trello.moveCard).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("routes refinement cards through refinement and returns them to Backlog", async () => {
    const events: string[] = [];

    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-refinement-"),
    );

    const card: TrelloCard = {
      id: "card-1",
      name: "Inventory thing",
      desc: "Players need inventory support.",
      idList: "ready-list",
      idLabels: ["refinement-label"],
      url: "https://trello.com/c/card-1",
    };

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
        gitIdentity: {
          name: "Agent Orchestrator",
          email: "agent-orchestrator@users.noreply.github.com",
        },
      },
      opencode: {
        refinement: {
          model: "refinement-model",
          variant: "refinement-variant",
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

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = new TrelloClient({
        apiKey: "test-key",
        token: "test-token",
      });

      vi.spyOn(trello, "getCards").mockImplementation(async (listId) => {
        if (listId === project.trello.reviewListId) {
          return [];
        }

        if (listId === project.trello.workingListId) {
          return [];
        }

        if (listId === project.trello.readyListId) {
          return [card];
        }

        return [];
      });

      vi.spyOn(trello, "moveCard").mockImplementation(
        async (_cardId, listId) => {
          if (listId === project.trello.workingListId) {
            events.push("claim-refinement");
          }

          if (listId === project.trello.backlogListId) {
            events.push("move-backlog");
          }

          return {
            ...card,
            idList: listId,
          };
        },
      );

      vi.spyOn(trello, "updateCardContent").mockImplementation(
        async (_cardId, title, description) => {
          events.push("update-card");

          return {
            ...card,
            name: title,
            desc: description,
          };
        },
      );

      vi.spyOn(trello, "addLabel").mockImplementation(
        async (_cardId, labelId) => {
          events.push(`add-label:${labelId}`);
        },
      );

      vi.spyOn(trello, "removeLabel").mockImplementation(
        async (_cardId, labelId) => {
          events.push(`remove-label:${labelId}`);
        },
      );

      let statusCall = 0;

      const runGit = vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === "branch" && args[1] === "--show-current") {
          return "agent/card-1";
        }

        if (args[0] === "status") {
          statusCall += 1;

          if (statusCall === 1) {
            return "";
          }

          if (statusCall === 2) {
            return "?? .agent-orchestrator/refinement-result.json";
          }

          return "";
        }

        if (args[0] === "worktree" && args[1] === "remove") {
          events.push("cleanup-worktree");
          return "";
        }

        if (args[0] === "worktree" && args[1] === "prune") {
          return "";
        }

        if (args[0] === "branch" && args[1] === "--list") {
          return "";
        }

        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      });

      const git = new GitClient(runGit);

      const openCodeRuns: OpenCodeRunOptions[] = [];

      const opencode = new OpenCodeClient(async (options) => {
        openCodeRuns.push(options);
        events.push("refinement");

        const resultPath = getRefinementResultPath(options.cwd);

        fs.mkdirSync(path.dirname(resultPath), {
          recursive: true,
        });

        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            title: "Add inventory support",
            type: "feature",
            description:
              "# Add inventory support\n\n## Description\n\nAdd inventory support.",
          }),
        );

        return {
          exitCode: 0,
          output: "Refinement complete",
          errorOutput: "",
        };
      });

      const github = new GitHubClient(async () => {
        throw new Error("GitHub should not be called for refinement");
      });

      const commands = new CommandRunner(async () => {
        throw new Error("Commands should not be run for refinement");
      });

      await pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        new AbortController().signal,
      );

      expect(openCodeRuns).toHaveLength(1);
      expect(openCodeRuns[0]).toEqual(
        expect.objectContaining({
          cwd: worktreePath,
          model: "refinement-model",
          variant: "refinement-variant",
          sessionLabel: "OpenCode refinement",
        }),
      );

      expect(trello.updateCardContent).toHaveBeenCalledWith(
        "card-1",
        "Add inventory support",
        "# Add inventory support\n\n## Description\n\nAdd inventory support.",
      );

      expect(trello.addLabel).toHaveBeenCalledWith("card-1", "feature-label");

      expect(trello.removeLabel).toHaveBeenCalledWith(
        "card-1",
        "refinement-label",
      );

      expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog-list");

      expect(events).toEqual([
        "claim-refinement",
        "refinement",
        "update-card",
        "add-label:feature-label",
        "remove-label:refinement-label",
        "move-backlog",
        "cleanup-worktree",
      ]);

      expect(fs.existsSync(getRefinementResultPath(worktreePath))).toBe(false);
    } finally {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("commits before pushing, creating the PR, and moving to Human Review", async () => {
    const events: string[] = [];

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
        gitIdentity: {
          name: "Agent Orchestrator",
          email: "agent-orchestrator@users.noreply.github.com",
          signingKey: "/secrets/agent-orchestrator-signing-key",
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

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = new TrelloClient({
        apiKey: "test-key",
        token: "test-token",
      });

      vi.spyOn(trello, "getCards").mockImplementation(async (listId) => {
        if (listId === project.trello.workingListId) {
          events.push("get-working");
          return [];
        }

        if (listId === project.trello.readyListId) {
          events.push("get-ready");
          return [card];
        }

        return [];
      });

      vi.spyOn(trello, "moveCard").mockImplementation(
        async (_cardId, listId) => {
          if (listId === project.trello.reviewListId) {
            events.push("human-review");
          }

          return {
            ...card,
            idList: listId,
          };
        },
      );
      vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

      let statusCall = 0;
      let headCall = 0;

      const runGit = vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === "branch" && args[1] === "--show-current") {
          return "agent/card-1";
        }

        if (args[0] === "status") {
          statusCall += 1;

          if (statusCall === 1) {
            return "";
          }

          if (statusCall === 2) {
            return " M src/example.ts";
          }

          return "";
        }

        if (args[0] === "rev-parse") {
          headCall += 1;

          return headCall === 1 ? "before-commit" : "after-commit";
        }

        if (args[0] === "push") {
          events.push("push");
          return "";
        }

        return "";
      });

      const git = new GitClient(runGit);

      let openCodeCall = 0;
      const openCodeRuns: OpenCodeRunOptions[] = [];

      const opencode = new OpenCodeClient(async (options) => {
        openCodeCall += 1;
        openCodeRuns.push(options);

        if (openCodeCall === 1) {
          events.push("implementation");

          return {
            exitCode: 0,
            output:
              "Tests completed successfully\npermission denied\n157 passed",
            errorOutput: "",
          };
        }

        if (openCodeCall === 2) {
          events.push("review");

          return {
            exitCode: 0,
            output: "REVIEW_PASS",
            errorOutput: "",
          };
        }

        events.push("commit");

        return {
          exitCode: 0,
          output: "",
          errorOutput: "",
        };
      });

      const github = new GitHubClient(async (_cwd, args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return "";
        }

        events.push("pr");

        return "https://github.com/example/repository/pull/123";
      });

      const commands = new CommandRunner(async () => ({
        exitCode: 0,
      }));

      const controller = new AbortController();

      await pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        controller.signal,
      );

      expect(events).toEqual([
        "get-working",
        "get-ready",
        "get-ready",
        "implementation",
        "review",
        "commit",
        "push",
        "pr",
        "human-review",
      ]);

      expect(openCodeRuns).toHaveLength(3);

      expect(openCodeRuns[0]?.environment).toBeUndefined();
      expect(openCodeRuns[1]?.environment).toBeUndefined();

      expect(openCodeRuns[2]?.environment).toEqual({
        GIT_AUTHOR_NAME: "Agent Orchestrator",
        GIT_AUTHOR_EMAIL: "agent-orchestrator@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Agent Orchestrator",
        GIT_COMMITTER_EMAIL: "agent-orchestrator@users.noreply.github.com",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "gpg.format",
        GIT_CONFIG_VALUE_0: "ssh",
        GIT_CONFIG_KEY_1: "user.signingKey",
        GIT_CONFIG_VALUE_1: "/secrets/agent-orchestrator-signing-key",
        GIT_CONFIG_KEY_2: "commit.gpgSign",
        GIT_CONFIG_VALUE_2: "true",
      });

      expect(events).not.toContain("move:failed");
    } finally {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("publishes directly after the final remediation pass", async () => {
    const events: string[] = [];

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

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = new TrelloClient({
        apiKey: "test-key",
        token: "test-token",
      });

      vi.spyOn(trello, "getCards").mockImplementation(async (listId) => {
        if (listId === project.trello.workingListId) {
          return [];
        }

        if (listId === project.trello.readyListId) {
          return [card];
        }

        return [];
      });

      vi.spyOn(trello, "moveCard").mockImplementation(
        async (_cardId, listId) => {
          if (listId === project.trello.reviewListId) {
            events.push("human-review");
          }

          return {
            ...card,
            idList: listId,
          };
        },
      );
      vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

      let statusCall = 0;
      let headCall = 0;

      const runGit = vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === "branch" && args[1] === "--show-current") {
          return "agent/card-1";
        }

        if (args[0] === "status") {
          statusCall += 1;

          if (statusCall === 1) {
            return "";
          }

          if (statusCall === 2) {
            return " M src/example.ts";
          }

          if (statusCall === 3) {
            return " M src/example.ts";
          }

          return "";
        }

        if (args[0] === "rev-parse") {
          headCall += 1;

          return headCall === 1 ? "before-commit" : "after-commit";
        }

        if (args[0] === "push") {
          events.push("push");
          return "";
        }

        return "";
      });

      const git = new GitClient(runGit);

      let openCodeCall = 0;

      const opencode = new OpenCodeClient(async () => {
        openCodeCall += 1;

        if (openCodeCall === 1) {
          events.push("implementation");

          return {
            exitCode: 0,
            output: "",
            errorOutput: "",
          };
        }

        if (openCodeCall === 2) {
          events.push("review-fail");

          return {
            exitCode: 0,
            output: "REVIEW_FAIL",
            errorOutput: "",
          };
        }

        if (openCodeCall === 3) {
          events.push("remediation");

          return {
            exitCode: 0,
            output: "",
            errorOutput: "",
          };
        }

        if (openCodeCall === 4) {
          events.push("commit");

          return {
            exitCode: 0,
            output: "",
            errorOutput: "",
          };
        }

        throw new Error(`Unexpected OpenCode call ${openCodeCall}`);
      });

      const github = new GitHubClient(async (_cwd, args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return "";
        }

        events.push("pr");

        return "https://github.com/example/repository/pull/123";
      });

      const commands = new CommandRunner(async () => ({
        exitCode: 0,
      }));

      const controller = new AbortController();

      await pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        controller.signal,
      );

      expect(events).toEqual([
        "implementation",
        "review-fail",
        "remediation",
        "commit",
        "push",
        "pr",
        "human-review",
      ]);
      expect(events).not.toContain("move:failed");
    } finally {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("does not run OpenCode when a claimed card already has an open PR", async () => {
    const card: TrelloCard = {
      id: "card-1",
      name: "Already published task",
      desc: "",
      idList: "ready",
      idLabels: ["feature-label"],
      url: "https://trello.com/c/card-1",
    };

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
        worktreeRoot: "/tmp/example-worktrees",
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

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    vi.spyOn(trello, "getCards").mockImplementation(async (listId) => {
      if (listId === project.trello.workingListId) {
        return [];
      }

      if (listId === project.trello.readyListId) {
        return [card];
      }

      return [];
    });

    vi.spyOn(trello, "moveCard").mockImplementation(
      async (_cardId, listId) => ({
        ...card,
        idList: listId,
      }),
    );

    const git = new GitClient(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--list") {
        return "";
      }

      return "";
    });

    const github = new GitHubClient(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("Unexpected GitHub command");
    });

    const runOpenCode = vi.fn().mockResolvedValue({
      exitCode: 0,
      output: "",
    });

    const opencode = new OpenCodeClient(runOpenCode);

    const commands = new CommandRunner(async () => ({
      exitCode: 0,
    }));

    const controller = new AbortController();

    await pollProject(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      controller.signal,
    );

    expect(runOpenCode).not.toHaveBeenCalled();

    expect(trello.moveCard).toHaveBeenCalledWith(
      "card-1",
      project.trello.workingListId,
    );

    expect(trello.moveCard).toHaveBeenCalledWith(
      "card-1",
      project.trello.reviewListId,
    );
  });

  it("applies requested PR changes and republishes the existing pull request", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-review-"),
    );

    const card: TrelloCard = {
      id: "card-1",
      name: "Example task",
      desc: "Implement the example task",
      idList: "review",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    };

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

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = {
        getCards: vi.fn().mockImplementation(async (listId: string) => {
          if (listId === project.trello.reviewListId) {
            return [card];
          }

          return [];
        }),
        getLatestListTransition: vi.fn().mockResolvedValue({
          id: "action-1",
          date: "2026-08-30T10:00:00.000Z",
          listBeforeId: project.trello.reviewListId,
          listAfterId: project.trello.workingListId,
        }),
        moveCard: vi
          .fn()
          .mockImplementation(async (_cardId: string, listId: string) => ({
            ...card,
            idList: listId,
          })),
        addComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as TrelloClient;

      const getStatus = vi
        .fn()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(" M src/example.ts")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("");

      const getHeadSha = vi
        .fn()
        .mockResolvedValueOnce("before-review-commit")
        .mockResolvedValueOnce("after-review-commit");

      const git = {
        fetch: vi.fn().mockResolvedValue(undefined),
        rebase: vi.fn().mockResolvedValue(undefined),
        getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
        resetHardTo: vi.fn().mockResolvedValue(undefined),
        cleanUntracked: vi.fn().mockResolvedValue(undefined),
        getStatus,
        getHeadSha,
        push: vi.fn().mockResolvedValue(undefined),
        removeWorktree: vi.fn().mockResolvedValue(undefined),
        pruneWorktrees: vi.fn().mockResolvedValue(undefined),
        branchExists: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitClient;

      const github = {
        findPullRequestState: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
          state: "OPEN",
          mergedAt: null,
        }),
        findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
          feedback: "Please add a regression test.",
        }),
        findPullRequest: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
        }),
        createPullRequest: vi.fn(),
      } as unknown as GitHubClient;

      const runOpenCode = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "REVIEW_PASS",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "",
        });

      const opencode = new OpenCodeClient(runOpenCode);

      const commands = new CommandRunner(async () => ({
        exitCode: 0,
      }));

      const controller = new AbortController();

      await pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        controller.signal,
      );

      expect(trello.moveCard).toHaveBeenNthCalledWith(
        1,
        "card-1",
        project.trello.workingListId,
      );

      expect(trello.moveCard).toHaveBeenNthCalledWith(
        2,
        "card-1",
        project.trello.reviewListId,
      );

      expect(git.fetch).toHaveBeenCalledWith(
        project.repository.path,
        "origin",
        "agent/card-1",
      );

      expect(git.resetHardTo).toHaveBeenCalledWith(
        worktreePath,
        "origin/agent/card-1",
      );

      expect(runOpenCode).toHaveBeenCalledTimes(3);

      expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(
        "Human review feedback:\nPlease add a regression test.",
      );

      expect(runOpenCode.mock.calls[0]?.[0]).toMatchObject({
        model: "implementation-model",
        variant: "implementation-variant",
      });

      expect(git.push).toHaveBeenCalledWith(
        worktreePath,
        "origin",
        "agent/card-1",
      );

      expect(github.findPullRequest).toHaveBeenCalledWith({
        cwd: worktreePath,
        repository: "example/repository",
        headBranch: "agent/card-1",
      });

      expect(github.createPullRequest).not.toHaveBeenCalled();

      expect(git.removeWorktree).toHaveBeenCalledWith(
        project.repository.path,
        worktreePath,
      );
    } finally {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("resumes requested changes directly from a Working card after restart", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-restart-"),
    );

    const card: TrelloCard = {
      id: "card-1",
      name: "Interrupted review task",
      desc: "Apply requested review changes",
      idList: "working",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    };

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

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = {
        getCards: vi.fn().mockImplementation(async (listId: string) => {
          if (listId === project.trello.reviewListId) {
            return [];
          }

          if (listId === project.trello.workingListId) {
            return [card];
          }

          return [];
        }),
        getLatestListTransition: vi.fn().mockResolvedValue({
          id: "action-1",
          date: "2026-08-30T10:00:00.000Z",
          listBeforeId: project.trello.reviewListId,
          listAfterId: project.trello.workingListId,
        }),
        moveCard: vi
          .fn()
          .mockImplementation(async (_cardId: string, listId: string) => ({
            ...card,
            idList: listId,
          })),
        addComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as TrelloClient;

      const getStatus = vi
        .fn()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(" M src/example.ts")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("");

      const getHeadSha = vi
        .fn()
        .mockResolvedValueOnce("before-review-commit")
        .mockResolvedValueOnce("after-review-commit");

      const git = {
        fetch: vi.fn().mockResolvedValue(undefined),
        getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
        resetHardTo: vi.fn().mockResolvedValue(undefined),
        cleanUntracked: vi.fn().mockResolvedValue(undefined),
        getStatus,
        getHeadSha,
        rebase: vi.fn().mockResolvedValue(undefined),
        push: vi.fn().mockResolvedValue(undefined),
        removeWorktree: vi.fn().mockResolvedValue(undefined),
        pruneWorktrees: vi.fn().mockResolvedValue(undefined),
        branchExists: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitClient;

      const github = {
        findPullRequest: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
        }),
        findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
          feedback: "Please fix the regression.",
        }),
        createPullRequest: vi.fn(),
      } as unknown as GitHubClient;

      const runOpenCode = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "REVIEW_PASS",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          output: "",
        });

      const opencode = new OpenCodeClient(runOpenCode);

      const commands = new CommandRunner(async () => ({
        exitCode: 0,
      }));

      const controller = new AbortController();

      await pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        controller.signal,
      );

      expect(github.findChangesRequestedPullRequest).toHaveBeenCalledWith({
        cwd: project.repository.path,
        repository: project.repository.github,
        headBranch: "agent/card-1",
      });

      expect(runOpenCode).toHaveBeenCalledTimes(3);

      expect(runOpenCode.mock.calls[0]?.[0].prompt).toContain(
        "Human review feedback:\nPlease fix the regression.",
      );

      expect(trello.moveCard).toHaveBeenCalledTimes(1);

      expect(trello.moveCard).toHaveBeenCalledWith(
        "card-1",
        project.trello.reviewListId,
      );

      expect(git.push).toHaveBeenCalledWith(
        worktreePath,
        "origin",
        "agent/card-1",
      );

      expect(github.createPullRequest).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(worktreeRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("leaves an interrupted review iteration in Working for restart recovery", async () => {
    const card: TrelloCard = {
      id: "card-1",
      name: "Interrupted review task",
      desc: "",
      idList: "working",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    };

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
        worktreeRoot: "/tmp/example-worktrees",
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

    const trello = {
      getCards: vi.fn().mockImplementation(async (listId: string) => {
        if (listId === project.trello.reviewListId) {
          return [];
        }

        if (listId === project.trello.workingListId) {
          return [card];
        }

        return [];
      }),
      getLatestListTransition: vi.fn().mockResolvedValue({
        id: "action-1",
        date: "2026-08-30T10:00:00.000Z",
        listBeforeId: project.trello.reviewListId,
        listAfterId: project.trello.workingListId,
      }),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    const git = {
      fetch: vi.fn().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
      addWorktreeWithNewBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
        feedback: "Please fix the regression.",
      }),
    } as unknown as GitHubClient;

    const controller = new AbortController();

    const opencode = new OpenCodeClient(async () => {
      controller.abort();
      throw new OpenCodeRunAbortedError();
    });

    const commands = new CommandRunner(async () => ({
      exitCode: 0,
    }));

    await pollProject(
      trello,
      git,
      github,
      opencode,
      commands,
      project,
      controller.signal,
    );

    expect(trello.moveCard).not.toHaveBeenCalledWith(
      card.id,
      project.trello.failedListId,
    );

    expect(trello.moveCard).not.toHaveBeenCalledWith(
      card.id,
      project.trello.reviewListId,
    );
  });

  it("moves a review iteration to Failed when a real error occurs during shutdown", async () => {
    const card: TrelloCard = {
      id: "card-1",
      name: "Broken review task",
      desc: "",
      idList: "working",
      idLabels: [],
      url: "https://trello.com/c/card-1",
    };

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
        worktreeRoot: "/tmp/example-worktrees",
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

    const trello = {
      getCards: vi.fn().mockImplementation(async (listId: string) => {
        if (listId === project.trello.reviewListId) {
          return [];
        }

        if (listId === project.trello.workingListId) {
          return [card];
        }

        return [];
      }),
      getLatestListTransition: vi.fn().mockResolvedValue({
        id: "action-1",
        date: "2026-08-30T10:00:00.000Z",
        listBeforeId: project.trello.reviewListId,
        listAfterId: project.trello.workingListId,
      }),
      moveCard: vi
        .fn()
        .mockImplementation(async (_cardId: string, listId: string) => ({
          ...card,
          idList: listId,
        })),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;

    const git = {
      fetch: vi.fn().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      branchExists: vi.fn().mockResolvedValue(false),
      addWorktreeWithNewBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitClient;

    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
        feedback: "Please fix the regression.",
      }),
    } as unknown as GitHubClient;

    const controller = new AbortController();

    const opencode = new OpenCodeClient(async () => {
      controller.abort();
      throw new Error("real review implementation failure");
    });

    const commands = new CommandRunner(async () => ({
      exitCode: 0,
    }));

    await expect(
      pollProject(
        trello,
        git,
        github,
        opencode,
        commands,
        project,
        controller.signal,
      ),
    ).rejects.toThrow("real review implementation failure");

    expect(trello.moveCard).toHaveBeenCalledWith(
      card.id,
      project.trello.failedListId,
    );
  });
});
