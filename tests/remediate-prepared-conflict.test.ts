import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { remediatePreparedConflict } from "../src/orchestrator/remediate-prepared-conflict.js";
import type { PreparedConflictHandoff } from "../src/orchestrator/prepared-conflict-state.js";

describe("prepared conflict recovery refusal", () => {
  it.each([
    "active rebase",
    "completed local rebase",
    "historically published PR",
  ])(
    "preserves the handoff and refuses %s continuation without external calls",
    async () => {
      const git = {
        getRemoteBranchSha: vi.fn(),
        rebase: vi.fn(),
      } as unknown as GitClient;
      const github = {
        findPullRequest: vi.fn(),
        findPullRequestState: vi.fn(),
      } as unknown as GitHubClient;
      const opencode = { run: vi.fn() } as unknown as OpenCodeClient;
      const project = {
        id: "project",
        repository: { github: "owner/repo", worktreeRoot: "/worktrees" },
      } as ProjectConfig;
      const card = { id: "card-1", name: "Task", desc: "Task" } as TrelloCard;
      const handoff = {
        version: 1,
        kind: "prepared-conflict",
        projectId: "project",
        cardId: "card-1",
        taskBranch: "agent/card-1",
        defaultBranch: "main",
        origin: "initial-publication",
        conflictedPaths: ["src/file.ts"],
        rebase: {
          active: true,
          backend: "merge",
          headName: "refs/heads/agent/card-1",
          onto: "abc",
          originalHead: "def",
        },
        preparedAt: new Date().toISOString(),
      } as PreparedConflictHandoff;

      await expect(
        remediatePreparedConflict({
          git,
          github,
          opencode,
          project,
          card,
          handoff,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("disabled to protect published history");
      expect(git.getRemoteBranchSha).not.toHaveBeenCalled();
      expect(git.rebase).not.toHaveBeenCalled();
      expect(github.findPullRequest).not.toHaveBeenCalled();
      expect(github.findPullRequestState).not.toHaveBeenCalled();
      expect(opencode.run).not.toHaveBeenCalled();
      expect(handoff.conflictedPaths).toEqual(["src/file.ts"]);
    },
  );
});
