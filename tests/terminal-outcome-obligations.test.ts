import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { PullRequestState } from "../src/github/github-client.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";
import {
  returnClosedTaskSessionPullRequestToBacklog,
  completeMergedTaskSessionPullRequest,
} from "../src/orchestrator/reconcile-terminal-task-session-pr.js";

describe("closed PR terminal obligations", () => {
  it("does not delete a remote branch changed after the human merge", async () => {
    const git = {
      getRemoteBranchSha: vi.fn().mockResolvedValue("b".repeat(40)),
      deleteRemoteBranch: vi.fn(),
    };
    await expect(
      completeMergedTaskSessionPullRequest({
        project: {
          id: "project",
          repository: { path: "/repo", worktreeRoot: "/worktrees" },
        } as ProjectConfig,
        git: git as unknown as GitClient,
        trello: {} as TrelloClient,
        card: { id: "card" } as TrelloCard,
        pullRequest: {
          state: "MERGED",
          mergedAt: "now",
          headRefOid: "a".repeat(40),
          url: "https://github.com/owner/repo/pull/1",
        } as PullRequestState,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("differs from the verified PR head");
    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
  });
  it.each(["review", "backlog"])(
    "retains the terminal obligation when its required comment fails in %s",
    async (idList) => {
      const failure = new Error("comment rejected");
      const trello = {
        moveCard: vi.fn().mockResolvedValue(undefined),
        addComment: vi.fn().mockRejectedValue(failure),
      };
      await expect(
        returnClosedTaskSessionPullRequestToBacklog({
          trello: trello as unknown as TrelloClient,
          git: {} as GitClient,
          project: {
            id: "project",
            trello: { backlogListId: "backlog" },
          } as ProjectConfig,
          card: { id: "card", idList } as TrelloCard,
          pullRequest: {
            state: "CLOSED",
            mergedAt: null,
            url: "https://github.com/owner/repo/pull/1",
          } as PullRequestState,
          preserveWorktree: true,
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(failure);
      expect(trello.addComment).toHaveBeenCalledWith(
        "card",
        expect.stringContaining("https://github.com/owner/repo/pull/1"),
      );
      expect(trello.moveCard).toHaveBeenCalledTimes(idList === "review" ? 1 : 0);
    },
  );
});
