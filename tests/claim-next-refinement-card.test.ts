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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("claimNextRefinementCard", () => {
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
