import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { GitClient } from "../src/git/git-client.js";
import {
  GitHubClient,
  type CiCheckObservation,
} from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("task-session production auto-merge CI gate", () => {
  it("waits for delayed expected checks and merges only after all current-head results pass", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-auto-merge-"));
    const repositoryPath = path.join(root, "repo");
    const worktreeRoot = path.join(root, "worktrees");
    const contextRoot = path.join(root, "state");
    const worktreePath = path.join(worktreeRoot, "merge-card");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(worktreePath, { recursive: true });
    const sourcePath = path.join(worktreePath, "src.ts");
    fs.writeFileSync(sourcePath, "export const value = 1;\n");
    const project = {
      id: "project",
      autoMerge: true,
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
        worktreeRoot,
        github: "owner/repo",
        defaultBranch: "main",
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
    const headSha = "a".repeat(40);
    const card: TrelloCard = {
      id: "merge-card",
      name: "Verified task",
      desc: "Implement and verify the feature.",
      idList: project.trello.reviewListId,
      idLabels: [],
      url: "https://trello.example/merge-card",
    };
    let cardList = project.trello.reviewListId;
    const trello = {
      getCards: vi.fn(async (listId: string) =>
        listId === cardList ? [{ ...card, idList: cardList }] : [],
      ),
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        cardList = listId;
        return { ...card, idList: listId };
      }),
      addComment: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const git = {
      getHeadSha: vi.fn(async () => headSha),
      getHeadTrackedFiles: vi.fn(async () => ["src.ts"]),
      getIndexEntries: vi.fn(async () => ""),
      getUntrackedFiles: vi.fn(async () => []),
    } as unknown as GitClient;
    const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      worktreePath,
    );
    let observedChecks: CiCheckObservation[] = [
      {
        source: "check-run" as const,
        id: 1,
        name: "Build",
        headSha,
        status: "completed",
        conclusion: "success",
        url: null,
      },
    ];
    const mergePullRequest = vi.fn(async () => undefined);
    const github = {
      findPullRequestState: vi.fn(async () => ({
        url: "https://github.com/owner/repo/pull/17",
        state: "OPEN",
        mergedAt: null,
        headRefOid: headSha,
        baseRefName: "main",
        headRefName: `agent/${card.id}`,
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "owner" },
      })),
      getCiObservations: vi.fn(async () => ({
        headSha,
        checks: observedChecks,
        expectationSources: [
          {
            kind: "repository-rules" as const,
            sourceId: "rules",
            complete: true,
            checkNames: ["Build", "Tests"],
          },
        ],
      })),
      findChangesRequestedPullRequest: vi.fn(async () => null),
      getPullRequestConversationComments: vi.fn(async () => []),
      mergePullRequest,
    } as unknown as GitHubClient;
    const taskStore = new TaskExecutionStore(contextRoot, project);
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: card.id,
      phase: "ci",
      primarySessionId: "primary-session",
      sessionCreationStatus: "bound",
      expectedBranch: `agent/${card.id}`,
      pullRequest: {
        number: 17,
        url: "https://github.com/owner/repo/pull/17",
        headSha,
      },
      operationKey: "auto-merge-operation",
      publicationQuality: {
        contentIdentity,
        validation: {
          command: "yarn validate",
          startedAt: "2026-10-24T09:00:00.000Z",
          completedAt: "2026-10-24T09:01:00.000Z",
          exitCode: 0,
          diagnostic: "validated",
          contentIdentity,
        },
        review: {
          version: 1,
          projectId: project.id,
          cardId: card.id,
          verdict: "pass",
          requirementAssessments: [
            {
              requirementId: "REQ-1",
              status: "satisfied",
              details: "Feature is implemented.",
              evidence: ["src.ts", "tests/task.test.ts"],
            },
          ],
          blockingFindings: [],
          reviewedContentIdentity: contentIdentity,
        },
      },
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
    });
    const planStore = new TaskPlanStore(contextRoot, project);
    planStore.create(
      {
        version: 1,
        projectId: project.id,
        cardId: card.id,
        requirements: [
          {
            id: "REQ-1",
            text: "Implement the feature",
            verification: "Run tests",
          },
        ],
        steps: [
          {
            id: "STEP-1",
            description: "Implement the feature",
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

    const poll = () =>
      pollProject(
        trello,
        git,
        github,
        new OpenCodeClient(vi.fn()),
        new CommandRunner(vi.fn()),
        project,
        new AbortController().signal,
      );
    await poll();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(
      taskStore.read(card.id)?.reviewObservation?.ciEvaluation,
    ).toMatchObject({
      status: "waiting",
      missingChecks: ["Tests"],
    });

    observedChecks = [
      ...observedChecks,
      {
        source: "commit-status",
        id: 2,
        context: "Tests",
        headSha,
        state: "success",
        createdAt: "2026-10-24T10:00:00.000Z",
        updatedAt: "2026-10-24T10:00:00.000Z",
        url: null,
        description: null,
      },
    ];
    await poll();
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(cardList).toBe(project.trello.doneListId);
    expect(taskStore.read(card.id)).toMatchObject({
      phase: "done",
      pullRequest: { headSha },
    });
    expect(taskStore.read(card.id)?.reviewObservation).toBeUndefined();
  });
});
