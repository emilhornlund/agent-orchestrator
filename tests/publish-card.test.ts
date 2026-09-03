import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { formatFailureDiagnostic } from "../src/orchestrator/failure-diagnostic.js";
import { publishCard } from "../src/orchestrator/publish-card.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";
import { type TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

function createProject(): ProjectConfig {
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
      worktreeRoot: "/tmp/example-worktrees",
      gitIdentity: {
        name: "Agent Orchestrator",
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

function createPublicationGit(
  overrides: Record<string, unknown> = {},
): GitClient {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue("agent/card-1"),
    fetch: vi.fn().mockResolvedValue(undefined),
    rebase: vi.fn().mockResolvedValue(undefined),
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    push: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitClient;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publishCard", () => {
  it("auto-merges after publication and completes before notifying", async () => {
    const events: string[] = [];
    const project = { ...createProject(), autoMerge: true };
    const notifier: EmailNotifier = {
      send: vi.fn(async (message) => {
        events.push("email");
        expect(message.text).toContain(
          "https://github.com/example/repository/pull/123",
        );
      }),
    };
    const trello = {
      moveCard: vi.fn().mockImplementation(async () => {
        events.push("done");
        return { ...createCard(), idList: "done-list" };
      }),
      addComment: vi.fn().mockImplementation(async (_cardId, text) => {
        events.push("comment");
        expect(text).toContain("Status: Auto-merged");
        expect(text).toContain("Final published commit: abc123");
        expect(text).toContain("Review: Passed");
        expect(text).toContain("Remediation: Not required");
        return undefined;
      }),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      mergePullRequest: vi.fn().mockImplementation(async () => {
        events.push("merge");
      }),
    } as unknown as GitHubClient;

    await publishCard({
      trello,
      git: createPublicationGit({
        push: vi.fn().mockImplementation(async () => {
          events.push("push");
        }),
      }),
      github,
      project,
      card: createCard(),
      worktreePath: "/worktree",
      branch: "agent/card-1",
      commitSha: "abc123",
      reviewResult: "Passed",
      remediationResult: "Not required",
      emailNotifier: notifier,
    });

    expect(events).toEqual(["push", "merge", "done", "email", "comment"]);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done-list", {
      dueComplete: true,
    });
    expect(github.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/worktree",
      repository: "example/repository",
      pullRequestUrl: "https://github.com/example/repository/pull/123",
      commitSha: "abc123",
      project,
    });
  });

  it("does not complete or notify when auto-merge fails", async () => {
    const mergeError = new Error("merge blocked");
    const trello = {
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      mergePullRequest: vi.fn().mockRejectedValue(mergeError),
    } as unknown as GitHubClient;
    const notifier: EmailNotifier = { send: vi.fn() };

    await expect(
      publishCard({
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
        emailNotifier: notifier,
      }),
    ).rejects.toThrow("Could not auto-merge pull request");

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(trello.addComment).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("keeps an auto-merged card in Done when completion email delivery fails", async () => {
    const trello = {
      moveCard: vi.fn().mockResolvedValue({
        ...createCard(),
        idList: "done-list",
      }),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      mergePullRequest: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitHubClient;
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };

    await expect(
      publishCard({
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
        emailNotifier: notifier,
      }),
    ).resolves.toBeUndefined();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done-list", {
      dueComplete: true,
    });
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("Status: Auto-merged"),
    );
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("does not add the auto-merge summary when moving to Done fails", async () => {
    const trello = {
      moveCard: vi.fn().mockRejectedValue(new Error("Done unavailable")),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequest: vi.fn().mockResolvedValue({
        url: "https://github.com/example/repository/pull/123",
      }),
      mergePullRequest: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitHubClient;
    const notifier: EmailNotifier = { send: vi.fn() };

    await expect(
      publishCard({
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
        emailNotifier: notifier,
      }),
    ).rejects.toThrow("could not be moved to Done");

    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(trello.addComment).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
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
        expect(message.text).toContain(
          "https://github.com/example/repository/pull/123",
        );
        expect(message.text).toContain(
          "Elapsed workflow time: 1 hour 5 minutes",
        );
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

    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockImplementation(async () => {
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

    const addComment = vi
      .spyOn(trello, "addComment")
      .mockImplementation(async () => {
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

    expect(events).toEqual([
      "fetch",
      "rebase",
      "push",
      "find-pr",
      "create-pr",
      "move",
      "comment",
    ]);

    expect(runGit).toHaveBeenNthCalledWith(1, "/tmp/example-worktrees/card-1", [
      "branch",
      "--show-current",
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, "/tmp/example-worktrees/card-1", [
      "fetch",
      "origin",
      "main",
    ]);
    expect(runGit).toHaveBeenNthCalledWith(
      3,
      "/tmp/example-worktrees/card-1",
      ["rebase", "origin/main"],
      {
        GIT_AUTHOR_NAME: "Agent Orchestrator",
        GIT_AUTHOR_EMAIL: "agent-orchestrator@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Agent Orchestrator",
        GIT_COMMITTER_EMAIL: "agent-orchestrator@users.noreply.github.com",
      },
    );
    expect(runGit).toHaveBeenNthCalledWith(4, "/tmp/example-worktrees/card-1", [
      "rev-parse",
      "HEAD",
    ]);

    expect(runGit).toHaveBeenCalledWith("/tmp/example-worktrees/card-1", [
      "push",
      "--set-upstream",
      "origin",
      "agent/card-1",
    ]);

    expect(runGitHubCommand).toHaveBeenNthCalledWith(
      1,
      "/tmp/example-worktrees/card-1",
      [
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
      ],
    );

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

    expect(runGitHubCommand).toHaveBeenNthCalledWith(
      2,
      "/tmp/example-worktrees/card-1",
      [
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
        [
          "Trello: https://trello.com/c/card-1",
          "",
          "Implemented automatically by Agent Orchestrator.",
        ].join("\n"),
      ],
    );

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

    expect(git.fetch).toHaveBeenCalledWith(
      "/worktree",
      "origin",
      "main",
      createProject(),
    );
    expect(git.rebase).toHaveBeenCalledWith(
      "/worktree",
      "origin/main",
      createProject().repository.gitIdentity,
    );
    expect(git.getRemoteBranchSha).toHaveBeenCalledWith(
      "/worktree",
      "origin",
      "agent/card-1",
      createProject(),
    );
    expect(git.isAncestor).toHaveBeenCalledWith(
      "/worktree",
      "published-commit",
      postRebaseSha,
    );
    expect(push).toHaveBeenCalledWith(
      "/worktree",
      "origin",
      "agent/card-1",
      createProject(),
    );
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

    expect(git.rebase).toHaveBeenCalledWith(
      "/worktree",
      "origin/main",
      createProject().repository.gitIdentity,
    );
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
    ).rejects.toThrow(
      "Failed to fetch origin/main before publishing agent/card-1",
    );

    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(github.findPullRequest).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("stops before publication when rebasing conflicts", async () => {
    const rebaseError = new Error("CONFLICT (content): merge conflict");
    const git = createPublicationGit({
      rebase: vi.fn().mockRejectedValue(rebaseError),
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
    ).rejects.toThrow(
      "Failed to rebase agent/card-1 onto origin/main: CONFLICT",
    );

    expect(git.getHeadSha).not.toHaveBeenCalled();
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
    expect(
      push.mock.calls
        .flat()
        .some((argument) => String(argument).includes("force")),
    ).toBe(false);
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

    const addComment = vi
      .spyOn(trello, "addComment")
      .mockImplementation(async () => {
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
      github: new GitHubClient(runGitHubCommand, credentials),
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
    expect(getInstallationToken).toHaveBeenCalledTimes(4);
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      1,
      project.repository.githubApp,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      2,
      project.repository.githubApp,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      3,
      project.repository.githubApp,
    );
    expect(getInstallationToken).toHaveBeenNthCalledWith(
      4,
      project.repository.githubApp,
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
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockRejectedValue(lookupError);

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

    vi.spyOn(trello, "addComment").mockRejectedValue(
      new Error("comment failed"),
    );

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
    const moveCard = vi
      .spyOn(trello, "moveCard")
      .mockRejectedValue(reviewError);

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
    ).rejects.toThrow(
      "was published, but the Trello card could not be moved to Human Review",
    );

    expect(runGitHubCommand).toHaveBeenCalledTimes(1);
    expect(moveCard).toHaveBeenCalledWith("card-1", "review-list");
  });
});
