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
        headSha = "b".repeat(40);
      }),
      getCommitCountBetween: vi.fn(async () => 1),
      rebase: vi.fn(async () => undefined),
      push: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === project.trello.readyListId ? [card] : [],
      ),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (_cardId: string, listId: string) => ({
        ...card,
        idList: listId,
      })),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const githubRun = vi.fn<RunGitHubCommand>(async (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list") {
        return args.some((argument) => argument.includes("headRefOid"))
          ? JSON.stringify([
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
            ])
          : "";
      }
      if (args[0] === "pr" && args[1] === "create")
        return "https://github.com/owner/repo/pull/9";
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
    await pollProject(
      trello,
      git,
      github,
      new OpenCodeClient(openCodeRun),
      commands,
      project,
      new AbortController().signal,
    );
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
    expect(trello.getCards).toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktreeRoot, card.id))).toBe(true);
    expect(fs.existsSync(repositoryPath)).toBe(true);
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
});
