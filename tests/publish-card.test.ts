import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import { GitHubClient, type RunGitHubCommand } from "../src/github/github-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH } from "../src/opencode/pull-request-description.js";
import { Logger } from "../src/logging/logger.js";
import { formatFailureDiagnostic } from "../src/orchestrator/failure-diagnostic.js";
import { publishCard } from "../src/orchestrator/publish-card.js";
import { reviewConcernsDismissedAsNonMaterialLabel } from "../src/task-session/implementation-review-result.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

function createProject(validationCommand?: string): ProjectConfig {
  return {
    id: "example",
    autoMerge: false,
    trello: {
      boardId: "board",
      backlogListId: "backlog-list",
      readyListId: "ready-list",
      workingListId: "working-list",
      reviewListId: "review-list",
      failedListId: "failed-list",
      doneListId: "done-list",
      refinementLabelId: "refinement-label",
      featureLabelId: "feature-label",
      improvementLabelId: "improvement-label",
      bugLabelId: "bug-label",
    },
    repository: {
      path: "/tmp/example-repository",
      github: "example/repository",
      defaultBranch: "main",
      worktreeRoot: path.join(os.tmpdir(), "example-worktrees"),
      ...(validationCommand === undefined ? {} : { validationCommand }),
      gitIdentity: {
        name: "Configured Git Author",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
    opencode: {
      refinement: {
        model: "openai/refinement-model",
        variant: "xhigh",
      },
      implementation: {
        model: "implementation-model",
        variant: "implementation-variant",
      },
      review: {
        model: "review-model",
        variant: "review-variant",
      },
      remediation: {
        model: "remediation-model",
        variant: "remediation-variant",
        maxPasses: 1,
      },
      commit: {
        model: "commit-model",
        variant: "commit-variant",
      },
      timeoutMinutes: 360,
    },
  };
}

function createGithubAppProject(): ProjectConfig {
  const project = createProject();

  return {
    ...project,
    repository: {
      ...project.repository,
      githubApp: {
        appId: "app-id",
        installationId: "installation-id",
        privateKeyPath: "/secrets/github-app.pem",
      },
    },
  };
}

function createCard(): TrelloCard {
  return {
    id: "card-1",
    name: "Example task",
    desc: "Implement the example task",
    idList: "working",
    idLabels: [],
    url: "https://trello.com/c/card-1",
  };
}

function createPublicationGit(overrides: Record<string, unknown> = {}): GitClient {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
    getStatus: vi.fn().mockResolvedValue(""),
    getDiff: vi.fn().mockResolvedValue(""),
    getUntrackedFiles: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockResolvedValue(undefined),
    rebase: vi.fn().mockResolvedValue(undefined),
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getRemoteBranchSha: vi.fn().mockResolvedValue(null),
    push: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitClient;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publishCard", () => {
  it("refreshes fallback evidence on the same PR, preserves human text, and drafts failed checks even after passing review", async () => {
    let body = "";
    let published = false;
    const github = {
      findPullRequest: vi.fn(async () =>
        published ? { url: "https://github.com/example/repository/pull/123" } : null,
      ),
      createPullRequest: vi.fn(async (options: { body: string }) => {
        body = options.body;
        published = true;
        return { url: "https://github.com/example/repository/pull/123" };
      }),
      getPullRequestDescription: vi.fn(async () => body),
      editPullRequestDescription: vi.fn(async (options: { body: string }) => {
        body = options.body;
      }),
      ensurePullRequestDraft: vi.fn(),
    } as unknown as GitHubClient;
    const options = {
      emailNotifier: { send: vi.fn() } as unknown as EmailNotifier,
      github,
      trello: {
        moveCard: vi.fn(),
        addComment: vi.fn(),
      } as unknown as TrelloClient,
      git: createPublicationGit({
        getChangedFiles: vi.fn().mockResolvedValue("src/task.ts"),
      }),
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      verifiedDescriptionFacts: () => ["Validation passed on initial content"],
    };
    await publishCard(options);
    body = `Human release notes\n${body}\nHuman checklist`;
    await publishCard({
      ...options,
      qualityNeedsDraft: true,
      verifiedDescriptionFacts: () => ["Validation failed on current content (exit 1)"],
    });
    expect(github.createPullRequest).toHaveBeenCalledOnce();
    expect(github.ensurePullRequestDraft).toHaveBeenCalledOnce();
    expect(body).toContain("Human release notes");
    expect(body).toContain("Human checklist");
    expect(body).toContain("Changed file: src/task.ts");
    expect(body).toContain("Validation failed on current content (exit 1)");
    expect(body).not.toContain("Validation passed on initial content");
    expect(options.emailNotifier.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Validation failed on current content (exit 1)"),
      }),
    );
  });

  it("does not force draft solely for dismissed non-material review findings", async () => {
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
    } as unknown as TrelloClient;
    let createdDraft: boolean | undefined;
    const createPullRequest = vi.fn(async (options: { draft: boolean }) => {
      createdDraft = options.draft;
      return { url: "https://github.com/example/repository/pull/123" };
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit(),
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: reviewConcernsDismissedAsNonMaterialLabel,
      remediationResult: "Findings were evaluated in the primary session",
    });

    expect(createdDraft).toBe(false);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("uses the current prepared negative review for draft status and disclosure", async () => {
    let publication: { draft: boolean; body: string } | undefined;
    const reviewDisclosure: ImplementationReviewResult = {
      version: 1,
      projectId: "example",
      cardId: "card-1",
      verdict: "fail",
      requirementAssessments: [
        {
          requirementId: "REQ-1",
          status: "unsatisfied",
          details: "The requested persisted state is lost after reload.",
          evidence: [],
        },
      ],
      blockingFindings: [
        {
          kind: "defect",
          summary: "Reload loses the saved setting",
          detail: "The current rebased source initializes the default value.",
        },
      ],
      reviewedContentIdentity: `sha256:${"c".repeat(64)}`,
    };
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest: vi.fn(async (options: { draft: boolean; body: string }) => {
        publication = { draft: options.draft, body: options.body };
        return { url: "https://github.com/example/repository/pull/123" };
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit(),
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      beforePushVerification: async () => ({
        reviewResult: "Failed (human review required; material findings unresolved)",
        reviewDisclosure,
        qualityNeedsDraft: false,
      }),
    });

    expect(publication?.draft).toBe(true);
    expect(publication?.body).toContain("The current independent AI review");
    expect(publication?.body).toContain("Reload loses the saved setting");
    expect(publication?.body).toContain("Unsatisfied requirement: REQ-1");
  });

  it("keeps an unavailable prepared review in draft without claiming a pass", async () => {
    let publication: { draft: boolean; body: string } | undefined;
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest: vi.fn(async (options: { draft: boolean; body: string }) => {
        publication = { draft: options.draft, body: options.body };
        return { url: "https://github.com/example/repository/pull/123" };
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit(),
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      beforePushVerification: async () => ({
        reviewResult: "Unavailable (current-source review timed out)",
        reviewDisclosure: null,
        qualityNeedsDraft: false,
      }),
    });

    expect(publication?.draft).toBe(true);
    expect(publication?.body).toContain("Review: Unavailable (current-source review timed out)");
    expect(publication?.body).not.toContain("Review: Passed");
  });

  it("publishes to Human Review even when passed a forged autoMerge value", async () => {
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit(),
      github,
      project: { ...createProject(), autoMerge: true },
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("sends a Human Review email only after the Trello move succeeds", async () => {
    const events: string[] = [];
    let emailText: string | undefined;
    let summaryText: string | undefined;
    const notifier: EmailNotifier = {
      send: vi.fn(async (message) => {
        events.push("email");
        emailText = message.text;
        expect(message.subject).toContain("Human Review");
        expect(message.text).toContain("https://github.com/example/repository/pull/123");
        expect(message.text).toContain("Elapsed workflow time: 1 hour 5 minutes");
      }),
    };
    const trello = {
      moveCard: vi.fn().mockImplementation(async () => {
        events.push("move");
        return createCard();
      }),
      getListTransitions: vi.fn().mockResolvedValue([
        {
          id: "working-transition",
          date: "2026-08-30T10:00:00.000Z",
          listBeforeId: "ready-list",
          listAfterId: "working-list",
        },
        {
          id: "review-transition",
          date: "2026-08-30T11:05:00.000Z",
          listBeforeId: "working-list",
          listAfterId: "review-list",
        },
      ]),
      addComment: vi.fn().mockImplementation(async (_cardId, text) => {
        events.push("comment");
        summaryText = text;
        return undefined;
      }),
    } as unknown as TrelloClient;
    const git = createPublicationGit({
      push: vi.fn().mockImplementation(async () => {
        events.push("push");
      }),
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      emailNotifier: notifier,
    });

    expect(events).toEqual(["push", "move", "email", "comment"]);
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(emailText).toContain("Elapsed workflow time: 1 hour 5 minutes");
    expect(summaryText).toContain("Elapsed workflow time: 1 hour 5 minutes");
  });

  it("does not send a duplicate for a commit already claimed by recovery", async () => {
    const notifier: EmailNotifier = { send: vi.fn() };
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = createPublicationGit();
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;
    const claimHumanReviewNotification = vi.fn(() => false);

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      emailNotifier: notifier,
      claimHumanReviewNotification,
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(claimHumanReviewNotification).toHaveBeenCalledWith("abc123");
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("does not claim notification state when Human Review email is disabled", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn(),
      isEventEnabled: vi.fn(() => false),
    };
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const claimHumanReviewNotification = vi.fn(() => true);

    await publishCard({
      trello,
      git: createPublicationGit(),
      github: {
        findPullRequest: vi.fn().mockResolvedValue({
          url: "https://github.com/example/repository/pull/123",
        }),
      } as unknown as GitHubClient,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      emailNotifier: notifier,
      claimHumanReviewNotification,
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(claimHumanReviewNotification).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("preserves publication artifacts without advancing the card after shutdown", async () => {
    const controller = new AbortController();
    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;
    const git = createPublicationGit({
      push: vi.fn().mockImplementation(async () => {
        controller.abort();
      }),
    });
    const github = {
      findPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
        signal: controller.signal,
      }),
    ).rejects.toThrow("Trello request aborted");

    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("keeps a published card in Human Review when email delivery fails", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = createPublicationGit();
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
        emailNotifier: notifier,
      }),
    ).resolves.toBeUndefined();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(trello.addComment).toHaveBeenCalled();
  });

  it("pushes, creates the PR, and moves the card in order", async () => {
    const events: string[] = [];
    vi.stubEnv("GH_TOKEN", "ambient-pat");

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "fetch" || args[0] === "rebase") {
        events.push(args[0]);
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      if (args[0] === "push") {
        events.push("push");
      }

      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        events.push("find-pr");
        return "";
      }

      events.push("create-pr");
      return "https://github.com/example/repository/pull/123";
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard").mockImplementation(async () => {
      events.push("move");
      return createCard();
    });

    vi.spyOn(trello, "getListTransitions").mockResolvedValue([
      {
        id: "working-transition",
        date: "2026-08-30T10:00:00.000Z",
        listBeforeId: "ready-list",
        listAfterId: "working-list",
      },
      {
        id: "review-transition",
        date: "2026-08-30T11:05:00.000Z",
        listBeforeId: "working-list",
        listAfterId: "review-list",
      },
    ]);

    const addComment = vi.spyOn(trello, "addComment").mockImplementation(async () => {
      events.push("comment");
      return {
        id: "action-1",
        type: "commentCard",
        date: "2026-08-22T09:00:00.000Z",
      };
    });

    await publishCard({
      trello,
      git: new GitClient(runGit),
      github: new GitHubClient(runGitHubCommand),
      project: createProject(),
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(events).toEqual(["fetch", "push", "find-pr", "create-pr", "move", "comment"]);

    expect(runGit).toHaveBeenNthCalledWith(1, "/tmp/example-worktrees/card-1", [
      "branch",
      "--show-current",
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, "/tmp/example-worktrees/card-1", [
      "fetch",
      "origin",
      "main",
    ]);
    expect(runGit.mock.calls.some(([, args]) => args.includes("rebase"))).toBe(false);
    expect(runGit).toHaveBeenNthCalledWith(3, "/tmp/example-worktrees/card-1", [
      "rev-parse",
      "HEAD",
    ]);

    expect(runGit).toHaveBeenCalledWith("/tmp/example-worktrees/card-1", [
      "push",
      "--set-upstream",
      "origin",
      "agent/card-1",
    ]);

    expect(runGitHubCommand).toHaveBeenNthCalledWith(1, "/tmp/example-worktrees/card-1", [
      "pr",
      "list",
      "--repo",
      "example/repository",
      "--head",
      "agent/card-1",
      "--state",
      "open",
      "--json",
      "url",
      "--limit",
      "1",
      "--jq",
      '.[0].url // ""',
    ]);

    for (const [cwd, args, environment] of runGit.mock.calls) {
      if (["fetch", "ls-remote", "push"].includes(args[0] ?? "")) {
        expect(cwd).toBe("/tmp/example-worktrees/card-1");
        expect(environment).toBeUndefined();
        expect(args).not.toContain("ambient-pat");
      }
    }
    for (const [cwd, args, environment] of runGitHubCommand.mock.calls) {
      expect(cwd).toBe("/tmp/example-worktrees/card-1");
      expect(environment).toBeUndefined();
      expect(args).not.toContain("ambient-pat");
    }
    expect(JSON.stringify(addComment.mock.calls)).not.toContain("ambient-pat");

    expect(runGitHubCommand).toHaveBeenNthCalledWith(2, "/tmp/example-worktrees/card-1", [
      "pr",
      "create",
      "--repo",
      "example/repository",
      "--base",
      "main",
      "--head",
      "agent/card-1",
      "--title",
      "Example task",
      "--body",
      expect.stringContaining("## Outstanding issues"),
    ]);

    expect(moveCard).toHaveBeenCalledWith("card-1", "review-list");

    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Agent Orchestrator completed successfully.",
        "",
        "PR: https://github.com/example/repository/pull/123",
        "Commit: abc123",
        "Review: Passed",
        "Remediation: Not required",
        "Elapsed workflow time: 1 hour 5 minutes",
      ].join("\n"),
    );
  });

  it("uses the post-rebase HEAD for comparison and publication reporting", async () => {
    const postRebaseSha = "rebased-commit";
    const push = vi.fn().mockResolvedValue(undefined);
    const git = createPublicationGit({
      getHeadSha: vi.fn().mockResolvedValue(postRebaseSha),
      getRemoteBranchSha: vi.fn().mockResolvedValue("published-commit"),
      isAncestor: vi.fn().mockResolvedValue(true),
      push,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-commit",
      reviewResult: "Passed",
      remediationResult: "Not required",
      emailNotifier: { send },
    });

    expect(git.fetch).toHaveBeenCalledWith("/worktree", "origin", "main", createProject());
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.getRemoteBranchSha).toHaveBeenCalledWith(
      "/worktree",
      "origin",
      "agent/card-1",
      createProject(),
    );
    expect(git.isAncestor).toHaveBeenCalledWith("/worktree", "published-commit", postRebaseSha);
    expect(push).toHaveBeenCalledWith("/worktree", "origin", "agent/card-1", createProject());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(`Commit: ${postRebaseSha}`),
      }),
    );
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining(`Commit: ${postRebaseSha}`),
    );
    expect(trello.addComment).not.toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Commit: stale-commit"),
    );
  });

  it("generates the PR description from the post-rebase commit and renders it", async () => {
    const events: string[] = [];
    const runDescription = vi.fn(async () => {
      events.push("description");

      return {
        exitCode: 0,
        output: JSON.stringify({
          summary: "Described the published implementation.",
          changes: ["Added structured PR content."],
          validation: ["yarn validate passed."],
        }),
        errorOutput: "",
      };
    });
    const git = createPublicationGit({
      rebase: vi.fn(async () => {
        events.push("rebase");
      }),
      getHeadSha: vi.fn().mockResolvedValue("post-rebase-sha"),
      getChangedFiles: vi.fn().mockResolvedValue("src/description.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("describe implementation"),
      push: vi.fn(async () => {
        events.push("push");
      }),
    });
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode: { run: runDescription } as unknown as OpenCodeClient,
      project: createProject("yarn validate"),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
      verifiedDescriptionFacts: () => ["yarn validate passed."],
    });

    expect(events.slice(0, 2)).toEqual(["description", "push"]);
    expect(runDescription).toHaveBeenCalledTimes(1);
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "commit-model",
        variant: "commit-variant",
        prompt: expect.stringContaining("Resulting commit SHA: post-rebase-sha"),
      }),
    );
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("src/description.ts"),
      }),
    );
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Commit message:\ndescribe implementation"),
      }),
    );
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Automated review result: Passed."),
      }),
    );
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Automated remediation result: Not required."),
      }),
    );
    expect(runDescription).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [
          "<!-- agent-orchestrator-description:start -->",
          "## Summary",
          "Described the published implementation.",
          "",
          "## Changes",
          "- Added structured PR content.",
          "",
          "## Validation",
          "- yarn validate passed.",
          "",
          "",
          "## Outstanding issues",
          "Review: Passed",
          "Remediation: Not required",
          "<!-- agent-orchestrator-description:end -->",
          "",
          "## Task",
          "[Trello card: Example task](https://trello.com/c/card-1)",
          "",
          "Implemented automatically by Configured Git Author.",
          "",
          "<!-- agent-orchestrator-status:start -->",
          "<!-- agent-orchestrator-status:end -->",
        ].join("\n"),
      }),
    );
  });

  it("does not publish an agent-provided validation claim without orchestrator evidence", async () => {
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit(),
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      pullRequestDescription: {
        summary: "Completed the implementation.",
        changes: ["Updated the implementation."],
        validation: ["yarn validate passed."],
      },
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("No verified validation or test results are available."),
      }),
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("yarn validate passed."),
      }),
    );
  });

  it("enriches the exact existing static fallback without replacing a PR", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({
        summary: "Completed implementation.",
        changes: ["Updated the task workflow."],
        validation: ["yarn validate passed with exit code 0."],
      }),
      errorOutput: "",
    });
    const currentBody = [
      "Trello: https://trello.com/c/card-1",
      "",
      "Implemented automatically by Configured Git Author.",
    ].join("\n");
    const editPullRequestDescription = vi.fn();
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/142",
      }),
      getPullRequestDescription: vi.fn().mockResolvedValue(currentBody),
      findPullRequestState: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/142",
        state: "OPEN",
        mergedAt: null,
      }),
      editPullRequestDescription,
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;

    await publishCard({
      trello,
      git: createPublicationGit({
        getChangedFiles: vi.fn().mockResolvedValue("src/task.ts"),
        getCommitMessage: vi.fn().mockResolvedValue("fix(task): complete task"),
      }),
      github,
      opencode: { run } as unknown as OpenCodeClient,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      expectedExistingPullRequestUrl: "https://github.com/example/repository/pull/142",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      verifiedDescriptionFacts: () => ["yarn validate passed with exit code 0."],
    });

    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(editPullRequestDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestUrl: "https://github.com/example/repository/pull/142",
        body: expect.stringContaining("Completed implementation."),
      }),
    );
  });

  it("rejects generated text when read-only source verification detects a mutation", async () => {
    const git = createPublicationGit({
      getStatus: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce(" M src/task.ts"),
      getChangedFiles: vi.fn().mockResolvedValue("src/task.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("fix(task): complete task"),
    });
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;

    await publishCard({
      trello,
      git,
      github,
      opencode: {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          output: JSON.stringify({
            summary: "Generated",
            changes: ["Change"],
            validation: [],
          }),
          errorOutput: "",
        }),
      } as unknown as OpenCodeClient,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("https://trello.com/c/card-1"),
      }),
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.not.stringContaining("Generated"),
      }),
    );
    expect(git.push).toHaveBeenCalled();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("retries conversational description output once with a corrective prompt", async () => {
    const runDescription = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        output: "Here is the pull request description:",
        errorOutput: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: JSON.stringify({
          summary: "Described the published implementation.",
          changes: ["Added structured PR content."],
          validation: [],
        }),
        errorOutput: "",
      });
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/description.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("describe implementation"),
    });
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode: { run: runDescription } as unknown as OpenCodeClient,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(runDescription).toHaveBeenCalledTimes(2);
    expect(runDescription).toHaveBeenCalledWith(
      expect.objectContaining({ sessionLogPath: expect.any(String) }),
    );
    expect(runDescription.mock.calls[1]?.[0].prompt).toEqual(
      expect.stringContaining("The previous response was invalid."),
    );
    expect(runDescription.mock.calls[1]?.[0].prompt).toEqual(
      expect.stringContaining("only one valid JSON object matching exactly the required schema"),
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Described the published implementation."),
      }),
    );
  });

  it("does not forward unknown JSON field names from child output into logs", async () => {
    const marker = "RAW_PR_JSON_FIELD_MARKER_82fd";
    const warnings = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const invalid = JSON.stringify({
      summary: "description",
      changes: [],
      validation: [],
      [marker]: "untrusted output",
    });
    const opencode = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        output: invalid,
        errorOutput: "",
        processExecutionId: "controlled-execution-id",
      }),
    } as unknown as OpenCodeClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("implement example"),
    });
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    const logged = warnings.mock.calls.map(([message]) => message).join("\n");
    expect(logged).not.toContain(marker);
    expect(logged).toContain("schema validation");
    expect(logged).toContain("process-executions/controlled-execution-id");
    warnings.mockRestore();
  });

  it("retains verified publication when the corrective description snapshot fails", async () => {
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/task.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("fix(task): implement"),
      getUntrackedFiles: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("retry snapshot unavailable")),
    });
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;
    const opencode = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        output: "not structured output",
        errorOutput: "",
      }),
    } as unknown as OpenCodeClient;
    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });
    expect(opencode.run).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("uses the deterministic body when final description context collection fails", async () => {
    const contextError = new Error("could not read final changed files");
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockRejectedValue(contextError),
      push: vi.fn().mockResolvedValue(undefined),
    });
    const opencode = { run: vi.fn() } as unknown as OpenCodeClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(git.push).toHaveBeenCalled();
    expect(opencode.run).not.toHaveBeenCalled();
    expect(github.findPullRequest).toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("uses the deterministic body when description generation fails", async () => {
    const generationError = new Error("description model unavailable");
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("implement example"),
      push: vi.fn().mockResolvedValue(undefined),
    });
    const opencode = {
      run: vi.fn().mockRejectedValue(generationError),
    } as unknown as OpenCodeClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(git.push).toHaveBeenCalled();
    expect(opencode.run).toHaveBeenCalledTimes(1);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it.each([
    ["malformed JSON", "not JSON"],
    ["missing required fields", JSON.stringify({ summary: "A summary" })],
    [
      "oversized generated summary",
      JSON.stringify({
        summary: "s".repeat(MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH + 1),
        changes: [],
        validation: [],
      }),
    ],
  ])("uses the deterministic body for %s", async (_failure, output) => {
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("implement example"),
    });
    const runDescription = vi.fn().mockResolvedValue({
      exitCode: 0,
      output,
      errorOutput: "",
    });
    const opencode = {
      run: runDescription,
    } as unknown as OpenCodeClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(runDescription).toHaveBeenCalledTimes(2);
    expect(runDescription.mock.calls[1]?.[0].prompt).toEqual(
      expect.stringContaining("The previous response was invalid."),
    );
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("uses the deterministic body for a non-successful description result", async () => {
    const marker = "RAW_OPENCODE_STDERR_MARKER_7fd9";
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const git = createPublicationGit({
      getChangedFiles: vi.fn().mockResolvedValue("src/example.ts"),
      getCommitMessage: vi.fn().mockResolvedValue("implement example"),
    });
    const opencode = {
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        output: "",
        errorOutput: marker,
      }),
    } as unknown as OpenCodeClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      opencode,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(opencode.run).toHaveBeenCalledTimes(1);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(marker);
    expect(warn.mock.calls.flat().join(" ")).toContain("process execution log");
    warn.mockRestore();
  });

  it("uses the deterministic body when Markdown rendering fails", async () => {
    const git = createPublicationGit();
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const createPullRequest = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repository/pull/123",
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest,
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: {
        ...createCard(),
        name: 42 as unknown as string,
      },
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "stale-sha",
      reviewResult: "Passed",
      remediationResult: "Not required",
      pullRequestDescription: {
        summary: "A summary",
        changes: [],
        validation: [],
      },
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("## Outstanding issues"),
      }),
    );
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("refuses a mismatched existing PR before any branch push", async () => {
    const git = createPublicationGit({ push: vi.fn() });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/999",
      }),
    } as unknown as GitHubClient;
    const trello = { moveCard: vi.fn() } as unknown as TrelloClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "new-commit",
        expectedExistingPullRequestUrl: "https://github.com/example/repository/pull/123",
        reviewResult: "Passed",
        remediationResult: "Feedback remediation",
      }),
    ).rejects.toThrow("Existing PR ownership changed before publication");
    expect(git.push).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("updates an existing PR by fast-forward without rebasing its published head", async () => {
    const url = "https://github.com/example/repository/pull/123";
    const git = createPublicationGit({
      getHeadSha: vi.fn().mockResolvedValue("new-commit"),
      getRemoteBranchSha: vi.fn().mockResolvedValue("published-head"),
      isAncestor: vi.fn().mockResolvedValue(true),
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({ url }),
      findPullRequestState: vi.fn().mockResolvedValue({ url, state: "OPEN", mergedAt: null }),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
    } as unknown as TrelloClient;

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "new-commit",
      expectedExistingPullRequestUrl: url,
      reviewResult: "Passed",
      remediationResult: "Feedback remediation",
    });

    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.isAncestor).toHaveBeenCalledWith("/worktree", "published-head", "new-commit");
    expect(git.push).toHaveBeenCalledWith("/worktree", "origin", "agent/card-1", createProject());
    expect(github.createPullRequest).not.toHaveBeenCalled();
  });

  it("does not push when rebasing an already-current branch leaves HEAD unchanged", async () => {
    const commitSha = "current-commit";
    const git = createPublicationGit({
      getHeadSha: vi.fn().mockResolvedValue(commitSha),
      getRemoteBranchSha: vi.fn().mockResolvedValue(commitSha),
      push: vi.fn(),
    });
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git,
      github,
      project: createProject(),
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha,
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(github.findPullRequest).toHaveBeenCalledTimes(1);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("stops before publication when fetching the default branch fails", async () => {
    const fetchError = new Error("remote unavailable");
    const git = createPublicationGit({
      fetch: vi.fn().mockRejectedValue(fetchError),
      push: vi.fn(),
    });
    const github = {
      findPullRequest: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;
    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "commit-sha",
        reviewResult: "Passed",
        remediationResult: "Not required",
      }),
    ).rejects.toThrow("Failed to fetch origin/main before publishing agent/card-1");

    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("refuses a rebased branch when publication would not be fast-forward", async () => {
    const push = vi.fn();
    const git = createPublicationGit({
      getHeadSha: vi.fn().mockResolvedValue("rebased-commit"),
      getRemoteBranchSha: vi.fn().mockResolvedValue("published-commit"),
      isAncestor: vi.fn().mockResolvedValue(false),
      push,
    });
    const github = {
      findPullRequest: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;
    const trello = {
      moveCard: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "stale-commit",
        reviewResult: "Passed",
        remediationResult: "Not required",
      }),
    ).rejects.toThrow("A non-fast-forward update would be required");

    expect(push).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(push.mock.calls.flat().some((argument) => String(argument).includes("force"))).toBe(
      false,
    );
  });

  it("reuses an existing pull request instead of creating another one", async () => {
    const events: string[] = [];
    const project = createGithubAppProject();
    const token = "project-installation-token";
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });

    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      if (command === "push") {
        events.push("push");
      }

      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        events.push("find-pr");
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("PR creation should not have been called");
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    vi.spyOn(trello, "moveCard").mockImplementation(async () => {
      events.push("move");
      return createCard();
    });

    vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

    const addComment = vi.spyOn(trello, "addComment").mockImplementation(async () => {
      events.push("comment");

      return {
        id: "action-1",
        type: "commentCard",
        date: "2026-08-22T09:00:00.000Z",
      };
    });

    await publishCard({
      trello,
      git: new GitClient(runGit, credentials),
      github: new GitHubClient(runGitHubCommand, credentials, async () => {
        throw new Error("Description unavailable in fixture");
      }),
      project,
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(events).toEqual(["push", "find-pr", "move", "comment"]);

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(getInstallationToken).toHaveBeenCalledTimes(5);
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      1,
      project.repository.githubApp,
      project.repository.github,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      2,
      project.repository.githubApp,
      project.repository.github,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      3,
      project.repository.githubApp,
      project.repository.github,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      4,
      project.repository.githubApp,
      project.repository.github,
    );

    for (const [cwd, args, environment] of runGit.mock.calls) {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (["fetch", "ls-remote", "push"].includes(command ?? "")) {
        expect(cwd).toBe("/tmp/example-worktrees/card-1");
        expect(environment?.GH_TOKEN).toBe(token);
        expect(environment?.GITHUB_TOKEN).toBe(token);
        expect(environment?.GIT_ASKPASS).toBeDefined();
        expect(environment?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(args).not.toContain(token);
      }
    }
    for (const [cwd, args, environment] of runGitHubCommand.mock.calls) {
      expect(cwd).toBe("/tmp/example-worktrees/card-1");
      expect(environment?.GH_TOKEN).toBe(token);
      expect(environment?.GITHUB_TOKEN).toBe(token);
      expect(args).not.toContain(token);
    }
    expect(JSON.stringify(addComment.mock.calls)).not.toContain(token);
  });

  it("publishes with a GitHub App token when no pull request exists", async () => {
    const project = createGithubAppProject();
    const token = "project-installation-token";
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (command === "branch") {
        return "agent/card-1";
      }
      if (command === "rev-parse") {
        return "abc123";
      }
      if (command === "ls-remote") {
        return "";
      }

      return "";
    });
    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "";
      }

      return "https://github.com/example/repository/pull/123";
    });
    const addComment = vi.fn().mockResolvedValue(undefined);
    const trello = {
      moveCard: vi.fn().mockResolvedValue(createCard()),
      getListTransitions: vi.fn().mockResolvedValue([]),
      addComment,
    } as unknown as TrelloClient;

    await publishCard({
      trello,
      git: new GitClient(runGit, credentials),
      github: new GitHubClient(runGitHubCommand, credentials),
      project,
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(runGitHubCommand).toHaveBeenCalledTimes(2);
    expect(getInstallationToken).toHaveBeenCalledTimes(5);
    for (const call of getInstallationToken.mock.calls) {
      expect(call[0]).toBe(project.repository.githubApp);
    }
    for (const [, args, environment] of runGit.mock.calls) {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (["fetch", "ls-remote", "push"].includes(command ?? "")) {
        expect(environment?.GH_TOKEN).toBe(token);
        expect(environment?.GITHUB_TOKEN).toBe(token);
        expect(environment?.GIT_ASKPASS).toBeDefined();
        expect(environment?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(args).not.toContain(token);
      }
    }
    for (const [, args, environment] of runGitHubCommand.mock.calls) {
      expect(environment?.GH_TOKEN).toBe(token);
      expect(environment?.GITHUB_TOKEN).toBe(token);
      expect(args).not.toContain(token);
    }
    expect(JSON.stringify(addComment.mock.calls)).not.toContain(token);
  });

  it("does not push again when the remote branch already has the commit", async () => {
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rebase") {
        return "";
      }

      if (args[0] === "fetch") {
        return "";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      if (args[0] === "ls-remote") {
        return "abc123\trefs/heads/agent/card-1";
      }

      throw new Error("The already-published branch should not be pushed");
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "";
      }

      return "https://github.com/example/repository/pull/123";
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...createCard(),
      idList: "review-list",
    });

    vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

    vi.spyOn(trello, "addComment").mockResolvedValue({
      id: "action-1",
      type: "commentCard",
      date: "2026-08-22T09:00:00.000Z",
    });

    await publishCard({
      trello,
      git: new GitClient(runGit),
      github: new GitHubClient(runGitHubCommand),
      project: createProject(),
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    expect(runGit).not.toHaveBeenCalledWith("/tmp/example-worktrees/card-1", [
      "push",
      "--set-upstream",
      "origin",
      "agent/card-1",
    ]);
    expect(moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("stops before PR lookup when pushing fails", async () => {
    const project = createGithubAppProject();
    const token = "project-installation-token";
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      if (command === "push") {
        throw new Error(`push failed with ${token}`);
      }

      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>();

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard");

    const request = publishCard({
      trello,
      git: new GitClient(runGit, credentials),
      github: new GitHubClient(runGitHubCommand, credentials),
      project,
      card: createCard(),
      worktreePath: "/tmp/example-worktrees/card-1",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
    });

    let failure: unknown;
    try {
      await request;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("push failed");
    expect((failure as Error).message).not.toContain(token);
    expect(formatFailureDiagnostic(failure)).not.toContain(token);

    expect(runGitHubCommand).not.toHaveBeenCalled();
    expect(moveCard).not.toHaveBeenCalled();
    expect(getInstallationToken).toHaveBeenCalledTimes(3);
    for (const [, args, environment] of runGit.mock.calls) {
      if (args[0] === "-c") {
        expect(environment?.GH_TOKEN).toBe(token);
        expect(environment?.GITHUB_TOKEN).toBe(token);
        expect(environment?.GIT_ASKPASS).toBeDefined();
        expect(environment?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(args).not.toContain(token);
      }
    }
  });

  it("classifies push failures as Git/GitHub workflow errors", async () => {
    const pushError = new Error("push failed");

    const trello = {
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    const git = createPublicationGit({
      push: vi.fn().mockRejectedValue(pushError),
    });

    const github = {
      findPullRequest: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    try {
      await publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "commit-sha",
        reviewResult: "Passed",
        remediationResult: "Not required",
      });

      throw new Error("Expected publishCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);

      const workflowError = error as WorkflowError;

      expect(workflowError.category).toBe("Git/GitHub");
      expect(workflowError.message).toBe("push failed");
      expect(workflowError.cause).toBe(pushError);
    }
  });

  it("classifies remote branch inspection failures as Git/GitHub errors", async () => {
    const remoteInspectionError = new Error("remote inspection failed");
    const trello = {
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const git = createPublicationGit({
      getRemoteBranchSha: vi.fn().mockRejectedValue(remoteInspectionError),
      push: vi.fn(),
    });
    const github = {
      findPullRequest: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    try {
      await publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "commit-sha",
        reviewResult: "Passed",
        remediationResult: "Not required",
      });

      throw new Error("Expected publishCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);

      const workflowError = error as WorkflowError;

      expect(workflowError.category).toBe("Git/GitHub");
      expect(workflowError.message).toBe("remote inspection failed");
      expect(workflowError.cause).toBe(remoteInspectionError);
    }

    expect(git.push).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("preserves structured publication failures in the workflow error", async () => {
    const publicationFailure = {
      code: "GIT_AUTH_FAILED",
      reason: "remote rejected credentials",
    };
    const trello = {
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const git = createPublicationGit({
      push: vi.fn().mockRejectedValue(publicationFailure),
    });
    const github = {
      findPullRequest: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    try {
      await publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "commit-sha",
        reviewResult: "Passed",
        remediationResult: "Not required",
      });

      throw new Error("Expected publishCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);

      const workflowError = error as WorkflowError;

      expect(workflowError.message).toBe(JSON.stringify(publicationFailure));
      expect(workflowError.cause).toBe(publicationFailure);
    }
  });

  it("stops before moving the card when PR creation fails", async () => {
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "";
      }

      throw new Error("PR creation failed");
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard");

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
      }),
    ).rejects.toThrow("PR creation failed");

    expect(runGitHubCommand).toHaveBeenCalledTimes(2);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("stops before PR creation and card movement when PR lookup fails", async () => {
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      return "";
    });
    const lookupError = new Error("PR lookup failed");
    const runGitHubCommand = vi.fn<RunGitHubCommand>().mockRejectedValue(lookupError);

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi.spyOn(trello, "moveCard");

    try {
      await publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
      });

      throw new Error("Expected publishCard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);

      const workflowError = error as WorkflowError;

      expect(workflowError.category).toBe("Git/GitHub");
      expect(workflowError.message).toBe("PR lookup failed");
      expect(workflowError.cause).toBe(lookupError);
    }

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("does not block publication when transition history cannot report a duration", async () => {
    const addComment = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "review-list",
      }),
      getListTransitions: vi.fn().mockResolvedValue(null),
      addComment,
    } as unknown as TrelloClient;
    const git = createPublicationGit({
      getHeadSha: vi.fn().mockResolvedValue("commit-sha"),
    });
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
    } as unknown as GitHubClient;

    await expect(
      publishCard({
        trello,
        git,
        github,
        project: createProject(),
        card: createCard(),
        worktreePath: "/worktree",
        branch: "agent/card-1",
        commitSha: "commit-sha",
        reviewResult: "Passed",
        remediationResult: "Not required",
        emailNotifier: { send },
      }),
    ).resolves.toBeUndefined();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "review-list");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Elapsed workflow time:"),
      }),
    );
    expect(addComment).toHaveBeenCalledWith(
      "card-1",
      expect.not.stringContaining("Elapsed workflow time:"),
    );
  });

  it("does not fail publishing when adding the workflow comment fails", async () => {
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      return "";
    });

    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("PR creation should not have been called");
    });

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });

    const moveCard = vi.spyOn(trello, "moveCard").mockResolvedValue({
      ...createCard(),
      idList: "review-list",
    });

    vi.spyOn(trello, "getListTransitions").mockResolvedValue([]);

    vi.spyOn(trello, "addComment").mockRejectedValue(new Error("comment failed"));

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
      }),
    ).resolves.toBeUndefined();

    expect(moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });

  it("classifies a Human Review move failure as a published-state error", async () => {
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return "agent/card-1";
      }

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }

      return "";
    });
    const runGitHubCommand = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return "https://github.com/example/repository/pull/123";
      }

      throw new Error("PR creation should not have been called");
    });
    const reviewError = new Error("Human Review move failed");

    const trello = new TrelloClient({
      apiKey: "test-key",
      token: "test-token",
    });
    const moveCard = vi.spyOn(trello, "moveCard").mockRejectedValue(reviewError);

    await expect(
      publishCard({
        trello,
        git: new GitClient(runGit),
        github: new GitHubClient(runGitHubCommand, undefined, async () => {
          throw new Error("Description unavailable in fixture");
        }),
        project: createProject(),
        card: createCard(),
        worktreePath: "/tmp/example-worktrees/card-1",
        branch: "agent/card-1",
        commitSha: "abc123",
        reviewResult: "Passed",
        remediationResult: "Not required",
      }),
    ).rejects.toThrow("was published, but the Trello card could not be moved to Human Review");

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });
});
