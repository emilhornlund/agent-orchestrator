import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { RequiredCheckObservation } from "../src/github/github-client.js";
import { decideVerifiedPublication } from "../src/task-session/verified-publication-decision.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { runTaskSessionCiRepairs } from "../src/task-session/run-task-session-ci-repairs.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { reconcileFeedbackRound } from "../src/task-session/reconcile-feedback-round.js";
import { selectActionableFeedback } from "../src/task-session/select-actionable-feedback.js";
import { publishVerifiedFeedbackReplies } from "../src/task-session/publish-verified-feedback-replies.js";
import { reconcileTaskSession } from "../src/task-session/reconcile-task-session.js";
import { observeTaskSessionReviewCards } from "../src/orchestrator/observe-task-session-review-cards.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { FeedbackLedgerEntry } from "../src/task-session/feedback-ledger.js";
import type { FeedbackVerificationResult } from "../src/task-session/feedback-verification.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function projectFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mocked-lifecycle-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(path.join(worktreeRoot, "card"), { recursive: true });
  const project = {
    id: "project",
    executionMode: "task-session",
    autoMerge: false,
    trello: {
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
    repository: {
      path: repositoryPath,
      worktreeRoot,
      github: "owner/repo",
      defaultBranch: "main",
      requiredChecks: ["Build"],
      validationCommand: "yarn validate",
    },
  } as ProjectConfig;
  const taskStore = new TaskExecutionStore(path.join(root, "state"), project);
  const ledgerStore = new FeedbackLedgerStore(
    path.join(root, "state"),
    project,
  );
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const record: TaskExecutionRecord = {
    version: 1,
    projectId: project.id,
    cardId: "card",
    phase: "ci",
    primarySessionId: "primary-session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    pullRequest: {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      headSha: headA,
    },
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
  taskStore.create(record);
  const qualityIdentity = `sha256:${"c".repeat(64)}`;
  const quality = {
    currentContentIdentity: qualityIdentity,
    validationCommand: "yarn validate",
    validation: {
      command: "yarn validate",
      startedAt: "2026-10-24T09:00:00.000Z",
      completedAt: "2026-10-24T09:01:00.000Z",
      exitCode: 0,
      status: "passed" as const,
      timedOut: false,
      aborted: false,
      diagnostic: "ok",
      contentIdentity: qualityIdentity,
    },
    coverage: null,
    review: {
      version: 1 as const,
      projectId: "project",
      cardId: "card",
      verdict: "pass" as const,
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "satisfied" as const,
          details: "Done",
          evidence: ["src/fix.ts"],
        },
      ],
      blockingFindings: [],
      reviewedContentIdentity: qualityIdentity,
    },
  };
  return {
    project,
    taskStore,
    ledgerStore,
    record,
    headA,
    headB,
    quality,
    qualityIdentity,
  };
}

const check = (
  headSha: string,
  status: RequiredCheckObservation["status"],
): RequiredCheckObservation => ({
  name: "Build",
  headSha,
  status,
  conclusion: status === "succeeded" ? "success" : null,
  diagnostic: "",
});
const feedback = (id: string): FeedbackLedgerEntry => ({
  kind: "inline-comment",
  id,
  author: "reviewer",
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: null,
  body: `Fix ${id}`,
  threadId: `thread-${id}`,
  actionability: "actionable",
  status: "pending",
  verificationEvidence: [],
  isResolved: false,
  isOutdated: false,
});

describe("mocked task-session lifecycle scenarios", () => {
  it("blocks failed validation/coverage evidence before publication readiness", () => {
    const f = projectFixture();
    expect(
      decideVerifiedPublication({ ...f.quality, validation: null }).allowed,
    ).toBe(false);
    expect(
      decideVerifiedPublication({
        ...f.quality,
        coverageCommand: "yarn coverage",
        coverage: {
          ...f.quality.validation!,
          command: "yarn coverage",
          status: "failed",
          exitCode: 1,
        },
      }).allowed,
    ).toBe(false);
    expect(decideVerifiedPublication(f.quality).allowed).toBe(true);
  });

  it("repairs failed CI through the same task session, reruns gates, and then reconciles two human-feedback rounds", async () => {
    const f = projectFixture();
    const queue = new TaskMutationQueue(path.join(root!, "state"), f.project);
    queue.enqueue({
      projectId: f.project.id,
      cardId: "card",
      eventId: "ci-event",
      kind: "ci-repair",
      operationKey: "operation:ci",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    expect(queue.claimNext()?.eventId).toBe("ci-event");
    const repairPrimarySession = vi.fn(
      async (_diagnostics, _attempt, session) =>
        expect(session).toBe("primary-session"),
    );
    const rerunLocalGatesAndReview = vi.fn(async () =>
      expect(decideVerifiedPublication(f.quality).allowed).toBe(true),
    );
    const ciResult = await runTaskSessionCiRepairs({
      store: f.taskStore,
      projectId: "project",
      cardId: "card",
      operationKey: "operation",
      expectedPrimarySessionId: "primary-session",
      headSha: f.headA,
      observeChecks: async (head) => [
        check(head, head === f.headA ? "failed" : "succeeded"),
      ],
      collectDiagnostics: async (_head, checks) => [
        {
          name: checks[0]!.name,
          checkRunId: 1,
          headSha: _head,
          logUrl: null,
          available: true,
          diagnostic: "compile error",
        },
      ],
      repairPrimarySession,
      rerunLocalGatesAndReview,
      publishSamePullRequest: async () => f.headB,
    });
    expect(ciResult.status).toBe("passed");
    expect(repairPrimarySession).toHaveBeenCalledOnce();
    expect(rerunLocalGatesAndReview).toHaveBeenCalledOnce();
    queue.complete("ci-event");

    const current = f.taskStore.read("card")!;
    f.taskStore.compareAndSwap("card", current.revision, {
      ...current,
      phase: "human-feedback",
      pullRequest: { ...current.pullRequest!, headSha: f.headB },
      revision: current.revision + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
    });
    f.ledgerStore.create("card", [feedback("old-inline")]);
    const roundOne = reconcileFeedbackRound({
      store: f.ledgerStore,
      projectId: "project",
      cardId: "card",
      previousHeadSha: f.headA,
      observedHeadSha: f.headB,
      newlyObservedFeedback: [feedback("old-inline")],
    });
    expect(roundOne.evidenceStillValid).toBe(false);
    const lateRound = reconcileFeedbackRound({
      store: f.ledgerStore,
      projectId: "project",
      cardId: "card",
      previousHeadSha: f.headB,
      observedHeadSha: f.headB,
      newlyObservedFeedback: [feedback("old-inline"), feedback("late-inline")],
    });
    expect(lateRound.newActionableFeedbackIds).toEqual([
      "inline-comment:late-inline",
    ]);
    const selection = selectActionableFeedback({
      currentHeadSha: f.headB,
      botAuthor: "agent[bot]",
      reviews: [],
      conversationComments: [],
    });
    expect(selection.actionable).toEqual([]);
    const verification: FeedbackVerificationResult = {
      version: 1,
      projectId: "project",
      cardId: "card",
      headSha: f.headB,
      contentIdentity: f.qualityIdentity,
      dispositions: ["old-inline", "late-inline"].map((id) => ({
        feedbackId: `inline-comment:${id}`,
        status: "verified-fixed" as const,
        evidence: ["src/fix.ts", "tests/fix.test.ts"],
      })),
    };
    const sendReply = vi.fn(async () => "reply-1");
    const replyResult = await publishVerifiedFeedbackReplies({
      project: f.project,
      cardId: "card",
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      publishedCommitSha: f.headB,
      observedHeadSha: f.headB,
      requiredCheckNames: ["Build"],
      checks: [check(f.headB, "succeeded")],
      verification,
      ledgerStore: f.ledgerStore,
      reconcileReply: async () => ({ status: "absent" }),
      sendReply,
    });
    expect(replyResult.publishedReplyIds).toHaveLength(2);
    expect(
      f.ledgerStore
        .read("card")
        ?.entries.every((item) => item.status === "published"),
    ).toBe(true);
  });

  it("holds multiple review cards independently and fails closed on interrupted ambiguous replies", async () => {
    const f = projectFixture();
    const record = f.taskStore.read("card")!;
    f.taskStore.compareAndSwap("card", record.revision, {
      ...record,
      phase: "human-feedback",
      reviewObservation: {
        headSha: f.headA,
        observedAt: "2026-10-24T09:00:00.000Z",
        checks: [{ name: "Build", status: "queued", headSha: f.headA }],
        feedbackIds: ["inline-comment:1"],
      },
      revision: record.revision + 1,
      updatedAt: new Date(Date.parse(record.updatedAt) + 1).toISOString(),
    });
    const queue = new TaskMutationQueue(path.join(root!, "state"), f.project);
    queue.enqueue({
      projectId: "project",
      cardId: "card",
      eventId: "feedback-event",
      kind: "feedback",
      operationKey: "feedback-op",
      enqueuedAt: "2026-10-24T09:01:00.000Z",
    });
    queue.claimNext();
    queue.fail("feedback-event");
    expect(queue.claimNext()).toBeNull();
    expect(queue.getActive()?.status).toBe("failed");
    const secondHead = "d".repeat(40);
    f.taskStore.create({
      version: 1,
      projectId: "project",
      cardId: "card-two",
      phase: "human-feedback",
      primarySessionId: "primary-session-two",
      sessionCreationStatus: "bound",
      expectedBranch: "agent/card-two",
      pullRequest: {
        number: 2,
        url: "https://github.com/owner/repo/pull/2",
        headSha: secondHead,
      },
      operationKey: "operation-two",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    fs.mkdirSync(path.join(f.project.repository.worktreeRoot, "card-two"), {
      recursive: true,
    });
    const github = {
      findPullRequestState: vi.fn(
        async ({ headBranch }: { headBranch: string }) => ({
          url: `https://github.com/owner/repo/pull/${headBranch === "agent/card" ? 1 : 2}`,
          state: "OPEN",
          mergedAt: null,
          headRefOid: headBranch === "agent/card" ? f.headA : secondHead,
        }),
      ),
      getRequiredChecks: vi.fn(async ({ headSha }: { headSha: string }) => ({
        headSha,
        checks: [check(headSha, "queued")],
      })),
      findChangesRequestedPullRequest: vi.fn(async () => null),
      getPullRequestConversationComments: vi.fn(async () => []),
    } as unknown as GitHubClient;
    const monitored = await observeTaskSessionReviewCards({
      project: f.project,
      cards: [
        {
          id: "card",
          name: "Card",
          desc: "",
          idList: "review",
          idLabels: [],
          url: "https://trello.example/card",
        },
        {
          id: "card-two",
          name: "Card two",
          desc: "",
          idList: "review",
          idLabels: [],
          url: "https://trello.example/card-two",
        },
      ],
      taskRecordStore: f.taskStore,
      github,
    });
    expect(monitored.map(({ cardId, headSha }) => [cardId, headSha])).toEqual([
      ["card", f.headA],
      ["card-two", secondHead],
    ]);
    const recovery = await reconcileTaskSession({
      project: f.project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath: path.join(f.project.repository.worktreeRoot, "card"),
      taskRecordStore: f.taskStore,
      readAuthoritativeSnapshot: async () => ({
        primarySessionAccessible: true,
        worktreeExists: true,
        worktreeBranch: "agent/card",
        worktreeHeadSha: f.headA,
        worktreeRebaseActive: false,
        trustedCommitSha: null,
        remoteBranchHeadSha: null,
        trelloListId: "review",
        pullRequest: {
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          headSha: f.headA,
          state: "OPEN",
        },
        checkHeadSha: null,
        checks: [],
        feedbackHeadSha: f.headA,
        uncertainReplyIds: ["conversation-comment:1"],
        reconciledReplyIds: [],
      }),
    });
    expect(recovery.status).toBe("attention-required");
  });
});
