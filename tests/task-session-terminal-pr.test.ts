import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("task-session terminal PR reconciliation", () => {
  it.each([
    {
      state: "MERGED" as const,
      destination: "done",
      mergedAt: "2026-10-24T12:00:00Z",
    },
    { state: "CLOSED" as const, destination: "backlog", mergedAt: null },
  ])(
    "moves a $state PR card to $destination without consulting CI",
    async ({ state, destination, mergedAt }) => {
      root = fs.mkdtempSync(
        path.join(os.tmpdir(), "terminal-task-session-pr-"),
      );
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const contextRoot = path.join(root, "state");
      fs.mkdirSync(repositoryPath);
      const project = {
        id: "project",
        executionMode: "task-session",
        autoMerge: false,
        contextRoot,
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
          path: repositoryPath,
          github: "owner/repo",
          defaultBranch: "main",
          worktreeRoot,
          validationCommand: "yarn validate",
          requiredChecks: ["Build"],
          gitIdentity: { name: "Agent", email: "agent@example.test" },
        },
        opencode: {
          refinement: { model: "refine", variant: "high" },
          implementation: { model: "implement", variant: "high" },
          review: { model: "review", variant: "high" },
          remediation: { model: "repair", variant: "high", maxPasses: 1 },
          commit: { model: "commit", variant: "low" },
          timeoutMinutes: 1,
        },
      } as ProjectConfig & { contextRoot: string };
      let currentList = project.trello.reviewListId;
      const card: TrelloCard = {
        id: "task-card",
        name: "Task",
        desc: "Task body",
        idList: currentList,
        idLabels: [],
        url: "https://trello.example/task-card",
      };
      const trello = {
        getCards: vi.fn(async (listId: string) =>
          listId === currentList ? [{ ...card, idList: currentList }] : [],
        ),
        moveCard: vi.fn(async (_cardId: string, listId: string) => {
          currentList = listId;
          return { ...card, idList: listId };
        }),
        addComment: vi.fn(async () => undefined),
      } as unknown as TrelloClient;
      let failCleanupOnce = state === "MERGED";
      const headSha = "a".repeat(40);
      const github = {
        findPullRequestState: vi.fn(async () => ({
          url: "https://github.com/owner/repo/pull/7",
          state,
          mergedAt,
          headRefOid: headSha,
          baseRefName: "main",
          headRefName: "agent/task-card",
          headRepository: { name: "repo" },
          headRepositoryOwner: { login: "owner" },
        })),
        getRequiredChecks: vi.fn(async () => {
          throw new Error("terminal PR reconciliation must not require CI");
        }),
      } as unknown as GitHubClient;
      const git = {
        remoteBranchExists: vi.fn(async () => false),
        pruneWorktrees: vi.fn(async () => {
          if (failCleanupOnce) {
            failCleanupOnce = false;
            throw new Error("simulated interruption during terminal cleanup");
          }
        }),
        branchExists: vi.fn(async () => false),
      } as unknown as GitClient;
      new TaskExecutionStore(contextRoot, project).create({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        phase: "ci",
        primarySessionId: "session",
        sessionCreationStatus: "bound",
        expectedBranch: `agent/${card.id}`,
        pullRequest: {
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          headSha,
        },
        operationKey: "operation",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: "2026-10-24T09:00:00.000Z",
        updatedAt: "2026-10-24T09:00:00.000Z",
      });

      const poll = () =>
        runTaskSessionWorkflow({
          project,
          trello,
          git,
          github,
          openCode: new OpenCodeClient(vi.fn()),
          commands: new CommandRunner(vi.fn()),
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => undefined,
        });

      if (state === "MERGED") {
        await expect(poll()).rejects.toThrow(
          "simulated interruption during terminal cleanup",
        );
        expect(currentList).toBe(project.trello.doneListId);
      }
      await poll();

      expect(currentList).toBe(
        project.trello[destination === "done" ? "doneListId" : "backlogListId"],
      );
      expect(trello.moveCard).toHaveBeenCalledWith(
        card.id,
        destination === "done"
          ? project.trello.doneListId
          : project.trello.backlogListId,
        ...(destination === "done" ? [{ dueComplete: true }] : []),
      );
      expect(github.getRequiredChecks).not.toHaveBeenCalled();
    },
  );
});
