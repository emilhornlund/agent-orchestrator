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
    autoMerge: false,
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
      remediation: {
        model: "remediation",
        variant: "xhigh",
        maxPasses: 1,
      },
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
  vi.useRealTimers();

  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("claimNextCard", () => {
  it("returns null for an empty Ready list", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      claimNextCard(trello, {} as GitClient, createProject("/worktrees")),
    ).resolves.toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it.each([
    ["without a start date", undefined, true],
    ["with a past start date", "2026-09-02T02:00:00.000Z", true],
    ["with a start date reached exactly", "2026-09-02T03:15:00.000Z", true],
    ["with a future start date", "2026-09-02T04:00:00.000Z", false],
    [
      "with a reached timezone-offset start date",
      "2026-09-02T05:00:00+02:00",
      true,
    ],
  ] as const)(
    "treats an implementation card %s as eligible: %s",
    async (_case, start, eligible) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-02T03:15:00.000Z"));

      const worktreeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "claim-card-"),
      );
      temporaryDirectories.push(worktreeRoot);
      const candidate = {
        ...createCard("card-1"),
        ...(start === undefined ? {} : { start }),
      };
      const prepare = vi.fn(async (...args: unknown[]) => {
        fs.mkdirSync(args[1] as string);
      });
      const moveCard = vi.fn(async () => ({ ...candidate, idList: "working" }));
      const git = {
        fetch: vi.fn(async () => undefined),
        branchExists: vi.fn(async () => false),
        addWorktreeWithNewBranch: prepare,
      } as unknown as GitClient;
      const trello = {
        getCards: vi.fn().mockResolvedValue([candidate]),
        moveCard,
      } as unknown as TrelloClient;

      const result = await claimNextCard(
        trello,
        git,
        createProject(worktreeRoot),
      );

      expect(result?.card.id).toBe(eligible ? "card-1" : undefined);
      expect(prepare).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(moveCard).toHaveBeenCalledTimes(eligible ? 1 : 0);
    },
  );

  it("skips a future-dated card and claims the next eligible implementation card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T03:15:00.000Z"));

    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claim-card-"));
    temporaryDirectories.push(worktreeRoot);
    const futureCard = {
      ...createCard("future-card"),
      start: "2026-09-02T00:00:00-04:00",
    };
    const eligibleCard = createCard("eligible-card");
    const preparedCardIds: string[] = [];
    const moveCard = vi.fn(async (cardId: string) => ({
      ...createCard(cardId),
      idList: "working",
    }));
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repository, worktreePath: string) => {
          preparedCardIds.push(path.basename(worktreePath));
          fs.mkdirSync(worktreePath);
        },
      ),
    } as unknown as GitClient;
    const trello = {
      getCards: vi.fn().mockResolvedValue([futureCard, eligibleCard]),
      moveCard,
    } as unknown as TrelloClient;

    const result = await claimNextCard(
      trello,
      git,
      createProject(worktreeRoot),
    );

    expect(result?.card.id).toBe("eligible-card");
    expect(preparedCardIds).toEqual(["eligible-card"]);
    expect(moveCard).toHaveBeenCalledWith("eligible-card", "working");
    expect(moveCard).not.toHaveBeenCalledWith("future-card", "working");
  });

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
