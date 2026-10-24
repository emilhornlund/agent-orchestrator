import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { observeTaskSessionReviewCards } from "../src/orchestrator/observe-task-session-review-cards.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "review-monitor-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreeRoot);
  fs.writeFileSync(
    path.join(repositoryPath, "keep.txt"),
    "source checkout remains untouched",
  );
  const project = {
    id: "project",
    executionMode: "task-session",
    autoMerge: false,
    repository: {
      path: repositoryPath,
      worktreeRoot,
      github: "owner/repo",
      defaultBranch: "main",
      requiredChecks: ["Build", "Tests"],
    },
    trello: {
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
  } as ProjectConfig;
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const cards: TrelloCard[] = ["card-one", "card-two"].map((id) => ({
    id,
    name: id,
    desc: "",
    idList: "review",
    idLabels: [],
    url: `https://trello.example/${id}`,
  }));
  const headByCard = new Map([
    ["card-one", "a".repeat(40)],
    ["card-two", "b".repeat(40)],
  ]);
  for (const card of cards) {
    const sha = headByCard.get(card.id)!;
    const record: TaskExecutionRecord = {
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "human-feedback",
      primarySessionId: `session-${card.id}`,
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      pullRequest: {
        number: card.id === "card-one" ? 1 : 2,
        url: `https://github.com/owner/repo/pull/${card.id === "card-one" ? 1 : 2}`,
        headSha: sha,
      },
      operationKey: `operation-${card.id}`,
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    };
    store.create(record);
  }
  const github = {
    findPullRequestState: vi.fn(
      async ({ headBranch }: { headBranch: string }) => {
        const cardId = headBranch.slice("agent/".length);
        const number = cardId === "card-one" ? 1 : 2;
        return {
          url: `https://github.com/owner/repo/pull/${number}`,
          state: "OPEN",
          mergedAt: null,
          headRefOid: headByCard.get(cardId),
        };
      },
    ),
    getRequiredChecks: vi.fn(async ({ headSha }: { headSha: string }) => ({
      headSha,
      checks: ["Build", "Tests"].map((name) => ({
        name,
        headSha,
        status: "queued" as const,
        conclusion: null,
        diagnostic: "",
      })),
    })),
    findChangesRequestedPullRequest: vi.fn(
      async ({ headBranch }: { headBranch: string }) => ({
        headSha: headByCard.get(headBranch.slice("agent/".length))!,
        feedback: {
          reviews: [
            {
              id: 7,
              body: "Fix it",
              author: "reviewer",
              submittedAt: "2026-10-24T09:00:00.000Z",
              inlineComments: [],
            },
          ],
        },
        url: "",
      }),
    ),
    getPullRequestConversationComments: vi.fn(
      async ({ pullRequestUrl }: { pullRequestUrl: string }) => [
        {
          id: pullRequestUrl.endsWith("/1") ? 101 : 202,
          author: "reviewer",
          createdAt: "2026-10-24T09:00:00.000Z",
          updatedAt: null,
          body: "Comment",
        },
      ],
    ),
  } as unknown as GitHubClient;
  return { project, store, cards, github, repositoryPath, headByCard };
}

describe("observeTaskSessionReviewCards", () => {
  it("observes multiple owned review cards independently without repository writes", async () => {
    const f = fixture();
    const observed = await observeTaskSessionReviewCards({
      project: f.project,
      cards: f.cards,
      taskRecordStore: f.store,
      github: f.github,
    });
    expect(observed.map(({ cardId }) => cardId)).toEqual([
      "card-one",
      "card-two",
    ]);
    expect(observed.map(({ headSha }) => headSha)).toEqual([
      f.headByCard.get("card-one"),
      f.headByCard.get("card-two"),
    ]);
    expect(observed[0]?.feedbackIds).toContain("conversation-comment:101");
    expect(observed[1]?.feedbackIds).toContain("conversation-comment:202");
    expect(f.store.read("card-one")?.reviewObservation?.headSha).toBe(
      f.headByCard.get("card-one"),
    );
    expect(f.store.read("card-two")?.reviewObservation?.headSha).toBe(
      f.headByCard.get("card-two"),
    );
    expect(
      fs.readFileSync(path.join(f.repositoryPath, "keep.txt"), "utf8"),
    ).toBe("source checkout remains untouched");
    expect(
      (
        f.github as unknown as {
          getRequiredChecks: { mock: { calls: unknown[][] } };
        }
      ).getRequiredChecks.mock.calls,
    ).toHaveLength(2);
  });

  it("does not persist observations for a card whose authoritative PR head mismatches", async () => {
    const f = fixture();
    vi.mocked(f.github.findPullRequestState).mockImplementation(
      async ({ headBranch }) => ({
        url: `https://github.com/owner/repo/pull/${headBranch.endsWith("one") ? 1 : 2}`,
        state: "OPEN",
        mergedAt: null,
        headRefOid: "c".repeat(40),
      }),
    );
    await expect(
      observeTaskSessionReviewCards({
        project: f.project,
        cards: f.cards.slice(0, 1),
        taskRecordStore: f.store,
        github: f.github,
      }),
    ).rejects.toThrow("identity or head changed");
    expect(f.store.read("card-one")?.reviewObservation).toBeUndefined();
  });
});
