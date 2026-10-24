import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { PublishCardOptions } from "../src/orchestrator/publish-card.js";
import { publishTaskSessionCard } from "../src/orchestrator/publish-task-session-card.js";
import type { VerifiedPublicationDecisionInput } from "../src/task-session/verified-publication-decision.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

vi.mock("../src/orchestrator/publish-card.js", () => ({
  publishCard: vi.fn(async (options: PublishCardOptions) => {
    await options.beforePushVerification?.();
  }),
}));

const identity = `sha256:${"a".repeat(64)}`;
const evidence: VerifiedPublicationDecisionInput = {
  currentContentIdentity: identity,
  validationCommand: "yarn validate",
  validation: {
    command: "yarn validate",
    startedAt: "2026-10-24T09:00:00.000Z",
    completedAt: "2026-10-24T09:01:00.000Z",
    exitCode: 0,
    status: "passed",
    timedOut: false,
    aborted: false,
    diagnostic: "passed",
    contentIdentity: identity,
  },
  coverage: null,
  review: {
    version: 1,
    projectId: "project",
    cardId: "card",
    verdict: "pass",
    requirementAssessments: [
      {
        requirementId: "REQ-1",
        status: "satisfied",
        details: "Implemented",
        evidence: ["source.ts"],
      },
    ],
    blockingFindings: [],
    reviewedContentIdentity: identity,
  },
};

function fixture() {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "task-session-publish-"),
  );
  temporaryRoots.push(stateRoot);
  const project = {
    id: "project",
    repository: {
      worktreeRoot: stateRoot,
      defaultBranch: "main",
      gitIdentity: { name: "Agent", email: "agent@example.test" },
    },
  } as ProjectConfig;
  const card = { id: "card" } as TrelloCard;
  const git = {
    getHeadSha: vi
      .fn()
      .mockResolvedValueOnce("before")
      .mockResolvedValue("after"),
    stageAll: vi.fn(),
    commit: vi.fn(),
    getCommitCountBetween: vi.fn().mockResolvedValue(1),
    getStatus: vi.fn().mockResolvedValue(""),
  } as unknown as GitClient;
  const base = {
    trello: {} as never,
    git,
    github: {} as never,
    project,
    card,
    worktreePath: "/task-worktree",
    branch: "agent/card",
    reviewResult: "Passed",
    remediationResult: "Not required",
    commitMessage: "feat: implement task",
    initialEvidence: evidence,
    verifyPreparedContent: async () => evidence,
  } as const;
  return { base, git, stateRoot };
}

describe("publishTaskSessionCard", () => {
  it("blocks before staging when required evidence is absent", async () => {
    const { base, git } = fixture();
    await expect(
      publishTaskSessionCard({
        ...base,
        initialEvidence: { ...evidence, review: null },
      } as never),
    ).rejects.toThrow("final implementation review is missing");
    expect(git.stageAll).not.toHaveBeenCalled();
  });

  it("creates one trusted commit and asks for a fresh gate before push", async () => {
    const { base, git } = fixture();
    const commitSha = await publishTaskSessionCard(base as never);
    expect(commitSha).toBe("after");
    expect(git.stageAll).toHaveBeenCalledOnce();
    expect(git.commit).toHaveBeenCalledOnce();
  });

  it("refuses publication when prepared content has stale evidence", async () => {
    const { base, git } = fixture();
    await expect(
      publishTaskSessionCard({
        ...base,
        verifyPreparedContent: async () => ({
          ...evidence,
          currentContentIdentity: `sha256:${"b".repeat(64)}`,
        }),
      } as never),
    ).rejects.toThrow("Local validation evidence is stale");
    expect(git.stageAll).toHaveBeenCalledOnce();
  });
});
