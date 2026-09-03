import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import { claimNextReadyCard } from "../src/orchestrator/claim-next-ready-card.js";
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
      remediation: { model: "remediation", variant: "xhigh", maxPasses: 1 },
      commit: { model: "commit", variant: "low" },
      timeoutMinutes: 360,
    },
  };
}

function createCard(id: string, idLabels: string[]): TrelloCard {
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

describe("claimNextReadyCard", () => {
  it.each([
    {
      name: "implementation above refinement",
      cards: [
        createCard("implementation", ["feature"]),
        createCard("refinement", ["refinement"]),
      ],
      expectedCard: "implementation",
      expectedWorkflow: "implementation",
    },
    {
      name: "refinement above implementation",
      cards: [
        createCard("refinement", ["refinement"]),
        createCard("implementation", ["bug"]),
      ],
      expectedCard: "refinement",
      expectedWorkflow: "refinement",
    },
    {
      name: "interleaved workflows after unlabelled cards",
      cards: [
        createCard("ignored-top", []),
        createCard("refinement", ["refinement", "improvement"]),
        createCard("implementation", ["feature"]),
        createCard("ignored-middle", []),
        createCard("later-implementation", ["bug"]),
      ],
      expectedCard: "refinement",
      expectedWorkflow: "refinement",
    },
  ])(
    "selects the first eligible card for $name and routes its workflow",
    async ({ cards, expectedCard, expectedWorkflow }) => {
      const worktreeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "claim-ready-card-"),
      );
      temporaryDirectories.push(worktreeRoot);
      const project = createProject(worktreeRoot);
      const preparedCardIds: string[] = [];
      const moveCard = vi.fn(async (cardId: string) => ({
        ...cards.find((candidate) => candidate.id === cardId)!,
        idList: "working",
      }));
      const git = {
        fetch: vi.fn(async () => undefined),
        branchExists: vi.fn(async () => false),
        addWorktreeWithNewBranch: vi.fn(
          async (_repository: string, worktreePath: string) => {
            preparedCardIds.push(path.basename(worktreePath));
            fs.mkdirSync(worktreePath);
          },
        ),
      } as unknown as GitClient;
      const trello = {
        getCards: vi.fn().mockResolvedValue(cards),
        moveCard,
      } as unknown as TrelloClient;

      const result = await claimNextReadyCard(trello, git, project);

      expect(result?.card.id).toBe(expectedCard);
      expect(result?.workflow).toBe(expectedWorkflow);
      expect(preparedCardIds).toEqual([expectedCard]);
      expect(moveCard).toHaveBeenCalledWith(expectedCard, "working");
      expect(trello.getCards).toHaveBeenCalledTimes(1);
    },
  );
});
