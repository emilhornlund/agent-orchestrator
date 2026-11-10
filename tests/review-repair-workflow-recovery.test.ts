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
import {
  ProcessEvidenceError,
  ProcessGroupTerminationError,
} from "../src/process/process-runtime.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { readPendingCommitState } from "../src/orchestrator/trusted-commit-state.js";
import { writeTrustedCommitState } from "../src/orchestrator/trusted-commit-state.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;

afterEach(() => {
  vi.restoreAllMocks();
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
      undefined,
      false,
      false,
    ],
    [
      "implementation after result persistence",
      "implementation",
      true,
      false,
      false,
      true,
      undefined,
      false,
      false,
    ],
    [
      "validation before reservation clearance at last pass",
      "validation",
      true,
      false,
      false,
      true,
      undefined,
      false,
      false,
    ],
    [
      "later pass with its original durable prompt",
      "implementation",
      true,
      true,
      false,
      true,
      undefined,
      false,
      false,
    ],
    [
      "recovery with OpenCode defaults",
      "implementation",
      false,
      false,
      true,
      true,
      undefined,
      false,
      false,
    ],
    [
      "repair of unavailable-planning task without a persisted prompt",
      "implementation",
      false,
      false,
      false,
      false,
      undefined,
      false,
      false,
    ],
    [
      "process-group termination uncertainty",
      "implementation",
      false,
      false,
      false,
      true,
      new ProcessGroupTerminationError(1234),
      false,
      false,
    ],
    [
      "process evidence failure",
      "implementation",
      false,
      false,
      false,
      true,
      new ProcessEvidenceError("process evidence failed"),
      false,
      false,
    ],
    [
      "restart after unavailable review and before the initial task commit",
      "validation",
      false,
      false,
      false,
      true,
      undefined,
      true,
      false,
    ],
    [
      "reuses a current prepared review after restart",
      "publication",
      false,
      false,
      false,
      true,
      undefined,
      false,
      "introduced",
    ],
    [
      "reopens a resolved cached finding after restart",
      "publication",
      false,
      false,
      false,
      true,
      undefined,
      false,
      "reopened",
    ],
    [
      "recovers a cached unresolved finding with its original context",
      "publication",
      false,
      false,
      false,
      true,
      undefined,
      false,
      "unresolved",
    ],
  ] as const)(
    "recovers %s before generic gates",
    async (
      _name,
      phase,
      completed,
      twoPass,
      useDefaults,
      includePlan,
      reviewFailure,
      interruptAfterUnavailable,
      publicationReviewCheckpoint,
    ) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "review-repair-workflow-"));
      const project = projectConfig(root);
      if (useDefaults) project.opencode.remediation = { maxPasses: 1 };
      if (twoPass) project.opencode.remediation.maxPasses = 2;
      if (!includePlan) project.opencode.remediation.validationMaxPasses = 0;
      fs.mkdirSync(project.repository.path, { recursive: true });
      const worktree = path.join(project.repository.worktreeRoot, "card");
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(worktree, "src.ts"), "partial work\n");
      let taskCommitCreated = publicationReviewCheckpoint !== false;
      let publishedPullRequest = false;
      let publishedDraft: boolean | undefined;
      let publishedBody: string | undefined;
      let interruptHandoff = interruptAfterUnavailable;
      let workflowController = new AbortController();
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
      const priorPassingReview = {
        version: 1 as const,
        projectId: project.id,
        cardId: card.id,
        verdict: "pass" as const,
        requirementAssessments: [
          {
            requirementId: "REQ-1",
            status: "satisfied" as const,
            details: "The prior source meets the task requirement.",
            evidence: ["src.ts"],
          },
        ],
        blockingFindings: [],
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
        ...(publicationReviewCheckpoint
          ? {
              reviewRepair: {
                cycleId: operationKey,
                status: "passed" as const,
                maxAttempts: 1,
                finalReview: priorPassingReview,
                findings: [],
              },
            }
          : interruptAfterUnavailable
            ? {}
            : {
                reviewRepair: {
                  cycleId: operationKey,
                  status: "active" as const,
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
              }),
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
          type: publicationReviewCheckpoint ? "review-passed" : "review-failed",
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
      if (publicationReviewCheckpoint) {
        const currentIdentity = await getTaskSessionSourceSnapshotIdentity(
          git,
          worktree,
        );
        const record = store.read(card.id)!;
        const now = new Date().toISOString();
        const reopenedFindingId = "finding-ledger-prior";
        const retainedPriorFinding =
          publicationReviewCheckpoint === "reopened" ||
          publicationReviewCheckpoint === "unresolved";
        const currentReview: ImplementationReviewResult = {
          version: 1 as const,
          projectId: project.id,
          cardId: card.id,
          verdict: "fail" as const,
          requirementAssessments: [
            {
              requirementId: "REQ-1",
              status: "satisfied" as const,
              details: "The current implementation satisfies this requirement.",
              evidence: ["src.ts"],
            },
          ],
          blockingFindings: retainedPriorFinding
            ? [
                {
                  id: reopenedFindingId,
                  sourceContentIdentity: currentIdentity,
                  kind: "defect",
                  summary: "Current prepared source has a material defect",
                  detail:
                    "The stored current review identifies the missing behavior with new source evidence.",
                  ...(publicationReviewCheckpoint === "reopened"
                    ? { location: { filePath: "src.ts", line: 1 } }
                    : {}),
                },
              ]
            : [
                {
                  id: "finding-ledger-current",
                  sourceContentIdentity: currentIdentity,
                  kind: "defect",
                  summary: "Current prepared source has a material defect",
                  detail:
                    "The stored current review identifies the missing behavior.",
                },
              ],
          ...(retainedPriorFinding
            ? {
                previousFindingAssessments: [
                  {
                    findingId: reopenedFindingId,
                    status:
                      publicationReviewCheckpoint === "reopened"
                        ? ("resolved" as const)
                        : ("unresolved" as const),
                  },
                ],
              }
            : { previousFindingAssessments: [] }),
          reviewedContentIdentity: currentIdentity,
        };
        const previousFinding = {
          id: reopenedFindingId,
          sourceContentIdentity: identity,
          sourceIdentities: [identity],
          status:
            publicationReviewCheckpoint === "reopened"
              ? ("resolved" as const)
              : ("unresolved" as const),
        };
        const currentLedgerFinding = retainedPriorFinding
          ? {
              ...previousFinding,
              sourceIdentities:
                publicationReviewCheckpoint === "reopened"
                  ? [identity, currentIdentity]
                  : [identity],
              status: "unresolved" as const,
              kind: "defect" as const,
              summary: "Current prepared source has a material defect",
              detail:
                "The stored current review identifies the missing behavior with new source evidence.",
            }
          : {
              id: "finding-ledger-current",
              kind: "defect" as const,
              summary: "Current prepared source has a material defect",
              detail:
                "The stored current review identifies the missing behavior.",
              sourceContentIdentity: currentIdentity,
              sourceIdentities: [currentIdentity],
              status: "unresolved" as const,
            };
        store.compareAndSwap(card.id, record.revision, {
          ...record,
          reviewRepair: {
            cycleId: operationKey,
            status: "exhausted",
            maxAttempts: 1,
            finalReview: currentReview,
            findings: [currentLedgerFinding],
          },
          validationRepair: {
            cycleId: operationKey,
            status: "passed",
            evidence: {
              command: "validate",
              startedAt: now,
              completedAt: now,
              exitCode: 0,
              status: "passed",
              diagnostic: "validation passed",
              contentIdentity: currentIdentity,
            },
          },
          publicationQuality: {
            contentIdentity: currentIdentity,
            validation: {
              command: "validate",
              startedAt: now,
              completedAt: now,
              exitCode: 0,
              status: "passed",
              diagnostic: "validation passed",
              contentIdentity: currentIdentity,
            },
            review: currentReview,
            reviewPreviousFindingIds: retainedPriorFinding
              ? [reopenedFindingId]
              : [],
            reviewPreviousFindings: retainedPriorFinding
              ? [previousFinding]
              : [],
          },
          revision: record.revision + 1,
          updatedAt: new Date(
            Math.max(Date.now(), Date.parse(record.updatedAt) + 1),
          ).toISOString(),
        });
        writeTrustedCommitState(project, card.id, {
          version: 1,
          kind: "trusted-commit",
          projectId: project.id,
          cardId: card.id,
          taskBranch: "agent/card",
          defaultBranch: "main",
          commitSha: "b".repeat(40),
        });
      }
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
        createPullRequest: vi.fn(
          async (options: { draft: boolean; body: string }) => {
            publishedPullRequest = true;
            publishedDraft = options.draft;
            publishedBody = options.body;
            return { url: "https://github.com/owner/repo/pull/42" };
          },
        ),
      } as unknown as GitHubClient;
      const primaryDispatches: Array<{
        prompt: string;
        sessionId?: string;
        model?: string;
        variant?: string;
      }> = [];
      const order: string[] = [];
      const reviewFailureError =
        reviewFailure === undefined ? undefined : reviewFailure;
      let independentReviewRounds = 0;
      let restartingSecondPass = false;
      let secondPassDispatch:
        { operationId: string; prompt: string; sessionId?: string } | undefined;
      const runOpenCode = vi.fn<RunOpenCode>(async (options) => {
        if (options.readOnly) {
          order.push("review");
          if (reviewFailureError !== undefined) throw reviewFailureError;
          if (restartingSecondPass)
            throw new Error("stop after second-pass prompt recovery");
          if (interruptAfterUnavailable) {
            independentReviewRounds += 1;
            const reviewedIdentity = options.prompt.match(
              /Reviewed source content identity: (sha256:[0-9a-f]{64})/u,
            )?.[1];
            if (reviewedIdentity === undefined)
              throw new Error("review prompt omitted source identity");
            if (independentReviewRounds > 1)
              return {
                exitCode: 1,
                output: "",
                errorOutput: "review service unavailable after correction",
              };
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
                    details: "The review found the required behavior missing.",
                    evidence: [],
                  },
                ],
                blockingFindings: [
                  {
                    kind: "incomplete",
                    summary:
                      "The requested persistence behavior is incomplete.",
                    detail:
                      "A concrete reload failure leaves the value at default.",
                  },
                ],
                reviewedContentIdentity: reviewedIdentity,
              }),
              errorOutput: "",
            };
          }
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
          if (!includePlan) {
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
                verdict: "pass",
                requirementAssessments: [],
                blockingFindings: [],
                previousFindingAssessments: [
                  {
                    findingId: "preserved-review-finding",
                    status: "resolved",
                  },
                ],
                reviewedContentIdentity: reviewedIdentity,
              }),
              errorOutput: "",
            };
          }
          return {
            exitCode: 1,
            output: "",
            errorOutput: "review service unavailable",
          };
        }
        if (
          interruptAfterUnavailable
            ? options.prompt.startsWith(
                "Address the independent implementation review findings",
              )
            : includePlan
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
        if (options.prompt.includes("Generate the commit message")) {
          const resultPath = options.prompt.match(
            /Write exactly one JSON object to ([^\n]+)\./u,
          )?.[1];
          if (resultPath === undefined)
            throw new Error("commit prompt omitted its result path");
          fs.mkdirSync(path.dirname(path.join(options.cwd, resultPath)), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(options.cwd, resultPath),
            JSON.stringify({
              message:
                "feat(task): preserve task behavior\n\n- Keep the implementation.\n- Verify the behavior.\n\nThe requested task behavior is retained.",
            }),
          );
          return {
            exitCode: 0,
            output: "commit message generated",
            errorOutput: "",
          };
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

      if (interruptAfterUnavailable) {
        const compareAndSwap = TaskExecutionStore.prototype.compareAndSwap;
        vi.spyOn(
          TaskExecutionStore.prototype,
          "compareAndSwap",
        ).mockImplementation(function (
          this: TaskExecutionStore,
          cardId,
          revision,
          nextRecord,
        ) {
          const persisted = compareAndSwap.call(
            this,
            cardId,
            revision,
            nextRecord,
          );
          if (
            interruptHandoff &&
            cardId === card.id &&
            nextRecord.reviewRepair?.status === "stopped" &&
            nextRecord.reviewRepair.stopReason === "review-unavailable"
          ) {
            interruptHandoff = false;
            workflowController.abort();
            throw new OpenCodeRunAbortedError();
          }
          return persisted;
        });
      }
      let publicationCheckpointWrites = 0;
      if (publicationReviewCheckpoint === "reopened") {
        const compareAndSwap = TaskExecutionStore.prototype.compareAndSwap;
        vi.spyOn(
          TaskExecutionStore.prototype,
          "compareAndSwap",
        ).mockImplementation(function (
          this: TaskExecutionStore,
          cardId,
          revision,
          nextRecord,
        ) {
          const persisted = compareAndSwap.call(
            this,
            cardId,
            revision,
            nextRecord,
          );
          const publicationQuality = nextRecord.publicationQuality;
          if (
            cardId === card.id &&
            publicationQuality !== undefined &&
            publicationQuality.contentIdentity ===
              store.read(card.id)?.publicationQuality?.contentIdentity &&
            publicationQuality.review !== null &&
            publicationQuality.review !== undefined &&
            publicationQuality.reviewPreviousFindingIds?.includes(
              "finding-ledger-prior",
            )
          ) {
            publicationCheckpointWrites += 1;
            if (publicationCheckpointWrites <= 2) {
              workflowController.abort();
              throw new OpenCodeRunAbortedError();
            }
          }
          return persisted;
        });
      }
      const initialWorkflow = runTaskSessionWorkflow({
        project,
        trello,
        git,
        github,
        openCode: new OpenCodeClient(runOpenCode),
        commands: new CommandRunner(runCommand),
        signal: workflowController.signal,
        prepareAttachmentContext: async () => undefined,
        retryIntervalMs: 1_000,
      });
      if (reviewFailureError !== undefined) {
        await expect(initialWorkflow).rejects.toBe(reviewFailureError);
        expect(store.read(card.id)?.phase).toBe("attention-required");
        expect(store.read(card.id)?.reviewUnavailable).toBeUndefined();
        expect(github.createPullRequest).not.toHaveBeenCalled();
        expect(taskCommitCreated).toBe(false);
        expect(primaryDispatches).toHaveLength(1);
        return;
      }
      if (publicationReviewCheckpoint === "reopened") {
        await expect(initialWorkflow).rejects.toBeInstanceOf(Error);
        const restart = async () => {
          workflowController = new AbortController();
          return runTaskSessionWorkflow({
            project,
            trello,
            git,
            github,
            openCode: new OpenCodeClient(runOpenCode),
            commands: new CommandRunner(runCommand),
            signal: workflowController.signal,
            prepareAttachmentContext: async () => undefined,
            retryIntervalMs: 1_000,
          });
        };
        for (let write = 1; write < 2; write += 1) {
          const saved = store.read(card.id)?.publicationQuality;
          expect(saved?.reviewPreviousFindings).toEqual([
            expect.objectContaining({
              id: "finding-ledger-prior",
              sourceIdentities: [identity],
              status: "resolved",
            }),
          ]);
          await expect(restart()).rejects.toBeInstanceOf(Error);
        }
        const savedAfterSecondWrite = store.read(card.id)?.publicationQuality;
        expect(savedAfterSecondWrite?.reviewPreviousFindings).toEqual([
          expect.objectContaining({
            id: "finding-ledger-prior",
            sourceIdentities: [identity],
            status: "resolved",
          }),
        ]);
        const reviewsBeforeFinalRestart = runOpenCode.mock.calls.filter(
          ([call]) =>
            call.readOnly &&
            call.prompt.includes("Independently review the implementation"),
        ).length;
        const primaryDispatchesBeforeFinalRestart = primaryDispatches.length;
        await restart();
        expect(publicationCheckpointWrites).toBeGreaterThanOrEqual(2);
        expect(store.read(card.id)?.phase).toBe("ci");
        expect(
          store.read(card.id)?.publicationQuality?.reviewPreviousFindings,
        ).toEqual([
          expect.objectContaining({
            id: "finding-ledger-prior",
            sourceIdentities: [identity],
            status: "resolved",
          }),
        ]);
        expect(
          runOpenCode.mock.calls.filter(
            ([call]) =>
              call.readOnly &&
              call.prompt.includes("Independently review the implementation"),
          ),
        ).toHaveLength(reviewsBeforeFinalRestart);
        expect(primaryDispatches).toHaveLength(
          primaryDispatchesBeforeFinalRestart,
        );
        expect(github.createPullRequest).toHaveBeenCalledOnce();
        expect(publishedDraft).toBe(true);
        expect(publishedBody).toContain(
          "Current prepared source has a material defect",
        );
        expect(store.read(card.id)?.phase).not.toBe("attention-required");
        return;
      }
      if (interruptAfterUnavailable) {
        await expect(initialWorkflow).rejects.toBeInstanceOf(Error);
        expect(taskCommitCreated).toBe(false);
        expect(github.createPullRequest).not.toHaveBeenCalled();
        expect(readPendingCommitState(project, card.id)).toBeNull();
        const reopenedStore = new TaskExecutionStore(
          project.contextRoot!,
          project,
        );
        expect(reopenedStore.read(card.id)).toMatchObject({
          phase: "publication",
          reviewRepair: {
            status: "stopped",
          },
          reviewUnavailable: {
            priorReview: {
              verdict: "fail",
              blockingFindings: [
                expect.objectContaining({
                  summary: "The requested persistence behavior is incomplete.",
                }),
              ],
              requirementAssessments: [
                expect.objectContaining({
                  requirementId: "REQ-1",
                  status: "unsatisfied",
                }),
              ],
            },
          },
        });
        expect(
          reopenedStore.read(card.id)?.reviewRepair?.finalReview,
        ).toBeUndefined();
        const reviewsBeforeRestart = runOpenCode.mock.calls.filter(
          ([call]) =>
            call.readOnly &&
            call.prompt.startsWith("Independently review the implementation"),
        ).length;
        const repairsBeforeRestart = primaryDispatches.length;
        workflowController = new AbortController();
        await runTaskSessionWorkflow({
          project,
          trello,
          git,
          github,
          openCode: new OpenCodeClient(runOpenCode),
          commands: new CommandRunner(runCommand),
          signal: workflowController.signal,
          prepareAttachmentContext: async () => undefined,
          retryIntervalMs: 1_000,
        });
        expect(store.read(card.id)?.phase).toBe("ci");
        expect(taskCommitCreated).toBe(true);
        expect(github.createPullRequest).toHaveBeenCalledOnce();
        expect(publishedDraft).toBe(true);
        expect(publishedBody).toContain("Prior review concern");
        expect(publishedBody).toContain(
          "The requested persistence behavior is incomplete.",
        );
        expect(publishedBody).toContain(
          "A concrete reload failure leaves the value at default.",
        );
        expect(publishedBody).toContain("REQ-1");
        expect(publishedBody).toContain("follow-up review");
        expect(
          runOpenCode.mock.calls.filter(
            ([call]) =>
              call.readOnly &&
              call.prompt.startsWith("Independently review the implementation"),
          ),
        ).toHaveLength(reviewsBeforeRestart);
        expect(primaryDispatches).toHaveLength(repairsBeforeRestart);
        return;
      }
      await initialWorkflow;

      if (publicationReviewCheckpoint) {
        expect(primaryDispatches).toEqual([]);
        expect(
          runOpenCode.mock.calls.filter(
            ([call]) =>
              call.readOnly &&
              call.prompt.startsWith("Independently review the implementation"),
          ),
        ).toEqual([]);
        expect(store.read(card.id)?.phase).toBe("ci");
        expect(github.createPullRequest).toHaveBeenCalledOnce();
        expect(publishedDraft).toBe(true);
        expect(publishedBody).toContain(
          "Current prepared source has a material defect",
        );
        expect(publishedBody).toContain(
          "Review: Failed (human review required",
        );
        expect(store.read(card.id)?.publicationQuality?.review).toMatchObject({
          verdict: "fail",
        });
        return;
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
        ).rejects.toThrow("stop after second-pass prompt recovery");
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
        expect(resumed.phase).toBe("attention-required");
        expect(resumed.reviewUnavailable).toBeUndefined();
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
      ).toHaveLength(includePlan ? 1 : 2);
      expect(order).toEqual(
        completed
          ? ["validation", "review"]
          : includePlan
            ? ["repair", "validation", "review"]
            : ["repair", "validation", "review", "validation"],
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
            status: "passed",
            maxAttempts: 1,
            findings: [
              expect.objectContaining({
                id: "preserved-review-finding",
                status: "resolved",
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
        expect(store.read(card.id)?.reviewRepair?.finalReview?.verdict).toBe(
          "pass",
        );
        expect(store.read(card.id)).toMatchObject({
          phase: "ci",
          pullRequest: { headSha: "b".repeat(40) },
        });
      }
      expect(github.findPullRequestState).toHaveBeenCalled();
      expect(publishedDraft).toBe(true);
      expect(
        store.read(card.id)?.reviewRepair?.activePrimaryOperation,
      ).toBeUndefined();
      expect(
        store.read(card.id)?.primaryOperations?.[operationId]?.executions,
      ).toBe(1);
      if (includePlan && !twoPass)
        expect(store.read(card.id)).toMatchObject({
          reviewUnavailable: {
            diagnostic: "Independent implementation review exited with code 1",
          },
          reviewRepair: {
            status: "stopped",
            stopReason: "review-unavailable",
          },
        });
      if (includePlan && !twoPass) {
        expect(
          store.read(card.id)?.reviewUnavailable?.priorReview,
        ).toMatchObject({
          verdict: "fail",
        });
        expect(store.read(card.id)?.reviewRepair?.finalReview).toBeUndefined();
        expect(publishedBody).toContain(
          "AI implementation review unavailable: Independent implementation review exited with code 1",
        );
        expect(publishedBody).toContain("Prior review concern");
        expect(publishedBody).toContain("Correct the failing behavior.");
        expect(publishedBody).toContain("A concrete failure was reproduced.");
        expect(publishedBody).toContain("REQ-1");
        expect(publishedBody).toContain(
          "No matching primary-session disposition is recorded",
        );
        expect(publishedDraft).toBe(true);
      }
    },
  );
});
