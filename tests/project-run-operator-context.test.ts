import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import {
  prepareProjectAttempt,
  readProjectPinCandidates,
  verifyAndPinProjects,
} from "../src/coordination/project-registry.js";
import { legacyAttemptId } from "../src/task-session/legacy-state-import.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { acquireProjectRunOperatorContext } from "../src/operator/project-run-operator-context.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { GitClient } from "../src/git/git-client.js";
import { withGitHubOperationProject } from "../src/github/github-operation-context.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { reconcileExternalTaskSessionPullRequest } from "../src/orchestrator/reconcile-external-task-session-pr.js";
import { runExternalTaskSessionRecovery } from "../src/operator/reconcile-external-task-session-pr.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

let root = "";
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  config: Config;
  project: ProjectConfig;
  sourceTask: string;
  coordinationRoot: string;
} {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-run-context-"));
  const repositoryPath = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  const contextRoot = path.join(root, "runtime");
  const coordinationRoot = path.join(root, "coordination");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreeRoot);
  fs.mkdirSync(contextRoot);
  fs.mkdirSync(coordinationRoot);
  provisionCoordinationNamespace(coordinationRoot, "operator-test");
  const project = {
    id: "project-one",
    trello: {
      boardId: "board-one",
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
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot,
      gitIdentity: { name: "Agent", email: "agent@example.invalid" },
    },
  } as ProjectConfig;
  const config = {
    projects: [project],
    workflow: {
      contextRoot,
      coordinationRoot,
      coordinationNamespaceId: "operator-test",
      pollIntervalSeconds: 15,
      logRetentionDays: 30,
      contextRetentionDays: 30,
    },
  } as Config;
  const task: TaskExecutionRecord = {
    version: 1,
    projectId: project.id,
    cardId: "card-one",
    phase: "attention-required",
    operationKey: "task-operation-one",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    primarySessionId: "session-one",
    expectedBranch: "agent/card-one",
  };
  const sourceStore = new TaskExecutionStore(contextRoot, project);
  sourceStore.create(task);
  return {
    config,
    project,
    sourceTask: path.join(contextRoot, "task-executions", project.id, "card-one.json"),
    coordinationRoot,
  };
}

describe("operator canonical attempt context", () => {
  it("refuses service contention without changing registry or legacy bytes, then migrates and writes only the envelope after release", async () => {
    const { config, project, sourceTask, coordinationRoot } = fixture();
    const serviceLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "operator-test",
    );
    await verifyAndPinProjects(config, [serviceLease]);
    const registryFile = path.join(coordinationRoot, "projects.registry.json");
    const registryBytes = fs.readFileSync(registryFile);
    const originalTaskBytes = fs.readFileSync(sourceTask);
    try {
      await expect(acquireProjectRunOperatorContext(config, project)).rejects.toThrow(
        "already held",
      );
      expect(fs.readFileSync(registryFile)).toEqual(registryBytes);
      expect(fs.readFileSync(sourceTask)).toEqual(originalTaskBytes);
    } finally {
      await serviceLease.release();
    }

    const operator = await acquireProjectRunOperatorContext(config, project);
    try {
      await operator.run(() => {
        const queue = new TaskMutationQueue(config.workflow.contextRoot, project);
        queue.enqueue({
          projectId: project.id,
          cardId: "card-one",
          eventId: "operator-recovery-event",
          operationKey: "task-operation-one",
          kind: "implementation",
          enqueuedAt: new Date().toISOString(),
        });
        expect(
          operator.authority.read(ProjectRunAuthority.queueKey(project.id), (value) => value),
        ).toMatchObject({
          events: [expect.objectContaining({ eventId: "operator-recovery-event" })],
        });
      });
      expect(fs.readFileSync(sourceTask)).toEqual(originalTaskBytes);
      expect(
        fs.existsSync(
          path.join(config.workflow.contextRoot, "task-mutation-queues", `${project.id}.json`),
        ),
      ).toBe(false);
    } finally {
      await operator.release();
    }
  });

  it("requires a provisioned coordination namespace", async () => {
    const { config, project } = fixture();
    const missingNamespace = {
      ...config,
      workflow: { ...config.workflow, coordinationRoot: undefined },
    } as unknown as Config;
    await expect(acquireProjectRunOperatorContext(missingNamespace, project)).rejects.toThrow(
      "requires the configured host coordination namespace",
    );
  });

  it("rejects changed active Trello mappings before operator recovery can dispatch", async () => {
    const { config, project, coordinationRoot } = fixture();
    const operator = await acquireProjectRunOperatorContext(config, project);
    const before = operator.authority.store.read();
    await operator.release();

    const changedProject = {
      ...project,
      trello: { ...project.trello, doneListId: "replacement-done" },
    };
    const changedConfig = {
      ...config,
      projects: [changedProject],
    };
    const registryBefore = fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"));

    await expect(acquireProjectRunOperatorContext(changedConfig, changedProject)).rejects.toThrow(
      "incompatible with its active host pin",
    );
    expect(fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"))).toEqual(
      registryBefore,
    );

    const originalContext = await acquireProjectRunOperatorContext(config, project);
    try {
      expect(originalContext.authority.store.read()).toMatchObject({
        attemptId: before?.attemptId,
        lifecycle: before?.lifecycle,
      });
      expect(originalContext.authority.store.read()?.pinned.lists.done).toBe(
        project.trello.doneListId,
      );
    } finally {
      await originalContext.release();
    }
  });

  it("rejects changed Trello mappings against a pending-only host pin", async () => {
    const { config, project, sourceTask, coordinationRoot } = fixture();
    const serviceLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "operator-test",
    );
    const [hostPin] = await verifyAndPinProjects(config, [serviceLease]);
    const legacyTask = JSON.parse(fs.readFileSync(sourceTask, "utf8")) as TaskExecutionRecord;
    await prepareProjectAttempt(coordinationRoot, project.id, serviceLease, {
      attemptId: legacyAttemptId(legacyTask),
      storageRoot: hostPin!.storageRoot,
    });
    await serviceLease.release();

    const registryFile = path.join(coordinationRoot, "projects.registry.json");
    const registryBefore = fs.readFileSync(registryFile);
    const changedProject = {
      ...project,
      trello: { ...project.trello, doneListId: "replacement-done" },
    };
    await expect(
      acquireProjectRunOperatorContext({ ...config, projects: [changedProject] }, changedProject),
    ).rejects.toThrow("incompatible with its active host pin");
    expect(fs.readFileSync(registryFile)).toEqual(registryBefore);

    const originalContext = await acquireProjectRunOperatorContext(config, project);
    await originalContext.release();
  });

  it("rejects public external-PR recovery on changed active mappings before external effects and preserves the active attempt", async () => {
    const { config, project, sourceTask, coordinationRoot } = fixture();
    const serviceLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "operator-test",
    );
    const [hostPin] = await verifyAndPinProjects(config, [serviceLease]);
    const task = {
      ...(JSON.parse(fs.readFileSync(sourceTask, "utf8")) as TaskExecutionRecord),
      lastEvent: { type: "attention-required" as const },
    };
    const attempt = await ProjectRunAuthority.createPreparingAttempt({
      projectId: project.id,
      cardId: task.cardId,
      taskKind: "implementation",
      pinned: {
        integrationId: hostPin!.integrationId,
        projectId: project.id,
        boardId: hostPin!.trello.boardId,
        lists: {
          ready: hostPin!.trello.readyListId,
          working: hostPin!.trello.workingListId,
          review: hostPin!.trello.reviewListId,
          failed: hostPin!.trello.failedListId,
          done: hostPin!.trello.doneListId,
          backlog: hostPin!.trello.backlogListId,
        },
        repository: hostPin!.repository.github,
        repositoryPath: hostPin!.repository.path,
        worktreeRoot: hostPin!.repository.worktreeRoot,
        storageRoot: hostPin!.storageRoot,
      },
      projectLease: serviceLease,
      coordinationRoot,
      attemptId: "active-attention-attempt",
    });
    attempt.claim();
    attempt.mutateTaskExecution({
      key: "task-execution-card-one",
      initial: task,
      operation: (current) => ({ value: current, result: undefined }),
      validate: (value) => value as TaskExecutionRecord,
    });
    await serviceLease.release();

    const registryFile = path.join(coordinationRoot, "projects.registry.json");
    const attemptFile = path.join(
      config.workflow.contextRoot,
      "attempts",
      "active-attention-attempt.json",
    );
    const registryBefore = fs.readFileSync(registryFile);
    const attemptBefore = fs.readFileSync(attemptFile);
    const taskBefore = fs.readFileSync(sourceTask);
    const externalCalls = {
      trello: vi.fn(),
      github: vi.fn(),
      git: vi.fn(),
    };
    const changedProject = {
      ...project,
      trello: { ...project.trello, doneListId: "replacement-done" },
    };
    const changedConfig = { ...config, projects: [changedProject] };

    await expect(
      runExternalTaskSessionRecovery(
        [
          "--project",
          project.id,
          "--card",
          task.cardId,
          "--commit",
          "a".repeat(40),
          "--branch",
          "recovery/card-one",
          "--pr",
          "18",
        ],
        {
          config: changedConfig,
          trello: externalCalls.trello as unknown as TrelloClient,
          github: externalCalls.github as never,
          git: externalCalls.git as never,
        },
      ),
    ).rejects.toThrow("incompatible with its active host pin");

    expect(externalCalls.trello).not.toHaveBeenCalled();
    expect(externalCalls.github).not.toHaveBeenCalled();
    expect(externalCalls.git).not.toHaveBeenCalled();
    expect(fs.readFileSync(registryFile)).toEqual(registryBefore);
    expect(fs.readFileSync(attemptFile)).toEqual(attemptBefore);
    expect(fs.readFileSync(sourceTask)).toEqual(taskBefore);

    const originalContext = await acquireProjectRunOperatorContext(config, project);
    try {
      expect(originalContext.authority.store.read()).toMatchObject({
        attemptId: "active-attention-attempt",
        lifecycle: "waiting",
        owner: { generation: 2 },
      });
      expect(originalContext.authority.store.read()?.pinned.lists.done).toBe(
        project.trello.doneListId,
      );
    } finally {
      await originalContext.release();
    }
  });

  it("does not accept a completed external result after the lease is lost in flight", async () => {
    const { config, project } = fixture();
    const operator = await acquireProjectRunOperatorContext(config, project);
    try {
      await expect(
        operator.authority.dispatch(async () => {
          await operator.lease.release();
          return "stale-result";
        }),
      ).rejects.toThrow("ownership is no longer held");
    } finally {
      await operator.release();
    }
  });

  it("guards direct local Git mutations, not just authenticated Git helpers", async () => {
    const { config, project } = fixture();
    const operator = await acquireProjectRunOperatorContext(config, project);
    let invocations = 0;
    const git = new GitClient(async () => {
      invocations += 1;
      await operator.lease.release();
      return "";
    });
    try {
      await expect(
        operator.run(() =>
          withGitHubOperationProject(project, () => git.stageAll(project.repository.path)),
        ),
      ).rejects.toThrow("ownership is no longer held");
      expect(invocations).toBe(1);
      await expect(
        operator.run(() =>
          withGitHubOperationProject(project, () => git.stageAll(project.repository.path)),
        ),
      ).rejects.toThrow("ownership is no longer held");
      expect(invocations).toBe(1);
    } finally {
      await operator.release();
    }
  });

  it("checks authority before task setup/quality command dispatch and after completion", async () => {
    const { config, project } = fixture();
    const operator = await acquireProjectRunOperatorContext(config, project);
    let invocations = 0;
    const commands = new CommandRunner(async () => {
      invocations += 1;
      await operator.lease.release();
      return { exitCode: 0, output: "stale", errorOutput: "" };
    });
    try {
      await expect(
        operator.run(() =>
          commands.run({
            cwd: project.repository.path,
            command: "yarn validate",
          }),
        ),
      ).rejects.toThrow("ownership is no longer held");
      expect(invocations).toBe(1);
      await expect(
        operator.run(() =>
          commands.run({
            cwd: project.repository.path,
            command: "yarn validate",
          }),
        ),
      ).rejects.toThrow("ownership is no longer held");
      expect(invocations).toBe(1);
    } finally {
      await operator.release();
    }
  });

  it("reconciles an operator PR into the canonical terminal projection and releases it for the next worker", async () => {
    const { config, project } = fixture();
    const operator = await acquireProjectRunOperatorContext(config, project);
    let cardList = project.trello.reviewListId;
    const trelloMock = {
      moveCard: vi.fn(async (_cardId: string, listId: string) => {
        cardList = listId;
      }),
    };
    const trello = trelloMock as unknown as TrelloClient;
    const github = {
      getPullRequestStateByNumber: vi.fn(async () => ({
        state: "MERGED",
        mergedAt: "2026-11-01T00:00:00.000Z",
        url: "https://github.com/owner/repository/pull/18",
        headRefName: "recovery/card-one",
        headRefOid: "b".repeat(40),
        baseRefName: "main",
      })),
      getPullRequestCommitShas: vi.fn(async () => ["b".repeat(40)]),
      getCiObservations: vi.fn(async () => ({
        headSha: "b".repeat(40),
        checks: [
          {
            source: "check-run" as const,
            id: 1,
            name: "Build",
            headSha: "b".repeat(40),
            status: "completed" as const,
            conclusion: "success",
            url: null,
          },
        ],
        expectationSources: [
          {
            kind: "workflow-contract" as const,
            sourceId: "fixture",
            complete: true,
            checkNames: ["Build"],
          },
        ],
      })),
    } as never;
    const git = {
      hasEquivalentImplementationCommit: vi.fn(async () => true),
    } as never;

    try {
      await operator.run(async () => {
        const queue = new TaskMutationQueue(config.workflow.contextRoot, project);
        queue.enqueue({
          projectId: project.id,
          cardId: "card-one",
          eventId: "legacy-attempt",
          operationKey: "task-operation-one",
          kind: "implementation",
          enqueuedAt: new Date().toISOString(),
        });
        await reconcileExternalTaskSessionPullRequest({
          project,
          association: {
            projectId: project.id,
            cardId: "card-one",
            implementationCommit: "a".repeat(40),
            recoveryBranch: "recovery/card-one",
            pullRequestNumber: 18,
          },
          github,
          git,
          taskStore: new TaskExecutionStore(config.workflow.contextRoot, project),
          queue,
          trello,
          doneListId: project.trello.doneListId,
          readTrelloListId: async () => cardList,
        });
      });
      const envelope = operator.authority.store.read();
      expect(envelope).toMatchObject({
        lifecycle: "done",
        publicationState: "merged",
        terminalSync: "verified",
        expectedTrelloListId: project.trello.doneListId,
        compatibility: {
          "task-execution-card-one": expect.objectContaining({ phase: "done" }),
        },
      });
      expect(trelloMock.moveCard).toHaveBeenCalledOnce();
    } finally {
      await operator.release();
    }
  });

  it("takes over the same active service attempt for an operator after the service lease releases", async () => {
    const { config, project, sourceTask, coordinationRoot } = fixture();
    fs.unlinkSync(sourceTask);
    const serviceLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "operator-test",
    );
    await verifyAndPinProjects(config, [serviceLease]);
    const pin = await readProjectPinCandidates(coordinationRoot, project.id);
    const hostPin = pin[0]!;
    const attemptAuthority = await ProjectRunAuthority.createPreparingAttempt({
      projectId: project.id,
      cardId: "card-one",
      taskKind: "implementation",
      pinned: {
        integrationId: hostPin.integrationId,
        projectId: project.id,
        boardId: hostPin.trello.boardId,
        lists: {
          ready: hostPin.trello.readyListId,
          working: hostPin.trello.workingListId,
          review: hostPin.trello.reviewListId,
          failed: hostPin.trello.failedListId,
          done: hostPin.trello.doneListId,
          backlog: hostPin.trello.backlogListId,
        },
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      },
      projectLease: serviceLease,
      coordinationRoot,
    });
    attemptAuthority.claim();
    await serviceLease.release();

    const operator = await acquireProjectRunOperatorContext(config, project);
    try {
      expect(operator.authority.store.read()).toMatchObject({
        cardId: "card-one",
        lifecycle: "planning",
        owner: { generation: 2 },
      });
      await operator.run(() => {
        const queue = new TaskMutationQueue(config.workflow.contextRoot, project);
        queue.enqueue({
          projectId: project.id,
          cardId: "card-one",
          eventId: "operator-resume-event",
          operationKey: "task-operation-one",
          kind: "implementation",
          enqueuedAt: new Date().toISOString(),
        });
      });
      expect(
        operator.authority.read(ProjectRunAuthority.queueKey(project.id), (value) => value),
      ).toMatchObject({
        events: [expect.objectContaining({ eventId: "operator-resume-event" })],
      });
    } finally {
      await operator.release();
    }
  });

  it("resumes an interrupted pending legacy migration through the same pinned recovery path", async () => {
    const { config, project, sourceTask, coordinationRoot } = fixture();
    const serviceLease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "operator-test",
    );
    const [pin] = await verifyAndPinProjects(config, [serviceLease]);
    const legacyTask = JSON.parse(fs.readFileSync(sourceTask, "utf8")) as TaskExecutionRecord;
    const attemptId = legacyAttemptId(legacyTask);
    await prepareProjectAttempt(coordinationRoot, project.id, serviceLease, {
      attemptId,
      storageRoot: pin!.storageRoot,
    });
    await serviceLease.release();

    const operator = await acquireProjectRunOperatorContext(config, project);
    try {
      expect(operator.authority.store.read()).toMatchObject({
        attemptId,
        lifecycle: "waiting",
        legacy: { recoveryDisposition: "operator-reconciliation-required" },
        compatibility: {
          [`task-execution-${legacyTask.cardId}`]: expect.objectContaining({
            operationKey: legacyTask.operationKey,
          }),
        },
      });
      const registryBytes = JSON.parse(
        fs.readFileSync(path.join(coordinationRoot, "projects.registry.json"), "utf8"),
      ) as {
        projects: Array<{ activeAttempt: unknown; pendingAttempt: unknown }>;
      };
      expect(registryBytes.projects[0]?.pendingAttempt).toBeNull();
      expect(registryBytes.projects[0]?.activeAttempt).toEqual({
        attemptId,
        storageRoot: pin!.storageRoot,
      });
    } finally {
      await operator.release();
    }
  });
});
