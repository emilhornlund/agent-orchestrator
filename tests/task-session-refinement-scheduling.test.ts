import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("task-session refinement scheduling", () => {
  it("claims an eligible refinement through the project queue and returns it to Backlog without PR work", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-refinement-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    fs.mkdirSync(repositoryPath);
    const project = {
      id: "project",
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
    const readyCard: TrelloCard = {
      id: "refine-card",
      name: "Clarify feature",
      desc: "Clarify acceptance criteria.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.refinementLabelId],
      url: "https://trello.example/refine-card",
    };
    let cardList = project.trello.readyListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === cardList ? [{ ...readyCard, idList: cardList }] : [],
      ),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        cardList = listId;
        return { ...readyCard, idList: listId };
      }),
    } as unknown as TrelloClient;
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repo: string, worktreePath: string) => {
          fs.mkdirSync(worktreePath, { recursive: true });
        },
      ),
    } as unknown as GitClient;
    const githubRun = vi.fn();
    const github = new GitHubClient(githubRun);
    const openCodeRun = vi.fn();
    const openCode = new OpenCodeClient(openCodeRun);
    const commands = new CommandRunner(vi.fn());
    const processRefinement = vi.fn(async (card: TrelloCard) => {
      expect(card.idList).toBe(project.trello.workingListId);
      cardList = project.trello.backlogListId;
    });

    await runTaskSessionWorkflow({
      project,
      trello,
      git,
      github,
      openCode,
      commands,
      signal: new AbortController().signal,
      prepareAttachmentContext: async () => undefined,
      processRefinement,
    });

    expect(processRefinement).toHaveBeenCalledOnce();
    expect(git.addWorktreeWithNewBranch).toHaveBeenCalledOnce();
    expect(cardList).toBe(project.trello.backlogListId);
    expect(githubRun).not.toHaveBeenCalled();
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(new TaskMutationQueue(contextRoot, project).list()).toMatchObject([
      { cardId: readyCard.id, kind: "refinement", status: "completed" },
    ]);
  });
});
