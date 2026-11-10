import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { buildTaskSessionReviewRepairPrompt } from "../src/opencode/build-task-session-review-repair-prompt.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

const projectConfig = (
  base: string,
): ProjectConfig & { contextRoot: string } => ({
  id: "project",
  autoMerge: false,
  contextRoot: path.join(base, "state"),
  trello: {
    boardId: "board",
    backlogListId: "backlog",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
    refinementLabelId: "refinement",
    featureLabelId: "feature",
    improvementLabelId: "improvement",
    bugLabelId: "bug",
  },
  repository: {
    path: path.join(base, "repo"),
    github: "owner/repo",
    defaultBranch: "main",
    worktreeRoot: path.join(base, "worktrees"),
    validationCommand: "validate",
    gitIdentity: { name: "Agent", email: "agent@example.test" },
  },
  opencode: {
    refinement: { model: "refine", variant: "high" },
    implementation: { model: "implement", variant: "high" },
    review: { model: "review", variant: "high" },
    remediation: { model: "repair", variant: "high", maxPasses: 1 },
    commit: { model: "commit", variant: "low" },
    timeoutMinutes: 1,
  },
});

describe("production workflow recovery of reserved review repairs", () => {
  it.each([
    [
      "implementation before primary dispatch",
      "implementation",
      false,
      false,
      false,
      true,
    ],
    [
      "implementation after result persistence",
      "implementation",
      true,
      false,
      false,
      true,
    ],
    [
      "validation before reservation clearance at last pass",
      "validation",
      true,
      false,
      false,
      true,
    ],
    [
      "later pass with its original durable prompt",
      "implementation",
      true,
      true,
      false,
      true,
    ],
    [
      "recovery with OpenCode defaults",
      "implementation",
      false,
      false,
      true,
      true,
    ],
    [
      "repair of unavailable-planning task without a persisted prompt",
      "implementation",
      false,
      false,
      false,
      false,
    ],
  ] as const)(
    "recovers %s before generic gates",
    async (_name, phase, completed, twoPass, useDefaults, includePlan) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "review-repair-workflow-"));
      const project = projectConfig(root);
      if (useDefaults) project.opencode.remediation = { maxPasses: 1 };
      if (twoPass) project.opencode.remediation.maxPasses = 2;
      if (!includePlan) project.opencode.remediation.validationMaxPasses = 0;
      fs.mkdirSync(project.repository.path, { recursive: true });
      const worktree = path.join(project.repository.worktreeRoot, "card");
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(worktree, "src.ts"), "partial work\n");
      let taskCommitCreated = false;
      let publishedPullRequest = false;
      const card: TrelloCard = {
        id: "card",
        name: "Implement the feature",
        desc: "Implement the requested behavior.",
        idList: project.trello.workingListId,
        idLabels: [],
        url: "https://trello.example/card",
      };
      const operationKey = "task-operation";
      const operationId = `${operationKey}:review:${operationKey}:pass:1`;
      const store = new TaskExecutionStore(project.contextRoot!, project);
      const identity = `sha256:${"a".repeat(64)}`;
      const failedReview = {
        version: 1 as const,
        projectId: project.id,
        cardId: card.id,
        verdict: "fail" as const,
        requirementAssessments: [
          {
            requirementId: "REQ-1",
            status: "unsatisfied" as const,
            details: "Review found a blocking defect.",
            evidence: [],
          },
        ],
        blockingFindings: [
          {
            kind: "defect" as const,
            summary: "Correct the failing behavior.",
            detail: "A concrete failure was reproduced.",
          },
        ],
        reviewedContentIdentity: identity,
      };
      const exactPrompt = includePlan
        ? "persisted review repair prompt, do not rebuild"
        : buildTaskSessionReviewRepairPrompt({
            projectId: project.id,
            card,
            review: failedReview,
            attempt: 1,
            maxAttempts: 1,
          });
      const artifact = store.writePrimaryResultArtifact(
        `${operationId}:prompt`,
        {
          prompt: exactPrompt,
          review: failedReview,
        },
      );
      const updatedAt = new Date().toISOString();
      store.create({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        phase,
        primarySessionId: "primary-session",
        sessionCreationStatus: "bound",
        expectedBranch: "agent/card",
        operationKey,
        ...(includePlan
          ? {}
          : {
              planningAdvice: {
                status: "unavailable" as const,
                diagnostic: "Planning advice was unavailable.",
              },
            }),
        ...(phase === "validation"
          ? {
              validationRepair: {
                cycleId: operationKey,
                status: "active" as const,
              },
            }
          : {}),
        reviewRepair: {
          cycleId: operationKey,
          status: "active",
          maxAttempts: twoPass ? 2 : 1,
          ...(!includePlan
            ? {
                findings: [
                  {
                    id: "preserved-review-finding",
                    kind: "defect" as const,
                    summary: "Correct the failing behavior.",
                    detail: "A concrete failure was reproduced.",
                    sourceContentIdentity: identity,
                    sourceIdentities: [identity],
                    status: "unresolved" as const,
                  },
                ],
              }
            : {}),
          activePrimaryOperation: {
            operationId,
            pass: 1,
            promptArtifact: artifact,
          },
        },
        ...(completed
          ? {
              primaryOperations: {
                [operationId]: {
                  id: operationId,
                  activity: "review-correction",
                  executions: 1,
                  status: "completed" as const,
                  result: {
                    exitCode: 0,
                    output: "repair result already persisted",
                    errorOutput: "",
                    sessionId: "primary-session",
                  },
                  lastSessionId: "primary-session",
                  updatedAt,
                },
              },
            }
          : {}),
        lastEvent: {
          id: `${operationKey}:review-failed:1`,
          type: "review-failed",
          operationKey,
          occurredAt: updatedAt,
        },
        revision: 1,
        retryCounters: { validation: 0, review: 1, ci: 0, humanFeedback: 0 },
        createdAt: updatedAt,
        updatedAt,
      });
      const planStore = new TaskPlanStore(project.contextRoot!, project);
      if (includePlan) {
        planStore.create(
          {
            version: 1,
            projectId: project.id,
            cardId: card.id,
            requirements: [
              { id: "REQ-1", text: "Feature", verification: "Test" },
            ],
            steps: [
              {
                id: "STEP-1",
                description: "Implement feature",
                requirementIds: ["REQ-1"],
                verification: "Run tests",
              },
            ],
            assumptions: [],
            blockers: [],
          },
          1,
        );
        planStore.storeVerification(card.id, 1, {
          version: 1,
          projectId: project.id,
          cardId: card.id,
          planRevision: 1,
          verdict: "pass",
          findings: [],
        });
      }
      const queue = new TaskMutationQueue(project.contextRoot!, project);
      queue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: "implementation-event",
        operationKey,
        kind: "implementation",
        enqueuedAt: updatedAt,
      });
      const trello = {
        getCards: vi.fn(async (listId: string) =>
          listId === project.trello.workingListId ? [card] : [],
        ),
        getCard: vi.fn(async () => card),
        getCardAttachments: vi.fn(async () => []),
        moveCard: vi.fn(async (_cardId: string, listId: string) => ({
          ...card,
          idList: listId,
        })),
      } as unknown as TrelloClient;
      const git = {
        getCurrentBranch: vi.fn(async () => "agent/card"),
        getHeadSha: vi.fn(async () =>
          taskCommitCreated ? "b".repeat(40) : "a".repeat(40),
        ),
        getRefSha: vi.fn(async () => "a".repeat(40)),
        getRemoteBranchSha: vi.fn(async () => null),
        getCommitCountBetween: vi.fn(
          async (_cwd: string, _base: string, head: string) =>
            taskCommitCreated && head === "b".repeat(40) ? 1 : 0,
        ),
        getStatus: vi.fn(async () => (taskCommitCreated ? "" : " M src.ts")),
        getDiff: vi.fn(async () => (taskCommitCreated ? "" : "partial work")),
        getIndexEntries: vi.fn(async () => ""),
        getUntrackedFiles: vi.fn(async () => []),
        getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
        getRebaseState: vi.fn(async () => null),
        getConflictedPaths: vi.fn(async () => []),
        getRefsIdentity: vi.fn(async () => "refs"),
        fetch: vi.fn(async () => undefined),
        stageAllExcept: vi.fn(async () => undefined),
        commit: vi.fn(async () => {
          taskCommitCreated = true;
        }),
        push: vi.fn(async () => undefined),
      } as unknown as GitClient;
      const github = {
        findPullRequest: vi.fn(async () => null),
        findPullRequestState: vi.fn(async () =>
          publishedPullRequest
            ? {
                number: 42,
                url: "https://github.com/owner/repo/pull/42",
                state: "OPEN",
                headRefOid: "b".repeat(40),
                baseRefName: "main",
                headRefName: "agent/card",
              }
            : null,
        ),
        createPullRequest: vi.fn(async () => {
          publishedPullRequest = true;
          return { url: "https://github.com/owner/repo/pull/42" };
        }),
      } as unknown as GitHubClient;
      const primaryDispatches: Array<{
        prompt: string;
        sessionId?: string;
        model?: string;
        variant?: string;
      }> = [];
      const order: string[] = [];
      let restartingSecondPass = false;
      let secondPassDispatch:
        { operationId: string; prompt: string; sessionId?: string } | undefined;
      const runOpenCode = vi.fn<RunOpenCode>(async (options) => {
        if (options.readOnly) {
          order.push("review");
          if (restartingSecondPass)
            throw new Error("stop after second-pass prompt recovery");
          if (twoPass) {
            const reviewedIdentity = options.prompt.match(
              /Reviewed source content identity: (sha256:[0-9a-f]{64})/u,
            )?.[1];
            if (reviewedIdentity === undefined)
              throw new Error("review prompt omitted source identity");
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                projectId: project.id,
                cardId: card.id,
                verdict: "fail",
                requirementAssessments: [
                  {
                    requirementId: "REQ-1",
                    status: "unsatisfied",
                    details: "The blocking defect remains.",
                    evidence: [],
                  },
                ],
                blockingFindings: [
                  {
                    kind: "defect",
                    summary: "The implementation still has a defect.",
                    detail:
                      "A repeatable error remains after the first repair.",
                  },
                ],
                reviewedContentIdentity: reviewedIdentity,
              }),
              errorOutput: "",
            };
          }
          throw new Error("stop after repair recovery, before publication");
        }
        if (
          includePlan
            ? options.prompt === exactPrompt
            : options.prompt.startsWith(
                "Address the independent implementation review findings",
              ) && options.prompt.includes("No usable plan was available.")
        ) {
          order.push("repair");
          primaryDispatches.push({
            prompt: options.prompt,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.variant === undefined
              ? {}
              : { variant: options.variant }),
            ...(options.sessionId === undefined
              ? {}
              : { sessionId: options.sessionId }),
          });
          return { exitCode: 0, output: "repair complete", errorOutput: "" };
        }
        if (twoPass && !restartingSecondPass) {
          const pending = store.read(card.id)?.reviewRepair
            ?.activePrimaryOperation;
          secondPassDispatch = {
            operationId: pending?.operationId ?? "missing-operation-id",
            prompt: options.prompt,
            ...(options.sessionId === undefined
              ? {}
              : { sessionId: options.sessionId }),
          };
          await options.onExecutionPrepared?.({
            executionId: `review-repair-execution-${primaryDispatches.length}`,
            metadataPath: path.join(root, "execution.json"),
            artifactRoot: root,
          });
          throw new OpenCodeRunAbortedError();
        }
        throw new Error("stop after repair recovery, before publication");
      });
      const runCommand = vi.fn<RunCommand>(async (options) => {
        if (options.command.startsWith("opencode session list"))
          return {
            exitCode: 0,
            output: JSON.stringify([
              { id: "primary-session", directory: worktree },
            ]),
            errorOutput: "",
          };
        if (options.command === "validate") {
          order.push("validation");
          return includePlan
            ? { exitCode: 0, output: "quality passed", errorOutput: "" }
            : {
                exitCode: 1,
                output: "validation still fails",
                errorOutput: "failure",
              };
        }
        return { exitCode: 0, output: "quality passed", errorOutput: "" };
      });

      const initialWorkflow = runTaskSessionWorkflow({
        project,
        trello,
        git,
        github,
        openCode: new OpenCodeClient(runOpenCode),
        commands: new CommandRunner(runCommand),
        signal: new AbortController().signal,
        prepareAttachmentContext: async () => undefined,
        retryIntervalMs: 1_000,
      });
      if (twoPass || !includePlan) await initialWorkflow;
      else {
        const initialError = await initialWorkflow.catch(
          (error: unknown) => error,
        );
        expect(initialError).toBeInstanceOf(Error);
        if (includePlan)
          expect(initialError).toMatchObject({
            message: expect.stringContaining(
              "Independent implementation review execution failed",
            ),
          });
      }

      if (twoPass) {
        const interrupted = store.read(card.id)!;
        expect(interrupted.phase).toBe("implementation");
        const pending = interrupted.reviewRepair?.activePrimaryOperation;
        expect(pending).toMatchObject({ pass: 2 });
        expect(secondPassDispatch).toMatchObject({
          operationId: pending?.operationId,
          sessionId: "primary-session",
        });
        const savedPrompt = store.readPrimaryResultArtifact({
          reference: pending!.promptArtifact!.reference as `sha256:${string}`,
          bytes: pending!.promptArtifact!.bytes,
          ...(pending!.promptArtifact!.path === undefined
            ? {}
            : { path: pending!.promptArtifact!.path }),
        }) as { prompt: string };
        expect(savedPrompt.prompt).toBe(secondPassDispatch?.prompt);
        expect(savedPrompt.prompt).toContain("Advisory plan and task scope:");
        expect(savedPrompt.prompt).toContain(
          "Latest independent review result and blocking findings:",
        );

        const current = store.read(card.id)!;
        store.compareAndSwap(card.id, current.revision, {
          ...current,
          recoveryWait: undefined,
          primaryOperations: {
            ...current.primaryOperations,
            [pending!.operationId]: {
              id: pending!.operationId,
              activity: "review-correction",
              executions: 1,
              status: "completed",
              result: {
                exitCode: 0,
                output: "authoritatively inspected completed result",
                errorOutput: "",
                sessionId: "primary-session",
              },
              lastSessionId: "primary-session",
              updatedAt: new Date().toISOString(),
            },
          },
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        restartingSecondPass = true;
        const dispatchesBeforeRestart = primaryDispatches.length;
        await expect(
          runTaskSessionWorkflow({
            project,
            trello,
            git,
            github,
            openCode: new OpenCodeClient(runOpenCode),
            commands: new CommandRunner(runCommand),
            signal: new AbortController().signal,
            prepareAttachmentContext: async () => undefined,
            retryIntervalMs: 1_000,
          }),
        ).rejects.toThrow("Independent implementation review execution failed");
        expect(primaryDispatches).toHaveLength(dispatchesBeforeRestart);
        const resumed = store.read(card.id)!;
        expect(resumed.reviewRepair?.activePrimaryOperation).toBeUndefined();
        expect(resumed.primaryOperations?.[pending!.operationId]).toMatchObject(
          {
            executions: 1,
            status: "completed",
          },
        );
        expect(
          runCommand.mock.calls.filter(
            ([options]) => options.command === "validate",
          ),
        ).toHaveLength(1);
        expect(github.findPullRequestState).not.toHaveBeenCalled();
        return;
      }

      expect(
        primaryDispatches,
        `expected optional-plan repair dispatch; task advice=${JSON.stringify(store.read(card.id)?.planningAdvice)}`,
      ).toHaveLength(completed ? 0 : 1);
      if (!completed) {
        expect(primaryDispatches[0]).toMatchObject({
          sessionId: "primary-session",
          ...(useDefaults ? {} : { model: "repair", variant: "high" }),
        });
        if (includePlan) expect(primaryDispatches[0]?.prompt).toBe(exactPrompt);
        else {
          expect(primaryDispatches[0]?.prompt).toContain(
            "No usable plan was available.",
          );
          expect(primaryDispatches[0]?.prompt).toContain(card.desc);
        }
      }
      if (!includePlan) {
        expect(exactPrompt).toContain("No usable plan was available.");
        expect(exactPrompt).toContain("original task scope");
      }
      expect(
        runOpenCode.mock.calls.some(([options]) =>
          options.prompt.includes("Implement the approved task plan"),
        ),
      ).toBe(false);
      expect(
        runCommand.mock.calls.filter(
          ([options]) => options.command === "validate",
        ),
      ).toHaveLength(1);
      expect(order).toEqual(
        completed
          ? ["validation", "review"]
          : includePlan
            ? ["repair", "validation", "review"]
            : ["repair", "validation"],
      );
      if (!includePlan) {
        const resultRecord = store.read(card.id);
        expect(
          resultRecord,
          `record=${JSON.stringify(resultRecord)}`,
        ).toMatchObject({
          validationRepair: {
            status: "exhausted",
            maxAttempts: 0,
            evidence: { status: "failed" },
          },
          reviewRepair: {
            status: "stopped",
            stopReason: "validation-exhausted",
            maxAttempts: 1,
            findings: [
              expect.objectContaining({
                id: "preserved-review-finding",
                status: "unresolved",
              }),
            ],
          },
        });
        expect(
          store.read(card.id)?.reviewRepair?.activePrimaryOperation,
        ).toBeUndefined();
        expect(
          store.read(card.id)?.primaryOperations?.[operationId],
        ).toMatchObject({ status: "completed", executions: 1 });
        expect(store.read(card.id)?.reviewRepair?.finalReview).toBeUndefined();
        expect(store.read(card.id)).toMatchObject({
          phase: "ci",
          pullRequest: { headSha: "b".repeat(40) },
        });
      }
      if (includePlan)
        expect(github.findPullRequestState).not.toHaveBeenCalled();
      else expect(github.findPullRequestState).toHaveBeenCalled();
      expect(
        store.read(card.id)?.reviewRepair?.activePrimaryOperation,
      ).toBeUndefined();
      expect(
        store.read(card.id)?.primaryOperations?.[operationId]?.executions,
      ).toBe(1);
    },
  );
});
