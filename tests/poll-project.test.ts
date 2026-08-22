import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

describe("pollProject", () => {
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
      url: "https://trello.com/c/card-1",
    };

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
      },
      opencode: {
        model: "test-model",
        variant: "test-variant",
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

      const opencode = new OpenCodeClient(async () => {
        openCodeCall += 1;

        if (openCodeCall === 1) {
          events.push("implementation");

          return {
            exitCode: 0,
            output: "",
          };
        }

        if (openCodeCall === 2) {
          events.push("review");

          return {
            exitCode: 0,
            output: "REVIEW_PASS",
          };
        }

        events.push("commit");

        return {
          exitCode: 0,
          output: "",
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
        "implementation",
        "review",
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

  it("remediates and re-reviews before committing and publishing", async () => {
    const events: string[] = [];

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
      },
      opencode: {
        model: "test-model",
        variant: "test-variant",
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
          };
        }

        if (openCodeCall === 2) {
          events.push("review-fail");

          return {
            exitCode: 0,
            output: "REVIEW_FAIL",
          };
        }

        if (openCodeCall === 3) {
          events.push("remediation");

          return {
            exitCode: 0,
            output: "",
          };
        }

        if (openCodeCall === 4) {
          events.push("second-review");

          return {
            exitCode: 0,
            output: "REVIEW_PASS",
          };
        }

        events.push("commit");

        return {
          exitCode: 0,
          output: "",
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
        "implementation",
        "review-fail",
        "remediation",
        "second-review",
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
      url: "https://trello.com/c/card-1",
    };

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
        worktreeRoot: "/tmp/example-worktrees",
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
      url: "https://trello.com/c/card-1",
    };

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
      },
      opencode: {
        model: "test-model",
        variant: "test-variant",
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
        push: vi.fn().mockResolvedValue(undefined),
        removeWorktree: vi.fn().mockResolvedValue(undefined),
        pruneWorktrees: vi.fn().mockResolvedValue(undefined),
        branchExists: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitClient;

      const github = {
        findMergedPullRequest: vi.fn().mockResolvedValue(null),
        findClosedPullRequest: vi.fn().mockResolvedValue(null),
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
      url: "https://trello.com/c/card-1",
    };

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
      },
      opencode: {
        model: "test-model",
        variant: "test-variant",
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
});
