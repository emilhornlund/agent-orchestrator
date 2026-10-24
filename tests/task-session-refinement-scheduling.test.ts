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
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
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
    const implementationCard: TrelloCard = {
      id: "implementation-card",
      name: "Implement feature",
      desc: "Implement the approved feature.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.featureLabelId],
      url: "https://trello.example/implementation-card",
    };
    const readyCards = [readyCard, implementationCard];
    const cardLists = new Map(readyCards.map((card) => [card.id, card.idList]));
    const cardLabels = new Map(
      readyCards.map((card) => [card.id, new Set(card.idLabels)]),
    );
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        readyCards
          .filter((card) => cardLists.get(card.id) === listId)
          .map((card) => ({ ...card, idList: listId })),
      ),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (cardId: string, listId: string) => {
        cardLists.set(cardId, listId);
        return {
          ...readyCards.find((card) => card.id === cardId)!,
          idList: listId,
          idLabels: [...cardLabels.get(cardId)!],
        };
      }),
      updateCardContent: vi.fn(async () => undefined),
      addLabel: vi.fn(async (cardId: string, labelId: string) => {
        cardLabels.get(cardId)!.add(labelId);
      }),
      removeLabel: vi.fn(async (cardId: string, labelId: string) => {
        cardLabels.get(cardId)!.delete(labelId);
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
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
    expect(cardLists.get(readyCard.id)).toBe(project.trello.backlogListId);
    expect(cardLists.get(implementationCard.id)).toBe(
      project.trello.readyListId,
    );
    expect([...cardLabels.get(readyCard.id)!]).toContain(
      project.trello.featureLabelId,
    );
    expect([...cardLabels.get(readyCard.id)!]).not.toContain(
      project.trello.refinementLabelId,
    );
    expect(githubRun).not.toHaveBeenCalled();
    expect(openCodeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "refine",
        sessionLabel: "OpenCode refinement",
      }),
    );
    expect(
      new TaskMutationQueue(contextRoot, project)
        .list()
        .map(({ cardId, kind, status }) => ({ cardId, kind, status })),
    ).toEqual([
      {
        cardId: readyCard.id,
        kind: "refinement",
        status: "completed",
      },
      {
        cardId: implementationCard.id,
        kind: "implementation",
        status: "queued",
      },
    ]);
  });

  it("keeps an implementation-first Ready card as the sole mutation owner ahead of refinement", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-ordering-"));
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
        setupCommand: "yarn install",
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
    const implementation: TrelloCard = {
      id: "first-implementation",
      name: "Implement first",
      desc: "Implement the approved feature.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.featureLabelId],
      url: "https://trello.example/first-implementation",
    };
    const refinement: TrelloCard = {
      id: "second-refinement",
      name: "Refine second",
      desc: "Clarify acceptance criteria.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.refinementLabelId],
      url: "https://trello.example/second-refinement",
    };
    const readyCards = [implementation, refinement];
    const lists = new Map(readyCards.map((card) => [card.id, card.idList]));
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        readyCards
          .filter((card) => lists.get(card.id) === listId)
          .map((card) => ({ ...card, idList: listId })),
      ),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (cardId: string, listId: string) => {
        lists.set(cardId, listId);
        return {
          ...readyCards.find((card) => card.id === cardId)!,
          idList: listId,
        };
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
    const openCodeRun = vi.fn();
    const runCommand = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      output: "setup failed",
      errorOutput: "",
    }));

    await expect(
      pollProject(
        trello,
        git,
        new GitHubClient(githubRun),
        new OpenCodeClient(openCodeRun),
        new CommandRunner(runCommand),
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Task-session repository setup exited with code 1");

    expect(lists.get(implementation.id)).toBe(project.trello.workingListId);
    expect(lists.get(refinement.id)).toBe(project.trello.readyListId);
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(githubRun).not.toHaveBeenCalled();
    expect(
      new TaskMutationQueue(contextRoot, project)
        .list()
        .map(({ cardId, kind, status }) => ({ cardId, kind, status })),
    ).toEqual([
      {
        cardId: implementation.id,
        kind: "implementation",
        status: "failed",
      },
      {
        cardId: refinement.id,
        kind: "refinement",
        status: "queued",
      },
    ]);
  });

  it.each(["malformed-result", "interrupted-cleanup"] as const)(
    "handles %s through pollProject without starting PR work",
    async (mode) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `refinement-${mode}-`));
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
      const card: TrelloCard = {
        id: "refinement-card",
        name: "Refine task",
        desc: "Clarify task scope.",
        idList: project.trello.readyListId,
        idLabels: [project.trello.refinementLabelId],
        url: "https://trello.example/refinement-card",
      };
      let listId = project.trello.readyListId;
      const labels = new Set(card.idLabels);
      const trello = {
        getCards: vi.fn(async (requestedList: string) =>
          requestedList === listId ? [{ ...card, idList: listId }] : [],
        ),
        getCardAttachments: vi.fn(async () => []),
        moveCard: vi.fn(async (_id: string, nextList: string) => {
          listId = nextList;
          return { ...card, idList: nextList, idLabels: [...labels] };
        }),
        updateCardContent: vi.fn(async () => undefined),
        addLabel: vi.fn(async (_id: string, label: string) =>
          labels.add(label),
        ),
        removeLabel: vi.fn(async (_id: string, label: string) =>
          labels.delete(label),
        ),
        addComment: vi.fn(async () => undefined),
      } as unknown as TrelloClient;
      const controller = new AbortController();
      const worktreePath = path.join(worktreeRoot, card.id);
      const git = {
        fetch: vi.fn(async () => undefined),
        branchExists: vi.fn(async () => false),
        addWorktreeWithNewBranch: vi.fn(
          async (_repo: string, worktree: string) => {
            fs.mkdirSync(worktree, { recursive: true });
          },
        ),
        getStatus: vi.fn(async (cwd: string) =>
          fs.existsSync(getRefinementResultPath(cwd))
            ? "?? .agent-orchestrator/refinement-result.json"
            : "",
        ),
        getCurrentBranch: vi.fn(async () => {
          if (mode === "interrupted-cleanup") controller.abort();
          return `agent/${card.id}`;
        }),
        getRebaseState: vi.fn(async () => null),
        getConflictedPaths: vi.fn(async () => []),
        resetHard: vi.fn(async () => undefined),
        cleanUntracked: vi.fn(async () => undefined),
        removeWorktree: vi.fn(async () => undefined),
        pruneWorktrees: vi.fn(async () => undefined),
      } as unknown as GitClient;
      const githubRun = vi.fn();
      const openCodeRun = vi.fn(async (options: OpenCodeRunOptions) => {
        const resultPath = getRefinementResultPath(options.cwd);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        if (mode === "interrupted-cleanup") {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              title: "Refined",
              description: "Details",
              type: "feature",
            }),
          );
        } else {
          fs.writeFileSync(resultPath, "not-json");
          const agentChange = path.join(options.cwd, "src", "agent-change.ts");
          fs.mkdirSync(path.dirname(agentChange), { recursive: true });
          fs.writeFileSync(agentChange, "preserve refinement changes");
        }
        return { exitCode: 0, output: "complete", errorOutput: "" };
      });

      const polling = pollProject(
        trello,
        git,
        new GitHubClient(githubRun),
        new OpenCodeClient(openCodeRun),
        new CommandRunner(vi.fn()),
        project,
        controller.signal,
      );
      if (mode === "malformed-result") {
        await expect(polling).rejects.toThrow("Invalid refinement result JSON");
      } else {
        await polling;
      }

      expect(githubRun).not.toHaveBeenCalled();
      expect(openCodeRun).toHaveBeenCalledOnce();
      if (mode === "malformed-result") {
        expect(listId).toBe(project.trello.failedListId);
        expect(git.resetHard).not.toHaveBeenCalled();
        expect(git.cleanUntracked).not.toHaveBeenCalled();
        expect(
          fs.readFileSync(
            path.join(worktreePath, "src", "agent-change.ts"),
            "utf8",
          ),
        ).toBe("preserve refinement changes");
      } else {
        expect(listId).toBe(project.trello.backlogListId);
        expect(git.removeWorktree).not.toHaveBeenCalled();
        expect(fs.existsSync(worktreePath)).toBe(true);
      }
      expect(
        new TaskMutationQueue(contextRoot, project).getActive()?.status,
      ).toBe("failed");
    },
  );
});
