import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type {
  CiObservationsResult,
  GitHubClient,
  PullRequestState,
} from "../src/github/github-client.js";
import type { GitClient } from "../src/git/git-client.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { reconcileExternalTaskSessionPullRequest } from "../src/orchestrator/reconcile-external-task-session-pr.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { mutationPending?: boolean } = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "external-task-recovery-"));
  const repositoryPath = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  fs.mkdirSync(repositoryPath);
  const project = {
    id: "project",
    autoMerge: false,
    trello: {
      workingListId: "working",
      reviewListId: "review",
      doneListId: "done",
    },
    repository: {
      path: repositoryPath,
      worktreeRoot,
      github: "owner/repository",
      defaultBranch: "main",
    },
  } as ProjectConfig;
  const taskStore = new TaskExecutionStore(path.join(root, "runtime"), project);
  const queue = new TaskMutationQueue(path.join(root, "runtime"), project);
  const now = "2026-10-25T00:00:00.000Z";
  taskStore.create({
    version: 1,
    projectId: project.id,
    cardId: "card",
    phase: "attention-required",
    primarySessionId: "session",
    sessionCreationStatus: "bound",
    expectedBranch: "agent/card",
    operationKey: "operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: now,
    updatedAt: now,
  });
  queue.enqueue({
    eventId: "implementation-event",
    projectId: project.id,
    cardId: "card",
    kind: "implementation",
    operationKey: "operation",
    enqueuedAt: now,
  });
  if (!options.mutationPending) {
    queue.claimNext();
    queue.complete("implementation-event");
  }
  const pullRequest: PullRequestState = {
    url: "https://github.com/owner/repository/pull/18",
    state: "MERGED",
    mergedAt: now,
    headRefName: "recovery/card",
    headRefOid: "b".repeat(40),
    baseRefName: "main",
  };
  const moveCard = vi.fn(async () => undefined);
  const github = {
    getPullRequestStateByNumber: vi.fn(async () => pullRequest),
    getPullRequestCommitShas: vi.fn(async () => ["b".repeat(40)]),
    getCiObservations: vi.fn(async ({ headSha }: { headSha: string }) => ({
      headSha,
      checks: [
        {
          source: "check-run" as const,
          id: 1,
          name: "Build",
          headSha,
          status: "completed",
          conclusion: "success",
          url: null,
        },
      ],
      expectationSources: [
        {
          kind: "workflow-contract" as const,
          sourceId: "workflow:ci.yml",
          complete: true,
          checkNames: ["Build"],
        },
      ],
    })),
  } as unknown as Pick<
    GitHubClient,
    | "getPullRequestStateByNumber"
    | "getPullRequestCommitShas"
    | "getCiObservations"
  >;
  const git = {
    hasEquivalentImplementationCommit: vi.fn(async () => true),
  } as unknown as Pick<GitClient, "hasEquivalentImplementationCommit">;
  const association = {
    projectId: project.id,
    cardId: "card",
    implementationCommit: "a".repeat(40),
    recoveryBranch: "recovery/card",
    pullRequestNumber: 18,
  };
  const reconcile = (
    overrides: Partial<
      Parameters<typeof reconcileExternalTaskSessionPullRequest>[0]
    > = {},
  ) =>
    reconcileExternalTaskSessionPullRequest({
      project,
      association,
      github,
      git,
      taskStore,
      queue,
      trello: { moveCard } as never,
      readTrelloListId: async () => "working",
      doneListId: "done",
      ...overrides,
    });
  return {
    project,
    taskStore,
    queue,
    runtimeRoot: path.join(root, "runtime"),
    pullRequest,
    github,
    git,
    moveCard,
    association,
    reconcile,
  };
}

function ciEvidence(
  status: "pending" | "failed" | "missing" | "ambiguous",
): CiObservationsResult {
  const headSha = "b".repeat(40);
  return {
    headSha,
    checks:
      status === "missing" || status === "ambiguous"
        ? []
        : [
            {
              source: "check-run",
              id: 1,
              name: "Build",
              headSha,
              status: status === "pending" ? "in_progress" : "completed",
              conclusion: status === "failed" ? "failure" : null,
              url: null,
            },
          ],
    expectationSources:
      status === "ambiguous"
        ? []
        : [
            {
              kind: "workflow-contract",
              sourceId: "workflow:ci.yml",
              complete: true,
              checkNames: ["Build"],
            },
          ],
  };
}

describe("reconcileExternalTaskSessionPullRequest", () => {
  it("completes an explicitly associated externally merged recovery PR", async () => {
    const f = fixture();
    await f.reconcile();
    expect(f.moveCard).toHaveBeenCalledOnce();
    expect(f.taskStore.read("card")).toMatchObject({
      phase: "done",
      externalRecovery: {
        implementationCommit: "a".repeat(40),
        recoveryBranch: "recovery/card",
        pullRequestNumber: 18,
        status: "card-moved",
      },
    });
    expect(f.git.hasEquivalentImplementationCommit).toHaveBeenCalledWith({
      project: f.project,
      implementationCommit: "a".repeat(40),
      pullRequestNumber: 18,
      pullRequestHeadSha: "b".repeat(40),
      pullRequestCommitShas: ["b".repeat(40)],
    });
    expect(f.github.getCiObservations).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "b".repeat(40) }),
    );
    expect(f.queue.list()[0]?.status).toBe("completed");
  });

  it("claims and completes only the matching unfinished mutation event", async () => {
    const f = fixture({ mutationPending: true });
    await f.reconcile();
    expect(f.queue.list()).toMatchObject([
      { eventId: "implementation-event", status: "completed" },
    ]);
    expect(f.taskStore.read("card")?.phase).toBe("done");
  });

  it("rejects mismatched target branch before changing state", async () => {
    const f = fixture();
    const originalGetPr = f.github.getPullRequestStateByNumber;
    vi.mocked(originalGetPr).mockResolvedValueOnce({
      ...f.pullRequest,
      baseRefName: "other",
    });
    await expect(f.reconcile()).rejects.toThrow("identity or merge target");
    expect(f.taskStore.read("card")?.externalRecovery).toBeUndefined();
    expect(f.moveCard).not.toHaveBeenCalled();
  });

  it("rejects implementation mismatch without persisting recovery intent", async () => {
    const f = fixture();
    await expect(
      f.reconcile({
        git: {
          hasEquivalentImplementationCommit: async () => false,
        } as never,
      }),
    ).rejects.toThrow("changes do not match");
    expect(f.taskStore.read("card")?.externalRecovery).toBeUndefined();
    expect(f.moveCard).not.toHaveBeenCalled();
  });

  it("rejects a missing implementation association without changing state", async () => {
    const f = fixture();
    const before = f.taskStore.read("card");
    await expect(
      f.reconcile({
        association: {
          ...f.association,
          implementationCommit: undefined,
        } as unknown as typeof f.association,
      }),
    ).rejects.toThrow("association is invalid");
    expect(f.taskStore.read("card")).toEqual(before);
    expect(f.queue.list()[0]?.status).toBe("completed");
    expect(f.github.getPullRequestStateByNumber).not.toHaveBeenCalled();
    expect(f.moveCard).not.toHaveBeenCalled();
  });

  it("rejects a conflicting persisted recovery association without changing it", async () => {
    const f = fixture();
    const current = f.taskStore.read("card");
    expect(current).not.toBeNull();
    const conflicting = f.taskStore.compareAndSwap("card", current!.revision, {
      ...current!,
      externalRecovery: {
        implementationCommit: "d".repeat(40),
        recoveryBranch: "recovery/other",
        pullRequestNumber: 19,
        pullRequestUrl: "https://github.com/owner/repository/pull/19",
        status: "verified",
        requestedAt: "2026-10-25T00:00:00.000Z",
      },
      revision: current!.revision + 1,
      updatedAt: "2026-10-25T00:00:01.000Z",
    });
    await expect(f.reconcile()).rejects.toThrow(
      "Conflicting external recovery",
    );
    expect(f.taskStore.read("card")).toEqual(conflicting);
    expect(f.moveCard).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed", "missing", "ambiguous"] as const)(
    "rejects %s PR-head CI evidence before any recovery mutation",
    async (status) => {
      const f = fixture();
      vi.mocked(f.github.getCiObservations).mockResolvedValueOnce(
        ciEvidence(status),
      );
      await expect(f.reconcile()).rejects.toThrow(
        "publication checks are not verified",
      );
      expect(f.taskStore.read("card")?.externalRecovery).toBeUndefined();
      expect(f.moveCard).not.toHaveBeenCalled();
      expect(f.queue.list()[0]?.status).toBe("completed");
    },
  );

  it("rejects reconciliation while a live mutation owns the project queue", async () => {
    const f = fixture();
    f.queue.enqueue({
      eventId: "other-active-event",
      projectId: f.project.id,
      cardId: "another-card",
      kind: "implementation",
      operationKey: "another-operation",
      enqueuedAt: "2026-10-25T00:00:01.000Z",
    });
    f.queue.claimNext();
    await expect(f.reconcile()).rejects.toThrow(
      "Another worker owns the project mutation queue",
    );
    expect(f.taskStore.read("card")?.externalRecovery).toBeUndefined();
    expect(f.moveCard).not.toHaveBeenCalled();
  });

  it("does not move the card twice after restart when it is already Done", async () => {
    const f = fixture();
    await f.reconcile({ readTrelloListId: async () => "done" });
    await f.reconcile({ readTrelloListId: async () => "done" });
    expect(f.moveCard).not.toHaveBeenCalled();
    expect(f.taskStore.read("card")?.phase).toBe("done");
  });

  it("rejects missing PR and mismatched PR repository evidence without writes", async () => {
    const missing = fixture();
    vi.mocked(missing.github.getPullRequestStateByNumber).mockResolvedValueOnce(
      null as unknown as PullRequestState,
    );
    await expect(missing.reconcile()).rejects.toThrow("could not be found");
    expect(missing.taskStore.read("card")?.externalRecovery).toBeUndefined();

    const wrongRepository = fixture();
    vi.mocked(
      wrongRepository.github.getPullRequestStateByNumber,
    ).mockResolvedValueOnce({
      ...wrongRepository.pullRequest,
      url: "https://github.com/other/repository/pull/18",
    });
    await expect(wrongRepository.reconcile()).rejects.toThrow(
      "identity or merge target",
    );
    expect(
      wrongRepository.taskStore.read("card")?.externalRecovery,
    ).toBeUndefined();
    expect(wrongRepository.moveCard).not.toHaveBeenCalled();

    const missingHead = fixture();
    vi.mocked(
      missingHead.github.getPullRequestStateByNumber,
    ).mockResolvedValueOnce({
      ...missingHead.pullRequest,
      headRefOid: undefined,
    } as unknown as PullRequestState);
    await expect(missingHead.reconcile()).rejects.toThrow(
      "incomplete commit evidence",
    );
    expect(
      missingHead.taskStore.read("card")?.externalRecovery,
    ).toBeUndefined();
    expect(missingHead.moveCard).not.toHaveBeenCalled();
  });

  it("resumes after Trello moved but before recovery progress was persisted", async () => {
    const f = fixture();
    const originalCompareAndSwap = f.taskStore.compareAndSwap.bind(f.taskStore);
    const compareAndSwap = vi.spyOn(f.taskStore, "compareAndSwap");
    compareAndSwap.mockImplementationOnce((...args) =>
      originalCompareAndSwap(...args),
    );
    compareAndSwap.mockImplementationOnce(() => {
      throw new Error("simulated interruption after Trello move");
    });
    await expect(f.reconcile()).rejects.toThrow("simulated interruption");
    expect(f.moveCard).toHaveBeenCalledOnce();
    compareAndSwap.mockRestore();

    await f.reconcile({ readTrelloListId: async () => "done" });
    expect(f.moveCard).toHaveBeenCalledOnce();
    expect(f.taskStore.read("card")?.phase).toBe("done");
  });

  it("re-reads Trello after an ambiguous move failure before retrying", async () => {
    const f = fixture();
    let currentListId = "working";
    f.moveCard.mockImplementationOnce(async () => {
      currentListId = "done";
      throw new Error("response lost after Trello applied the move");
    });
    await expect(
      f.reconcile({ readTrelloListId: async () => currentListId }),
    ).rejects.toThrow("response lost");
    await f.reconcile({ readTrelloListId: async () => currentListId });
    expect(f.moveCard).toHaveBeenCalledOnce();
    expect(f.taskStore.read("card")?.phase).toBe("done");
  });

  it("resumes a persisted move intent after interruption before the move", async () => {
    const f = fixture();
    f.moveCard.mockRejectedValueOnce(
      new Error("Trello unavailable before move"),
    );
    await expect(f.reconcile()).rejects.toThrow("Trello unavailable");
    expect(f.taskStore.read("card")?.externalRecovery?.status).toBe(
      "move-pending",
    );
    expect(f.taskStore.read("card")?.phase).toBe("attention-required");

    await f.reconcile();
    expect(f.moveCard).toHaveBeenCalledTimes(2);
    expect(f.taskStore.read("card")?.phase).toBe("done");
    expect(f.queue.list()[0]?.status).toBe("completed");
  });

  it("resumes queue retirement after the record reached Done with fresh stores", async () => {
    const f = fixture({ mutationPending: true });
    vi.spyOn(f.queue, "complete").mockImplementationOnce(() => {
      throw new Error("simulated interruption while retiring queue event");
    });
    await expect(f.reconcile()).rejects.toThrow("simulated interruption");
    expect(f.taskStore.read("card")?.phase).toBe("done");
    expect(f.queue.list()[0]).toMatchObject({ status: "active" });
    expect(f.queue.list()[0]?.ownerToken).toBeUndefined();

    const freshQueue = new TaskMutationQueue(f.runtimeRoot, f.project);
    const freshTaskStore = new TaskExecutionStore(f.runtimeRoot, f.project);
    await f.reconcile({
      queue: freshQueue,
      taskStore: freshTaskStore,
      readTrelloListId: async () => "done",
    });
    expect(f.moveCard).toHaveBeenCalledOnce();
    expect(f.github.getCiObservations).toHaveBeenCalledOnce();
    expect(freshQueue.list()[0]?.status).toBe("completed");
  });
});
