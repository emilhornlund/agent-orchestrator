import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import type {
  OpenCodeRunOptions,
  RunOpenCode,
} from "../src/opencode/opencode-client.js";
import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
} from "../src/opencode/opencode-client.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { getProcessRuntime } from "../src/process/process-runtime.js";
import { writeTrustedCommitState } from "../src/orchestrator/trusted-commit-state.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function projectFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-dispatch-"));
  const repositoryPath = path.join(root, "source-repository");
  const worktreeRoot = path.join(root, "worktrees");
  const contextRoot = path.join(root, "runtime-state");
  fs.mkdirSync(repositoryPath);
  const project: ProjectConfig & { contextRoot: string } = {
    id: "project",
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
      refinementLabelId: "refinement",
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
  };
  return { project, repositoryPath, worktreeRoot, contextRoot };
}

function createCard(): TrelloCard {
  return {
    id: "card",
    name: "Implement settings",
    desc: "Make settings persistent.",
    idList: "ready",
    idLabels: ["feature"],
    url: "https://trello.example/card",
  };
}

describe("task-session production dispatch", () => {
  it.each(["reachable", "confirmed-lost"] as const)(
    "reconciles the production feedback checkpoint with a %s session and resumes the persisted operation",
    async (validationSessionState) => {
      const { project, worktreeRoot, repositoryPath } = projectFixture();
      const card: TrelloCard = {
        ...createCard(),
        idList: project.trello.reviewListId,
      };
      const cardListId = project.trello.reviewListId;
      const headSha = "a".repeat(40);
      const worktreePath = path.join(worktreeRoot, card.id);
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, "src.ts"), "existing change\n");
      const integrationId = JSON.stringify({
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      });
      const pinned = {
        integrationId,
        projectId: project.id,
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
        storageRoot: path.join(project.contextRoot, "canonical-runs"),
      };
      const lease = {
        integrationId,
        instanceId: "restart-instance",
        token: "restart-token",
        assertHeld: vi.fn(),
      };
      const runStore = new RunStore(
        pinned.storageRoot,
        "ci-restart-attempt",
        pinned,
        lease,
      );
      runStore.create({
        version: 1,
        revision: 1,
        projectId: project.id,
        cardId: card.id,
        attemptId: "ci-restart-attempt",
        taskKind: "implementation",
        pinned,
        lifecycle: "ci",
        checkpoint: "ci",
        publicationState: "open",
        operation: { id: null, kind: null, generation: 0 },
        wait: { reason: null, dependency: null, since: null, retryAt: null },
        owner: {
          instanceId: lease.instanceId,
          token: lease.token,
          generation: 1,
        },
        resources: [],
        pendingOperations: [],
        queue: [],
        budgets: {},
        sessions: { primary: "ses_lost-ci-owner" },
        artifacts: [],
        expectedTrelloListId: project.trello.reviewListId,
        terminalSync: "not-applicable",
        terminalEvidence: null,
        legacy: {},
        compatibility: {},
        updatedAt: new Date().toISOString(),
      });
      const authority = new ProjectRunAuthority(
        project.id,
        runStore,
        1,
        undefined,
        undefined,
        card.id,
      );
      const ownedStore = new TaskExecutionStore(
        project.contextRoot,
        project,
        authority,
      );
      const originalCiOperationId = "ci-cycle-original:pass:1";
      const originalPrompt = "Repair the required GitHub CI failures for Build";
      const originalPromptArtifact = runStore.writeArtifact(
        Buffer.from(JSON.stringify({ prompt: originalPrompt })),
        "application/json",
      );
      const originalDiagnosticsArtifact = runStore.writeArtifact(
        Buffer.from(
          JSON.stringify([
            {
              name: "Build",
              headSha,
              logUrl: null,
              available: true,
              diagnostic: "persisted failure details",
            },
          ]),
        ),
        "application/json",
      );
      await authority.run(async () =>
        ownedStore.create({
          version: 1,
          projectId: project.id,
          cardId: card.id,
          phase: "ci",
          primarySessionId: "ses_lost-ci-owner",
          sessionCreationStatus: "bound",
          expectedBranch: `agent/${card.id}`,
          pullRequest: {
            number: 9,
            url: "https://github.com/owner/repo/pull/9",
            headSha,
          },
          operationKey: "original-task-operation",
          ciRepair: {
            cycleId: "ci-cycle-original",
            headSha,
            status: "active",
            activePrimaryOperation: {
              operationId: originalCiOperationId,
              pass: 1,
              promptArtifact: {
                reference: originalPromptArtifact.id,
                path: originalPromptArtifact.path,
                bytes: originalPromptArtifact.bytes,
              },
              diagnosticsArtifact: {
                reference: originalDiagnosticsArtifact.id,
                path: originalDiagnosticsArtifact.path,
                bytes: originalDiagnosticsArtifact.bytes,
              },
            },
          },
          revision: 1,
          retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
          createdAt: "2026-10-24T09:00:00.000Z",
          updatedAt: "2026-10-24T09:00:00.000Z",
        }),
      );
      const taskPlanStore = new TaskPlanStore(
        project.contextRoot,
        project,
        authority,
      );
      await authority.run(async () =>
        taskPlanStore.create(
          {
            version: 1,
            projectId: project.id,
            cardId: card.id,
            requirements: [
              { id: "REQ-1", text: "Task", verification: "Check task" },
            ],
            steps: [
              {
                id: "STEP-1",
                description: "Implement task",
                requirementIds: ["REQ-1"],
                verification: "Run checks",
              },
            ],
            assumptions: [],
            blockers: [],
          },
          1,
        ),
      );
      await authority.run(async () =>
        taskPlanStore.storeVerification(card.id, 1, {
          version: 1,
          projectId: project.id,
          cardId: card.id,
          planRevision: 1,
          verdict: "pass",
          findings: [],
        }),
      );
      await authority.run(async () =>
        writeTrustedCommitState(project, card.id, {
          version: 1,
          kind: "trusted-commit",
          projectId: project.id,
          cardId: card.id,
          taskBranch: `agent/${card.id}`,
          defaultBranch: "main",
          commitSha: headSha,
        }),
      );

      let publishedHeadSha = headSha;
      const trello = {
        getCards: vi.fn(async (listId: string) =>
          listId === cardListId ? [card] : [],
        ),
        getCard: vi.fn(async () => card),
        moveCard: vi.fn(async (_cardId: string, listId: string) => ({
          ...card,
          idList: listId,
        })),
        getCardAttachments: vi.fn(async () => []),
      } as unknown as TrelloClient;
      const git = {
        getCurrentBranch: vi.fn(async () => `agent/${card.id}`),
        getHeadSha: vi.fn(async () => publishedHeadSha),
        getRefSha: vi.fn(async (_cwd: string, ref: string) =>
          ref.includes("agent/") ? publishedHeadSha : "b".repeat(40),
        ),
        getRebaseState: vi.fn(async () => null),
        getConflictedPaths: vi.fn(async () => []),
        getStatus: vi.fn(async () => ""),
        getRemoteBranchSha: vi.fn(async () => publishedHeadSha),
        getCommitCountBetween: vi.fn(async () => 1),
        getDiff: vi.fn(async () => "existing change"),
        getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
        getIndexEntries: vi.fn(
          async () =>
            "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc.ts\0",
        ),
        getUntrackedFiles: vi.fn(async () => []),
        getIgnoredFiles: vi.fn(async () => []),
        getRefsIdentity: vi.fn(async () => "refs-v1"),
        fetch: vi.fn(async () => undefined),
        push: vi.fn(async () => undefined),
        stageAllExcept: vi.fn(async () => undefined),
        commit: vi.fn(async () => {
          publishedHeadSha = "c".repeat(40);
        }),
      } as unknown as GitClient;
      let feedbackMode = false;
      let malformedFeedbackCommitResult = false;
      const github = {
        ensurePullRequestDraft: vi.fn(async () => undefined),
        findPullRequest: vi.fn(async () => ({
          number: 9,
          url: "https://github.com/owner/repo/pull/9",
        })),
        findPullRequestState: vi.fn(async () => ({
          url: "https://github.com/owner/repo/pull/9",
          state: "OPEN",
          mergedAt: null,
          headRefOid: publishedHeadSha,
        })),
        getCiObservations: vi.fn(async () => ({
          headSha: publishedHeadSha,
          checks: [
            {
              source: "check-run" as const,
              id: 1,
              name: "Build",
              headSha: publishedHeadSha,
              status: "completed" as const,
              conclusion: feedbackMode ? "success" : "failure",
              url: null,
            },
          ],
          expectationSources: [
            {
              kind: "repository-rules" as const,
              sourceId: "rules",
              complete: true,
              checkNames: ["Build"],
            },
          ],
        })),
        findChangesRequestedPullRequest: vi.fn(async () =>
          feedbackMode
            ? {
                url: "https://github.com/owner/repo/pull/9",
                number: 9,
                headSha: publishedHeadSha,
                feedback: {
                  reviews: [
                    {
                      id: 12,
                      commitSha: publishedHeadSha,
                      body: null,
                      author: "reviewer",
                      submittedAt: "2026-10-24T11:00:00Z",
                      inlineComments: [
                        {
                          id: 501,
                          reviewId: 12,
                          commitSha: publishedHeadSha,
                          body: "Handle the empty case.",
                          author: "reviewer",
                          path: "src.ts",
                          line: 1,
                          originalLine: 1,
                          diffHunk: "@@ -1 +1 @@",
                          threadId: "thread-501",
                          source: "current-head" as const,
                        },
                      ],
                    },
                  ],
                },
              }
            : null,
        ),
        getPullRequestConversationComments: vi.fn(async () => []),
      } as unknown as GitHubClient;
      let listedSessionId: string | undefined;
      let replacementSessionId = "ses_ci-replacement";
      let validationCheckpointMode = false;
      let abortAtValidation = false;
      const validationRestartController = new AbortController();
      const run = vi.fn<RunOpenCode>(async (options) => {
        if (options.prompt.includes("Reconstruct")) {
          listedSessionId = replacementSessionId;
          return {
            exitCode: 0,
            output: JSON.stringify({
              type: "step_start",
              sessionID: replacementSessionId,
            }),
            errorOutput: "",
          };
        }
        if (
          options.prompt.startsWith(
            "Address the following verified-as-actionable human PR feedback",
          )
        ) {
          fs.writeFileSync(
            path.join(worktreePath, "src.ts"),
            "export const corrected = true;\n",
          );
          return {
            exitCode: 0,
            output: "feedback repair dispatched",
            errorOutput: "",
          };
        }
        if (
          options.readOnly &&
          feedbackMode &&
          options.prompt.includes(
            "Independently verify each actionable human PR feedback item",
          )
        ) {
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId: card.id,
              headSha: feedbackHeadSha,
              contentIdentity: await getTaskSessionSourceSnapshotIdentity(
                git,
                worktreePath,
              ),
              dispositions: [
                {
                  feedbackId: "inline-comment:501",
                  status: "verified-fixed",
                  evidence: ["src.ts"],
                },
              ],
            }),
            errorOutput: "",
          };
        }
        if (options.readOnly && feedbackMode) {
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId: card.id,
              verdict: "pass",
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "satisfied",
                  details: "The requested behavior is implemented.",
                  evidence: ["src.ts"],
                },
              ],
              blockingFindings: [],
              reviewedContentIdentity:
                await getTaskSessionSourceSnapshotIdentity(git, worktreePath),
            }),
            errorOutput: "",
          };
        }
        if (options.prompt.includes("Generate the commit message")) {
          const resultRelativePath = options.prompt.match(
            /Write exactly one JSON object to ([^\n]+)\./u,
          )?.[1];
          if (resultRelativePath === undefined)
            throw new Error(
              "Commit-message prompt omitted its output location",
            );
          const resultPath = path.join(options.cwd, resultRelativePath);
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          if (feedbackMode && malformedFeedbackCommitResult) {
            fs.writeFileSync(resultPath, "{ malformed", "utf8");
            return {
              exitCode: 0,
              output: "commit message generated",
              errorOutput: "",
            };
          }
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              message: [
                "fix(feedback): address requested feedback",
                "",
                "- Handle the empty case.",
                "- Preserve the existing task scope.",
                "",
                "The requested feedback correction is included.",
              ].join("\n"),
            }),
          );
          return {
            exitCode: 0,
            output: "commit message generated",
            errorOutput: "",
          };
        }
        if (
          validationCheckpointMode &&
          options.prompt.includes('"reviewedContentIdentity"')
        ) {
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId: card.id,
              reviewedContentIdentity:
                await getTaskSessionSourceSnapshotIdentity(git, worktreePath),
              verdict: "pass",
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "satisfied",
                  details: "The requested task behavior is satisfied.",
                  evidence: ["src.ts"],
                },
              ],
              blockingFindings: [],
              previousFindingAssessments: [],
            }),
            errorOutput: "",
          };
        }
        return { exitCode: 0, output: "repair dispatched", errorOutput: "" };
      });
      const commands = new CommandRunner(
        vi.fn<RunCommand>(async (options) => {
          if (
            abortAtValidation &&
            options.command === project.repository.validationCommand
          ) {
            validationRestartController.abort();
            return {
              exitCode: 0,
              output: "validation passed",
              errorOutput: "",
            };
          }
          if (options.command.startsWith("opencode session list"))
            return {
              exitCode: 0,
              output: JSON.stringify(
                listedSessionId === undefined
                  ? []
                  : [{ id: listedSessionId, directory: worktreePath }],
              ),
              errorOutput: "",
            };
          return { exitCode: 0, output: "", errorOutput: "" };
        }),
      );

      await expect(
        authority.run(() =>
          runTaskSessionWorkflow({
            project,
            trello,
            git,
            github,
            openCode: new OpenCodeClient(run),
            commands,
            signal: new AbortController().signal,
            prepareAttachmentContext: async () => undefined,
          }),
        ),
      ).rejects.toThrow("CI repair did not complete");

      const resumed = await authority.run(() => ownedStore.read(card.id));
      expect(resumed).toMatchObject({
        phase: "review",
        operationKey: "original-task-operation",
        primarySessionId: "ses_ci-replacement",
        sessionRecovery: {
          originalSessionId: "ses_lost-ci-owner",
          status: "reconstruction-verified",
        },
        pullRequest: {
          number: 9,
          url: "https://github.com/owner/repo/pull/9",
          headSha,
        },
        ciRepair: {
          cycleId: "ci-cycle-original",
          activePrimaryOperation: { operationId: "ci-cycle-original:pass:1" },
        },
      });
      expect(
        run.mock.calls.some(
          ([options]) =>
            options.prompt === originalPrompt &&
            options.sessionId === "ses_ci-replacement",
        ),
      ).toBe(true);
      expect(github.findPullRequestState).toHaveBeenCalled();
      expect(fs.existsSync(repositoryPath)).toBe(true);

      // Start a fresh canonical published-feedback attempt and lose its primary
      // session before the feedback correction operation is dispatched.
      const beforeFeedback = await authority.run(() =>
        ownedStore.read(card.id),
      );
      if (beforeFeedback === null)
        throw new Error("Expected canonical task record");
      const feedbackRunStore = new RunStore(
        pinned.storageRoot,
        "feedback-restart-attempt",
        pinned,
        lease,
      );
      feedbackRunStore.create({
        ...runStore.read()!,
        revision: 1,
        attemptId: "feedback-restart-attempt",
        lifecycle: "ci",
        checkpoint: "ci",
        sessions: { primary: "ses_lost-feedback-owner" },
        compatibility: {},
        updatedAt: new Date().toISOString(),
      });
      const feedbackAuthority = new ProjectRunAuthority(
        project.id,
        feedbackRunStore,
        1,
        undefined,
        undefined,
        card.id,
      );
      const feedbackStore = new TaskExecutionStore(
        project.contextRoot,
        project,
        feedbackAuthority,
      );
      const feedbackLedger = new FeedbackLedgerStore(
        project.contextRoot,
        project,
        feedbackAuthority,
      );
      let feedbackHeadSha = headSha;
      const feedbackOperationId = `feedback:${feedbackHeadSha}:${createHash(
        "sha256",
      )
        .update("inline-comment:501:Handle the empty case.")
        .digest("hex")
        .slice(0, 16)}`;
      const feedbackQueue = new TaskMutationQueue(
        pinned.storageRoot,
        project,
        feedbackAuthority,
      );
      feedbackQueue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: feedbackOperationId,
        operationKey: feedbackOperationId,
        kind: "feedback",
        enqueuedAt: new Date().toISOString(),
      });
      expect(feedbackQueue.claimNext()?.eventId).toBe(feedbackOperationId);
      feedbackQueue.fail(feedbackOperationId);
      await feedbackAuthority.run(() =>
        feedbackStore.create({
          ...beforeFeedback,
          revision: 1,
          phase: "human-feedback",
          primarySessionId: "ses_lost-feedback-owner",
          sessionCreationStatus: "bound",
          sessionRecovery: undefined,
          ciRepair: undefined,
          reviewRepair: undefined,
          feedbackRemediation: {
            operationId: feedbackOperationId,
            status: "active",
            headSha: feedbackHeadSha,
            ledgerRevision: 1,
          },
          primaryOperations: {
            [feedbackOperationId]: {
              id: feedbackOperationId,
              activity: "feedback-remediation",
              executions: 1,
              status: "failed",
              retrySafe: true,
              lastSessionId: "ses_lost-feedback-owner",
              updatedAt: new Date().toISOString(),
            },
          },
          lastEvent: {
            id: "feedback-restart-ci-passed",
            type: "ci-passed-awaiting-human",
            operationKey: beforeFeedback.operationKey,
            occurredAt: new Date().toISOString(),
          },
          reviewObservation: {
            headSha: feedbackHeadSha,
            observedAt: new Date().toISOString(),
            ciEvaluation: {
              status: "passed",
              expectedCheckNames: ["Build"],
              missingChecks: [],
              pendingChecks: [],
              failureCheckNames: [],
            },
            feedbackIds: ["501"],
          },
          updatedAt: new Date().toISOString(),
        }),
      );
      await feedbackAuthority.run(() =>
        feedbackLedger.create(card.id, [
          {
            kind: "review",
            id: "12",
            author: "reviewer",
            createdAt: "2026-10-24T11:00:00.000Z",
            updatedAt: null,
            body: "Please handle the empty case.",
            actionability: "actionable",
            status: "pending",
            verificationEvidence: [],
          },
          {
            kind: "inline-comment",
            id: "501",
            author: "reviewer",
            createdAt: "2026-10-24T11:00:00.000Z",
            updatedAt: null,
            body: "Handle the empty case.",
            actionability: "actionable",
            status: "pending",
            verificationEvidence: [],
          },
        ]),
      );
      const feedbackPlanStore = new TaskPlanStore(
        project.contextRoot,
        project,
        feedbackAuthority,
      );
      await feedbackAuthority.run(async () =>
        feedbackPlanStore.create(
          {
            version: 1,
            projectId: project.id,
            cardId: card.id,
            requirements: [
              { id: "REQ-1", text: "Task", verification: "Check task" },
            ],
            steps: [
              {
                id: "STEP-1",
                description: "Implement task",
                requirementIds: ["REQ-1"],
                verification: "Run checks",
              },
            ],
            assumptions: [],
            blockers: [],
          },
          1,
        ),
      );
      await feedbackAuthority.run(async () =>
        feedbackPlanStore.storeVerification(card.id, 1, {
          version: 1,
          projectId: project.id,
          cardId: card.id,
          planRevision: 1,
          verdict: "pass",
          findings: [],
        }),
      );
      await feedbackAuthority.run(async () =>
        writeTrustedCommitState(project, card.id, {
          version: 1,
          kind: "trusted-commit",
          projectId: project.id,
          cardId: card.id,
          taskBranch: `agent/${card.id}`,
          defaultBranch: "main",
          commitSha: headSha,
        }),
      );
      feedbackMode = true;
      malformedFeedbackCommitResult = true;
      replacementSessionId = "ses_feedback-replacement";
      listedSessionId = undefined;
      await feedbackAuthority.run(() =>
        runTaskSessionWorkflow({
          project,
          trello,
          git,
          github,
          openCode: new OpenCodeClient(run),
          commands,
          signal: new AbortController().signal,
          prepareAttachmentContext: async () => undefined,
        }),
      );
      feedbackHeadSha = publishedHeadSha;
      expect(
        fs
          .readdirSync(path.join(worktreePath, ".agent-orchestrator"))
          .filter((name) => name.startsWith("commit-result-")),
      ).toEqual([]);
      const afterFeedback = await feedbackAuthority.run(() =>
        feedbackStore.read(card.id),
      );
      expect(
        afterFeedback?.sessionRecovery?.contextAvailabilityReason,
      ).toBeUndefined();
      expect(
        run.mock.calls.some(([options]) =>
          options.prompt.includes("Restore continuity"),
        ),
      ).toBe(true);
      expect(afterFeedback).toMatchObject({
        phase: "ci",
        primarySessionId: "ses_feedback-replacement",
        sessionRecovery: {
          originalSessionId: "ses_lost-feedback-owner",
          status: "reconstruction-verified",
        },
        operationKey: "original-task-operation",
        pullRequest: {
          number: 9,
          url: "https://github.com/owner/repo/pull/9",
          headSha: feedbackHeadSha,
        },
        feedbackRemediation: {
          operationId: feedbackOperationId,
          status: "changed",
          headSha,
        },
      });
      expect(
        run.mock.calls.some(
          ([options]) =>
            options.prompt.startsWith(
              "Address the following verified-as-actionable human PR feedback",
            ) &&
            options.prompt.includes("Handle the empty case.") &&
            options.sessionId === "ses_feedback-replacement",
        ),
      ).toBe(true);
      expect(
        afterFeedback?.primaryOperations?.[feedbackOperationId],
      ).toMatchObject({
        id: feedbackOperationId,
        activity: "feedback-remediation",
        executions: 2,
        status: "completed",
      });
      expect(
        run.mock.calls.filter(
          ([options]) =>
            options.prompt.startsWith(
              "Address the following verified-as-actionable human PR feedback",
            ) && options.sessionId === "ses_feedback-replacement",
        ),
      ).toHaveLength(1);

      // A second process restart occurs after feedback has completed and the
      // canonical task has moved into its validation checkpoint. The published
      // Trello card intentionally remains in Human Review; the feedback queue
      // event remains the persisted owner and must not be mistaken for the
      // original implementation claim or replay feedback remediation.
      const checkpointOperationId = `feedback:${feedbackHeadSha}:checkpoint`;
      feedbackQueue.enqueue({
        projectId: project.id,
        cardId: card.id,
        eventId: checkpointOperationId,
        operationKey: checkpointOperationId,
        kind: "feedback",
        enqueuedAt: new Date().toISOString(),
      });
      expect(feedbackQueue.claimNext()?.eventId).toBe(checkpointOperationId);
      feedbackQueue.fail(checkpointOperationId);
      if (afterFeedback === null)
        throw new Error("Expected feedback-completed task record");
      const feedbackCompletedRecord = await feedbackAuthority.run(() => {
        const awaitingHuman = transitionTaskExecutionRecord(afterFeedback, {
          type: "ci-passed-awaiting-human",
          eventId: `${feedbackOperationId}:ci-passed-awaiting-human`,
          projectId: project.id,
          cardId: card.id,
          operationKey: afterFeedback.operationKey,
          occurredAt: new Date(
            Math.max(Date.now(), Date.parse(afterFeedback.updatedAt) + 1),
          ).toISOString(),
        });
        return feedbackStore.compareAndSwap(
          card.id,
          afterFeedback.revision,
          awaitingHuman,
        );
      });
      expect(feedbackCompletedRecord.feedbackRemediation).toMatchObject({
        operationId: feedbackOperationId,
        status: "changed",
        headSha,
      });
      await feedbackAuthority.run(() => {
        const prepared = feedbackStore.compareAndSwap(
          card.id,
          feedbackCompletedRecord.revision,
          {
            ...feedbackCompletedRecord,
            ciRepair: undefined,
            reviewObservation: undefined,
            publicationQuality: undefined,
            reviewRepair: undefined,
            revision: feedbackCompletedRecord.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        );
        const feedbackReceived = transitionTaskExecutionRecord(prepared, {
          type: "feedback-received",
          eventId: `${feedbackOperationId}:feedback-received`,
          projectId: project.id,
          cardId: card.id,
          operationKey: feedbackCompletedRecord.operationKey,
          occurredAt: new Date().toISOString(),
        });
        expect(feedbackReceived.feedbackRemediation).toMatchObject({
          operationId: feedbackOperationId,
          status: "changed",
          headSha,
        });
        const implementation = feedbackStore.compareAndSwap(
          card.id,
          prepared.revision,
          feedbackReceived,
        );
        const validation = transitionTaskExecutionRecord(implementation, {
          type: "implementation-completed",
          eventId: `${feedbackOperationId}:implementation-completed`,
          projectId: project.id,
          cardId: card.id,
          operationKey: implementation.operationKey,
          occurredAt: new Date().toISOString(),
        });
        expect(validation.feedbackRemediation).toMatchObject({
          operationId: feedbackOperationId,
          status: "changed",
          headSha,
        });
        feedbackStore.compareAndSwap(card.id, implementation.revision, {
          ...validation,
          primarySessionId: "ses_lost-validation-owner",
          sessionRecovery: undefined,
          feedbackRemediation: {
            operationId: checkpointOperationId,
            status: "changed",
            headSha: feedbackHeadSha,
            ledgerRevision: 1,
          },
          primaryOperations: {
            ...validation.primaryOperations,
            [checkpointOperationId]: {
              id: checkpointOperationId,
              activity: "feedback-remediation",
              executions: 1,
              status: "completed",
              result: {
                exitCode: 0,
                output: "persisted feedback result",
                errorOutput: "",
              },
              lastSessionId: "ses_lost-validation-owner",
              updatedAt: new Date().toISOString(),
            },
          },
        });
      });
      replacementSessionId = "ses_validation-replacement";
      validationCheckpointMode = true;
      listedSessionId =
        validationSessionState === "reachable"
          ? "ses_lost-validation-owner"
          : undefined;
      abortAtValidation = true;
      const validationRunStart = run.mock.calls.length;
      await expect(
        feedbackAuthority.run(() =>
          runTaskSessionWorkflow({
            project,
            trello,
            git,
            github,
            openCode: new OpenCodeClient(run),
            commands,
            signal: validationRestartController!.signal,
            prepareAttachmentContext: async () => undefined,
          }),
        ),
      ).rejects.toThrow("Publication configuration differs from attempt pins");
      const afterValidationRestart = await feedbackAuthority.run(() =>
        feedbackStore.read(card.id),
      );
      expect(afterValidationRestart?.primarySessionId).toBe(
        validationSessionState === "reachable"
          ? "ses_lost-validation-owner"
          : "ses_validation-replacement",
      );
      if (validationSessionState === "confirmed-lost")
        expect(afterValidationRestart?.sessionRecovery).toMatchObject({
          originalSessionId: "ses_lost-validation-owner",
          status: "reconstruction-verified",
        });
      else expect(afterValidationRestart?.sessionRecovery).toBeUndefined();
      expect(afterValidationRestart?.phase).toBe("publication");
      expect(afterValidationRestart?.operationKey).toBe(
        "original-task-operation",
      );
      expect(cardListId).toBe(project.trello.reviewListId);
      expect(card.idList).toBe(project.trello.reviewListId);
      expect(feedbackQueue.getActive()).toMatchObject({
        eventId: checkpointOperationId,
        kind: "feedback",
        cardId: card.id,
      });
      expect(
        afterValidationRestart?.primaryOperations?.[checkpointOperationId],
      ).toMatchObject({ executions: 1, status: "completed" });
      expect(
        run.mock.calls
          .slice(validationRunStart)
          .some(([options]) =>
            options.prompt.startsWith(
              "Address the following verified-as-actionable human PR feedback",
            ),
          ),
      ).toBe(false);
      expect(
        run.mock.calls
          .slice(validationRunStart)
          .some(([options]) =>
            options.prompt.includes(
              "Implement the task described on the Trello card",
            ),
          ),
      ).toBe(false);
    },
  );

  it("does not claim a queued Ready event before its start time and resumes it once eligible", async () => {
    const { project } = projectFixture();
    const card: TrelloCard = {
      ...createCard(),
      start: new Date(Date.now() + 60_000).toISOString(),
    };
    const queue = new TaskMutationQueue(project.contextRoot, project);
    const digest = createHash("sha256")
      .update(`${card.name}\0${card.desc}\0${card.idLabels.join(",")}`)
      .digest("hex")
      .slice(0, 16);
    queue.enqueue({
      eventId: `implementation:card:${digest}`,
      projectId: project.id,
      cardId: card.id,
      kind: "implementation",
      operationKey: `task-session:card:${digest}`,
      enqueuedAt: new Date().toISOString(),
    });
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.readyListId ? [card] : [],
      ),
    } as unknown as TrelloClient;
    const poll = () =>
      pollProject(
        trello,
        {} as GitClient,
        {} as GitHubClient,
        new OpenCodeClient(vi.fn<RunOpenCode>()),
        new CommandRunner(vi.fn<RunCommand>()),
        project,
        new AbortController().signal,
      );

    await poll();
    expect(queue.getActive()).toBeNull();
    expect(queue.list()).toMatchObject([
      { eventId: `implementation:card:${digest}`, status: "queued" },
    ]);
    expect(
      new TaskExecutionStore(project.contextRoot, project).read(card.id),
    ).toBeNull();

    card.start = new Date(Date.now() - 60_000).toISOString();
    await expect(poll()).rejects.toThrow();
    expect(queue.list()).toMatchObject([
      {
        eventId: `implementation:card:${digest}`,
        status: "failed",
      },
    ]);
  });

  it("recovers an interrupted Working task through the primary session before CI and feedback polling", async () => {
    const { project, repositoryPath, worktreeRoot } = projectFixture();
    const card = createCard();
    let branch = "";
    let headSha = "a".repeat(40);
    let commitIndex = 0;
    const commitHeads = [
      "b".repeat(40),
      "c".repeat(40),
      "d".repeat(40),
      "e".repeat(40),
      ...Array.from({ length: 20 }, (_, index) =>
        index.toString(16).padStart(40, "0"),
      ),
    ];
    let cardList = project.trello.readyListId;
    let failFirstClaimMove = true;
    let pullRequestCreated = false;
    let pullRequestDraft = false;
    let feedbackActive = false;
    let lateFeedback = false;
    let failAllChecks = false;
    let failNextPush = true;
    let throwAfterFirstReviewReply = true;
    let reviewReplyMutationCount = 0;
    let nextReplyId = 900;
    const reviewReplyBodies: Array<{ body: string; id: number }> = [];
    let conversationReplyCount = 0;
    let nextConversationReplyId = 910;
    const conversationReplyBodies: string[] = [];
    const trackedFiles = ["src/settings.ts"];
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repo: string, worktreePath: string, nextBranch: string) => {
          branch = nextBranch;
          fs.mkdirSync(worktreePath, { recursive: true });
          fs.mkdirSync(
            path.dirname(path.join(worktreePath, "src/settings.ts")),
            { recursive: true },
          );
          fs.writeFileSync(
            path.join(worktreePath, "src/settings.ts"),
            "export const settings = {};\n",
          );
        },
      ),
      getCurrentBranch: vi.fn(async () => branch),
      getHeadSha: vi.fn(async () => headSha),
      getRebaseState: vi.fn(async () => null),
      getConflictedPaths: vi.fn(async () => []),
      getHeadTrackedFiles: vi.fn(async () => trackedFiles),
      getIndexEntries: vi.fn(
        async () =>
          "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsrc/settings.ts\0",
      ),
      getUntrackedFiles: vi.fn(async () => []),
      getStatus: vi.fn(async () => ""),
      getDiff: vi.fn(async (_cwd: string, staged = false) =>
        staged ? "" : "implementation diff",
      ),
      stageAllExcept: vi.fn(async () => undefined),
      commit: vi.fn(async () => {
        headSha = commitHeads[commitIndex++]!;
      }),
      getCommitCountBetween: vi.fn(async () => 1),
      rebase: vi.fn(async () => undefined),
      getRemoteBranchSha: vi.fn(async () => null),
      push: vi.fn(async () => {
        if (failNextPush) {
          failNextPush = false;
          throw new Error("simulated interruption after trusted commit");
        }
      }),
    } as unknown as GitClient;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === cardList ? [{ ...card, idList: cardList }] : [],
      ),
      getCard: vi.fn(async () => ({ ...card, idList: cardList })),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        if (listId === project.trello.workingListId && failFirstClaimMove) {
          failFirstClaimMove = false;
          throw new Error("simulated interruption after worktree preparation");
        }
        cardList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const githubRun = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        const requestedFields =
          args.find((argument) => argument.includes("headRefOid")) ?? "";
        if (!pullRequestCreated)
          return requestedFields.length > 0 ? JSON.stringify([]) : "";
        if (requestedFields.includes("reviewDecision")) {
          return JSON.stringify([
            {
              url: "https://github.com/owner/repo/pull/9",
              number: 9,
              reviewDecision: feedbackActive
                ? "CHANGES_REQUESTED"
                : "REVIEW_REQUIRED",
              headRefOid: headSha,
            },
          ]);
        }
        if (requestedFields.length > 0) {
          return JSON.stringify([
            {
              url: "https://github.com/owner/repo/pull/9",
              state: "OPEN",
              mergedAt: null,
              headRefOid: headSha,
              baseRefName: "main",
              headRefName: "agent/card",
              headRepository: { name: "repo" },
              headRepositoryOwner: { login: "owner" },
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
            },
          ]);
        }
        return pullRequestCreated ? "https://github.com/owner/repo/pull/9" : "";
      }
      if (args[0] === "pr" && args[1] === "create") {
        pullRequestDraft = args.includes("--draft");
        pullRequestCreated = true;
        return "https://github.com/owner/repo/pull/9";
      }
      if (args[0] === "api" && args[1]?.includes("/pulls/9/reviews")) {
        return feedbackActive
          ? JSON.stringify([
              [
                {
                  id: 12,
                  body: null,
                  commit_id: headSha,
                  state: "CHANGES_REQUESTED",
                  submitted_at: "2026-10-24T11:00:00Z",
                  user: { login: "reviewer" },
                },
              ],
            ])
          : JSON.stringify([[]]);
      }
      if (args[0] === "api" && args[1]?.includes("/pulls/9/comments")) {
        return feedbackActive
          ? JSON.stringify([
              [
                {
                  id: 501,
                  pull_request_review_id: 12,
                  body: "Fix the empty settings case.",
                  path: "src/settings.ts",
                  line: 2,
                  original_line: 2,
                  diff_hunk: "@@ -1 +1 @@",
                  user: { login: "reviewer" },
                },
                ...(lateFeedback
                  ? [
                      {
                        id: 502,
                        pull_request_review_id: 12,
                        body: "Also cover the reset path.",
                        path: "src/settings.ts",
                        line: 3,
                        original_line: 3,
                        diff_hunk: "@@ -2 +2 @@",
                        user: { login: "reviewer" },
                      },
                    ]
                  : []),
              ],
            ])
          : JSON.stringify([[]]);
      }
      if (args[0] === "api" && args[1] === "graphql") {
        if (
          args.some((argument) =>
            argument.includes("addPullRequestReviewThreadReply"),
          )
        ) {
          reviewReplyMutationCount += 1;
          const replyBody =
            args
              .find((argument) => argument.startsWith("body="))
              ?.slice("body=".length) ?? "";
          const replyId = nextReplyId++;
          reviewReplyBodies.push({ body: replyBody, id: replyId });
          if (throwAfterFirstReviewReply) {
            throwAfterFirstReviewReply = false;
            throw new Error("socket closed after GitHub accepted the reply");
          }
          return JSON.stringify({
            data: {
              addPullRequestReviewThreadReply: {
                comment: { databaseId: replyId },
              },
            },
          });
        }
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [501, ...(lateFeedback ? [502] : [])].map((id) => ({
                    id: `PRRT_${id}`,
                    isResolved: false,
                    isOutdated: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: id,
                          body:
                            id === 501
                              ? "Fix the empty settings case."
                              : "Also cover the reset path.",
                          author: { login: "reviewer" },
                          path: "src/settings.ts",
                          line: id === 501 ? 2 : 3,
                          originalLine: id === 501 ? 2 : 3,
                          diffHunk: "@@ -1 +1 @@",
                          pullRequestReview: { databaseId: 12 },
                        },
                        ...reviewReplyBodies
                          .filter((reply) =>
                            reply.body.includes(`inline-comment%3A${id}`),
                          )
                          .map((reply) => ({
                            databaseId: reply.id,
                            body: reply.body,
                            author: { login: "agent[bot]" },
                            path: null,
                            line: null,
                            originalLine: null,
                            diffHunk: null,
                            pullRequestReview: { databaseId: 12 },
                          })),
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  })),
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      }
      if (args[0] === "pr" && args[1] === "ready") {
        pullRequestDraft = args.includes("--undo");
        return "";
      }
      if (
        args[0] === "pr" &&
        args[1] === "view" &&
        args[args.indexOf("--json") + 1] === "isDraft"
      )
        return String(pullRequestDraft);
      if (args[0] === "pr" && args[1] === "view")
        return JSON.stringify([
          {
            url: "https://github.com/owner/repo/pull/9",
            state: "OPEN",
            mergedAt: null,
            headRefOid: headSha,
            baseRefName: "main",
            headRefName: "agent/card",
            headRepository: { name: "repo" },
            headRepositoryOwner: { login: "owner" },
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        ]);
      if (
        args[0] === "api" &&
        args.some((argument) => argument.includes("/check-runs?"))
      ) {
        const endpoint =
          args.find((argument) => argument.includes("/check-runs?")) ?? "";
        const observedHead =
          endpoint.match(/\/commits\/([0-9a-f]+)\/check-runs/u)?.[1] ?? "";
        return JSON.stringify([
          {
            total_count: 2,
            check_runs: [
              {
                id: 42,
                name: "Build",
                head_sha: observedHead,
                status: "completed",
                conclusion:
                  observedHead === "b".repeat(40) || failAllChecks
                    ? "failure"
                    : "success",
                created_at: "2026-10-24T10:00:00Z",
                html_url: "https://github.com/owner/repo/actions/runs/42",
              },
              {
                id: 43,
                name: "Tests",
                head_sha: observedHead,
                status: "completed",
                conclusion:
                  observedHead === "b".repeat(40) || failAllChecks
                    ? "failure"
                    : "success",
                created_at: "2026-10-24T10:00:01Z",
                html_url: "https://github.com/owner/repo/actions/runs/43",
              },
            ],
          },
        ]);
      }
      if (
        args[0] === "api" &&
        args.some((argument) => argument.includes("/statuses?"))
      ) {
        const endpoint =
          args.find((argument) => argument.includes("/statuses?")) ?? "";
        const observedHead =
          endpoint.match(/\/commits\/([0-9a-f]+)\/statuses/u)?.[1] ?? "";
        return JSON.stringify([
          [
            {
              id: 52,
              context: "Security",
              sha: observedHead,
              state:
                observedHead === "b".repeat(40) || failAllChecks
                  ? "failure"
                  : "success",
              created_at: "2026-10-24T10:00:02Z",
              updated_at: "2026-10-24T10:00:02Z",
              target_url: "https://github.com/owner/repo/security",
              description: "Security policy",
            },
          ],
        ]);
      }
      if (
        args[0] === "api" &&
        args.some((argument) =>
          argument.includes("/protection/required_status_checks"),
        )
      ) {
        return JSON.stringify({
          contexts: ["Build", "Tests", "Security"],
          checks: [],
        });
      }
      if (
        args[0] === "api" &&
        args.some((argument) => argument.includes("/annotations?"))
      )
        return JSON.stringify([[]]);
      if (
        args[0] === "api" &&
        args.some((argument) => argument.includes("/issues/9/comments?"))
      )
        return JSON.stringify([
          [
            ...(feedbackActive
              ? [
                  {
                    id: 601,
                    user: { login: "reviewer" },
                    created_at: "2026-10-24T11:30:00Z",
                    updated_at: null,
                    body: "Please also document the reset behavior.",
                  },
                ]
              : []),
            ...conversationReplyBodies.map((body, index) => ({
              id: 910 + index,
              user: { login: "agent[bot]" },
              created_at: "2026-10-24T12:00:00Z",
              updated_at: null,
              body,
            })),
          ],
        ]);
      if (
        args[0] === "api" &&
        args.includes("POST") &&
        args.some((argument) => argument.includes("/issues/9/comments"))
      ) {
        conversationReplyCount += 1;
        const body =
          args
            .find((argument) => argument.startsWith("body="))
            ?.slice("body=".length) ?? "";
        conversationReplyBodies.push(body);
        return JSON.stringify({ id: nextConversationReplyId++, body });
      }
      return "";
    });
    const github = new GitHubClient(githubRun);
    const plan = {
      version: 1,
      projectId: "project",
      cardId: card.id,
      requirements: [
        {
          id: "REQ-1",
          text: "Persist settings",
          verification: "Reload settings in a test",
        },
      ],
      steps: [
        {
          id: "STEP-1",
          description: "Implement settings persistence",
          requirementIds: ["REQ-1"],
          verification: "Run tests",
        },
      ],
      assumptions: [],
      blockers: [],
    };
    const review = (contentIdentity: string) => ({
      version: 1,
      projectId: "project",
      cardId: card.id,
      verdict: "pass",
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "satisfied",
          details: "Persistence is implemented.",
          evidence: ["src/settings.ts", "tests/settings.test.ts"],
        },
      ],
      blockingFindings: [],
      reviewedContentIdentity: contentIdentity,
    });
    let opened = false;
    let interruptImplementation = true;
    const interruptedProcess = new AbortController();
    const openCodeRun = vi
      .fn<RunOpenCode>()
      .mockImplementation(async (run: OpenCodeRunOptions) => {
        let processEvidence:
          | {
              executionId: string;
              metadataPath: string;
              artifactRoot: string;
            }
          | undefined;
        await run.onExecutionPrepared?.(
          (processEvidence = {
            executionId: `mock-execution-${openCodeRun.mock.calls.length}`,
            metadataPath: path.join(
              getProcessRuntime().artifactRoot,
              `mock-execution-${openCodeRun.mock.calls.length}`,
              "execution.json",
            ),
            artifactRoot: path.join(
              getProcessRuntime().artifactRoot,
              `mock-execution-${openCodeRun.mock.calls.length}`,
            ),
          }),
        );
        if (run.captureSessionId) {
          opened = true;
          return {
            exitCode: 0,
            sessionId: "ses_primary-task",
            output: [
              JSON.stringify({
                type: "step_start",
                sessionID: "ses_primary-task",
              }),
              JSON.stringify({
                type: "text",
                sessionID: "ses_primary-task",
                part: { type: "text", text: JSON.stringify(plan) },
              }),
            ].join("\n"),
            errorOutput: "",
          };
        }
        if (
          run.readOnly &&
          run.prompt.includes("verify the persisted task plan")
        ) {
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: "project",
              cardId: card.id,
              planRevision: 1,
              verdict: "pass",
              findings: [],
            }),
            errorOutput: "",
          };
        }
        if (
          run.readOnly &&
          run.prompt.includes(
            "Independently verify each actionable human PR feedback item",
          )
        ) {
          const identity = run.prompt.match(
            /Reviewed source identity: (sha256:[0-9a-f]{64})/,
          )?.[1];
          const verificationHead = run.prompt.match(
            /Current PR head: ([0-9a-f]{40,64})/,
          )?.[1];
          if (identity === undefined || verificationHead === undefined)
            throw new Error(
              "feedback verifier prompt omitted snapshot identity",
            );
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: "project",
              cardId: card.id,
              headSha: verificationHead,
              contentIdentity: identity,
              dispositions: [
                ["inline-comment", 501],
                ["inline-comment", 502],
                ["conversation-comment", 601],
              ]
                .filter(
                  ([kind, id]) =>
                    run.prompt.includes(`"kind": "${kind}"`) &&
                    run.prompt.includes(`"id": "${id}"`),
                )
                .map(([kind, id]) => ({
                  feedbackId: `${kind}:${id}`,
                  status: "verified-fixed",
                  evidence: ["src/settings.ts", "tests/settings.test.ts"],
                })),
            }),
            errorOutput: "",
          };
        }
        if (run.readOnly) {
          const identity = run.prompt.match(
            /Reviewed source content identity: (sha256:[0-9a-f]{64})/,
          )?.[1];
          if (identity === undefined)
            throw new Error("review prompt omitted source identity");
          return {
            exitCode: 0,
            output: JSON.stringify(review(identity)),
            errorOutput: "",
          };
        }
        if (run.prompt.includes("Implement the task plan in this repository")) {
          fs.writeFileSync(
            path.join(run.cwd, "src/settings.ts"),
            "export const settings = { fixed: true };\n",
          );
          if (interruptImplementation) {
            interruptImplementation = false;
            if (processEvidence === undefined)
              throw new Error(
                "implementation execution evidence was not bound",
              );
            fs.mkdirSync(processEvidence.artifactRoot, { recursive: true });
            fs.writeFileSync(
              processEvidence.metadataPath,
              JSON.stringify({
                executionId: processEvidence.executionId,
                cwd: fs.realpathSync(run.cwd),
                status: "interrupted",
                treeStopped: true,
                exitCode: 1,
                sessionId: run.sessionId,
              }),
            );
            interruptedProcess.abort();
            throw new OpenCodeRunAbortedError();
          }
        }
        if (run.prompt.startsWith("Repair the required GitHub CI failures")) {
          fs.writeFileSync(
            path.join(run.cwd, "src/settings.ts"),
            "export const settings = { fixed: true };\n",
          );
        }
        if (
          run.prompt.startsWith(
            "Address the following verified-as-actionable human PR feedback",
          )
        ) {
          fs.writeFileSync(
            path.join(run.cwd, "src/settings.ts"),
            run.prompt.includes("Also cover the reset path")
              ? "export const settings = { fixed: true, feedbackHandled: true, resetHandled: true };\n"
              : "export const settings = { fixed: true, feedbackHandled: true };\n",
          );
        }
        if (run.prompt.includes("Generate the commit message")) {
          const resultRelativePath = run.prompt.match(
            /Write exactly one JSON object to ([^\n]+)\./u,
          )?.[1];
          if (resultRelativePath === undefined)
            throw new Error(
              "Commit-message prompt omitted its output location",
            );
          const resultPath = path.join(run.cwd, resultRelativePath);
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              message:
                "feat(settings): persist settings\n\n- Save settings.\n- Cover loading.\n\nMake settings survive restart.",
            }),
          );
        }
        return { exitCode: 0, output: "completed", errorOutput: "" };
      });
    const runCommand = vi.fn<RunCommand>(async (options) => {
      if (options.command.startsWith("opencode session list"))
        return {
          exitCode: 0,
          output: JSON.stringify([
            { id: "ses_primary-task", directory: options.cwd },
          ]),
          errorOutput: "",
        };
      return {
        exitCode: 0,
        output: "validation passed",
        errorOutput: "",
      };
    });
    const commands = new CommandRunner(runCommand);
    const openCode = new OpenCodeClient(openCodeRun);
    const signal = new AbortController().signal;
    const abandonQueueOwner = (eventId: string) => {
      const queuePath = path.join(
        project.contextRoot,
        "task-mutation-queues",
        `${project.id}.json`,
      );
      const persisted = JSON.parse(fs.readFileSync(queuePath, "utf8")) as {
        activeEventId: string | null;
        events: Array<{
          eventId: string;
          status: string;
          ownerToken?: string;
          ownerPid?: number;
        }>;
      };
      const event = persisted.events.find(
        (candidate) => candidate.eventId === eventId,
      );
      if (event === undefined)
        throw new Error("Expected persisted queue event");
      persisted.activeEventId = eventId;
      event.status = "active";
      event.ownerToken = "00000000-0000-4000-8000-000000000001";
      event.ownerPid = 2_147_483_647;
      fs.writeFileSync(queuePath, JSON.stringify(persisted), "utf8");
    };
    await expect(
      pollProject(
        trello,
        git,
        github,
        openCode,
        commands,
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("simulated interruption after worktree preparation");
    expect(cardList).toBe(project.trello.readyListId);
    expect(
      new TaskExecutionStore(project.contextRoot, project).read(card.id),
    ).toBe(null);
    expect(fs.existsSync(path.join(worktreeRoot, card.id))).toBe(true);
    const claimedEventId = new TaskMutationQueue(
      project.contextRoot,
      project,
    ).list()[0]!.eventId;
    abandonQueueOwner(claimedEventId);
    await expect(
      pollProject(
        trello,
        git,
        github,
        openCode,
        commands,
        project,
        interruptedProcess.signal,
      ),
    ).rejects.toThrow("Task-session implementation aborted");
    const interruptedRecord = new TaskExecutionStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(interruptedRecord).toMatchObject({
      phase: "implementation",
      primarySessionId: "ses_primary-task",
      sessionCreationStatus: "bound",
      setup: { status: "not-required" },
    });
    const operationID = Object.keys(
      interruptedRecord?.primaryOperations ?? {},
    )[0]!;
    expect(
      interruptedRecord?.primaryOperations?.[operationID]?.executions,
    ).toBe(1);
    expect(
      new TaskMutationQueue(project.contextRoot, project).getActive()?.status,
    ).toBe("failed");
    abandonQueueOwner(claimedEventId);
    await expect(
      pollProject(
        trello,
        git,
        github,
        openCode,
        commands,
        project,
        signal,
        undefined,
        undefined,
        undefined,
        undefined,
        1_000,
      ),
    ).rejects.toThrow("simulated interruption after trusted commit");
    expect(
      new TaskExecutionStore(project.contextRoot, project).read(card.id)
        ?.primaryOperations?.[operationID],
    ).toMatchObject({ id: operationID, executions: 2 });
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(git.commit).toHaveBeenCalledTimes(1);
    expect(opened).toBe(true);
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(trello.moveCard).toHaveBeenCalledWith(
      card.id,
      project.trello.workingListId,
    );
    expect(trello.moveCard).toHaveBeenCalledWith(
      card.id,
      project.trello.reviewListId,
    );
    const feedbackLedger = new FeedbackLedgerStore(
      project.contextRoot,
      project,
    );
    feedbackLedger.create(card.id, [
      {
        kind: "conversation-comment",
        id: "601",
        author: "reviewer",
        createdAt: "2026-10-24T11:30:00.000Z",
        updatedAt: null,
        body: "Please also document the reset behavior.",
        actionability: "actionable",
        status: "pending",
        verificationEvidence: [],
      },
    ]);
    feedbackActive = true;
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(git.commit).toHaveBeenCalledTimes(3);
    expect(pullRequestCreated).toBe(true);
    expect(
      githubRun.mock.calls.filter(
        ([, args]) => args[0] === "pr" && args[1] === "create",
      ),
    ).toHaveLength(1);
    expect(
      openCodeRun.mock.calls.some(
        ([options]) =>
          options.prompt.startsWith("Repair the required GitHub CI failures") &&
          options.prompt.includes("Build") &&
          options.prompt.includes("Tests") &&
          options.prompt.includes("Security") &&
          options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    const record = new TaskExecutionStore(project.contextRoot, project).read(
      card.id,
    );
    expect(record).toMatchObject({
      phase: "ci",
      retryCounters: { ci: 1 },
      pullRequest: { headSha: "d".repeat(40) },
      publicationQuality: {
        validation: { status: "passed", exitCode: 0 },
        coverageEvidence: { status: "skipped", exitCode: null, command: "" },
      },
    });
    expect(
      new TaskMutationQueue(project.contextRoot, project)
        .list()
        .map(({ status }) => status),
    ).toEqual(["completed", "completed", "completed"]);
    expect(trello.getCards).toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktreeRoot, card.id))).toBe(true);
    expect(fs.existsSync(repositoryPath)).toBe(true);
    lateFeedback = true;
    await expect(
      pollProject(trello, git, github, openCode, commands, project, signal),
    ).rejects.toThrow("outcome is uncertain");
    expect(reviewReplyMutationCount).toBe(1);
    expect(conversationReplyCount).toBe(1);
    const afterUncertainReply = new TaskExecutionStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(afterUncertainReply).toMatchObject({
      phase: "human-feedback",
      pullRequest: { headSha: "d".repeat(40) },
    });
    expect(afterUncertainReply?.publicationQuality).toBeDefined();
    expect(feedbackLedger.read(card.id)?.entries).toContainEqual(
      expect.objectContaining({
        kind: "inline-comment",
        id: "501",
        status: "verified",
        replyState: "outcome-unknown",
      }),
    );
    expect(
      new TaskMutationQueue(project.contextRoot, project).getActive()?.eventId,
    ).toContain("feedback-replies:");
    expect(
      new TaskMutationQueue(project.contextRoot, project).getActive()?.status,
    ).toBe("failed");
    expect(
      openCodeRun.mock.calls.some(
        ([options]) =>
          options.prompt.startsWith(
            "Address the following verified-as-actionable human PR feedback",
          ) && options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    // The reply was accepted remotely but the client saw a connection failure.
    // A fresh polling client must find the idempotency marker rather than resend.
    await pollProject(
      trello,
      git,
      github,
      new OpenCodeClient(openCodeRun),
      commands,
      project,
      signal,
    );
    expect(reviewReplyMutationCount).toBe(1);
    const publishedFeedback = feedbackLedger.read(card.id);
    const recoveredRecord = new TaskExecutionStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(recoveredRecord?.reviewObservation).toMatchObject({
      headSha: "d".repeat(40),
      ciEvaluation: {
        status: "passed",
        expectedCheckNames: ["Build", "Security", "Tests"],
      },
    });
    expect(recoveredRecord?.publicationQuality).toBeDefined();
    expect(publishedFeedback?.entries).toContainEqual(
      expect.objectContaining({
        kind: "inline-comment",
        id: "501",
        status: "published",
        replyId: "900",
        remediationCommitSha: "d".repeat(40),
      }),
    );
    expect(recoveredRecord?.phase).toBe("ci");
    expect(publishedFeedback?.entries).toContainEqual(
      expect.objectContaining({
        kind: "conversation-comment",
        id: "601",
        status: "published",
        replyId: "910",
        remediationCommitSha: "d".repeat(40),
      }),
    );

    // The late request is preserved and starts a second remediation round.
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(git.commit).toHaveBeenCalledTimes(4);
    expect(reviewReplyMutationCount).toBe(1);
    const secondRoundRecord = new TaskExecutionStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(secondRoundRecord).toMatchObject({
      phase: "ci",
      pullRequest: { headSha: "e".repeat(40) },
    });
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(reviewReplyMutationCount).toBe(2);
    failAllChecks = true;
    await pollProject(trello, git, github, openCode, commands, project, signal);
    const exhaustedRecord = new TaskExecutionStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(exhaustedRecord).toMatchObject({
      phase: "attention-required",
      retryCounters: { ci: 2 },
      ciRepair: { status: "exhausted" },
    });
    expect(git.commit).toHaveBeenCalledTimes(6);
    expect(
      new TaskMutationQueue(project.contextRoot, project).list().at(-1)?.status,
    ).toBe("failed");
    const finalLedger = feedbackLedger.read(card.id);
    expect(finalLedger?.entries).toContainEqual(
      expect.objectContaining({
        kind: "inline-comment",
        id: "502",
        status: "published",
        replyId: "901",
        remediationCommitSha: "e".repeat(40),
      }),
    );
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(reviewReplyMutationCount).toBe(2);
  });

  it("refuses an unowned Working card without a task-session record", async () => {
    const { project } = projectFixture();
    const legacyCard = {
      ...createCard(),
      idList: project.trello.workingListId,
    };
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.workingListId ? [legacyCard] : [],
      ),
    } as unknown as TrelloClient;
    const openCode = vi.fn<RunOpenCode>();
    await expect(
      pollProject(
        trello,
        {} as GitClient,
        {} as GitHubClient,
        new OpenCodeClient(openCode),
        new CommandRunner(vi.fn<RunCommand>()),
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Refusing to process unowned Working card");
    expect(openCode).not.toHaveBeenCalled();
  });

  it("parks a legacy attention-required task without repeated polling failures or unauthorized mutation", async () => {
    const { project } = projectFixture();
    const card = { ...createCard(), idList: project.trello.workingListId };
    const queue = new TaskMutationQueue(project.contextRoot, project);
    queue.enqueue({
      eventId: "implementation:card:legacy",
      projectId: project.id,
      cardId: card.id,
      kind: "implementation",
      operationKey: "legacy-operation",
      enqueuedAt: "2026-10-25T20:20:00.000Z",
    });
    expect(queue.claimNext()?.cardId).toBe(card.id);
    queue.fail("implementation:card:legacy");
    const store = new TaskExecutionStore(project.contextRoot, project);
    store.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "attention-required",
      primarySessionId: "legacy-session",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      operationKey: "legacy-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 2, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-25T20:20:00.000Z",
      updatedAt: "2026-10-25T20:27:00.000Z",
    });
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.workingListId ? [card] : [],
      ),
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const openCode = vi.fn<RunOpenCode>();
    const call = () =>
      pollProject(
        trello,
        {} as GitClient,
        {} as GitHubClient,
        new OpenCodeClient(openCode),
        new CommandRunner(vi.fn<RunCommand>()),
        project,
        new AbortController().signal,
      );
    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();
    expect(openCode).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(queue.getActive()).toMatchObject({
      eventId: "implementation:card:legacy",
      status: "failed",
    });
    expect(store.read(card.id)?.phase).toBe("attention-required");
  });

  it("waits for delayed registrations and mixed pending/failing CI without consuming repair attempts", async () => {
    const { project, worktreeRoot } = projectFixture();
    project.autoMerge = true;
    const card = createCard();
    card.idList = project.trello.reviewListId;
    const headSha = "d".repeat(40);
    fs.mkdirSync(path.join(worktreeRoot, card.id), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, card.id, "src.ts"), "worktree\n");
    const recordStore = new TaskExecutionStore(project.contextRoot, project);
    recordStore.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "ci",
      primarySessionId: "session",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      pullRequest: {
        number: 9,
        url: "https://github.com/owner/repo/pull/9",
        headSha,
      },
      operationKey: "operation-ci",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.reviewListId ? [card] : [],
      ),
    } as unknown as TrelloClient;
    let checks: Array<{
      source: "check-run";
      id: number;
      name: string;
      headSha: string;
      status: string;
      conclusion: string | null;
      url: null;
    }> = [
      {
        source: "check-run",
        id: 42,
        name: "Build",
        headSha,
        status: "completed",
        conclusion: "success",
        url: null,
      },
    ];
    const github = {
      findPullRequestState: vi.fn(async () => ({
        url: "https://github.com/owner/repo/pull/9",
        state: "OPEN",
        mergedAt: null,
        headRefOid: headSha,
      })),
      getCiObservations: vi.fn(async () => ({
        headSha,
        checks,
        expectationSources: [
          {
            kind: "repository-rules" as const,
            sourceId: "rules",
            complete: true,
            checkNames: ["Build", "Tests", "Security"],
          },
        ],
      })),
      findChangesRequestedPullRequest: vi.fn(async () => null),
      getPullRequestConversationComments: vi.fn(async () => []),
    } as unknown as GitHubClient;
    const openCode = vi.fn<RunOpenCode>();
    await pollProject(
      trello,
      {} as GitClient,
      github,
      new OpenCodeClient(openCode),
      new CommandRunner(vi.fn<RunCommand>()),
      project,
      new AbortController().signal,
    );
    expect(openCode).not.toHaveBeenCalled();
    expect(recordStore.read(card.id)).toMatchObject({
      phase: "ci",
      reviewObservation: {
        headSha,
        ciEvaluation: {
          status: "waiting",
          expectedCheckNames: ["Build", "Security", "Tests"],
          missingChecks: ["Security", "Tests"],
        },
      },
    });

    checks = [
      {
        source: "check-run",
        id: 42,
        name: "Build",
        headSha,
        status: "completed",
        conclusion: "success",
        url: null,
      },
      {
        source: "check-run",
        id: 43,
        name: "Tests",
        headSha,
        status: "in_progress",
        conclusion: null,
        url: null,
      },
      {
        source: "check-run",
        id: 44,
        name: "Security",
        headSha,
        status: "completed",
        conclusion: "failure",
        url: null,
      },
    ];
    await pollProject(
      trello,
      {} as GitClient,
      github,
      new OpenCodeClient(openCode),
      new CommandRunner(vi.fn<RunCommand>()),
      project,
      new AbortController().signal,
    );
    expect(
      recordStore.read(card.id)?.reviewObservation?.ciEvaluation,
    ).toMatchObject({
      status: "waiting",
      pendingChecks: ["Tests"],
      missingChecks: [],
    });
    expect(recordStore.read(card.id)?.retryCounters.ci).toBe(0);
    expect(new TaskMutationQueue(project.contextRoot, project).list()).toEqual(
      [],
    );
    expect(openCode).not.toHaveBeenCalled();
  });

  it("monitors multiple waiting PRs through production polling without concurrent mutations", async () => {
    const { project } = projectFixture();
    const cards = ["card-one", "card-two"].map((id) => ({
      ...createCard(),
      id,
      idList: project.trello.reviewListId,
    }));
    const headByCard = new Map([
      ["card-one", "a".repeat(40)],
      ["card-two", "b".repeat(40)],
    ]);
    const taskStore = new TaskExecutionStore(project.contextRoot, project);
    for (const [index, card] of cards.entries()) {
      const headSha = headByCard.get(card.id)!;
      taskStore.create({
        version: 1,
        projectId: project.id,
        cardId: card.id,
        phase: "ci",
        primarySessionId: `session-${index}`,
        sessionCreationStatus: "bound",
        expectedBranch: `agent/${card.id}`,
        pullRequest: {
          number: index + 1,
          url: `https://github.com/owner/repo/pull/${index + 1}`,
          headSha,
        },
        operationKey: `operation-${index}`,
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: "2026-10-24T09:00:00.000Z",
        updatedAt: "2026-10-24T09:00:00.000Z",
      });
    }
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.reviewListId ? cards : [],
      ),
    } as unknown as TrelloClient;
    const getCiObservations = vi.fn(
      async ({ headSha }: { headSha: string }) => ({
        headSha,
        checks: [
          {
            source: "check-run" as const,
            id: 42,
            name: "Build",
            headSha,
            status: "queued" as const,
            conclusion: null,
            url: null,
          },
        ],
        expectationSources: [
          {
            kind: "repository-rules" as const,
            sourceId: "rules",
            complete: true,
            checkNames: ["Build"],
          },
        ],
      }),
    );
    const github = {
      findPullRequestState: vi.fn(
        async ({ headBranch }: { headBranch: string }) => {
          const cardId = headBranch.slice("agent/".length);
          const index = cards.findIndex(({ id }) => id === cardId);
          return {
            url: `https://github.com/owner/repo/pull/${index + 1}`,
            state: "OPEN",
            mergedAt: null,
            headRefOid: headByCard.get(cardId),
          };
        },
      ),
      getCiObservations,
      findChangesRequestedPullRequest: vi.fn(async () => null),
      getPullRequestConversationComments: vi.fn(async () => []),
    } as unknown as GitHubClient;
    const openCode = vi.fn<RunOpenCode>();

    await pollProject(
      trello,
      {} as GitClient,
      github,
      new OpenCodeClient(openCode),
      new CommandRunner(vi.fn<RunCommand>()),
      project,
      new AbortController().signal,
    );

    expect(getCiObservations).toHaveBeenCalledTimes(4);
    expect(
      new Set(getCiObservations.mock.calls.map(([input]) => input.headSha)),
    ).toEqual(new Set(headByCard.values()));
    expect(
      taskStore.read("card-one")?.reviewObservation?.ciEvaluation,
    ).toMatchObject({
      status: "waiting",
      expectedCheckNames: ["Build"],
      pendingChecks: ["Build"],
    });
    expect(
      taskStore.read("card-two")?.reviewObservation?.ciEvaluation,
    ).toMatchObject({
      status: "waiting",
      expectedCheckNames: ["Build"],
      pendingChecks: ["Build"],
    });
    expect(new TaskMutationQueue(project.contextRoot, project).list()).toEqual(
      [],
    );
    expect(openCode).not.toHaveBeenCalled();
  });

  it("escalates an ambiguous owned Working task during production restart recovery", async () => {
    const { project, worktreeRoot } = projectFixture();
    const card = { ...createCard(), idList: project.trello.workingListId };
    const worktreePath = path.join(worktreeRoot, card.id);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src.ts"), "preserve me\n");
    const taskStore = new TaskExecutionStore(project.contextRoot, project);
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "implementation",
      primarySessionId: "ses_primary-task",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      operationKey: "restart-operation",
      setup: { command: null, status: "not-required" },
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const queue = new TaskMutationQueue(project.contextRoot, project);
    queue.enqueue({
      projectId: project.id,
      cardId: card.id,
      eventId: "implementation:card:restart",
      operationKey: "restart-operation",
      kind: "implementation",
      enqueuedAt: "2026-10-24T09:00:00.000Z",
    });
    queue.claimNext();
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.workingListId ? [card] : [],
      ),
    } as unknown as TrelloClient;
    const git = {
      getCurrentBranch: vi.fn(async () => "agent/some-other-task"),
      getHeadSha: vi.fn(async () => "a".repeat(40)),
      getRebaseState: vi.fn(async () => null),
      getConflictedPaths: vi.fn(async () => []),
    } as unknown as GitClient;
    const openCodeRun = vi.fn<RunOpenCode>();
    const commands = new CommandRunner(
      vi.fn<RunCommand>().mockResolvedValue({
        exitCode: 0,
        output: JSON.stringify([
          {
            id: "ses_primary-task",
            directory: worktreePath,
          },
        ]),
        errorOutput: "",
      }),
    );

    await expect(
      pollProject(
        trello,
        git,
        {} as GitHubClient,
        new OpenCodeClient(openCodeRun),
        commands,
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Owned worktree is missing, on the wrong branch");

    expect(taskStore.read(card.id)).toMatchObject({
      phase: "attention-required",
      primarySessionId: "ses_primary-task",
    });
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(worktreePath, "src.ts"), "utf8")).toBe(
      "preserve me\n",
    );
    expect(queue.getActive()).toMatchObject({
      cardId: card.id,
      operationKey: "restart-operation",
    });
  });
});
