import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { isOwnedMaintenanceWorktreePath } from "../src/orchestrator/maintain-outdated-pr.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";

const root = path.join(path.sep, "worktrees");
const project = {
  id: "project",
  repository: { path: path.join(path.sep, "source"), worktreeRoot: root },
} as ProjectConfig;

afterEach(() => vi.restoreAllMocks());

describe("PR maintenance worktree identity", () => {
  it("accepts the canonical attempt-suffixed worktree and rejects a legacy alias", () => {
    const attemptId = "12345678-1234-1234-1234-123456789abc";
    const name = `card--${attemptId}`;
    const ownedPath = path.join(root, name);
    const run = {
      cardId: "card",
      attemptId,
      pinned: { worktreeRoot: root },
      resources: [
        { kind: "worktree", id: "card", path: ownedPath },
        { kind: "branch", id: "card", path: `refs/heads/agent/${name}` },
      ],
    } as unknown as RunRecord;
    vi.spyOn(ProjectRunAuthority, "current").mockReturnValue({
      store: { read: () => run },
    } as unknown as ProjectRunAuthority);

    expect(isOwnedMaintenanceWorktreePath(project, "card", ownedPath)).toBe(true);
    expect(isOwnedMaintenanceWorktreePath(project, "card", path.join(root, "card"))).toBe(false);
    expect(isOwnedMaintenanceWorktreePath(project, "card", path.join(root, "other"))).toBe(false);
  });

  it("continues accepting the exact legacy card-only worktree without an active attempt", () => {
    vi.spyOn(ProjectRunAuthority, "current").mockReturnValue(undefined);
    expect(isOwnedMaintenanceWorktreePath(project, "card", path.join(root, "card"))).toBe(true);
    expect(
      isOwnedMaintenanceWorktreePath(project, "card", path.join(root, "card--other")),
    ).toBe(false);
  });
});
