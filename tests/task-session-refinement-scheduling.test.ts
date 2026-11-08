import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { logger } from "../src/logging/logger.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../src/coordination/project-registry.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { withGitHubOperationProject } from "../src/github/github-operation-context.js";
import { GitHubClient } from "../src/github/github-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type OpenCodeRunResult,
} from "../src/opencode/opencode-client.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { runRefinementSetup } from "../src/refinement/run-refinement-setup.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("task-session refinement scheduling", () => {
  it("claims an eligible refinement through the project queue and returns it to Backlog without PR work", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-refinement-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    fs.mkdirSync(repositoryPath);
    const project = {
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
        setupCommand: "printf setup-ready > .setup-marker",
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
    } as ProjectConfig & { contextRoot: string };
    const coordinationRoot = path.join(root, "coordination");
    fs.mkdirSync(coordinationRoot);
    provisionCoordinationNamespace(coordinationRoot, "refinement-test");
    const config = {
      projects: [project],
      workflow: {
        contextRoot,
        coordinationRoot,
        coordinationNamespaceId: "refinement-test",
        pollIntervalSeconds: 1,
        logRetentionDays: 30,
        contextRetentionDays: 30,
      },
    } as Config;
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      "refinement-test",
    );
    leases.push(lease);
    const pin = (await verifyAndPinProjects(config, [lease]))[0]!;
    const pinned: RunRecord["pinned"] = {
      integrationId: pin.integrationId,
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
      repository: pin.repository.github,
      repositoryPath: pin.repository.path,
      worktreeRoot: pin.repository.worktreeRoot,
      storageRoot: pin.storageRoot,
    };
    const readyCard: TrelloCard = {
      id: "refine-card",
      name: "Clarify feature",
      desc: "Clarify acceptance criteria.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.refinementLabelId],
      url: "https://trello.example/refine-card",
    };
    const implementationCard: TrelloCard = {
      id: "implementation-card",
      name: "Implement feature",
      desc: "Implement the approved feature.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.featureLabelId],
      url: "https://trello.example/implementation-card",
    };
    const setupFailureCards = ["read-failure-card", "move-failure-card"].map(
      (id): TrelloCard => ({
        id,
        name: "Setup failure refinement",
        desc: "Setup must fail before refinement.",
        idList: project.trello.readyListId,
        idLabels: [project.trello.refinementLabelId],
        url: `https://trello.example/${id}`,
      }),
    );
    const readyCards = [readyCard, ...setupFailureCards, implementationCard];
    const cardLists = new Map(readyCards.map((card) => [card.id, card.idList]));
    const cardLabels = new Map(
      readyCards.map((card) => [card.id, new Set(card.idLabels)]),
    );
    let setupFailureMode: "read" | "move" | undefined;
    let failedListReadInjected = false;
    let failedListMoveInjected = false;
    const acceptedFailureComments = new Set<string>();
    const trello = {
      getCards: vi.fn(async (listId: string) => {
        if (
          setupFailureMode === "read" &&
          listId === project.trello.failedListId &&
          !failedListReadInjected
        ) {
          failedListReadInjected = true;
          throw new Error("injected Failed list read outage");
        }
        return readyCards
          .filter((card) => cardLists.get(card.id) === listId)
          .map((card) => ({ ...card, idList: listId }));
      }),
      getCard: vi.fn(async (cardId: string) => {
        const card = readyCards.find((candidate) => candidate.id === cardId)!;
        return { ...card, idList: cardLists.get(cardId)! };
      }),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (cardId: string, listId: string) => {
        if (
          setupFailureMode === "move" &&
          listId === project.trello.failedListId &&
          !failedListMoveInjected
        ) {
          failedListMoveInjected = true;
          throw new Error("injected Failed transition outage");
        }
        cardLists.set(cardId, listId);
        return {
          ...readyCards.find((card) => card.id === cardId)!,
          idList: listId,
          idLabels: [...cardLabels.get(cardId)!],
        };
      }),
      updateCardContent: vi.fn(async () => undefined),
      addLabel: vi.fn(async (cardId: string, labelId: string) => {
        cardLabels.get(cardId)!.add(labelId);
      }),
      removeLabel: vi.fn(async (cardId: string, labelId: string) => {
        cardLabels.get(cardId)!.delete(labelId);
      }),
      addComment: vi.fn(async (_cardId: string, text: string) => {
        acceptedFailureComments.add(`${_cardId}:${text}`);
      }),
    } as unknown as TrelloClient;
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repo: string, worktreePath: string) => {
          fs.mkdirSync(worktreePath, { recursive: true });
        },
      ),
      getStatus: vi.fn(async (worktreePath: string) =>
        fs.existsSync(getRefinementResultPath(worktreePath))
          ? "?? .agent-orchestrator/refinement-result.json"
          : "",
      ),
      getCurrentBranch: vi.fn(
        async (cwd: string) => `agent/${path.basename(cwd)}`,
      ),
      getHeadSha: vi.fn(async () => "a".repeat(40)),
      getHeadTrackedFiles: vi.fn(async () => []),
      getCommittableChangedPaths: vi.fn(async () => []),
      getUntrackedFiles: vi.fn(async () => []),
      getIgnoredFiles: vi.fn(async () => []),
      getRebaseState: vi.fn(async () => null),
      getConflictedPaths: vi.fn(async () => []),
      removeWorktree: vi.fn(async (_repo: string, worktreePath: string) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }),
      pruneWorktrees: vi.fn(async () => undefined),
    } as unknown as GitClient;
    const githubRun = vi.fn();
    const github = new GitHubClient(githubRun);
    let setupExecutions = 0;
    const setupCommandRunner = new CommandRunner();
    const commands = new CommandRunner(async (options) => {
      setupExecutions += 1;
      return setupCommandRunner.run(options);
    });
    const openCodeRun = vi.fn(
      async (options: OpenCodeRunOptions): Promise<OpenCodeRunResult> => {
        expect(
          fs.readFileSync(path.join(options.cwd, ".setup-marker"), "utf8"),
        ).toBe("setup-ready");
        await runRefinementSetup({
          commands,
          git,
          project,
          cardId: readyCard.id,
          worktreePath: options.cwd,
          signal: new AbortController().signal,
          cardLog: logger.child({
            projectId: project.id,
            cardId: readyCard.id,
          }),
        });
        expect(setupExecutions).toBe(1);
        const resultPath = getRefinementResultPath(options.cwd);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            title: "Clarified feature",
            description: "# Clarified feature\n\nAcceptance criteria.",
            type: "feature",
          }),
        );
        return { exitCode: 0, output: "done", errorOutput: "" };
      },
    );
    const openCode = new OpenCodeClient(openCodeRun);

    const refinementAuthority =
      await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: readyCard.id,
        taskKind: "refinement",
        pinned,
        projectLease: lease,
        coordinationRoot,
      });
    refinementAuthority.claim();
    await refinementAuthority.run(() =>
      withGitHubOperationProject(project, () =>
        pollProject(
          trello,
          git,
          github,
          openCode,
          commands,
          project,
          new AbortController().signal,
          undefined,
          undefined,
          undefined,
          refinementAuthority,
        ),
      ),
    );

    expect(openCodeRun).toHaveBeenCalledOnce();
    expect(setupExecutions).toBe(1);
    expect(git.addWorktreeWithNewBranch).toHaveBeenCalledOnce();
    expect(cardLists.get(readyCard.id)).toBe(project.trello.backlogListId);
    expect(cardLists.get(implementationCard.id)).toBe(
      project.trello.readyListId,
    );
    expect([...cardLabels.get(readyCard.id)!]).toContain(
      project.trello.featureLabelId,
    );
    expect([...cardLabels.get(readyCard.id)!]).not.toContain(
      project.trello.refinementLabelId,
    );
    expect(githubRun).not.toHaveBeenCalled();
    expect(refinementAuthority.store.read()).toMatchObject({
      lifecycle: "refined",
      terminalSync: "verified",
      expectedTrelloListId: project.trello.backlogListId,
    });
    expect(openCodeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "refine",
        sessionLabel: "OpenCode refinement",
      }),
    );
    expect(
      new TaskMutationQueue(contextRoot, project, refinementAuthority)
        .list()
        .map(({ cardId, kind, status }) => ({ cardId, kind, status })),
    ).toEqual([
      {
        cardId: readyCard.id,
        kind: "refinement",
        status: "completed",
      },
    ]);
    for (const [index, failureCard] of setupFailureCards.entries()) {
      const failureAuthority = await ProjectRunAuthority.createPreparingAttempt(
        {
          projectId: project.id,
          cardId: failureCard.id,
          taskKind: "refinement",
          pinned,
          projectLease: lease,
          coordinationRoot,
        },
      );
      failureAuthority.claim();
      const failureProject = {
        ...project,
        repository: {
          ...project.repository,
          setupCommand:
            "printf setup-preserved > .setup-failure-marker; exit 7",
        },
      };
      setupFailureMode = index === 0 ? "read" : "move";
      const runFailurePoll = () =>
        failureAuthority.run(() =>
          withGitHubOperationProject(failureProject, () =>
            pollProject(
              trello,
              git,
              github,
              openCode,
              commands,
              failureProject,
              new AbortController().signal,
              undefined,
              undefined,
              undefined,
              failureAuthority,
            ),
          ),
        );
      await expect(runFailurePoll()).rejects.toThrow(
        index === 0
          ? "injected Failed list read outage"
          : "injected Failed transition outage",
      );
      expect(failureAuthority.store.read()).toMatchObject({
        lifecycle: "refinement",
        terminalSync: "not-applicable",
      });
      expect(
        new TaskMutationQueue(contextRoot, project, failureAuthority).list(),
      ).toContainEqual(
        expect.objectContaining({
          cardId: failureCard.id,
          kind: "refinement",
          status: "active",
        }),
      );
      await runFailurePoll();
      expect(failureAuthority.store.read()).toMatchObject({
        lifecycle: "failed",
        terminalSync: "verified",
        terminalEvidence: {
          prOutcome: "no-pr-failure",
          trelloListId: project.trello.failedListId,
        },
      });
      expect(cardLists.get(failureCard.id)).toBe(project.trello.failedListId);
      expect(openCodeRun).toHaveBeenCalledOnce();
      expect(
        fs.readFileSync(
          path.join(worktreeRoot, failureCard.id, ".setup-failure-marker"),
          "utf8",
        ),
      ).toBe("setup-preserved");
      expect(
        [...acceptedFailureComments].filter((entry) =>
          entry.startsWith(`${failureCard.id}:`),
        ),
      ).toHaveLength(1);
      expect(
        new TaskMutationQueue(
          contextRoot,
          project,
          failureAuthority,
        ).getActive(),
      ).toBeNull();
      setupFailureMode = undefined;
    }
    const nextAuthority = await ProjectRunAuthority.createPreparingAttempt({
      projectId: project.id,
      cardId: implementationCard.id,
      taskKind: "implementation",
      pinned,
      projectLease: lease,
      coordinationRoot,
    });
    nextAuthority.claim();
    expect(nextAuthority.store.read()).toMatchObject({
      cardId: implementationCard.id,
      lifecycle: "planning",
    });
    expect(
      fs.existsSync(
        path.join(contextRoot, "task-mutation-queues", `${project.id}.json`),
      ),
    ).toBe(false);
    const implementationProject = {
      ...project,
      repository: { ...project.repository, setupCommand: "yarn install" },
    };
    const failedSetupCommands = new CommandRunner(
      vi.fn<RunCommand>().mockResolvedValue({
        exitCode: 1,
        output: "setup failed",
        errorOutput: "",
      }),
    );
    await expect(
      nextAuthority.run(() =>
        withGitHubOperationProject(implementationProject, () =>
          pollProject(
            trello,
            git,
            github,
            openCode,
            failedSetupCommands,
            implementationProject,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            nextAuthority,
          ),
        ),
      ),
    ).rejects.toThrow("repository setup exited with code 1");
    expect(cardLists.get(implementationCard.id)).toBe(
      project.trello.workingListId,
    );
    expect(nextAuthority.store.read()).toMatchObject({
      cardId: implementationCard.id,
      lifecycle: "planning",
      terminalSync: "not-applicable",
    });
    expect(
      new TaskExecutionStore(contextRoot, project, nextAuthority).read(
        implementationCard.id,
      )?.phase,
    ).toBe("planning");
    expect(
      new TaskMutationQueue(contextRoot, project, nextAuthority)
        .list()
        .find((event) => event.cardId === implementationCard.id)?.status,
    ).toBe("failed");
    expect(openCodeRun.mock.calls.map(([options]) => options.model)).toEqual([
      "refine",
    ]);
    expect(
      fs.existsSync(
        path.join(
          contextRoot,
          "task-executions",
          project.id,
          `${implementationCard.id}.json`,
        ),
      ),
    ).toBe(false);
  });

  it("keeps an implementation-first Ready card as the sole mutation owner ahead of refinement", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-ordering-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    fs.mkdirSync(repositoryPath);
    const project = {
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
        setupCommand: "yarn install",
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
    } as ProjectConfig & { contextRoot: string };
    const implementation: TrelloCard = {
      id: "first-implementation",
      name: "Implement first",
      desc: "Implement the approved feature.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.featureLabelId],
      url: "https://trello.example/first-implementation",
    };
    const refinement: TrelloCard = {
      id: "second-refinement",
      name: "Refine second",
      desc: "Clarify acceptance criteria.",
      idList: project.trello.readyListId,
      idLabels: [project.trello.refinementLabelId],
      url: "https://trello.example/second-refinement",
    };
    const readyCards = [implementation, refinement];
    const lists = new Map(readyCards.map((card) => [card.id, card.idList]));
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        readyCards
          .filter((card) => lists.get(card.id) === listId)
          .map((card) => ({ ...card, idList: listId })),
      ),
      getCardAttachments: vi.fn(async () => []),
      moveCard: vi.fn(async (cardId: string, listId: string) => {
        lists.set(cardId, listId);
        return {
          ...readyCards.find((card) => card.id === cardId)!,
          idList: listId,
        };
      }),
    } as unknown as TrelloClient;
    const git = {
      fetch: vi.fn(async () => undefined),
      branchExists: vi.fn(async () => false),
      addWorktreeWithNewBranch: vi.fn(
        async (_repo: string, worktreePath: string) => {
          fs.mkdirSync(worktreePath, { recursive: true });
        },
      ),
      getCurrentBranch: vi.fn(async () => "agent/first-implementation"),
      getHeadSha: vi.fn(async () => "a".repeat(40)),
      getStatus: vi.fn(async () => ""),
      getHeadTrackedFiles: vi.fn(async () => []),
      getCommittableChangedPaths: vi.fn(async () => []),
      getUntrackedFiles: vi.fn(async () => []),
      getIgnoredFiles: vi.fn(async () => []),
    } as unknown as GitClient;
    const githubRun = vi.fn();
    const openCodeRun = vi.fn();
    const runCommand = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      output: "setup failed",
      errorOutput: "",
    }));

    await expect(
      pollProject(
        trello,
        git,
        new GitHubClient(githubRun),
        new OpenCodeClient(openCodeRun),
        new CommandRunner(runCommand),
        project,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Task-session repository setup exited with code 1");

    expect(lists.get(implementation.id)).toBe(project.trello.workingListId);
    expect(lists.get(refinement.id)).toBe(project.trello.readyListId);
    expect(openCodeRun).not.toHaveBeenCalled();
    expect(githubRun).not.toHaveBeenCalled();
    expect(
      new TaskMutationQueue(contextRoot, project)
        .list()
        .map(({ cardId, kind, status }) => ({ cardId, kind, status })),
    ).toEqual([
      {
        cardId: implementation.id,
        kind: "implementation",
        status: "failed",
      },
      {
        cardId: refinement.id,
        kind: "refinement",
        status: "queued",
      },
    ]);
  });

  it.each(["malformed-result", "interrupted-cleanup"] as const)(
    "handles %s through pollProject without starting PR work",
    async (mode) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `refinement-${mode}-`));
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const contextRoot = path.join(root, "state");
      fs.mkdirSync(repositoryPath);
      const project = {
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
      } as ProjectConfig & { contextRoot: string };
      const card: TrelloCard = {
        id: "refinement-card",
        name: "Refine task",
        desc: "Clarify task scope.",
        idList: project.trello.readyListId,
        idLabels: [project.trello.refinementLabelId],
        url: "https://trello.example/refinement-card",
      };
      let listId = project.trello.readyListId;
      const labels = new Set(card.idLabels);
      const trello = {
        getCards: vi.fn(async (requestedList: string) =>
          requestedList === listId ? [{ ...card, idList: listId }] : [],
        ),
        getCardAttachments: vi.fn(async () => []),
        moveCard: vi.fn(async (_id: string, nextList: string) => {
          listId = nextList;
          return { ...card, idList: nextList, idLabels: [...labels] };
        }),
        updateCardContent: vi.fn(async () => undefined),
        addLabel: vi.fn(async (_id: string, label: string) =>
          labels.add(label),
        ),
        removeLabel: vi.fn(async (_id: string, label: string) =>
          labels.delete(label),
        ),
        addComment: vi.fn(async () => undefined),
      } as unknown as TrelloClient;
      const controller = new AbortController();
      const worktreePath = path.join(worktreeRoot, card.id);
      const git = {
        fetch: vi.fn(async () => undefined),
        branchExists: vi.fn(async () => false),
        addWorktreeWithNewBranch: vi.fn(
          async (_repo: string, worktree: string) => {
            fs.mkdirSync(worktree, { recursive: true });
          },
        ),
        getStatus: vi.fn(async (cwd: string) =>
          fs.existsSync(getRefinementResultPath(cwd))
            ? "?? .agent-orchestrator/refinement-result.json"
            : "",
        ),
        getCurrentBranch: vi.fn(async () => `agent/${card.id}`),
        getHeadSha: vi.fn(async () => "a".repeat(40)),
        getHeadTrackedFiles: vi.fn(async () => []),
        getCommittableChangedPaths: vi.fn(async () => []),
        getUntrackedFiles: vi.fn(async () => []),
        getIgnoredFiles: vi.fn(async () => []),
        getRebaseState: vi.fn(async () => {
          if (mode === "interrupted-cleanup") controller.abort();
          return null;
        }),
        getConflictedPaths: vi.fn(async () => []),
        resetHard: vi.fn(async () => undefined),
        cleanUntracked: vi.fn(async () => undefined),
        removeWorktree: vi.fn(async () => undefined),
        pruneWorktrees: vi.fn(async () => undefined),
      } as unknown as GitClient;
      const githubRun = vi.fn();
      const openCodeRun = vi.fn(async (options: OpenCodeRunOptions) => {
        const resultPath = getRefinementResultPath(options.cwd);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        if (mode === "interrupted-cleanup") {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              title: "Refined",
              description: "Details",
              type: "feature",
            }),
          );
        } else {
          fs.writeFileSync(resultPath, "not-json");
          const agentChange = path.join(options.cwd, "src", "agent-change.ts");
          fs.mkdirSync(path.dirname(agentChange), { recursive: true });
          fs.writeFileSync(agentChange, "preserve refinement changes");
        }
        return { exitCode: 0, output: "complete", errorOutput: "" };
      });

      const polling = pollProject(
        trello,
        git,
        new GitHubClient(githubRun),
        new OpenCodeClient(openCodeRun),
        new CommandRunner(vi.fn()),
        project,
        controller.signal,
      );
      if (mode === "malformed-result") {
        await expect(polling).rejects.toThrow("Invalid refinement result JSON");
      } else {
        await polling;
      }

      expect(githubRun).not.toHaveBeenCalled();
      expect(openCodeRun).toHaveBeenCalledOnce();
      if (mode === "malformed-result") {
        expect(listId).toBe(project.trello.failedListId);
        expect(git.resetHard).not.toHaveBeenCalled();
        expect(git.cleanUntracked).not.toHaveBeenCalled();
        expect(
          fs.readFileSync(
            path.join(worktreePath, "src", "agent-change.ts"),
            "utf8",
          ),
        ).toBe("preserve refinement changes");
      } else {
        expect(listId).toBe(project.trello.backlogListId);
        expect(git.removeWorktree).not.toHaveBeenCalled();
        expect(fs.existsSync(worktreePath)).toBe(true);
      }
      expect(
        new TaskMutationQueue(contextRoot, project).getActive()?.status,
      ).toBe("failed");
    },
  );
});
