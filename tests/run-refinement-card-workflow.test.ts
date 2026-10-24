import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
} from "../src/opencode/opencode-client.js";
import { runRefinementCardWorkflow } from "../src/refinement/run-refinement-card.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-card-workflow-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card-one");
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  const project = {
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
      path: repositoryPath,
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot,
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
  } as ProjectConfig;
  const card: TrelloCard = {
    id: "card-one",
    name: "Refine feature",
    desc: "Clarify the requested behavior.",
    idList: project.trello.workingListId,
    idLabels: [project.trello.refinementLabelId],
    url: "https://trello.example/card-one",
  };
  let cardList = project.trello.workingListId;
  let labels = [...card.idLabels];
  const trello = {
    updateCardContent: vi.fn(async () => undefined),
    addLabel: vi.fn(async (_id: string, labelId: string) => {
      labels = [...labels, labelId];
    }),
    removeLabel: vi.fn(async (_id: string, labelId: string) => {
      labels = labels.filter((existing) => existing !== labelId);
    }),
    moveCard: vi.fn(async (_id: string, listId: string) => {
      cardList = listId;
      return { ...card, idList: listId, idLabels: [...labels] };
    }),
    addComment: vi.fn(async () => undefined),
  } as unknown as TrelloClient;
  const git = {
    getStatus: vi.fn(async (cwd: string) =>
      fs.existsSync(getRefinementResultPath(cwd))
        ? "?? .agent-orchestrator/refinement-result.json"
        : "",
    ),
    getCurrentBranch: vi.fn(async () => `agent/${card.id}`),
    getRebaseState: vi.fn(async () => null),
    getConflictedPaths: vi.fn(async () => []),
    removeWorktree: vi.fn(async () => undefined),
    pruneWorktrees: vi.fn(async () => undefined),
    branchExists: vi.fn(async () => false),
    resetHard: vi.fn(async () => undefined),
    cleanUntracked: vi.fn(async () => undefined),
  } as unknown as GitClient;
  const runOpenCode = vi.fn(async (options: OpenCodeRunOptions) => {
    const resultPath = getRefinementResultPath(options.cwd);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        title: "Refined",
        description: "## Requirements",
        type: "feature",
      }),
    );
    return { exitCode: 0, output: "complete", errorOutput: "" };
  });
  return {
    project,
    card,
    trello,
    git,
    openCode: new OpenCodeClient(runOpenCode),
    runOpenCode,
    worktreePath,
    cardList: () => cardList,
    labels: () => labels,
  };
}

function run(
  f: ReturnType<typeof fixture>,
  signal = new AbortController().signal,
) {
  return runRefinementCardWorkflow({
    trello: f.trello,
    git: f.git,
    openCode: f.openCode,
    project: f.project,
    card: f.card,
    signal,
    preparedWorktree: { path: f.worktreePath, branch: `agent/${f.card.id}` },
    prepareAttachmentContext: async () => undefined,
  });
}

describe("runRefinementCardWorkflow", () => {
  it.each([
    [
      "malformed result",
      "Invalid refinement result JSON",
      async (f: ReturnType<typeof fixture>) => {
        vi.mocked(f.runOpenCode).mockImplementationOnce(async (options) => {
          const resultPath = getRefinementResultPath(options.cwd);
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          fs.writeFileSync(resultPath, "not-json");
          return { exitCode: 0, output: "done", errorOutput: "" };
        });
      },
    ],
    [
      "failed execution",
      "OpenCode refinement exited with code 7",
      async (f: ReturnType<typeof fixture>) => {
        vi.mocked(f.runOpenCode).mockImplementationOnce(async (options) => {
          const modifiedPath = path.join(options.cwd, "src", "agent-change.ts");
          fs.mkdirSync(path.dirname(modifiedPath), { recursive: true });
          fs.writeFileSync(modifiedPath, "preserve me");
          return { exitCode: 7, output: "", errorOutput: "failure" };
        });
      },
    ],
  ] as const)(
    "moves a %s refinement to Failed without publishing",
    async (_label, expectedError, configure) => {
      const f = fixture();
      await configure(f);
      await expect(run(f)).rejects.toThrow(expectedError);
      expect(f.cardList()).toBe(f.project.trello.failedListId);
      expect(f.trello.moveCard).toHaveBeenCalledWith(
        f.card.id,
        f.project.trello.failedListId,
      );
      expect(f.trello.updateCardContent).not.toHaveBeenCalled();
      expect(f.git.resetHard).not.toHaveBeenCalled();
      expect(f.git.cleanUntracked).not.toHaveBeenCalled();
      if (_label === "failed execution") {
        expect(
          fs.readFileSync(
            path.join(f.worktreePath, "src", "agent-change.ts"),
            "utf8",
          ),
        ).toBe("preserve me");
      }
    },
  );

  it("preserves the isolated worktree when shutdown interrupts terminal cleanup", async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.git.getCurrentBranch).mockImplementationOnce(async () => {
      controller.abort();
      return `agent/${f.card.id}`;
    });

    await run(f, controller.signal);

    expect(f.cardList()).toBe(f.project.trello.backlogListId);
    expect(fs.existsSync(f.worktreePath)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });
});
