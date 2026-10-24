import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../src/opencode/opencode-client.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
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
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        cardList = listId;
        return { ...readyCard, idList: listId, idLabels: [...labels] };
      }),
      updateCardContent: vi.fn(async () => undefined),
      addLabel: vi.fn(async (_cardId: string, labelId: string) => {
        labels.add(labelId);
      }),
      removeLabel: vi.fn(async (_cardId: string, labelId: string) => {
        labels.delete(labelId);
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const labels = new Set(readyCard.idLabels);
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repo: string, worktreePath: string) => {
          fs.mkdirSync(worktreePath, { recursive: true });
        },
      ),
      getStatus: vi.fn(async (worktreePath: string) =>
        fs.existsSync(getRefinementResultPath(worktreePath))
          ? "?? .agent-orchestrator/refinement-result.json"
          : "",
      ),
      getCurrentBranch: vi.fn(async () => `agent/${readyCard.id}`),
      getRebaseState: vi.fn(async () => null),
      getConflictedPaths: vi.fn(async () => []),
      removeWorktree: vi.fn(async (_repo: string, worktreePath: string) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }),
      pruneWorktrees: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const githubRun = vi.fn();
    const github = new GitHubClient(githubRun);
    const openCodeRun = vi.fn(
      async (options: OpenCodeRunOptions): Promise<OpenCodeRunResult> => {
        const resultPath = getRefinementResultPath(options.cwd);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            title: "Clarified feature",
            description: "# Clarified feature\n\nAcceptance criteria.",
            type: "feature",
          }),
        );
        return { exitCode: 0, output: "done", errorOutput: "" };
      },
    );
    const openCode = new OpenCodeClient(openCodeRun);
    const commands = new CommandRunner(vi.fn());

    await pollProject(
      trello,
      git,
      github,
      openCode,
      commands,
      project,
      new AbortController().signal,
    );

    expect(openCodeRun).toHaveBeenCalledOnce();
    expect(git.addWorktreeWithNewBranch).toHaveBeenCalledOnce();
    expect(cardList).toBe(project.trello.backlogListId);
    expect([...labels]).toContain(project.trello.featureLabelId);
    expect([...labels]).not.toContain(project.trello.refinementLabelId);
    expect(githubRun).not.toHaveBeenCalled();
    expect(openCodeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "refine",
        sessionLabel: "OpenCode refinement",
      }),
    );
    expect(new TaskMutationQueue(contextRoot, project).list()).toMatchObject([
      { cardId: readyCard.id, kind: "refinement", status: "completed" },
    ]);
  });
});
