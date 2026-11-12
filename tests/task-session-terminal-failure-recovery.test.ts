import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import {
  isPlanningOutageSafeToSkip,
  runTaskSessionWorkflow,
} from "../src/orchestrator/run-task-session-workflow.js";
import type { PrimaryOperationEntry } from "../src/task-session/run-primary-operation.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { Logger } from "../src/logging/logger.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
import { runPrimaryOperation } from "../src/task-session/run-primary-operation.js";
import { ProcessEvidenceError } from "../src/process/process-runtime.js";
import { PrimaryOperationExhaustedError } from "../src/task-session/primary-operation-ledger.js";
import { persistPrimaryOperationRecovery } from "../src/task-session/persist-primary-operation-recovery.js";
import { RunStore } from "../src/task-session/run-store.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("terminal failure recovery", () => {
  it("allows workflow continuation only after a failed planning outage is retry-safe", () => {
    const operation = {
      id: "task:planning",
      activity: "planning",
      role: "advisory",
      executions: 3,
      failureExecutions: 0,
      dependencyOutages: 3,
      accountedExecution: 3,
      lastExecutionClassification: "dependency-outage",
      status: "failed",
      updatedAt: new Date().toISOString(),
    } satisfies PrimaryOperationEntry;

    expect(isPlanningOutageSafeToSkip(operation)).toBe(false);
    expect(isPlanningOutageSafeToSkip({ ...operation, retrySafe: true })).toBe(true);
    expect(
      isPlanningOutageSafeToSkip({
        ...operation,
        retrySafe: true,
        accountedExecution: 2,
      }),
    ).toBe(false);
  });

  it("keeps a plan-review process-evidence failure fenced before implementation", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-evidence-failure-"));
    const projectId = "agent-orchestrator";
    const cardId = "plan-review-safety-card";
    const contextRoot = path.join(root, "state");
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    fs.mkdirSync(repositoryPath, { recursive: true });
    const project = {
      id: projectId,
      autoMerge: false,
      contextRoot,
      trello: {
        boardId: "board",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
        featureLabelId: "feature",
      },
      repository: {
        path: repositoryPath,
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
      },
      opencode: {
        timeoutMinutes: 1,
        implementation: { model: "impl", variant: "high" },
        planning: { model: "plan", variant: "high" },
        planReview: { model: "review", variant: "high" },
      },
    } as unknown as ProjectConfig & { contextRoot: string };
    const card: TrelloCard = {
      id: cardId,
      name: "Add the export action",
      desc: "Add a task-scoped export action.",
      idList: project.trello.readyListId,
      idLabels: ["feature"],
      url: "https://trello.example/plan-review-safety-card",
    };
    let currentList = project.trello.readyListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      getCard: vi.fn(async () => ({ ...card, idList: currentList })),
      moveCard: vi.fn(async (_id: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: currentList };
      }),
      addComment: vi.fn(async () => ({
        id: "comment-one",
        type: "commentCard",
        date: new Date().toISOString(),
      })),
    } as unknown as TrelloClient;
    const plan = {
      version: 1,
      projectId,
      cardId,
      requirements: [
        {
          id: "REQ-1",
          text: "Export the requested task data.",
          verification: "Check the produced export content.",
        },
      ],
      steps: [
        {
          id: "STEP-1",
          description: "Implement the task export action.",
          requirementIds: ["REQ-1"],
          verification: "Run a focused export test.",
        },
      ],
      assumptions: [],
      blockers: [],
    };
    const runOpenCode = vi.fn(async (options: { captureSessionId?: boolean }) => {
      if (!options.captureSessionId)
        throw new ProcessEvidenceError("review evidence could not be finalized");
      return {
        exitCode: 0,
        output: [
          JSON.stringify({
            type: "step_start",
            sessionID: "ses-plan-safety",
          }),
          JSON.stringify({
            type: "text",
            sessionID: "ses-plan-safety",
            part: { type: "text", text: JSON.stringify(plan) },
          }),
        ].join("\n"),
        errorOutput: "",
      };
    });
    const taskStore = new TaskExecutionStore(contextRoot, project);

    await expect(
      runTaskSessionWorkflow({
        project,
        trello,
        git: {
          fetch: vi.fn(async () => undefined),
          branchExists: vi.fn(async () => false),
          addWorktreeWithNewBranch: vi.fn(async (_repo: string, worktree: string) => {
            fs.mkdirSync(worktree, { recursive: true });
          }),
        } as unknown as GitClient,
        github: {
          findPullRequestState: vi.fn(async () => null),
        } as unknown as GitHubClient,
        openCode: new OpenCodeClient(runOpenCode),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProcessEvidenceError);

    const record = taskStore.read(cardId);
    expect(record).toMatchObject({
      phase: "planning",
      sessionCreationStatus: "bound",
    });
    expect(record?.planReviewAdvice).toBeUndefined();
    expect(record?.primarySessionId).toBe("ses-plan-safety");
    expect(runOpenCode).toHaveBeenCalledTimes(2);
    expect(runOpenCode.mock.calls.every(([options]) => options.captureSessionId !== false)).toBe(
      true,
    );
  });

  it.each([false, true])(
    "routes a planning clarification to durable Failed without implementation (open PR: %s)",
    async (openPr) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-clarification-"));
      const projectId = "agent-orchestrator";
      const cardId = "clarification-card";
      const contextRoot = path.join(root, "state");
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      fs.mkdirSync(repositoryPath, { recursive: true });
      const project = {
        id: projectId,
        autoMerge: false,
        contextRoot,
        trello: {
          boardId: "board",
          backlogListId: "backlog",
          readyListId: "ready",
          workingListId: "working",
          reviewListId: "review",
          failedListId: "failed",
          doneListId: "done",
          featureLabelId: "feature",
          improvementLabelId: "improvement",
          bugLabelId: "bug",
        },
        repository: {
          path: repositoryPath,
          github: "owner/repo",
          defaultBranch: "main",
          worktreeRoot,
          validationCommand: "yarn validate",
        },
        opencode: {
          timeoutMinutes: 1,
          implementation: { model: "impl", variant: "high" },
          planning: { model: "plan", variant: "high" },
          planReview: { model: "review", variant: "high" },
        },
      } as unknown as ProjectConfig & { contextRoot: string };
      const card: TrelloCard = {
        id: cardId,
        name: "Configure export",
        desc: "Add an export action.",
        idList: "ready",
        idLabels: ["feature"],
        url: "https://trello.example/card",
      };
      let currentList = "ready";
      const comments: string[] = [];
      let loseFirstFailedMove = true;
      const trello = {
        getCards: vi.fn(async (listId: string) =>
          listId === currentList ? [{ ...card, idList: currentList }] : [],
        ),
        getCard: vi.fn(async () => ({ ...card, idList: currentList })),
        moveCard: vi.fn(async (_id: string, listId: string) => {
          currentList = listId;
          if (listId === "failed" && loseFirstFailedMove) {
            loseFirstFailedMove = false;
            throw new Error("simulated Failed move response loss");
          }
          return { ...card, idList: listId };
        }),
        addComment: vi.fn(async (_id: string, text: string) => {
          comments.push(text);
          return {
            id: `comment-${comments.length}`,
            type: "commentCard",
            date: new Date().toISOString(),
          };
        }),
      } as unknown as TrelloClient;
      const clarification = {
        version: 1,
        outcome: "clarification-required",
        projectId,
        cardId,
        evidenceExamined: [
          "Read the current card and searched existing export implementations in the repository",
          "Inspected the available export-format attachment",
        ],
        reason:
          "The destination and export format are essential decisions not present in the evidence.",
        questions: ["Which destination and file format should the export use?"],
      };
      const openCode = vi.fn(async () => ({
        exitCode: 0,
        output: [
          JSON.stringify({
            type: "step_start",
            sessionID: "ses-clarification",
          }),
          JSON.stringify({
            type: "text",
            sessionID: "ses-clarification",
            part: { type: "text", text: JSON.stringify(clarification) },
          }),
        ].join("\n"),
        errorOutput: "",
      }));
      const attachmentContext = {
        projectId,
        cardId,
        contextRoot,
        manifest: {
          attachments: [
            {
              id: "format-file",
              name: "export-notes.md",
              mimeType: "text/markdown",
              bytes: "12",
              url: "https://example.invalid/export-notes",
              isUpload: false,
              localFilename: null,
            },
          ],
        },
      };
      let taskStore = new TaskExecutionStore(contextRoot, project);
      const authorityRef: { current?: ProjectRunAuthority } = {};
      const runWorkflow = () =>
        runTaskSessionWorkflow({
          project,
          trello,
          git: {
            fetch: vi.fn(async () => undefined),
            branchExists: vi.fn(async () => false),
            addWorktreeWithNewBranch: vi.fn(async (_repo: string, worktree: string) => {
              fs.mkdirSync(worktree, { recursive: true });
            }),
          } as unknown as GitClient,
          github: {
            findPullRequestState: vi.fn(async () =>
              openPr
                ? {
                    number: 7,
                    url: "https://github.com/owner/repo/pull/7",
                    state: "OPEN",
                    headRefOid: "a".repeat(40),
                    baseRefName: "main",
                    headRefName: `agent/${cardId}`,
                  }
                : null,
            ),
          } as unknown as GitHubClient,
          openCode: new OpenCodeClient(openCode),
          commands: new CommandRunner(vi.fn()),
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => attachmentContext,
        });
      const workflow = () =>
        authorityRef.current === undefined ? runWorkflow() : authorityRef.current.run(runWorkflow);

      await workflow();
      if (openPr) {
        expect(taskStore.read(cardId)).toMatchObject({
          phase: "planning",
        });
        expect(taskStore.read(cardId)?.terminalFailure).toBeUndefined();
        expect(currentList).toBe("working");
        expect(comments).toHaveLength(0);
        expect(trello.moveCard).not.toHaveBeenCalledWith(cardId, "failed");
        expect(openCode).toHaveBeenCalledOnce();
        return;
      }
      expect(taskStore.read(cardId)?.terminalFailure?.outcome).toBe("pending");
      const canonicalRoot = path.join(contextRoot, "canonical-runs");
      const pinned: RunRecord["pinned"] = {
        integrationId: JSON.stringify({
          trelloBoardId: project.trello.boardId,
          githubRepository: project.repository.github,
        }),
        projectId,
        boardId: project.trello.boardId,
        lists: {
          ready: project.trello.readyListId,
          working: project.trello.workingListId,
          review: project.trello.reviewListId,
          failed: project.trello.failedListId,
          done: project.trello.doneListId,
          backlog: project.trello.backlogListId,
        },
        repository: project.repository.github,
        repositoryPath,
        worktreeRoot,
        storageRoot: canonicalRoot,
      };
      const lease = {
        integrationId: pinned.integrationId,
        instanceId: "clarification-restart",
        token: "clarification-lease",
        assertHeld: () => undefined,
      };
      const canonicalRunStore = new RunStore(canonicalRoot, "clarification-attempt", pinned, lease);
      const now = new Date().toISOString();
      canonicalRunStore.create({
        version: 1,
        revision: 1,
        projectId,
        cardId,
        attemptId: "clarification-attempt",
        taskKind: "implementation",
        pinned,
        lifecycle: "waiting",
        checkpoint: "planning",
        publicationState: "none",
        operation: { id: null, kind: null, generation: 0 },
        wait: {
          reason: "clarification",
          since: now,
          dependency: null,
          retryAt: null,
        },
        owner: {
          instanceId: lease.instanceId,
          token: lease.token,
          generation: 1,
        },
        resources: [],
        pendingOperations: [],
        queue: [],
        budgets: {},
        sessions: {},
        artifacts: [],
        expectedTrelloListId: project.trello.workingListId,
        terminalSync: "not-applicable",
        terminalEvidence: null,
        legacy: {},
        compatibility: {},
        updatedAt: now,
      });
      authorityRef.current = new ProjectRunAuthority(
        projectId,
        canonicalRunStore,
        1,
        undefined,
        undefined,
        cardId,
      );
      const canonicalTaskStore = new TaskExecutionStore(contextRoot, project, authorityRef.current);
      const prior = taskStore.read(cardId)!;
      const clarificationPayload = taskStore.readPrimaryResultArtifact(
        prior.terminalFailure!.clarificationArtifact!,
      );
      const canonicalArtifact = canonicalRunStore.writeArtifact(
        Buffer.from(JSON.stringify(clarificationPayload), "utf8"),
        "application/json",
      );
      canonicalTaskStore.create({
        ...prior,
        terminalFailure: {
          ...prior.terminalFailure!,
          clarificationArtifact: canonicalArtifact.id,
        },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const canonicalQueue = new TaskMutationQueue(contextRoot, project, authorityRef.current);
      canonicalQueue.enqueue({
        projectId,
        cardId,
        eventId: "clarification:terminal-recovery",
        operationKey: prior.operationKey,
        kind: "implementation",
        enqueuedAt: now,
      });
      canonicalQueue.claimNext();
      canonicalQueue.fail("clarification:terminal-recovery");
      taskStore = canonicalTaskStore;
      await expect(workflow()).rejects.toThrow("Failed move response loss");
      expect(taskStore.read(cardId)?.terminalFailure?.outcome).toBe("pending");
      const simulateProcessRestart = vi.spyOn(process, "kill").mockImplementation(((
        pid: number,
      ) => {
        if (pid === process.pid)
          throw Object.assign(new Error("simulated old process exit"), {
            code: "ESRCH",
          });
        return true;
      }) as typeof process.kill);
      await workflow();
      simulateProcessRestart.mockRestore();

      const terminal = taskStore.read(cardId);
      expect(terminal).toMatchObject({
        phase: "attention-required",
        terminalFailure: {
          kind: "clarification",
          outcome: "confirmed",
          clarificationArtifact: expect.stringMatching(/^sha256:/u),
        },
      });
      expect(currentList).toBe("failed");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("Which destination and file format");
      expect(openCode).toHaveBeenCalledOnce();
      expect(canonicalQueue.getActive()).toBeNull();
      const canonicalTerminal = canonicalRunStore.read();
      expect(canonicalTerminal).toMatchObject({
        lifecycle: "failed",
        terminalEvidence: {
          prOutcome: "no-pr-failure",
          trelloListId: "failed",
        },
      });
      expect(terminal?.primarySessionId).toBe("ses-clarification");
      expect(terminal?.pullRequest).toBeUndefined();
      const evidence = taskStore.readPrimaryResultArtifact(
        terminal!.terminalFailure!.clarificationArtifact!,
      ) as {
        decision: typeof clarification;
        task: { title: string; description: string };
        attachmentContext: { manifest: { attachments: { name: string }[] } };
      };
      expect(evidence.decision).toEqual(clarification);
      expect(evidence.task).toMatchObject({
        title: card.name,
        description: card.desc,
      });
      expect(evidence.attachmentContext.manifest.attachments[0]?.name).toBe("export-notes.md");
    },
  );

  it("reconciles implementation failures and retires only after Failed is confirmed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-failure-recovery-"));
    const projectId = "agent-orchestrator";
    const cardId = "6addc5c65599982e28a0c6b9";
    const contextRoot = path.join(root, "state");
    const project = {
      id: projectId,
      autoMerge: false,
      contextRoot,
      trello: {
        boardId: "board",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
      },
      repository: {
        path: path.join(root, "repo"),
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot: path.join(root, "worktrees"),
        validationCommand: "yarn validate",
      },
      opencode: { timeoutMinutes: 1 },
    } as unknown as ProjectConfig & { contextRoot: string };
    fs.mkdirSync(project.repository.path, { recursive: true });
    fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
    const card: TrelloCard = {
      id: cardId,
      name: "Implementation failure",
      desc: "Saved failure fixture",
      idList: project.trello.workingListId,
      idLabels: [],
      url: "https://trello.example/card",
    };
    let currentList = project.trello.workingListId;
    const postedComments: { effectId: string; text: string }[] = [];
    let failFirstCommentResponse = true;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_id: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
      getCard: vi.fn(async () => ({ ...card, idList: currentList })),
      addComment: vi.fn(async (_id: string, text: string) => {
        // Record each accepted append separately. Identical text is not an
        // idempotency oracle; the canonical late-acceptance behavior is tested
        // with a real TrelloClient in workflow-mutations.integration.test.ts.
        postedComments.push({
          effectId: `effect-${postedComments.length + 1}`,
          text,
        });
        if (failFirstCommentResponse) {
          failFirstCommentResponse = false;
          throw new Error("simulated response loss after comment acceptance");
        }
        return {
          id: "comment-1",
          type: "commentCard",
          date: new Date().toISOString(),
        };
      }),
    } as unknown as TrelloClient;
    const store = new TaskExecutionStore(contextRoot, project);
    store.create({
      version: 1,
      projectId,
      cardId,
      phase: "implementation",
      primarySessionId: "session-preserved",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${cardId}`,
      operationKey: "implementation-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const primaryOperationId = "implementation-operation:primary";
    await expect(
      runPrimaryOperation({
        store,
        cardId,
        operationId: primaryOperationId,
        activity: "implementation",
        sessionId: "session-preserved",
        execute: async () => ({
          exitCode: 1,
          output: "partial",
          errorOutput: "failed",
        }),
        inspectPending: async (entry) => ({
          status: "stopped-after-dispatch",
          operationId: entry.id,
          execution: entry.executions,
          ...(entry.lastSessionId === undefined ? {} : { sessionId: entry.lastSessionId }),
        }),
      }),
    ).rejects.toBeInstanceOf(PrimaryOperationExhaustedError);
    const exhausted = store.read(cardId)!;
    expect(exhausted.primaryOperations?.[primaryOperationId]?.executions).toBe(3);
    expect(
      persistPrimaryOperationRecovery(
        store,
        exhausted,
        new PrimaryOperationExhaustedError(`Primary operation ${primaryOperationId} exhausted`),
        1000,
      ),
    ).toBe("prepublication-failure");
    expect(store.read(cardId)?.terminalFailure?.outcome).toBe("pending");
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId,
      cardId,
      eventId: "implementation:failure",
      operationKey: "implementation-operation",
      kind: "implementation",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    queue.claimNext();
    queue.fail("implementation:failure");

    const outbox = new NotificationOutbox(contextRoot, projectId, () => undefined);
    const emailNotifier = {
      deliveryTarget: "test-inbox@example.invalid",
      isEventEnabled: (event: string) => event === "failed",
      send: vi.fn(async () => {
        throw new Error("notification response is ambiguous");
      }),
    };
    const runWorkflow = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git: {} as GitClient,
        github: {} as GitHubClient,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
        emailNotifier,
      });
    await expect(outbox.run(runWorkflow)).rejects.toThrow(
      "simulated response loss after comment acceptance",
    );
    expect(trello.addComment).toHaveBeenCalledOnce();
    expect(store.read(cardId)?.terminalFailure?.outcome).toBe("pending");
    expect(queue.getActive()).not.toBeNull();

    await outbox.run(runWorkflow);

    expect(trello.moveCard).toHaveBeenCalledWith(cardId, project.trello.failedListId);
    expect(queue.getActive()).toBeNull();
    expect(store.read(cardId)).toMatchObject({
      primarySessionId: "session-preserved",
      terminalFailure: { outcome: "confirmed" },
    });
    expect(postedComments).toHaveLength(2);
    expect(trello.addComment).toHaveBeenCalledTimes(2);
    expect(outbox.records()).toHaveLength(1);
    expect(outbox.records()[0]?.event).toBe("failed");
    await outbox.drain(emailNotifier, vi.fn());
    // Notification uncertainty is best-effort and cannot roll back the already
    // confirmed terminal workflow transition.
    expect(store.read(cardId)?.terminalFailure?.outcome).toBe("confirmed");
    expect(outbox.records()[0]?.message.text).toContain(
      "Primary operation execution budget is exhausted",
    );
  });

  it("leaves a legacy failed mutation untouched until Trello authorizes retirement", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-failure-recovery-"));
    const projectId = "agent-orchestrator";
    const cardId = "6addc5c65599982e28a0c6b9";
    const contextRoot = path.join(root, "state");
    const worktreeRoot = path.join(root, "worktrees");
    const project = {
      id: projectId,
      autoMerge: false,
      contextRoot,
      trello: {
        boardId: "board",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
      },
      repository: {
        path: path.join(root, "repo"),
        github: "owner/repo",
        defaultBranch: "main",
        worktreeRoot,
        validationCommand: "yarn validate",
      },
      opencode: { timeoutMinutes: 1 },
    } as unknown as ProjectConfig & { contextRoot: string };
    fs.mkdirSync(project.repository.path, { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const worktree = path.join(worktreeRoot, cardId);
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, "preserved.txt"), "keep me", "utf8");

    const card: TrelloCard = {
      id: cardId,
      name: "Legacy failed task",
      desc: "Retained implementation awaiting operator reconciliation",
      idList: project.trello.workingListId,
      idLabels: [],
      url: "https://trello.example/card",
    };
    let currentList = project.trello.workingListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === currentList ? [{ ...card, idList: currentList }] : [],
      ),
      moveCard: vi.fn(async (_id: string, listId: string) => {
        currentList = listId;
        return { ...card, idList: listId };
      }),
    } as unknown as TrelloClient;
    const store = new TaskExecutionStore(contextRoot, project);
    store.create({
      version: 1,
      projectId,
      cardId,
      phase: "attention-required",
      primarySessionId: "ses_e8db2e6edffezePNR3A6EPnlR5",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${cardId}`,
      operationKey: "legacy-failed-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    for (let revision = 1; revision < 12; revision += 1) {
      const current = store.read(cardId)!;
      store.compareAndSwap(cardId, current.revision, {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
      });
    }
    const queue = new TaskMutationQueue(contextRoot, project);
    queue.enqueue({
      projectId,
      cardId,
      eventId: "implementation:legacy-failed",
      operationKey: "legacy-failed-operation",
      kind: "implementation",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    queue.claimNext();
    queue.fail("implementation:legacy-failed");

    const poll = () =>
      runTaskSessionWorkflow({
        project,
        trello,
        git: {} as GitClient,
        github: {} as GitHubClient,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(vi.fn()),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
      });
    const lifecycleEvent = vi.spyOn(Logger.prototype, "event");
    await expect(poll()).resolves.toBeUndefined();
    await expect(poll()).resolves.toBeUndefined();
    expect(queue.getActive()).toMatchObject({
      eventId: "implementation:legacy-failed",
      status: "failed",
    });
    expect(queue.getActive()?.ownerToken).toBeUndefined();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(currentList).toBe(project.trello.workingListId);

    // The operator's move is the authorization for retiring this legacy event.
    currentList = project.trello.failedListId;
    await poll();

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(lifecycleEvent).not.toHaveBeenCalledWith(
      "Card claimed; transition to Working succeeded",
    );
    expect(queue.getActive()).toBeNull();
    expect(store.read(cardId)).toMatchObject({
      phase: "attention-required",
      primarySessionId: "ses_e8db2e6edffezePNR3A6EPnlR5",
    });
    expect(fs.readFileSync(path.join(worktree, "preserved.txt"), "utf8")).toBe("keep me");
    await poll();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });
});
