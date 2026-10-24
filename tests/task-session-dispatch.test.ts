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
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
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
    executionMode: "task-session",
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
      requiredChecks: ["Build"],
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
  it("runs an eligible Ready task through planning, implementation, local gates, independent review, commit, and PR publication", async () => {
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
    ];
    let cardList = project.trello.readyListId;
    let pullRequestCreated = false;
    let feedbackActive = false;
    let reviewReplySent = false;
    let reviewReplyBody = "";
    let reviewReplyMutationCount = 0;
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
      push: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === cardList ? [{ ...card, idList: cardList }] : [],
      ),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        cardList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const githubRun = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        const requestedFields =
          args.find((argument) => argument.includes("headRefOid")) ?? "";
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
          reviewReplySent = true;
          reviewReplyBody =
            args
              .find((argument) => argument.startsWith("body="))
              ?.slice("body=".length) ?? "";
          return JSON.stringify({
            data: {
              addPullRequestReviewThreadReply: { comment: { databaseId: 900 } },
            },
          });
        }
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_settings",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 501,
                            body: "Fix the empty settings case.",
                            author: { login: "reviewer" },
                            path: "src/settings.ts",
                            line: 2,
                            originalLine: 2,
                            diffHunk: "@@ -1 +1 @@",
                            pullRequestReview: { databaseId: 12 },
                          },
                          ...(reviewReplySent
                            ? [
                                {
                                  databaseId: 900,
                                  body: reviewReplyBody,
                                  author: { login: "agent[bot]" },
                                  path: null,
                                  line: null,
                                  originalLine: null,
                                  diffHunk: null,
                                  pullRequestReview: { databaseId: 12 },
                                },
                              ]
                            : []),
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  ],
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
          reviewReplySent = true;
          reviewReplyBody =
            args
              .find((argument) => argument.startsWith("body="))
              ?.slice("body=".length) ?? "";
          return JSON.stringify({
            data: {
              addPullRequestReviewThreadReply: { comment: { databaseId: 900 } },
            },
          });
        }
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_settings",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 501,
                            body: "Fix the empty settings case.",
                            author: { login: "reviewer" },
                            path: "src/settings.ts",
                            line: 2,
                            originalLine: 2,
                            diffHunk: "@@ -1 +1 @@",
                            pullRequestReview: { databaseId: 12 },
                          },
                          ...(reviewReplySent
                            ? [
                                {
                                  databaseId: 900,
                                  body: reviewReplyBody,
                                  author: { login: "agent[bot]" },
                                  path: null,
                                  line: null,
                                  originalLine: null,
                                  diffHunk: null,
                                  pullRequestReview: { databaseId: 12 },
                                },
                              ]
                            : []),
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        });
      }
      if (
        args[0] === "api" &&
        args.some((argument) => argument.includes("/check-runs?"))
      ) {
        const endpoint =
          args.find((argument) => argument.includes("/check-runs?")) ?? "";
        const observedHead =
          endpoint.match(/\/commits\/([0-9a-f]+)\/check-runs/u)?.[1] ?? "";
        return JSON.stringify([
          [
            {
              check_runs: [
                {
                  id: 42,
                  name: "Build",
                  head_sha: observedHead,
                  status: "completed",
                  conclusion:
                    observedHead === "b".repeat(40) ? "failure" : "success",
                  created_at: "2026-10-24T10:00:00Z",
                  html_url: "https://github.com/owner/repo/actions/runs/42",
                },
              ],
            },
          ],
        ]);
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
        return JSON.stringify([[]]);
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
                {
                  feedbackId: "inline-comment:501",
                  status: "verified-fixed",
                  evidence: ["src/settings.ts", "tests/settings.test.ts"],
                },
              ],
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
            "export const settings = { fixed: true, feedbackHandled: true };\n",
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
    const commands = new CommandRunner(
      vi.fn<RunCommand>().mockResolvedValue({
        exitCode: 0,
        output: "validation passed",
        errorOutput: "",
      }),
    );
    const openCode = new OpenCodeClient(openCodeRun);
    const signal = new AbortController().signal;
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(opened).toBe(true);
    expect(
      openCodeRun.mock.calls.some(
        ([options]) => options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    expect(git.stageAll).toHaveBeenCalledOnce();
    expect(git.commit).toHaveBeenCalledOnce();
    expect(git.push).toHaveBeenCalledOnce();
    expect(trello.moveCard).toHaveBeenCalledWith(
      card.id,
      project.trello.workingListId,
    );
    expect(trello.moveCard).toHaveBeenCalledWith(
      card.id,
      project.trello.reviewListId,
    );
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
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(reviewReplyMutationCount).toBe(1);
    expect(
      openCodeRun.mock.calls.some(
        ([options]) =>
          options.prompt.startsWith(
            "Address the following verified-as-actionable human PR feedback",
          ) && options.sessionId === "ses_primary-task",
      ),
    ).toBe(true);
    const successfulHeadChecks = githubRun.mock.calls.findIndex(([, args]) =>
      args.some((argument) =>
        argument.includes(`/commits/${"d".repeat(40)}/check-runs`),
      ),
    );
    const replyMutation = githubRun.mock.calls.findIndex(([, args]) =>
      args.some((argument) =>
        argument.includes("addPullRequestReviewThreadReply"),
      ),
    );
    expect(successfulHeadChecks).toBeGreaterThanOrEqual(0);
    expect(replyMutation).toBeGreaterThan(successfulHeadChecks);
    const publishedFeedback = new FeedbackLedgerStore(
      project.contextRoot,
      project,
    ).read(card.id);
    expect(publishedFeedback?.entries).toContainEqual(
      expect.objectContaining({
        kind: "inline-comment",
        id: "501",
        status: "published",
        replyId: "900",
        remediationCommitSha: "d".repeat(40),
      }),
    );
    await pollProject(trello, git, github, openCode, commands, project, signal);
    expect(reviewReplyMutationCount).toBe(1);
  });

  it("refuses to auto-migrate an active Working card without a task-session record", async () => {
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
    ).rejects.toThrow("Refusing to auto-migrate active legacy Working card");
    expect(openCode).not.toHaveBeenCalled();
  });

  it("does not trigger CI repair on a pending required check during production polling", async () => {
    const { project, worktreeRoot } = projectFixture();
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
    const github = {
      findPullRequestState: vi.fn(async () => ({
        url: "https://github.com/owner/repo/pull/9",
        state: "OPEN",
        mergedAt: null,
        headRefOid: headSha,
      })),
      getRequiredChecks: vi.fn(async () => ({
        headSha,
        checks: [
          {
            name: "Build",
            headSha,
            status: "queued",
            conclusion: null,
            diagnostic: "",
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
      reviewObservation: { headSha, checks: [{ status: "queued" }] },
    });
  });
});
