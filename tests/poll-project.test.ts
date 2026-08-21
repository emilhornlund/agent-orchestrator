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
      },
    };

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = new TrelloClient({
        apiKey: "test-key",
        token: "test-token",
      });

      vi.spyOn(trello, "getCards").mockResolvedValue([card]);

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

      await pollProject(trello, git, github, opencode, commands, project);

      expect(events).toEqual([
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
      },
    };

    const worktreePath = path.join(worktreeRoot, card.id);

    fs.mkdirSync(worktreePath);

    try {
      const trello = new TrelloClient({
        apiKey: "test-key",
        token: "test-token",
      });

      vi.spyOn(trello, "getCards").mockResolvedValue([card]);

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

      await pollProject(trello, git, github, opencode, commands, project);

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
});
