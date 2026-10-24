import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  reconcileTaskSession,
  type TaskSessionRecoverySnapshot,
} from "../src/task-session/reconcile-task-session.js";
import type {
  TaskExecutionPhase,
  TaskExecutionRecord,
} from "../src/task-session/task-execution-record.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(phase: TaskExecutionPhase = "validation") {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-recovery-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  const project = {
    id: "project",
    autoMerge: false,
    trello: {
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
    repository: { path: repositoryPath, worktreeRoot },
  } as ProjectConfig;
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const sha = "a".repeat(40);
  const record: TaskExecutionRecord = {
    version: 1,
    projectId: "project",
    cardId: "card",
    phase,
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    ...(phase === "ci" || phase === "human-feedback" || phase === "done"
      ? {
          pullRequest: {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: sha,
          },
        }
      : {}),
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
  };
  store.create(record);
  const baseSnapshot: TaskSessionRecoverySnapshot = {
    primarySessionAccessible: true,
    worktreeExists: true,
    worktreeBranch: "agent/card",
    worktreeHeadSha: sha,
    worktreeRebaseActive: false,
    trustedCommitSha:
      phase === "ci" || phase === "human-feedback" || phase === "done"
        ? sha
        : null,
    remoteBranchHeadSha: null,
    trelloListId:
      phase === "human-feedback"
        ? "review"
        : phase === "done"
          ? "done"
          : "working",
    pullRequest:
      phase === "ci" || phase === "human-feedback" || phase === "done"
        ? {
            number: 1,
            url: "https://github.com/o/r/pull/1",
            headSha: sha,
            state: phase === "done" ? "MERGED" : "OPEN",
          }
        : null,
    ciEvaluation:
      phase === "ci"
        ? {
            status: "passed",
            expectedHeadSha: sha,
            expectedCheckNames: ["Build"],
          }
        : null,
    feedbackHeadSha: phase === "human-feedback" ? sha : null,
    uncertainReplyIds: [],
    reconciledReplyIds: [],
  };
  const reconcile = (snapshot: Partial<TaskSessionRecoverySnapshot> = {}) =>
    reconcileTaskSession({
      project,
      cardId: "card",
      expectedBranch: "agent/card",
      operationKey: "operation",
      worktreePath,
      taskRecordStore: store,
      readAuthoritativeSnapshot: async () => ({ ...baseSnapshot, ...snapshot }),
    });
  return { project, store, sha, reconcile };
}

describe("reconcileTaskSession", () => {
  it("resumes a verified restart at its persisted phase", async () => {
    const f = fixture();
    const result = await f.reconcile();
    expect(result).toMatchObject({ status: "resume", phase: "validation" });
  });

  it("persists attention-required for missing session identity and untrusted partial publication", async () => {
    const f = fixture();
    const result = await f.reconcile({ primarySessionAccessible: null });
    expect(result.status).toBe("attention-required");
    expect(f.store.read("card")?.phase).toBe("attention-required");

    const publication = fixture("publication");
    const partial = await publication.reconcile({
      trustedCommitSha: null,
      remoteBranchHeadSha: "b".repeat(40),
    });
    expect(partial.status).toBe("attention-required");
  });

  it("resumes an unambiguously prepared publication but blocks mismatched CI and reply outcomes", async () => {
    const publication = fixture("publication");
    expect(
      (await publication.reconcile({ trustedCommitSha: publication.sha }))
        .status,
    ).toBe("resume");

    const ci = fixture("ci");
    expect(
      (
        await ci.reconcile({
          ciEvaluation: {
            status: "passed",
            expectedHeadSha: "b".repeat(40),
            expectedCheckNames: ["Build"],
          },
        })
      ).status,
    ).toBe("attention-required");

    const feedback = fixture("human-feedback");
    expect(
      (
        await feedback.reconcile({
          uncertainReplyIds: ["conversation-comment:1"],
        })
      ).status,
    ).toBe("attention-required");
  });

  it("completes only when merged PR and Done card snapshots agree", async () => {
    const f = fixture("done");
    expect((await f.reconcile()).status).toBe("complete");
    const mismatch = fixture("done");
    expect((await mismatch.reconcile({ trelloListId: "review" })).status).toBe(
      "attention-required",
    );
  });

  it("fails closed on malformed durable records and untrusted local commits", async () => {
    const malformed = fixture();
    fs.writeFileSync(
      path.join(root, "state", "task-executions", "project", "card.json"),
      "{broken",
      "utf8",
    );
    await expect(malformed.reconcile()).rejects.toThrow(
      "Could not parse task execution record",
    );

    const committed = fixture();
    const mismatch = await committed.reconcile({
      trustedCommitSha: "c".repeat(40),
      worktreeHeadSha: "b".repeat(40),
    });
    expect(mismatch.status).toBe("attention-required");
  });

  it("requires recorded setup state and preserves uncertain setup outcomes for attention", async () => {
    const legacyRecord = fixture("planning");
    legacyRecord.project.repository.setupCommand = "yarn install";
    const missingSetupState = await legacyRecord.reconcile();
    expect(missingSetupState).toMatchObject({
      status: "attention-required",
      reason:
        "Repository setup state is missing, changed, or has an uncertain outcome",
    });

    const interruptedSetup = fixture("planning");
    interruptedSetup.project.repository.setupCommand = "yarn install";
    const current = interruptedSetup.store.read("card");
    expect(current).not.toBeNull();
    interruptedSetup.store.compareAndSwap("card", current!.revision, {
      ...current!,
      setup: { command: "yarn install", status: "active" },
      revision: current!.revision + 1,
      updatedAt: "2026-10-24T09:00:01.000Z",
    });
    const setupOutcome = await interruptedSetup.reconcile();
    expect(setupOutcome).toMatchObject({
      status: "attention-required",
      reason:
        "Repository setup state is missing, changed, or has an uncertain outcome",
    });
    expect(interruptedSetup.store.read("card")?.setup?.status).toBe("active");
  });
});
