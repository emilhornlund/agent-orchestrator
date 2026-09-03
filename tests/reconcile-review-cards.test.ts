import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";
import { Logger } from "../src/logging/logger.js";
import {
  formatFailureDiagnostic,
  getFailureContext,
} from "../src/orchestrator/failure-diagnostic.js";
import { RetryableGitHubReconciliationError } from "../src/orchestrator/github-reconciliation-error.js";
import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import { reconcileReviewCards } from "../src/orchestrator/reconcile-review-cards.js";
import {
  TrelloRequestError,
  type TrelloCard,
  type TrelloClient,
} from "../src/trello/trello-client.js";

const project = {
  id: "project",
  repository: {
    path: "/repo",
    github: "owner/repo",
  },
  trello: {
    boardId: "board",
    backlogListId: "backlog",
    readyListId: "ready",
    workingListId: "working",
    reviewListId: "review",
    failedListId: "failed",
    doneListId: "done",
  },
} as ProjectConfig;

function createGithubAppProject(): ProjectConfig {
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

function card(id = "card-1"): TrelloCard {
  return {
    id,
    name: id,
    desc: "",
    idList: "review",
    idLabels: [],
    url: `https://trello.example/${id}`,
  };
}

function githubFor(
  cardId: string,
  state: "none" | "open" | "requested" | "closed" | "merged",
): GitHubClient {
  const pullRequest = {
    url: `https://github.com/owner/repo/pull/${cardId === "card-1" ? 1 : 2}`,
    state:
      state === "merged" ? "MERGED" : state === "closed" ? "CLOSED" : "OPEN",
    mergedAt: state === "merged" ? "2026-09-01T13:42:03Z" : null,
  };

  return {
    findPullRequestState: vi
      .fn()
      .mockResolvedValue(state === "none" ? null : pullRequest),
    findChangesRequestedPullRequest: vi
      .fn()
      .mockResolvedValue(
        state === "requested"
          ? { ...pullRequest, feedback: "Fix this." }
          : null,
      ),
  } as unknown as GitHubClient;
}

function trelloFor(cardValue: TrelloCard): TrelloClient {
  return {
    getCards: vi.fn().mockResolvedValue([cardValue]),
    moveCard: vi
      .fn()
      .mockImplementation(async (_cardId: string, listId: string) => ({
        ...cardValue,
        idList: listId,
      })),
    addComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrelloClient;
}

afterEach(() => {
  removeSessionLog(project.id, "card-1");
});

describe("reconcileReviewCards", () => {
  it("returns requested changes from Human Review", async () => {
    const trello = trelloFor(card());
    const github = githubFor("card-1", "requested");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({
      card: card(),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: "Fix this.",
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working");
  });

  it("leaves a card in Human Review when a requested-changes move is uncertain and retries later", async () => {
    const trello = trelloFor(card());
    const moveCard = vi
      .fn()
      .mockRejectedValueOnce(
        new TrelloRequestError(
          "card move",
          "Trello request failed: 503 Unavailable",
          { status: 503, retryable: true },
        ),
      )
      .mockResolvedValueOnce({ ...card(), idList: "working" });
    trello.moveCard = moveCard;
    const github = githubFor("card-1", "requested");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.toMatchObject({
      name: "RetryableTrelloReconciliationError",
      operation: "card move",
    });
    expect(moveCard).toHaveBeenCalledTimes(1);

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({
      card: card(),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: "Fix this.",
    });
    expect(moveCard).toHaveBeenCalledTimes(2);
  });

  it("leaves an open PR without requested changes in Human Review", async () => {
    const trello = trelloFor(card());
    const github = githubFor("card-1", "open");
    const event = vi.spyOn(Logger.prototype, "event");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toEqual({ card: card(), active: true });

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalledWith("Human Review card remains active");
    event.mockRestore();
  });

  it("uses one authoritative PR-state lookup for Human Review classification", async () => {
    const trello = trelloFor(card());
    const github = githubFor("card-1", "open");

    await reconcileReviewCards(trello, {} as GitClient, github, project);

    expect(github.findPullRequestState).toHaveBeenCalledTimes(1);
    expect(github.findPullRequestState).toHaveBeenCalledWith({
      cwd: "/repo",
      repository: "owner/repo",
      headBranch: "agent/card-1",
      project,
    });
    expect(github.findPullRequest).toBeUndefined();
  });

  it("uses the project GitHub App token for state and review reconciliation", async () => {
    const configuredProject = createGithubAppProject();
    const token = "project-installation-token";
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/owner/repo/pull/1",
            state: "OPEN",
            mergedAt: null,
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            url: "https://github.com/owner/repo/pull/1",
            number: 1,
            reviewDecision: "CHANGES_REQUESTED",
            headRefOid: "head-sha",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 2,
          body: "Please fix this.",
          commitId: "head-sha",
          author: "reviewer",
        }),
      )
      .mockResolvedValueOnce("reviewer: Add a regression test.");
    const trello = trelloFor(card());

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        new GitHubClient(runGitHubCommand, credentials),
        configuredProject,
      ),
    ).resolves.toEqual({
      card: card(),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      feedback: [
        "reviewer: Please fix this.",
        "",
        "Inline review comments:",
        "reviewer: Add a regression test.",
      ].join("\n"),
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "working");
    expect(getInstallationToken).toHaveBeenCalledTimes(2);
    for (const call of getInstallationToken.mock.calls) {
      expect(call[0]).toBe(configuredProject.repository.githubApp);
    }
    for (const [, args, environment] of runGitHubCommand.mock.calls) {
      expect(environment?.GH_TOKEN).toBe(token);
      expect(environment?.GITHUB_TOKEN).toBe(token);
      expect(args).not.toContain(token);
    }
    expect(
      JSON.stringify(runGitHubCommand.mock.calls.map(([, args]) => args)),
    ).not.toContain(token);
  });

  it("moves a card with no expected PR to Backlog", async () => {
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockResolvedValue({ ...card(), idList: "backlog" }),
    } as unknown as TrelloClient;
    const github = githubFor("card-1", "none");

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining("no expected pull request"),
    );
  });

  it("moves a merged expected PR to Done and removes its remote branch", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const events: string[] = [];
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockImplementation(async () => {
        events.push(
          existsSync(sessionLogPath)
            ? "move with session log"
            : "move without session log",
        );

        return { ...card(), idList: "done" };
      }),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        events.push("branch exists");

        return true;
      }),
      deleteRemoteBranch: vi.fn().mockImplementation(async () => {
        events.push("branch deleted");
      }),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "merged"),
      project,
    );

    expect(git.deleteRemoteBranch).toHaveBeenCalledWith(
      "/repo",
      "origin",
      "agent/card-1",
      project,
    );
    expect(events).toEqual([
      "branch exists",
      "branch deleted",
      "move with session log",
    ]);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("uses the project GitHub App token for merged branch cleanup", async () => {
    const configuredProject = createGithubAppProject();
    const token = "project-installation-token";
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const runGit = vi.fn<RunGit>(async (_cwd, args) => {
      const command = args[0] === "-c" ? args[2] : args[0];

      if (command === "ls-remote") {
        return "merged-sha\trefs/heads/agent/card-1";
      }

      return "";
    });
    const runGitHubCommand = vi.fn<RunGitHubCommand>().mockResolvedValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/1",
          state: "MERGED",
          mergedAt: "2026-09-01T13:42:03Z",
        },
      ]),
    );
    const trello = trelloFor(card());

    await expect(
      reconcileReviewCards(
        trello,
        new GitClient(runGit, credentials),
        new GitHubClient(runGitHubCommand, credentials),
        configuredProject,
      ),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(getInstallationToken).toHaveBeenCalledTimes(3);
    for (const call of getInstallationToken.mock.calls) {
      expect(call[0]).toBe(configuredProject.repository.githubApp);
    }
    for (const [, args, environment] of runGit.mock.calls) {
      expect(environment?.GH_TOKEN).toBe(token);
      expect(environment?.GITHUB_TOKEN).toBe(token);
      expect(environment?.GIT_ASKPASS).toBeDefined();
      expect(environment?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(args).not.toContain(token);
    }
    for (const [, args, environment] of runGitHubCommand.mock.calls) {
      expect(environment?.GH_TOKEN).toBe(token);
      expect(environment?.GITHUB_TOKEN).toBe(token);
      expect(args).not.toContain(token);
    }
  });

  it("moves a merged expected PR to Done when its remote branch is already absent", async () => {
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "merged"),
      project,
    );

    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
  });

  it("completes a merged card when its remote branch disappears during cleanup", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const events: string[] = [];
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockImplementation(async () => {
        events.push("card moved to Done");

        return { ...card(), idList: "done" };
      }),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        events.push("branch checked");

        return (
          events.filter((event) => event === "branch checked").length === 1
        );
      }),
      deleteRemoteBranch: vi.fn().mockImplementation(async () => {
        events.push("delete failed because branch was absent");
        throw new Error(
          "git push origin --delete agent/card-1 failed: unable to delete 'agent/card-1': remote ref does not exist",
        );
      }),
    } as unknown as GitClient;
    const notifier: EmailNotifier = {
      send: vi.fn().mockImplementation(async () => {
        events.push("email sent");
      }),
    };

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        notifier,
      ),
    ).resolves.toBeNull();

    expect(events).toEqual([
      "branch checked",
      "delete failed because branch was absent",
      "branch checked",
      "card moved to Done",
      "email sent",
    ]);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("treats a non-null mergedAt as merged even when state is CLOSED", async () => {
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;
    const github = {
      findPullRequestState: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        state: "CLOSED",
        mergedAt: "2026-09-01T13:42:03Z",
      }),
      findChangesRequestedPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await reconcileReviewCards(trello, git, github, project);

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(trello.moveCard).not.toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("sends a completion email after moving a merged card to Done", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const events: string[] = [];
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockImplementation(async () => {
        events.push("card moved to Done");

        return { ...card(), idList: "done" };
      }),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        events.push("branch exists");

        return true;
      }),
      deleteRemoteBranch: vi.fn().mockImplementation(async () => {
        events.push("branch deleted");
      }),
    } as unknown as GitClient;
    const notifier: EmailNotifier = {
      send: vi.fn().mockImplementation(async (message) => {
        events.push("email sent");

        expect(message).toEqual({
          subject: "[Agent Orchestrator] Completed: project / card-1",
          text: [
            "Event: Completed",
            "Project: project",
            "Card: card-1",
            "Trello card URL: https://trello.example/card-1",
            "Pull request URL: https://github.com/owner/repo/pull/1",
          ].join("\n"),
        });
      }),
    };

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "merged"),
      project,
      {},
      notifier,
    );

    expect(events).toEqual([
      "branch exists",
      "branch deleted",
      "card moved to Done",
      "email sent",
    ]);
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("does not delete a merged remote branch after shutdown", async () => {
    const controller = new AbortController();
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockImplementation(async () => {
        controller.abort();
        return true;
      }),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        undefined,
        controller.signal,
      ),
    ).resolves.toBeNull();

    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("reports merged remote-branch cleanup failures without moving the card to Done", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const trello = trelloFor(card());
    const deleteError = new Error("delete failed");
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(true),
      deleteRemoteBranch: vi.fn().mockRejectedValue(deleteError),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        notifier,
      ),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: deleteError,
      message: expect.stringContaining(
        "Could not clean up merged pull request branch",
      ),
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it("does not suppress an unexpected deletion failure when the branch is absent afterward", async () => {
    const trello = trelloFor(card());
    const deleteError = new Error("permission denied");
    const git = {
      remoteBranchExists: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      deleteRemoteBranch: vi.fn().mockRejectedValue(deleteError),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(trello, git, githubFor("card-1", "merged"), project),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: deleteError,
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("keeps a Human Review card unchanged when GitHub reconciliation fails", async () => {
    const lookupError = new Error("GitHub unavailable");
    const trello = trelloFor(card());
    const github = {
      findPullRequestState: vi.fn().mockRejectedValue(lookupError),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.toMatchObject({
      category: "Git/GitHub",
      cause: lookupError,
    });

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 504])(
    "keeps a Human Review card unchanged for a retryable HTTP %s failure",
    async (status) => {
      const trello = trelloFor(card());
      const github = {
        findPullRequestState: vi
          .fn()
          .mockRejectedValue(new Error(`GitHub API returned HTTP ${status}`)),
      } as unknown as GitHubClient;

      await expect(
        reconcileReviewCards(trello, {} as GitClient, github, project),
      ).rejects.toBeInstanceOf(RetryableGitHubReconciliationError);

      expect(trello.moveCard).not.toHaveBeenCalled();
      expect(trello.addComment).not.toHaveBeenCalled();
    },
  );

  it("handles an authentication failure immediately instead of retrying it", async () => {
    const trello = trelloFor(card());
    const github = {
      findPullRequestState: vi
        .fn()
        .mockRejectedValue(new Error("HTTP 401: Bad credentials")),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, {} as GitClient, github, project),
    ).rejects.not.toBeInstanceOf(RetryableGitHubReconciliationError);

    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("does not fall back to ambient authentication when App resolution fails", async () => {
    const token = "token-must-not-appear";
    const configuredProject = createGithubAppProject();
    const runGitHubCommand = vi.fn<RunGitHubCommand>();
    const credentials = new GitHubCredentialProvider({
      authenticator: {
        getInstallationToken: vi
          .fn()
          .mockRejectedValue(new Error(`token exchange failed: ${token}`)),
      },
    });
    const trello = trelloFor(card());
    const github = new GitHubClient(runGitHubCommand, credentials);

    const request = reconcileReviewCards(
      trello,
      {} as GitClient,
      github,
      configuredProject,
    );

    await expect(request).rejects.toThrow("GitHub authentication failed");
    await expect(request).rejects.not.toThrow(token);
    expect(runGitHubCommand).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("does not advance a card after an authenticated GitHub command fails", async () => {
    const token = "project-installation-token";
    const configuredProject = createGithubAppProject();
    const getInstallationToken = vi.fn().mockResolvedValue(token);
    const credentials = new GitHubCredentialProvider({
      authenticator: { getInstallationToken },
    });
    const runGitHubCommand = vi
      .fn<RunGitHubCommand>()
      .mockRejectedValue(new Error(`GitHub request failed with ${token}`));
    const trello = trelloFor(card());
    const github = new GitHubClient(runGitHubCommand, credentials);

    let failure: unknown;
    try {
      await reconcileReviewCards(
        trello,
        {} as GitClient,
        github,
        configuredProject,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(token);
    expect(formatFailureDiagnostic(failure)).not.toContain(token);
    expect(runGitHubCommand).toHaveBeenCalledWith(
      "/repo",
      expect.any(Array),
      expect.objectContaining({ GH_TOKEN: token, GITHUB_TOKEN: token }),
    );
    expect(runGitHubCommand.mock.calls[0]?.[1]).not.toContain(token);
    expect(trello.moveCard).not.toHaveBeenCalled();
    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("keeps the session log when moving a merged card to Done fails", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const moveError = new Error("move failed");
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockRejectedValue(moveError),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        notifier,
      ),
    ).rejects.toMatchObject({
      category: "Workflow",
      cause: moveError,
      message: expect.stringContaining(
        "Could not complete merged Human Review card",
      ),
    });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(existsSync(sessionLogPath)).toBe(true);
  });

  it("keeps the Done state and removes the session log when completion delivery fails", async () => {
    const sessionLogPath = getSessionLogPath(project.id, "card-1");
    appendSessionLog(sessionLogPath, "OpenCode output");

    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await expect(
      reconcileReviewCards(
        trello,
        git,
        githubFor("card-1", "merged"),
        project,
        {},
        notifier,
      ),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(existsSync(sessionLogPath)).toBe(false);
  });

  it("moves a closed unmerged expected PR to Backlog and comments", async () => {
    const trello = trelloFor(card());
    const git = {
      remoteBranchExists: vi.fn(),
      deleteRemoteBranch: vi.fn(),
    } as unknown as GitClient;

    await reconcileReviewCards(
      trello,
      git,
      githubFor("card-1", "closed"),
      project,
    );

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(trello.moveCard).not.toHaveBeenCalledWith("card-1", "failed");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      [
        "Pull request was closed without being merged.",
        "",
        "Pull request: https://github.com/owner/repo/pull/1",
      ].join("\n"),
    );
    expect(git.remoteBranchExists).not.toHaveBeenCalled();
    expect(git.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("does not send a Failed email after closed unmerged reconciliation", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn(),
    };
    const trello = trelloFor(card());

    await reconcileReviewCards(
      trello,
      {} as GitClient,
      githubFor("card-1", "closed"),
      project,
      {},
      notifier,
    );

    expect(notifier.send).not.toHaveBeenCalled();
    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
  });

  it("does not invoke the Failed email path for a closed card", async () => {
    const notifier: EmailNotifier = {
      send: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };
    const trello = trelloFor(card());

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        githubFor("card-1", "closed"),
        project,
        {},
        notifier,
      ),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(notifier.send).not.toHaveBeenCalled();
    expect(trello.addComment).toHaveBeenCalled();
  });

  it("reports the primary failure when moving a closed PR card to Backlog fails", async () => {
    const moveError = new Error("move failed");
    const trello = {
      ...trelloFor(card()),
      moveCard: vi.fn().mockRejectedValue(moveError),
      addComment: vi.fn(),
    } as unknown as TrelloClient;

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        githubFor("card-1", "closed"),
        project,
      ),
    ).rejects.toMatchObject({
      category: "Workflow",
      cause: moveError,
      message: expect.stringContaining(
        "Could not move closed Human Review card to Backlog",
      ),
    });

    expect(trello.addComment).not.toHaveBeenCalled();
  });

  it("keeps a closed PR in Backlog when its explanatory comment fails", async () => {
    const commentError = new Error("comment failed");
    const trello = {
      ...trelloFor(card()),
      addComment: vi.fn().mockRejectedValue(commentError),
    } as unknown as TrelloClient;
    const error = vi.spyOn(Logger.prototype, "error");

    await expect(
      reconcileReviewCards(
        trello,
        {} as GitClient,
        githubFor("card-1", "closed"),
        project,
      ),
    ).resolves.toBeNull();

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "backlog");
    expect(trello.addComment).toHaveBeenCalledWith(
      "card-1",
      expect.stringContaining(
        "Pull request: https://github.com/owner/repo/pull/1",
      ),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to add closed pull request comment"),
    );
    error.mockRestore();
  });

  it("blocks the project when multiple expected PRs are active", async () => {
    const second = card("card-2");
    const trello = {
      getCards: vi.fn().mockResolvedValue([card(), second]),
      moveCard: vi.fn(),
      addComment: vi.fn(),
    } as unknown as TrelloClient;
    const github = {
      findPullRequestState: vi.fn().mockResolvedValue({
        url: "https://github.com/owner/repo/pull/1",
        state: "OPEN",
        mergedAt: null,
      }),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    try {
      await reconcileReviewCards(trello, {} as GitClient, github, project);
      throw new Error("Expected reconciliation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Multiple active cards are in Human Review",
      );
      expect(getFailureContext(error)).toMatchObject({
        projectId: "project",
        cardIds: ["card-1", "card-2"],
      });
    }
    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("reconciles terminal cards without counting them as active", async () => {
    const mergedCard = card("card-1");
    const activeCard = card("card-2");
    const trello = {
      getCards: vi.fn().mockResolvedValue([mergedCard, activeCard]),
      moveCard: vi.fn().mockResolvedValue(undefined),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrelloClient;
    const git = {
      remoteBranchExists: vi.fn().mockResolvedValue(false),
    } as unknown as GitClient;
    const github = {
      findPullRequestState: vi
        .fn()
        .mockImplementation(async ({ headBranch }: { headBranch: string }) =>
          headBranch === "agent/card-1"
            ? {
                url: "https://github.com/owner/repo/pull/1",
                state: "MERGED",
                mergedAt: null,
              }
            : {
                url: "https://github.com/owner/repo/pull/2",
                state: "OPEN",
                mergedAt: null,
              },
        ),
      findChangesRequestedPullRequest: vi.fn().mockResolvedValue(null),
    } as unknown as GitHubClient;

    await expect(
      reconcileReviewCards(trello, git, github, project),
    ).resolves.toEqual({ card: activeCard, active: true });

    expect(trello.moveCard).toHaveBeenCalledWith("card-1", "done", {
      dueComplete: true,
    });
    expect(trello.moveCard).not.toHaveBeenCalledWith("card-2", "working");
  });
});
