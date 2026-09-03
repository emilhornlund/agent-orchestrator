import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import { claimNextRefinementCard } from "../src/orchestrator/claim-next-refinement-card.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

type Project = Config["projects"][number];
const temporaryDirectories: string[] = [];

function project(worktreeRoot: string): Project {
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

function card(id: string, labels = ["refinement"]): TrelloCard {
  return {
    id,
    name: id,
    desc: "",
    idList: "ready",
    idLabels: labels,
    url: `https://trello.com/c/${id}`,
  };
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("claimNextRefinementCard", () => {
  it("returns null for an empty Ready list", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      claimNextRefinementCard(trello, {} as GitClient, project("/worktrees")),
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
    "treats a refinement card %s as eligible: %s",
    async (_case, start, eligible) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-02T03:15:00.000Z"));

      const worktreeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "claim-refinement-"),
      );
      temporaryDirectories.push(worktreeRoot);
      const candidate = {
        ...card("card-1"),
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

      const result = await claimNextRefinementCard(
        trello,
        git,
        project(worktreeRoot),
      );

      expect(result?.card.id).toBe(eligible ? "card-1" : undefined);
      expect(prepare).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(moveCard).toHaveBeenCalledTimes(eligible ? 1 : 0);
    },
  );

  it("skips a future refinement and claims the next eligible refinement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T03:15:00.000Z"));

    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "claim-refinement-"),
    );
    temporaryDirectories.push(worktreeRoot);
    const futureCard = {
      ...card("future-card"),
      start: "2026-09-02T00:00:00-04:00",
    };
    const eligibleCard = card("eligible-card");
    const preparedCardIds: string[] = [];
    const moveCard = vi.fn(async (cardId: string) => ({
      ...card(cardId),
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

    const result = await claimNextRefinementCard(
      trello,
      git,
      project(worktreeRoot),
    );

    expect(result?.card.id).toBe("eligible-card");
    expect(preparedCardIds).toEqual(["eligible-card"]);
    expect(moveCard).toHaveBeenCalledWith("eligible-card", "working");
    expect(moveCard).not.toHaveBeenCalledWith("future-card", "working");
  });

  it("prepares and passes the claimed refinement worktree to processing", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "claim-refinement-"),
    );
    temporaryDirectories.push(worktreeRoot);
    const events: string[] = [];
    const git = {
      fetch: vi.fn(async () => events.push("fetch")),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(async () => {
        events.push("prepare");
        fs.mkdirSync(path.join(worktreeRoot, "card-1"));
      }),
    } as unknown as GitClient;
    const trello = {
      getCards: vi.fn().mockResolvedValue([card("card-1")]),
      moveCard: vi.fn(async () => {
        events.push("move");
        return { ...card("card-1"), idList: "working" };
      }),
    } as unknown as TrelloClient;

    const result = await claimNextRefinementCard(
      trello,
      git,
      project(worktreeRoot),
    );

    expect(result?.card.id).toBe("card-1");
    expect(result?.worktree.path).toBe(path.join(worktreeRoot, "card-1"));
    expect(events).toEqual(["fetch", "prepare", "move"]);
  });

  it("does not move an implementation-only card", async () => {
    const trello = {
      getCards: vi.fn().mockResolvedValue([card("card-1", ["feature"])]),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      claimNextRefinementCard(trello, {} as GitClient, project("/worktrees")),
    ).resolves.toBeNull();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
