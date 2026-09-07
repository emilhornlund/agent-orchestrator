import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { PullRequestReviewFeedback } from "../src/github/github-client.js";
import {
  getRequestedChangeNoOpIdentity,
  matchesRequestedChangeNoOp,
  readRequestedChangeNoOpState,
  writeRequestedChangeNoOpState,
} from "../src/orchestrator/requested-change-no-op-state.js";

const directories: string[] = [];

function createProject(worktreeRoot: string): ProjectConfig {
  return {
    id: "project",
    repository: {
      path: "/repo",
      github: "owner/repo",
      defaultBranch: "main",
      worktreeRoot,
    },
    trello: {
      boardId: "board",
      backlogListId: "backlog",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
    },
  } as ProjectConfig;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("requested-change no-op state", () => {
  it("persists an identity for the pull request head and attributed feedback", () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "requested-change-no-op-state-"),
    );
    directories.push(worktreeRoot);
    const project = createProject(worktreeRoot);
    const feedback: PullRequestReviewFeedback = {
      reviews: [
        {
          id: 42,
          body: "Already satisfied",
          author: "reviewer",
          submittedAt: "2026-09-01T10:00:00Z",
          inlineComments: [],
        },
      ],
    };
    const input = {
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      headSha: "a".repeat(40),
      feedback,
    };

    const state = writeRequestedChangeNoOpState(project, "card-1", input);
    const restored = readRequestedChangeNoOpState(project, "card-1");

    expect(restored).toEqual(state);
    expect(state.reviewIds).toEqual([42]);
    expect(state.identity).toBe(getRequestedChangeNoOpIdentity(input));
    expect(matchesRequestedChangeNoOp(state, input)).toBe(true);
    expect(
      matchesRequestedChangeNoOp(state, {
        ...input,
        headSha: "b".repeat(40),
      }),
    ).toBe(false);
    expect(
      matchesRequestedChangeNoOp(state, {
        ...input,
        feedback: {
          reviews: [
            {
              id: 43,
              body: "Already satisfied",
              author: "reviewer",
              submittedAt: "2026-09-01T10:00:00Z",
              inlineComments: [],
            },
          ],
        } satisfies PullRequestReviewFeedback,
      }),
    ).toBe(false);
  });
});
