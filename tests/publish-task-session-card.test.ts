import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  publishCard,
  type PublishCardOptions,
} from "../src/orchestrator/publish-card.js";
import { publishTaskSessionCard } from "../src/orchestrator/publish-task-session-card.js";
import {
  readPendingCommitState,
  readTrustedCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
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
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValue("b".repeat(40)),
    stageAll: vi.fn(),
    commit: vi.fn(),
    getCommitCountBetween: vi.fn().mockResolvedValue(1),
    getStatus: vi.fn().mockResolvedValue(""),
  } as unknown as GitClient;
  const base = {
    trello: {} as never,
    git,
    github: {} as never,
    opencode: { run: vi.fn() } as never,
    commands: { run: vi.fn() } as never,
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
  it("writes a durable parent intent before Git commit and clears it after trust", async () => {
    const { base, git } = fixture();
    vi.mocked(git.commit).mockImplementation(async () => {
      expect(readPendingCommitState(base.project, base.card.id)).toMatchObject({
        parentSha: "a".repeat(40),
        taskBranch: "agent/card",
      });
      expect(readTrustedCommitState(base.project, base.card.id)).toBeNull();
    });
    await publishTaskSessionCard(base as never);
    expect(readPendingCommitState(base.project, base.card.id)).toBeNull();
    expect(readTrustedCommitState(base.project, base.card.id)?.commitSha).toBe(
      "b".repeat(40),
    );
  });

  it("preserves unresolved commit intent when commit execution fails", async () => {
    const { base, git } = fixture();
    vi.mocked(git.commit).mockRejectedValueOnce(
      new Error("commit interrupted"),
    );
    await expect(publishTaskSessionCard(base as never)).rejects.toThrow(
      "commit interrupted",
    );
    expect(readPendingCommitState(base.project, base.card.id)).toMatchObject({
      parentSha: "a".repeat(40),
    });
    await expect(publishTaskSessionCard(base as never)).rejects.toThrow(
      "Unresolved pending task commit intent",
    );
    expect(git.commit).toHaveBeenCalledOnce();
  });

  it("creates a human-review commit when final review evidence is missing", async () => {
    const { base, git } = fixture();
    await expect(
      publishTaskSessionCard({
        ...base,
        initialEvidence: { ...evidence, review: null },
      } as never),
    ).resolves.toBe("b".repeat(40));
    expect(git.stageAll).toHaveBeenCalledOnce();
  });

  it("creates one trusted commit and asks for a fresh gate before push", async () => {
    const { base, git } = fixture();
    const emailNotifier = { send: vi.fn() };
    const claimHumanReviewNotification = vi.fn(() => true);
    const commitSha = await publishTaskSessionCard({
      ...base,
      emailNotifier,
      claimHumanReviewNotification,
    } as never);
    expect(commitSha).toBe("b".repeat(40));
    expect(git.stageAll).toHaveBeenCalledOnce();
    expect(git.commit).toHaveBeenCalledOnce();
    expect(publishCard).toHaveBeenCalledWith(
      expect.objectContaining({
        beforePushVerification: expect.any(Function),
        opencode: base.opencode,
        commands: base.commands,
        emailNotifier,
        claimHumanReviewNotification,
      }),
    );
    expect(vi.mocked(publishCard).mock.calls[0]?.[0]).not.toHaveProperty(
      "deferAutoMerge",
    );
  });

  it("publishes exhausted failed reviews only to Human Review with valid snapshot evidence", async () => {
    const { base, git } = fixture();
    const failed = {
      ...evidence.review!,
      verdict: "fail" as const,
      blockingFindings: [
        {
          kind: "defect" as const,
          summary: "Open issue",
          detail: "Needs human review",
        },
      ],
    };
    const withFailure = { ...evidence, review: failed };
    const committed = await publishTaskSessionCard({
      ...base,
      reviewResult: "Failed (human review required)",
      exhaustedReview: failed,
      initialEvidence: withFailure,
      verifyPreparedContent: async () => withFailure,
    } as never);
    expect(committed).toBe("b".repeat(40));
    expect(git.stageAll).toHaveBeenCalledOnce();
    expect(publishCard).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewResult: "Failed (human review required)",
        exhaustedReview: failed,
      }),
    );
  });

  it("publishes a failed review without exhaustion evidence for human review", async () => {
    const { base, git } = fixture();
    await expect(
      publishTaskSessionCard({
        ...base,
        initialEvidence: {
          ...evidence,
          review: {
            ...evidence.review!,
            verdict: "fail",
            blockingFindings: [
              {
                kind: "defect",
                summary: "Needs review",
                detail: "Open finding",
              },
            ],
          },
        },
      } as never),
    ).resolves.toBe("b".repeat(40));
    expect(git.stageAll).toHaveBeenCalledOnce();
  });

  it("publishes a rebased exhausted review only when the new head passes current validation", async () => {
    const { base, git } = fixture();
    const failed = {
      ...evidence.review!,
      verdict: "fail" as const,
      blockingFindings: [
        {
          kind: "defect" as const,
          summary: "Open issue",
          detail: "Needs human review",
        },
      ],
    };
    const rebasedIdentity = `sha256:${"c".repeat(64)}`;
    const prepared = {
      ...evidence,
      currentContentIdentity: rebasedIdentity,
      validation: { ...evidence.validation!, contentIdentity: rebasedIdentity },
      review: failed,
    };
    vi.mocked(git.getHeadSha)
      .mockReset()
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValueOnce("b".repeat(40))
      .mockResolvedValue("c".repeat(40));
    const head = await publishTaskSessionCard({
      ...base,
      exhaustedReview: failed,
      initialEvidence: { ...evidence, review: failed },
      verifyPreparedContent: async () => prepared,
    } as never);
    expect(head).toBe("c".repeat(40));
    expect(git.getStatus).toHaveBeenCalled();
    expect(publishCard).toHaveBeenCalledOnce();
  });

  it("refuses a rebased exhausted review when validation belongs to the previous head", async () => {
    const { base, git } = fixture();
    const failed = {
      ...evidence.review!,
      verdict: "fail" as const,
      blockingFindings: [
        {
          kind: "defect" as const,
          summary: "Open issue",
          detail: "Needs human review",
        },
      ],
    };
    vi.mocked(git.getHeadSha)
      .mockReset()
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValueOnce("b".repeat(40))
      .mockResolvedValue("c".repeat(40));
    await expect(
      publishTaskSessionCard({
        ...base,
        exhaustedReview: failed,
        initialEvidence: { ...evidence, review: failed },
        verifyPreparedContent: async () => ({
          ...evidence,
          currentContentIdentity: `sha256:${"c".repeat(64)}`,
          review: failed,
        }),
      } as never),
    ).rejects.toThrow("Local validation evidence is stale");
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
