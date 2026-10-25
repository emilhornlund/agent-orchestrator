import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { getCommitResultPath } from "../src/opencode/commit-result.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
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
      stageAll: vi.fn(async () => undefined),
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
        if (run.prompt.includes("Implement the approved task plan")) {
          fs.writeFileSync(
            path.join(run.cwd, "src/settings.ts"),
            "export const settings = { fixed: true };\n",
          );
          if (interruptImplementation) {
            interruptImplementation = false;
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
          const resultPath = getCommitResultPath(run.cwd);
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
    expect(
      new TaskMutationQueue(project.contextRoot, project).getActive()?.status,
    ).toBe("failed");
    abandonQueueOwner(claimedEventId);
    await expect(
      pollProject(trello, git, github, openCode, commands, project, signal),
    ).rejects.toThrow("simulated interruption after trusted commit");
    expect(git.commit).toHaveBeenCalledOnce();
    expect(
      new TaskExecutionStore(project.contextRoot, project).read(card.id),
    ).toMatchObject({ phase: "publication" });
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(opened).toBe(true);
    expect(git.addWorktreeWithNewBranch).toHaveBeenCalledOnce();
    const implementationResumes = openCodeRun.mock.calls.filter(([options]) =>
      options.prompt.includes("Implement the approved task plan"),
    );
    expect(implementationResumes).toHaveLength(2);
    expect(
      implementationResumes.every(
        ([options]) => options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    expect(
      openCodeRun.mock.calls.filter(([options]) => options.captureSessionId),
    ).toHaveLength(1);
    expect(
      openCodeRun.mock.calls.some(
        ([options]) => options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    expect(git.stageAll).toHaveBeenCalledOnce();
    expect(git.commit).toHaveBeenCalledOnce();
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
      mergePullRequest: vi.fn(async () => undefined),
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
    expect(github.mergePullRequest).not.toHaveBeenCalled();
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
