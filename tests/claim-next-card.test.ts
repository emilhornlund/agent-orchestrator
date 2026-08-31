import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import { claimNextCard } from "../src/orchestrator/claim-next-card.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

type Project = Config["projects"][number];
const temporaryDirectories: string[] = [];

function createProject(worktreeRoot: string): Project {
  return {
    id: "project",
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
      path: "/repo",
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    opencode: {
      refinement: { model: "refinement", variant: "xhigh" },
      implementation: { model: "implementation", variant: "xhigh" },
      review: { model: "review", variant: "high" },
      remediation: { model: "remediation", variant: "xhigh" },
      commit: { model: "commit", variant: "low" },
      timeoutMinutes: 360,
    },
  };
}

function createCard(id: string, idLabels: string[] = ["feature"]): TrelloCard {
  return {
    id,
    name: id,
    desc: "",
    idList: "ready",
    idLabels,
    url: `https://trello.com/c/${id}`,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("claimNextCard", () => {
  it("prepares the first eligible worktree before moving the card to Working", async () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claim-card-"));
    temporaryDirectories.push(worktreeRoot);
    const project = createProject(worktreeRoot);
    const events: string[] = [];
    const moveCard = vi.fn(async () => {
      events.push("move");
      return { ...createCard("card-2"), idList: "working" };
    });
    const git = {
      fetch: vi.fn(async () => events.push("fetch")),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(async () => {
        events.push("prepare");
        fs.mkdirSync(path.join(worktreeRoot, "card-2"));
      }),
    } as unknown as GitClient;
    const trello = {
      getCards: vi
        .fn()
        .mockResolvedValue([
          createCard("card-1", ["refinement"]),
          createCard("card-2"),
        ]),
      moveCard,
    } as unknown as TrelloClient;

    const result = await claimNextCard(trello, git, project);

    expect(result?.card.id).toBe("card-2");
    expect(result?.worktree).toEqual({
      path: path.join(worktreeRoot, "card-2"),
      branch: "agent/card-2",
      reused: false,
    });
    expect(events).toEqual(["fetch", "prepare", "move"]);
  });

  it("leaves a prepared worktree intact when moving to Working fails", async () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claim-card-"));
    temporaryDirectories.push(worktreeRoot);
    const project = createProject(worktreeRoot);
    const worktreePath = path.join(worktreeRoot, "card-1");
    let existing = false;
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(async () => {
        existing = true;
        fs.mkdirSync(worktreePath);
      }),
      getCurrentBranch: vi.fn(async () => "agent/card-1"),
      getStatus: vi.fn(async () => ""),
    } as unknown as GitClient;
    const moveCard = vi
      .fn()
      .mockRejectedValueOnce(new Error("Trello unavailable"))
      .mockResolvedValueOnce({ ...createCard("card-1"), idList: "working" });
    const trello = {
      getCards: vi.fn().mockResolvedValue([createCard("card-1")]),
      moveCard,
    } as unknown as TrelloClient;

    await expect(claimNextCard(trello, git, project)).rejects.toThrow(
      "Trello unavailable",
    );
    expect(existing).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(true);

    const retry = await claimNextCard(trello, git, project);

    expect(retry?.worktree.reused).toBe(true);
    expect(moveCard).toHaveBeenCalledTimes(2);
  });

  it("returns null when no implementation label is ready", async () => {
    const project = createProject("/worktrees");
    const trello = {
      getCards: vi
        .fn()
        .mockResolvedValue([
          createCard("card-1", []),
          createCard("card-2", ["refinement"]),
        ]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      claimNextCard(trello, {} as GitClient, project),
    ).resolves.toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("does not claim a card when shutdown occurs during worktree preparation", async () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claim-card-"));
    temporaryDirectories.push(worktreeRoot);
    const controller = new AbortController();
    const project = createProject(worktreeRoot);
    const moveCard = vi.fn();
    const trello = {
      getCards: vi.fn().mockResolvedValue([createCard("card-1")]),
      moveCard,
    } as unknown as TrelloClient;
    const git = {
      fetch: vi.fn(),
      branchExists: vi.fn().mockResolvedValue(false),
      addWorktreeWithNewBranch: vi.fn(async () => {
        fs.mkdirSync(path.join(worktreeRoot, "card-1"));
        controller.abort();
      }),
    } as unknown as GitClient;

    await expect(
      claimNextCard(trello, git, project, controller.signal),
    ).resolves.toBeNull();

    expect(moveCard).not.toHaveBeenCalled();
  });
});
