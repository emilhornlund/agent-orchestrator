import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import {
  prepareProjectAttempt,
  readProjectPinCandidates,
  readHistoricalProjectPins,
  updateProjectActiveAttempt,
  verifyAndPinProjects,
} from "../src/coordination/project-registry.js";
import { RunRegistry, RunStore } from "../src/task-session/run-store.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { legacyAttemptId } from "../src/task-session/legacy-state-import.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import {
  CommandRunner,
  type RunCommand,
} from "../src/process/command-runner.js";
import * as cardContextRetention from "../src/context/card-context-retention.js";
import * as persistedStateTemporaryFiles from "../src/orchestrator/persisted-state-temporary-files.js";
import {
  runStartup,
  type StartupDependencies,
  type StartupOperations,
} from "../src/startup/run-startup.js";
import {
  TrelloRequestError,
  type TrelloClient,
} from "../src/trello/trello-client.js";
import { ProjectResourceError } from "../src/startup/project-resource-error.js";
import { acquireProjectRunOperatorContext } from "../src/operator/project-run-operator-context.js";
import { drainProcessGroup } from "../src/process/process-runtime.js";

function createProject(repositoryPath: string): ProjectConfig {
  return {
    id: "test-project",
    autoMerge: false,
    repository: {
      path: repositoryPath,
      github: "owner/repository",
      defaultBranch: "main",
      worktreeRoot: path.join(path.dirname(repositoryPath), "worktrees"),
      gitIdentity: {
        name: "Agent Orchestrator",
        email: "agent-orchestrator@users.noreply.github.com",
      },
    },
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

function createConfig(project: ProjectConfig): Config {
  const coordinationRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-coordination-"),
  );
  provisionCoordinationNamespace(coordinationRoot, "startup-test");
  return {
    projects: [project],
    workflow: {
      pollIntervalSeconds: 1,
      logRetentionDays: 14,
      contextRetentionDays: 14,
      contextRoot: "/opt/.agent-context",
      coordinationRoot,
      coordinationNamespaceId: "startup-test",
    },
  };
}

function validRepositoryGit(): RunGit {
  return vi
    .fn<RunGit>()
    .mockImplementation(async (_cwd, args) =>
      args[0] === "remote" ? "https://github.com/owner/repository.git" : "true",
    );
}

describe("runStartup", () => {
  it("starts projects under the unified workflow", async () => {
    const project = createProject("/tmp/task-session-repository");
    const config = createConfig(project);
    const runGit = validRepositoryGit();
    const validateGitHubCli = vi.fn().mockResolvedValue(undefined);
    const validateProjectTrello = vi.fn().mockResolvedValue(undefined);
    const runOrchestrator = vi.fn().mockResolvedValue(undefined);

    const validateToolchain = vi.fn().mockResolvedValue(undefined);
    await runStartup(
      config,
      {
        trello: {} as TrelloClient,
        git: new GitClient(runGit),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(
          vi.fn<RunCommand>().mockResolvedValue({
            exitCode: 0,
            output: "",
            errorOutput: "",
          }),
        ),
      },
      new AbortController().signal,
      {
        validateToolchain,
        validateGitHubCli,
        validateProjectTrello,
        validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
        runOrchestrator,
      },
    );

    expect(validateGitHubCli).toHaveBeenCalledOnce();
    expect(validateToolchain).toHaveBeenCalledWith(
      expect.any(CommandRunner),
      project.opencode.timeoutMinutes * 60_000,
    );
    expect(runGit).toHaveBeenCalled();
    expect(validateProjectTrello).toHaveBeenCalledOnce();
    expect(runOrchestrator).toHaveBeenCalledOnce();
    const hostRegistry = JSON.parse(
      fs.readFileSync(
        path.join(config.workflow.coordinationRoot!, "projects.registry.json"),
        "utf8",
      ),
    ) as { projects: Array<{ projectId: string; activeAttempt: unknown }> };
    expect(hostRegistry.projects).toEqual([
      expect.objectContaining({ projectId: project.id, activeAttempt: null }),
    ]);
  });

  it("routes ambiguity from startup toolchain dispatch into its held lease", async () => {
    const project = createProject("/tmp/startup-ambiguous-repository");
    const config = createConfig(project);
    const pid = 41_723;
    const originalKill = process.kill;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((target, signal) => {
        if (typeof target === "number" && target === -pid) return true;
        return originalKill(target, signal);
      });
    const originalReaddir = fs.readdirSync;
    const procSpy = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation((directory, options) => {
        if (directory === "/proc") {
          const error = new Error(
            "injected procfs access failure",
          ) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalReaddir(directory, options as never) as never;
      });
    try {
      await expect(
        runStartup(
          config,
          {
            trello: {} as TrelloClient,
            git: new GitClient(validRepositoryGit()),
            github: {} as GitHubClient,
            opencode: {} as OpenCodeClient,
            commands: new CommandRunner(),
          },
          new AbortController().signal,
          {
            validateToolchain: async () => {
              await ProjectRunAuthority.dispatch(project.id, async () =>
                drainProcessGroup(pid, () => true, 0),
              );
            },
            validateGitHubCli: vi.fn().mockResolvedValue(undefined),
            validateProjectTrello: vi.fn().mockResolvedValue(undefined),
            validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
            runOrchestrator: vi.fn().mockResolvedValue(undefined),
          },
        ),
      ).rejects.toThrow(/Unable to verify termination/);
    } finally {
      procSpy.mockRestore();
      killSpy.mockRestore();
    }
    const key = createHash("sha256")
      .update(`github:${project.repository.github}`)
      .digest("hex");
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(config.workflow.coordinationRoot!, `${key}.ambiguity.json`),
        "utf8",
      ),
    ) as { processGroup: number };
    expect(marker.processGroup).toBe(pid);
    await expect(
      acquireProjectOwnership(
        config.workflow.coordinationRoot!,
        {
          trelloBoardId: project.trello.boardId,
          githubRepository: project.repository.github,
        },
        config.workflow.coordinationNamespaceId!,
      ),
    ).rejects.toThrow(/unresolved process-group termination ambiguity/);
  });

  it("resumes an active attempt on its old pins and defers redirected claims", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-old-pin-"));
    const repositoryPath = path.join(root, "old-repository");
    const worktreeRoot = path.join(root, "old-worktrees");
    const storageRoot = path.join(root, "old-runtime");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(worktreeRoot);
    fs.mkdirSync(storageRoot);
    const project = {
      ...createProject(repositoryPath),
      repository: {
        ...createProject(repositoryPath).repository,
        worktreeRoot,
      },
    };
    const baseConfig = createConfig(project);
    const originalConfig = {
      ...baseConfig,
      workflow: {
        ...baseConfig.workflow,
        contextRoot: storageRoot,
      },
    };
    const coordinationRoot = originalConfig.workflow.coordinationRoot!;
    const oldLease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      originalConfig.workflow.coordinationNamespaceId!,
    );
    try {
      const hostPin = (
        await verifyAndPinProjects(originalConfig, [oldLease])
      )[0]!;
      const pinned: RunRecord["pinned"] = {
        integrationId: hostPin.integrationId,
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
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      };
      const runLease = {
        integrationId: oldLease.identity
          ? JSON.stringify({
              trelloBoardId: oldLease.identity.trelloBoardId,
              githubRepository: oldLease.identity.githubRepository,
            })
          : hostPin.integrationId,
        instanceId: oldLease.instanceId,
        token: oldLease.token,
        assertHeld: () => oldLease.assertHeld(),
      };
      const attempt = new RunStore(storageRoot, "active-old", pinned, runLease);
      attempt.create({
        version: 1,
        revision: 1,
        projectId: project.id,
        cardId: "active-card",
        attemptId: "active-old",
        taskKind: "implementation",
        pinned,
        lifecycle: "planning",
        checkpoint: "planning",
        publicationState: "none",
        operation: { id: null, kind: null, generation: 0 },
        wait: { reason: null, dependency: null, since: null, retryAt: null },
        owner: {
          instanceId: oldLease.instanceId,
          token: oldLease.token,
          generation: 1,
        },
        resources: [],
        pendingOperations: [],
        queue: [],
        budgets: {},
        sessions: {},
        artifacts: [],
        expectedTrelloListId: null,
        terminalSync: "not-applicable",
        terminalEvidence: null,
        legacy: {},
        compatibility: {},
        updatedAt: new Date().toISOString(),
      });
      const registry = new RunRegistry(
        storageRoot,
        pinned.integrationId,
        runLease,
      );
      registry.handoff(attempt, null, 1);
      await updateProjectActiveAttempt(coordinationRoot, project.id, oldLease, {
        attemptId: attempt.read()!.attemptId,
        storageRoot,
      });
    } finally {
      await oldLease.release();
    }

    const newRepositoryPath = path.join(root, "new-repository");
    const newWorktreeRoot = path.join(root, "new-worktrees");
    const newStorageRoot = path.join(root, "new-runtime");
    fs.mkdirSync(newRepositoryPath);
    fs.mkdirSync(newWorktreeRoot);
    fs.mkdirSync(newStorageRoot);
    const redirected = {
      ...project,
      trello: { ...project.trello, boardId: "redirected-board" },
      repository: {
        ...project.repository,
        github: "owner/redirected",
        path: newRepositoryPath,
        worktreeRoot: newWorktreeRoot,
      },
    };
    const changedConfig = {
      ...originalConfig,
      projects: [redirected],
      workflow: { ...originalConfig.workflow, contextRoot: newStorageRoot },
    };
    const runOrchestrator = vi.fn().mockResolvedValue(undefined);
    const operations: StartupOperations = {
      validateToolchain: vi.fn().mockResolvedValue(undefined),
      validateGitHubCli: vi.fn().mockResolvedValue(undefined),
      validateProjectTrello: vi.fn().mockResolvedValue(undefined),
      validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
      runOrchestrator,
    };
    await runStartup(
      changedConfig,
      {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(
          vi.fn<RunCommand>().mockResolvedValue({
            exitCode: 0,
            output: "",
            errorOutput: "",
          }),
        ),
      },
      new AbortController().signal,
      operations,
    );
    expect(runOrchestrator).toHaveBeenCalledOnce();
    const runtimeConfig = runOrchestrator.mock.calls[0]?.[5] as Config;
    expect(runtimeConfig.projects[0]?.repository.path).toBe(repositoryPath);
    expect(runtimeConfig.projects[0]?.repository.github).toBe(
      "owner/repository",
    );
    const contexts = runOrchestrator.mock.calls[0]?.[9] as ReadonlyMap<
      string,
      { blockedReason?: string; authority?: { store: RunStore } }
    >;
    expect(contexts.get(project.id)?.authority).toBeUndefined();
    expect(contexts.get(project.id)?.blockedReason).toContain(
      "Configured resources changed while attempt",
    );
    const persistedAttempt = JSON.parse(
      fs.readFileSync(
        path.join(storageRoot, "attempts", "active-old.json"),
        "utf8",
      ),
    ) as RunRecord;
    expect(persistedAttempt.attemptId).toBe("active-old");
    expect(persistedAttempt.owner.generation).toBe(1);
  });

  it.each([
    "candidate-durable",
    "registry-pointer-durable",
    "legacy-import-pending",
    "pending-without-candidate",
  ] as const)(
    "recovers a host-pending fresh attempt after the %s crash boundary",
    async (barrier) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "startup-pending-handoff-"),
      );
      const repositoryPath = path.join(root, "repository");
      const worktreeRoot = path.join(root, "worktrees");
      const storageRoot = path.join(root, "runtime");
      const coordinationRoot = path.join(root, "coordination");
      fs.mkdirSync(repositoryPath);
      fs.mkdirSync(worktreeRoot);
      fs.mkdirSync(storageRoot);
      fs.mkdirSync(coordinationRoot);
      provisionCoordinationNamespace(coordinationRoot, "handoff-test");
      const project = createProject(repositoryPath);
      const baseConfig = createConfig(project);
      const config = {
        ...baseConfig,
        workflow: {
          ...baseConfig.workflow,
          contextRoot: storageRoot,
          coordinationRoot,
          coordinationNamespaceId: "handoff-test",
        },
      };
      const lease = await acquireProjectOwnership(
        coordinationRoot,
        {
          trelloBoardId: project.trello.boardId,
          githubRepository: project.repository.github,
        },
        "handoff-test",
      );
      let attemptId = "chosen-before-crash";
      try {
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
        const runLease = {
          integrationId: pin.integrationId,
          instanceId: lease.instanceId,
          token: lease.token,
          assertHeld: () => lease.assertHeld(),
        };
        let originalLegacyBytes: Buffer | undefined;
        if (barrier === "legacy-import-pending") {
          const legacyTask: TaskExecutionRecord = {
            version: 1,
            projectId: project.id,
            cardId: "chosen-card",
            phase: "planning",
            operationKey: "legacy-operation",
            revision: 1,
            retryCounters: {
              validation: 0,
              review: 0,
              ci: 0,
              humanFeedback: 0,
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          new TaskExecutionStore(storageRoot, project).create(legacyTask);
          attemptId = legacyAttemptId(legacyTask);
          originalLegacyBytes = fs.readFileSync(
            path.join(
              storageRoot,
              "task-executions",
              project.id,
              "chosen-card.json",
            ),
          );
        }
        await prepareProjectAttempt(coordinationRoot, project.id, lease, {
          attemptId,
          storageRoot,
        });
        if (
          barrier !== "legacy-import-pending" &&
          barrier !== "pending-without-candidate"
        ) {
          const candidateStore = new RunStore(
            storageRoot,
            attemptId,
            pinned,
            runLease,
          );
          candidateStore.create({
            version: 1,
            revision: 1,
            projectId: project.id,
            cardId: "chosen-card",
            attemptId,
            taskKind: "implementation",
            pinned,
            lifecycle: "preparing",
            checkpoint: "preparing",
            publicationState: "none",
            operation: { id: null, kind: null, generation: 0 },
            wait: {
              reason: null,
              dependency: null,
              since: null,
              retryAt: null,
            },
            owner: {
              instanceId: lease.instanceId,
              token: lease.token,
              generation: 1,
            },
            resources: [],
            pendingOperations: [],
            queue: [],
            budgets: {},
            sessions: {},
            artifacts: [],
            expectedTrelloListId: null,
            terminalSync: "not-applicable",
            terminalEvidence: null,
            legacy: {},
            compatibility: {},
            updatedAt: new Date().toISOString(),
          });
          if (barrier === "registry-pointer-durable")
            new RunRegistry(storageRoot, pin.integrationId, runLease).handoff(
              candidateStore,
              null,
              1,
            );
        }
        if (originalLegacyBytes)
          expect(
            fs.readFileSync(
              path.join(
                storageRoot,
                "task-executions",
                project.id,
                "chosen-card.json",
              ),
            ),
          ).toEqual(originalLegacyBytes);
      } finally {
        await lease.release();
      }

      const runOrchestrator = vi.fn().mockResolvedValue(undefined);
      await runStartup(
        config,
        {
          trello: {} as TrelloClient,
          git: new GitClient(validRepositoryGit()),
          github: {} as GitHubClient,
          opencode: {} as OpenCodeClient,
          commands: new CommandRunner(
            vi.fn<RunCommand>().mockResolvedValue({
              exitCode: 0,
              output: "",
              errorOutput: "",
            }),
          ),
        },
        new AbortController().signal,
        {
          validateToolchain: vi.fn().mockResolvedValue(undefined),
          validateGitHubCli: vi.fn().mockResolvedValue(undefined),
          validateProjectTrello: vi.fn().mockResolvedValue(undefined),
          validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
          runOrchestrator,
        },
      );
      const contexts = runOrchestrator.mock.calls[0]?.[9] as ReadonlyMap<
        string,
        { authority?: { store: RunStore }; blockedReason?: string }
      >;
      const authority = contexts.get(project.id)?.authority;
      if (barrier === "pending-without-candidate") {
        expect(authority).toBeUndefined();
        expect(contexts.get(project.id)?.blockedReason).toContain(
          "no durable candidate",
        );
        expect(
          new RunRegistry(
            storageRoot,
            JSON.stringify({
              trelloBoardId: "board",
              githubRepository: "owner/repository",
            }),
            {
              integrationId: JSON.stringify({
                trelloBoardId: "board",
                githubRepository: "owner/repository",
              }),
              instanceId: "inspection",
              token: "inspection",
              assertHeld() {},
            },
          ).read(),
        ).toBeNull();
      } else {
        expect(authority).toBeDefined();
        const recoveredRecord = JSON.parse(
          fs.readFileSync(
            path.join(storageRoot, "attempts", `${attemptId}.json`),
            "utf8",
          ),
        ) as RunRecord;
        expect(recoveredRecord.attemptId).toBe(attemptId);
        expect(recoveredRecord.owner.generation).toBe(
          barrier === "legacy-import-pending" ? 1 : 2,
        );
      }
      const registry = new RunRegistry(
        storageRoot,
        JSON.stringify({
          trelloBoardId: "board",
          githubRepository: "owner/repository",
        }),
        {
          integrationId: JSON.stringify({
            trelloBoardId: "board",
            githubRepository: "owner/repository",
          }),
          instanceId: "inspection",
          token: "inspection",
          assertHeld() {},
        },
      );
      expect(registry.read()?.attemptId).toBe(
        barrier === "pending-without-candidate" ? undefined : attemptId,
      );
      const hostPin = JSON.parse(
        fs.readFileSync(
          path.join(coordinationRoot, "projects.registry.json"),
          "utf8",
        ),
      ) as {
        projects: Array<{
          projectId: string;
          activeAttempt: { attemptId: string } | null;
          pendingAttempt: unknown;
        }>;
      };
      expect(hostPin.projects[0]).toMatchObject(
        barrier === "pending-without-candidate"
          ? {
              projectId: project.id,
              activeAttempt: null,
              pendingAttempt: { attemptId },
            }
          : {
              projectId: project.id,
              activeAttempt: { attemptId },
              pendingAttempt: null,
            },
      );
    },
  );

  it.each([false, true])(
    "recovers a fresh UUID candidate after importing and terminalizing legacy state (same-root integration reconfiguration: %s)",
    async (reconfigureIntegration) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "startup-composed-legacy-handoff-"),
      );
      const repositoryPath = path.join(root, "repository");
      const worktreeRoot = path.join(root, "worktrees");
      const runtimeRoot = path.join(root, "runtime");
      fs.mkdirSync(repositoryPath);
      fs.mkdirSync(worktreeRoot);
      fs.mkdirSync(runtimeRoot);
      const originalProject = createProject(repositoryPath);
      const baseConfig = createConfig(originalProject);
      const configA = {
        ...baseConfig,
        workflow: { ...baseConfig.workflow, contextRoot: runtimeRoot },
      };
      const runStartupWith = (
        startupConfig: Config,
        runOrchestrator: StartupOperations["runOrchestrator"],
      ) =>
        runStartup(
          startupConfig,
          {
            trello: {} as TrelloClient,
            git: new GitClient(
              vi
                .fn<RunGit>()
                .mockImplementation(async (_cwd, args) =>
                  args[0] === "remote"
                    ? `https://github.com/${startupConfig.projects[0]!.repository.github}.git`
                    : "true",
                ),
            ),
            github: {} as GitHubClient,
            opencode: {} as OpenCodeClient,
            commands: new CommandRunner(
              vi.fn<RunCommand>().mockResolvedValue({
                exitCode: 0,
                output: "",
                errorOutput: "",
              }),
            ),
          },
          new AbortController().signal,
          {
            validateToolchain: vi.fn().mockResolvedValue(undefined),
            validateGitHubCli: vi.fn().mockResolvedValue(undefined),
            validateProjectTrello: vi.fn().mockResolvedValue(undefined),
            validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
            runOrchestrator,
          },
        );

      const legacyTask: TaskExecutionRecord = {
        version: 1,
        projectId: originalProject.id,
        cardId: "original-legacy-card",
        phase: "planning",
        operationKey: "original-legacy-operation",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      new TaskExecutionStore(runtimeRoot, originalProject).create(legacyTask);
      const legacyFile = path.join(
        runtimeRoot,
        "task-executions",
        originalProject.id,
        `${legacyTask.cardId}.json`,
      );
      const legacyOriginalBytes = fs.readFileSync(legacyFile);
      const importedId = legacyAttemptId(legacyTask);
      const importingRun = vi.fn<StartupOperations["runOrchestrator"]>();
      await runStartupWith(configA, importingRun);
      const importedBytes = fs.readFileSync(
        path.join(runtimeRoot, "attempts", `${importedId}.json`),
      );
      const importedRecord = JSON.parse(
        importedBytes.toString("utf8"),
      ) as RunRecord;
      expect(importedRecord).toMatchObject({
        attemptId: importedId,
        lifecycle: "waiting",
        legacy: { sourceManifestHash: expect.any(String) },
      });
      expect(fs.readFileSync(legacyFile)).toEqual(legacyOriginalBytes);

      const terminalLease = await acquireProjectOwnership(
        configA.workflow.coordinationRoot!,
        {
          trelloBoardId: originalProject.trello.boardId,
          githubRepository: originalProject.repository.github,
        },
        configA.workflow.coordinationNamespaceId!,
      );
      let terminalRecord: RunRecord;
      try {
        const runLease = {
          integrationId: importedRecord.pinned.integrationId,
          instanceId: terminalLease.instanceId,
          token: terminalLease.token,
          assertHeld: () => terminalLease.assertHeld(),
        };
        const importedStore = new RunStore(
          runtimeRoot,
          importedId,
          importedRecord.pinned,
          runLease,
        );
        let current = importedStore.read()!;
        current = importedStore.takeOwnership(
          current.revision,
          current.owner.generation,
          terminalLease.token,
        );
        terminalRecord = importedStore.transition(
          current.revision,
          current.owner.generation,
          null,
          "failed",
          "waiting",
          "failed",
          (record) => record,
          {
            prOutcome: "no-pr-failure",
            prObservationId: "legacy-import-verified-pr-outcome",
            prVerifiedAt: new Date().toISOString(),
            trelloListId: importedRecord.pinned.lists.failed,
            trelloObservationId: "legacy-import-verified-list-readback",
            trelloVerifiedAt: new Date().toISOString(),
          },
        );
        await updateProjectActiveAttempt(
          configA.workflow.coordinationRoot!,
          originalProject.id,
          terminalLease,
          null,
        );
      } finally {
        await terminalLease.release();
      }
      expect(terminalRecord!).toMatchObject({
        attemptId: importedId,
        lifecycle: "failed",
        terminalSync: "verified",
        terminalEvidence: {
          prObservationId: "legacy-import-verified-pr-outcome",
          trelloObservationId: "legacy-import-verified-list-readback",
        },
      });
      const terminalImportedBytes = fs.readFileSync(
        path.join(runtimeRoot, "attempts", `${importedId}.json`),
      );

      let activeConfig = configA;
      if (reconfigureIntegration) {
        const changedProject = {
          ...originalProject,
          trello: { ...originalProject.trello, boardId: "reconfigured-board" },
          repository: {
            ...originalProject.repository,
            github: "owner/reconfigured-repository",
          },
        };
        activeConfig = { ...configA, projects: [changedProject] };
        const noTaskBeforeCrash = vi.fn<StartupOperations["runOrchestrator"]>();
        await runStartupWith(activeConfig, noTaskBeforeCrash);
        expect(noTaskBeforeCrash).toHaveBeenCalledOnce();
        expect(fs.readFileSync(legacyFile)).toEqual(legacyOriginalBytes);
        expect(
          fs.readFileSync(
            path.join(runtimeRoot, "attempts", `${importedId}.json`),
          ),
        ).toEqual(terminalImportedBytes);
      }

      const configuredProject = activeConfig.projects[0]!;
      const handoffLease = await acquireProjectOwnership(
        activeConfig.workflow.coordinationRoot!,
        {
          trelloBoardId: configuredProject.trello.boardId,
          githubRepository: configuredProject.repository.github,
        },
        activeConfig.workflow.coordinationNamespaceId!,
      );
      const freshAttemptId = randomUUID();
      try {
        const pin = (
          await readProjectPinCandidates(
            activeConfig.workflow.coordinationRoot!,
            configuredProject.id,
          )
        ).find(
          (candidate) =>
            candidate.integrationId ===
            JSON.stringify({
              trelloBoardId: configuredProject.trello.boardId,
              githubRepository: configuredProject.repository.github,
            }),
        )!;
        expect(pin.storageRoot).toBe(runtimeRoot);
        const pinned: RunRecord["pinned"] = {
          integrationId: pin.integrationId,
          projectId: configuredProject.id,
          boardId: pin.trello.boardId,
          lists: {
            ready: pin.trello.readyListId,
            working: pin.trello.workingListId,
            review: pin.trello.reviewListId,
            failed: pin.trello.failedListId,
            done: pin.trello.doneListId,
            backlog: pin.trello.backlogListId,
          },
          repository: pin.repository.github,
          repositoryPath: pin.repository.path,
          worktreeRoot: pin.repository.worktreeRoot,
          storageRoot: pin.storageRoot,
        };
        await prepareProjectAttempt(
          activeConfig.workflow.coordinationRoot!,
          configuredProject.id,
          handoffLease,
          { attemptId: freshAttemptId, storageRoot: runtimeRoot },
        );
        const candidateLease = {
          integrationId: pin.integrationId,
          instanceId: handoffLease.instanceId,
          token: handoffLease.token,
          assertHeld: () => handoffLease.assertHeld(),
        };
        const candidate = new RunStore(
          runtimeRoot,
          freshAttemptId,
          pinned,
          candidateLease,
        );
        candidate.create({
          version: 1,
          revision: 1,
          projectId: configuredProject.id,
          cardId: "fresh-card-after-legacy-import",
          attemptId: freshAttemptId,
          taskKind: "implementation",
          pinned,
          lifecycle: "preparing",
          checkpoint: "preparing",
          publicationState: "none",
          operation: { id: null, kind: null, generation: 0 },
          wait: { reason: null, dependency: null, since: null, retryAt: null },
          owner: {
            instanceId: handoffLease.instanceId,
            token: handoffLease.token,
            generation: 1,
          },
          resources: [],
          pendingOperations: [],
          queue: [],
          budgets: {},
          sessions: {},
          artifacts: [],
          expectedTrelloListId: null,
          terminalSync: "not-applicable",
          terminalEvidence: null,
          legacy: {},
          compatibility: {},
          updatedAt: new Date().toISOString(),
        });
        const registry = new RunRegistry(
          runtimeRoot,
          pin.integrationId,
          candidateLease,
        );
        const prior = registry.read();
        registry.handoff(candidate, prior, prior ? prior.generation + 1 : 1);
        expect(registry.read()?.attemptId).toBe(freshAttemptId);
        const hostBeforeCrash = (
          await readProjectPinCandidates(
            activeConfig.workflow.coordinationRoot!,
            configuredProject.id,
          )
        ).find(
          (candidatePin) => candidatePin.integrationId === pin.integrationId,
        )!;
        expect(hostBeforeCrash.pendingAttempt?.attemptId).toBe(freshAttemptId);
        expect(hostBeforeCrash.activeAttempt).toBeNull();
      } finally {
        await handoffLease.release();
      }

      const resumedRun = vi.fn<StartupOperations["runOrchestrator"]>();
      resumedRun.mockImplementation(async (...args) => {
        const contexts = args[9] as ReadonlyMap<
          string,
          { authority?: ProjectRunAuthority; blockedReason?: string }
        >;
        const context = contexts.get(configuredProject.id)!;
        expect(context.blockedReason).toBeUndefined();
        expect(context.authority?.store.read()).toMatchObject({
          attemptId: freshAttemptId,
          lifecycle: "preparing",
          owner: { generation: 2 },
        });
        context.authority!.claim();
      });
      await runStartupWith(activeConfig, resumedRun);
      expect(resumedRun).toHaveBeenCalledOnce();
      const resumedAttempt = JSON.parse(
        fs.readFileSync(
          path.join(runtimeRoot, "attempts", `${freshAttemptId}.json`),
          "utf8",
        ),
      ) as RunRecord;
      expect(resumedAttempt).toMatchObject({
        attemptId: freshAttemptId,
        lifecycle: "planning",
        owner: { generation: 2 },
      });
      expect(fs.readFileSync(legacyFile)).toEqual(legacyOriginalBytes);
      expect(
        fs.readFileSync(
          path.join(runtimeRoot, "attempts", `${importedId}.json`),
        ),
      ).toEqual(terminalImportedBytes);
    },
  );

  it("reconfigures an inactive project only after inspecting the predecessor with old pins", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "startup-terminal-relocation-"),
    );
    const repositoryPath = path.join(root, "repository");
    const worktreeRoot = path.join(root, "old-worktrees");
    const oldStorageRoot = path.join(root, "old-state");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(worktreeRoot);
    fs.mkdirSync(oldStorageRoot);
    const project = {
      ...createProject(repositoryPath),
      repository: {
        ...createProject(repositoryPath).repository,
        worktreeRoot,
      },
    };
    const baseConfig = createConfig(project);
    const coordinationRoot = baseConfig.workflow.coordinationRoot!;
    const namespaceId = baseConfig.workflow.coordinationNamespaceId!;
    const originalConfig = {
      ...baseConfig,
      workflow: { ...baseConfig.workflow, contextRoot: oldStorageRoot },
    };
    const oldLease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      namespaceId,
    );
    let attemptFile: string;
    try {
      const hostPin = (
        await verifyAndPinProjects(originalConfig, [oldLease])
      )[0]!;
      const pinned: RunRecord["pinned"] = {
        integrationId: hostPin.integrationId,
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
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      };
      const runLease = {
        integrationId: hostPin.integrationId,
        instanceId: oldLease.instanceId,
        token: oldLease.token,
        assertHeld: () => oldLease.assertHeld(),
      };
      const terminalStore = new RunStore(
        oldStorageRoot,
        "old-terminal",
        pinned,
        runLease,
      );
      terminalStore.create({
        version: 1,
        revision: 1,
        projectId: project.id,
        cardId: "old-card",
        attemptId: "old-terminal",
        taskKind: "implementation",
        pinned,
        lifecycle: "failed",
        checkpoint: "failed",
        publicationState: "none",
        operation: { id: null, kind: null, generation: 0 },
        wait: { reason: null, dependency: null, since: null, retryAt: null },
        owner: {
          instanceId: oldLease.instanceId,
          token: oldLease.token,
          generation: 1,
        },
        resources: [],
        pendingOperations: [],
        queue: [],
        budgets: {},
        sessions: {},
        artifacts: [],
        expectedTrelloListId: project.trello.failedListId,
        terminalSync: "verified",
        terminalEvidence: {
          prOutcome: "no-pr-failure",
          prObservationId: "verified-no-pr-failure",
          prVerifiedAt: new Date().toISOString(),
          trelloListId: project.trello.failedListId,
          trelloObservationId: "verified-failed-list",
          trelloVerifiedAt: new Date().toISOString(),
        },
        legacy: {},
        compatibility: {},
        updatedAt: new Date().toISOString(),
      });
      const registry = new RunRegistry(
        oldStorageRoot,
        pinned.integrationId,
        runLease,
      );
      registry.handoff(terminalStore, null, 1);
      await updateProjectActiveAttempt(coordinationRoot, project.id, oldLease, {
        attemptId: "old-terminal",
        storageRoot: oldStorageRoot,
      });
      attemptFile = path.join(oldStorageRoot, "attempts", "old-terminal.json");
    } finally {
      await oldLease.release();
    }
    const oldBytes = fs.readFileSync(attemptFile!);
    const newRepositoryPath = path.join(root, "new-repository");
    const newWorktreeRoot = path.join(root, "new-worktrees");
    const newStorageRoot = oldStorageRoot;
    fs.mkdirSync(newRepositoryPath);
    fs.mkdirSync(newWorktreeRoot);
    const relocated = {
      ...project,
      trello: { ...project.trello, readyListId: "ready-v2" },
      repository: {
        ...project.repository,
        path: newRepositoryPath,
        worktreeRoot: newWorktreeRoot,
      },
    };
    const changedConfig = {
      ...originalConfig,
      projects: [relocated],
      workflow: { ...originalConfig.workflow, contextRoot: newStorageRoot },
    };
    const runOrchestrator = vi.fn().mockResolvedValue(undefined);
    await runStartup(
      changedConfig,
      {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(
          vi.fn<RunCommand>().mockResolvedValue({
            exitCode: 0,
            output: "",
            errorOutput: "",
          }),
        ),
      },
      new AbortController().signal,
      {
        validateToolchain: vi.fn().mockResolvedValue(undefined),
        validateGitHubCli: vi.fn().mockResolvedValue(undefined),
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
        runOrchestrator,
      },
    );
    expect(runOrchestrator).toHaveBeenCalledOnce();
    const effective = runOrchestrator.mock.calls[0]?.[5] as Config;
    expect(effective.projects[0]?.repository.path).toBe(newRepositoryPath);
    expect(effective.workflow.contextRoot).toBe(newStorageRoot);
    expect(fs.readFileSync(attemptFile!)).toEqual(oldBytes);
    const restartedRunOrchestrator =
      vi.fn<StartupOperations["runOrchestrator"]>();
    restartedRunOrchestrator.mockImplementation(async (...args) => {
      const contexts = args[9]! as ReadonlyMap<
        string,
        {
          pinned?: RunRecord["pinned"];
          projectLease?: ProjectOwnershipLease;
          coordinationRoot?: string;
        }
      >;
      const context = contexts.get(project.id)!;
      const next = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "fresh-after-relocation",
        taskKind: "implementation",
        pinned: context.pinned!,
        projectLease: context.projectLease!,
        coordinationRoot: context.coordinationRoot!,
      });
      expect(next.store.read()?.resources[0]?.path).toBe(
        path.join(
          newWorktreeRoot,
          `fresh-after-relocation--${next.store.attemptId}`,
        ),
      );
    });
    await runStartup(
      changedConfig,
      {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(
          vi.fn<RunCommand>().mockResolvedValue({
            exitCode: 0,
            output: "",
            errorOutput: "",
          }),
        ),
      },
      new AbortController().signal,
      {
        validateToolchain: vi.fn().mockResolvedValue(undefined),
        validateGitHubCli: vi.fn().mockResolvedValue(undefined),
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
        runOrchestrator: restartedRunOrchestrator,
      },
    );
    const restartedContexts = restartedRunOrchestrator.mock
      .calls[0]?.[9] as ReadonlyMap<
      string,
      { pinned?: RunRecord["pinned"]; authority?: unknown }
    >;
    expect(restartedContexts.get(project.id)).toMatchObject({
      pinned: {
        repositoryPath: newRepositoryPath,
        worktreeRoot: newWorktreeRoot,
        storageRoot: newStorageRoot,
      },
    });
    expect(restartedContexts.get(project.id)?.authority).toBeUndefined();
    expect(fs.readFileSync(attemptFile!)).toEqual(oldBytes);
  });

  it("does not reimport retained legacy sources after an inactive integration change at the same runtime root", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "startup-stale-legacy-"),
    );
    const repositoryPath = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(worktreeRoot);
    fs.mkdirSync(runtimeRoot);
    const project = createProject(repositoryPath);
    const base = createConfig(project);
    const config = {
      ...base,
      workflow: { ...base.workflow, contextRoot: runtimeRoot },
    };
    const legacyTask: TaskExecutionRecord = {
      version: 1,
      projectId: project.id,
      cardId: "retained-legacy-card",
      phase: "planning",
      operationKey: "legacy-source-operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const legacyStore = new TaskExecutionStore(runtimeRoot, project);
    legacyStore.create(legacyTask);
    const legacyFile = path.join(
      runtimeRoot,
      "task-executions",
      project.id,
      `${legacyTask.cardId}.json`,
    );
    const originalLegacyBytes = fs.readFileSync(legacyFile);
    const startup = async (
      startupConfig: Config,
      runOrchestrator: StartupOperations["runOrchestrator"],
    ) =>
      runStartup(
        startupConfig,
        {
          trello: {} as TrelloClient,
          git: new GitClient(
            vi
              .fn<RunGit>()
              .mockImplementation(async (_cwd, args) =>
                args[0] === "remote"
                  ? `https://github.com/${startupConfig.projects[0]!.repository.github}.git`
                  : "true",
              ),
          ),
          github: {} as GitHubClient,
          opencode: {} as OpenCodeClient,
          commands: new CommandRunner(
            vi.fn<RunCommand>().mockResolvedValue({
              exitCode: 0,
              output: "",
              errorOutput: "",
            }),
          ),
        },
        new AbortController().signal,
        {
          validateToolchain: vi.fn().mockResolvedValue(undefined),
          validateGitHubCli: vi.fn().mockResolvedValue(undefined),
          validateProjectTrello: vi.fn().mockResolvedValue(undefined),
          validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
          runOrchestrator,
        },
      );

    const firstRun = vi.fn<StartupOperations["runOrchestrator"]>();
    await startup(config, firstRun);
    const firstContexts = firstRun.mock.calls[0]?.[9] as ReadonlyMap<
      string,
      { projectLease?: ProjectOwnershipLease; pinned?: RunRecord["pinned"] }
    >;
    const firstContext = firstContexts.get(project.id)!;
    const oldAttemptId = legacyAttemptId(legacyTask);
    const oldAttemptPath = path.join(
      runtimeRoot,
      "attempts",
      `${oldAttemptId}.json`,
    );
    expect(fs.existsSync(oldAttemptPath)).toBe(true);
    const oldAttemptBytes = fs.readFileSync(oldAttemptPath);
    const terminalLease = await acquireProjectOwnership(
      config.workflow.coordinationRoot!,
      {
        trelloBoardId: project.trello.boardId,
        githubRepository: project.repository.github,
      },
      config.workflow.coordinationNamespaceId!,
    );
    try {
      const store = new RunStore(
        runtimeRoot,
        oldAttemptId,
        firstContext.pinned!,
        {
          integrationId: firstContext.pinned!.integrationId,
          instanceId: terminalLease.instanceId,
          token: terminalLease.token,
          assertHeld: () => terminalLease.assertHeld(),
        },
      );
      const waiting = store.read()!;
      store.takeOwnership(
        waiting.revision,
        waiting.owner.generation,
        terminalLease.token,
      );
      const owned = store.read()!;
      store.transition(
        owned.revision,
        owned.owner.generation,
        null,
        "failed",
        "waiting",
        "failed",
        (record) => record,
        {
          prOutcome: "no-pr-failure",
          prObservationId: "legacy-import-terminal-pr-readback",
          prVerifiedAt: new Date().toISOString(),
          trelloListId: firstContext.pinned!.lists.failed,
          trelloObservationId: "legacy-import-terminal-card-readback",
          trelloVerifiedAt: new Date().toISOString(),
        },
      );
    } finally {
      await terminalLease.release();
    }
    const terminalAttemptBytes = fs.readFileSync(oldAttemptPath);
    expect(terminalAttemptBytes).not.toEqual(oldAttemptBytes);
    expect(fs.readFileSync(legacyFile)).toEqual(originalLegacyBytes);

    const changedProject = {
      ...project,
      trello: { ...project.trello, boardId: "new-board" },
      repository: { ...project.repository, github: "owner/new-repository" },
    };
    const changedConfig = { ...config, projects: [changedProject] };
    const changedRun = vi.fn<StartupOperations["runOrchestrator"]>();
    changedRun.mockImplementation(async (...args) => {
      const contexts = args[9] as ReadonlyMap<
        string,
        {
          authority?: unknown;
          blockedReason?: string;
          projectLease?: ProjectOwnershipLease;
          pinned?: RunRecord["pinned"];
          coordinationRoot?: string;
        }
      >;
      const context = contexts.get(project.id)!;
      expect(context.blockedReason).toBeUndefined();
      expect(context.authority).toBeUndefined();
      const fresh = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "fresh-under-new-integration",
        taskKind: "implementation",
        pinned: context.pinned!,
        projectLease: context.projectLease!,
        coordinationRoot: context.coordinationRoot!,
      });
      expect(fresh.store.read()).toMatchObject({
        cardId: "fresh-under-new-integration",
        lifecycle: "preparing",
      });
    });
    await startup(changedConfig, changedRun);
    expect(changedRun).toHaveBeenCalledOnce();
    const operatorContext = await acquireProjectRunOperatorContext(
      changedConfig,
      changedProject,
    );
    try {
      expect(operatorContext.authority.store.read()).toMatchObject({
        cardId: "fresh-under-new-integration",
        lifecycle: "preparing",
      });
    } finally {
      await operatorContext.release();
    }
    expect(fs.readFileSync(legacyFile)).toEqual(originalLegacyBytes);
    expect(fs.readFileSync(oldAttemptPath)).toEqual(terminalAttemptBytes);
    const currentRegistry = new RunRegistry(
      runtimeRoot,
      JSON.stringify({
        trelloBoardId: "new-board",
        githubRepository: "owner/new-repository",
      }),
      {
        integrationId: JSON.stringify({
          trelloBoardId: "new-board",
          githubRepository: "owner/new-repository",
        }),
        instanceId: "inspection",
        token: "inspection",
        assertHeld() {},
      },
    );
    expect(currentRegistry.read()?.attemptId).not.toBe(oldAttemptId);
  });

  it("inspects each completed integration's actual registry pointer before allowing the next settings revision", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "startup-history-pointers-"),
    );
    const repositoryPath = path.join(root, "repository");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(runtimeRoot);
    const originalProject = createProject(repositoryPath);
    const base = createConfig(originalProject);
    const configA = {
      ...base,
      workflow: { ...base.workflow, contextRoot: runtimeRoot },
    };
    const startup = async (
      startupConfig: Config,
      runOrchestrator: StartupOperations["runOrchestrator"],
    ) =>
      runStartup(
        startupConfig,
        {
          trello: {} as TrelloClient,
          git: new GitClient(validRepositoryGit()),
          github: {} as GitHubClient,
          opencode: {} as OpenCodeClient,
          commands: new CommandRunner(
            vi
              .fn<RunCommand>()
              .mockResolvedValue({ exitCode: 0, output: "", errorOutput: "" }),
          ),
        },
        new AbortController().signal,
        {
          validateToolchain: vi.fn().mockResolvedValue(undefined),
          validateGitHubCli: vi.fn().mockResolvedValue(undefined),
          validateProjectTrello: vi.fn().mockResolvedValue(undefined),
          validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
          runOrchestrator,
        },
      );
    const completeCurrentAttempt = async (
      contexts: ReadonlyMap<
        string,
        { projectLease?: ProjectOwnershipLease; pinned?: RunRecord["pinned"] }
      >,
      cardId: string,
    ) => {
      const context = contexts.get(originalProject.id)!;
      const authority = await ProjectRunAuthority.createPreparingAttempt({
        projectId: originalProject.id,
        cardId,
        attemptId: cardId,
        taskKind: "implementation",
        pinned: context.pinned!,
        projectLease: context.projectLease!,
        coordinationRoot: configA.workflow.coordinationRoot!,
      });
      authority.claim();
      const active = authority.store.read()!;
      authority.store.transition(
        active.revision,
        active.owner.generation,
        null,
        "failed",
        active.lifecycle,
        "failed",
        (record) => record,
        {
          prOutcome: "no-pr-failure",
          prObservationId: `${cardId}-terminal-pr-readback`,
          prVerifiedAt: new Date().toISOString(),
          trelloListId: context.pinned!.lists.failed,
          trelloObservationId: `${cardId}-terminal-card-readback`,
          trelloVerifiedAt: new Date().toISOString(),
        },
      );
      return authority.store.read()!;
    };

    const runA = vi.fn<StartupOperations["runOrchestrator"]>();
    runA.mockImplementation(async (...args) => {
      const contexts = args[9] as ReadonlyMap<
        string,
        { projectLease?: ProjectOwnershipLease; pinned?: RunRecord["pinned"] }
      >;
      await completeCurrentAttempt(contexts, "attempt-revision-a");
    });
    await startup(configA, runA);
    const recordA = JSON.parse(
      fs.readFileSync(
        path.join(runtimeRoot, "attempts", "attempt-revision-a.json"),
        "utf8",
      ),
    ) as RunRecord;
    const pointerA = new RunRegistry(
      runtimeRoot,
      recordA.pinned.integrationId,
      {
        integrationId: recordA.pinned.integrationId,
        instanceId: "inspection",
        token: "inspection",
        assertHeld() {},
      },
    ).read();
    expect(pointerA?.attemptId).toBe(recordA.attemptId);
    const bytesA = fs.readFileSync(
      path.join(runtimeRoot, "attempts", "attempt-revision-a.json"),
    );

    const projectB = {
      ...originalProject,
      trello: { ...originalProject.trello, readyListId: "ready-revision-b" },
      repository: {
        ...originalProject.repository,
        worktreeRoot: path.join(root, "worktrees-b"),
      },
    };
    fs.mkdirSync(projectB.repository.worktreeRoot);
    const configB = { ...configA, projects: [projectB] };
    const runB = vi.fn<StartupOperations["runOrchestrator"]>();
    runB.mockImplementation(async (...args) => {
      const contexts = args[9] as ReadonlyMap<
        string,
        { projectLease?: ProjectOwnershipLease; pinned?: RunRecord["pinned"] }
      >;
      await completeCurrentAttempt(contexts, "attempt-revision-b");
    });
    await startup(configB, runB);
    const bytesB = fs.readFileSync(
      path.join(runtimeRoot, "attempts", "attempt-revision-b.json"),
    );
    const recordB = JSON.parse(bytesB.toString("utf8")) as RunRecord;
    const pointerB = new RunRegistry(
      runtimeRoot,
      recordB.pinned.integrationId,
      {
        integrationId: recordB.pinned.integrationId,
        instanceId: "inspection",
        token: "inspection",
        assertHeld() {},
      },
    ).read();
    expect(pointerB?.attemptId).toBe(recordB.attemptId);
    expect(recordB.pinned.lists.ready).toBe("ready-revision-b");
    expect(recordB.pinned.worktreeRoot).toBe(projectB.repository.worktreeRoot);

    const projectC = {
      ...projectB,
      trello: { ...projectB.trello, readyListId: "ready-revision-c" },
      repository: {
        ...projectB.repository,
        worktreeRoot: path.join(root, "worktrees-c"),
      },
    };
    fs.mkdirSync(projectC.repository.worktreeRoot);
    const configC = { ...configA, projects: [projectC] };
    const runC = vi.fn<StartupOperations["runOrchestrator"]>();
    runC.mockImplementation(async (...args) => {
      const contexts = args[9] as ReadonlyMap<
        string,
        {
          projectLease?: ProjectOwnershipLease;
          pinned?: RunRecord["pinned"];
          coordinationRoot?: string;
          authority?: unknown;
          blockedReason?: string;
        }
      >;
      const context = contexts.get(originalProject.id)!;
      expect(context.blockedReason).toBeUndefined();
      expect(context.authority).toBeUndefined();
      const fresh = await ProjectRunAuthority.createPreparingAttempt({
        projectId: originalProject.id,
        cardId: "attempt-revision-c",
        attemptId: "attempt-revision-c",
        taskKind: "implementation",
        pinned: context.pinned!,
        projectLease: context.projectLease!,
        coordinationRoot: context.coordinationRoot!,
      });
      expect(fresh.store.read()).toMatchObject({
        lifecycle: "preparing",
        pinned: { lists: { ready: "ready-revision-c" } },
      });
    });
    await startup(configC, runC);
    expect(runC).toHaveBeenCalledOnce();
    expect(
      fs.readFileSync(
        path.join(runtimeRoot, "attempts", "attempt-revision-a.json"),
      ),
    ).toEqual(bytesA);
    expect(
      fs.readFileSync(
        path.join(runtimeRoot, "attempts", "attempt-revision-b.json"),
      ),
    ).toEqual(bytesB);
    expect(recordA.pinned.lists.ready).toBe(originalProject.trello.readyListId);
    const history = await readHistoricalProjectPins(
      configA.workflow.coordinationRoot!,
      originalProject.id,
    );
    expect(history.map((pin) => pin.integrationId)).toEqual(
      expect.arrayContaining([
        JSON.stringify({
          trelloBoardId: originalProject.trello.boardId,
          githubRepository: originalProject.repository.github,
        }),
        JSON.stringify({
          trelloBoardId: projectB.trello.boardId,
          githubRepository: projectB.repository.github,
        }),
      ]),
    );
    const finalPointer = new RunRegistry(
      runtimeRoot,
      recordB.pinned.integrationId,
      {
        integrationId: recordB.pinned.integrationId,
        instanceId: "inspection",
        token: "inspection",
        assertHeld() {},
      },
    ).read();
    // C creates the next attempt only after historical reconciliation has
    // opened the actual shared registry pointer (B) using its persisted pins.
    expect(finalPointer?.attemptId).toBe("attempt-revision-c");
  });

  it("preserves an inactive host pin when the project is omitted", async () => {
    const repositoryPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-pinned-repository-"),
    );
    const project = createProject(repositoryPath);
    const config = createConfig(project);
    const operations: StartupOperations = {
      validateToolchain: vi.fn().mockResolvedValue(undefined),
      validateGitHubCli: vi.fn().mockResolvedValue(undefined),
      validateProjectTrello: vi.fn().mockResolvedValue(undefined),
      validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
      runOrchestrator: vi.fn().mockResolvedValue(undefined),
    };
    const dependencies: StartupDependencies = {
      trello: {} as TrelloClient,
      git: new GitClient(validRepositoryGit()),
      github: {} as GitHubClient,
      opencode: {} as OpenCodeClient,
      commands: new CommandRunner(vi.fn<RunCommand>()),
    };
    await runStartup(
      config,
      dependencies,
      new AbortController().signal,
      operations,
    );

    const removed = {
      ...config,
      projects: [],
    } as unknown as Config;
    await runStartup(
      removed,
      dependencies,
      new AbortController().signal,
      operations,
    );
    expect(operations.runOrchestrator).toHaveBeenCalledTimes(2);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  });

  it("runs context retention cleanup before startup operations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);
    const cleanup = vi.spyOn(
      cardContextRetention,
      "cleanupCardContextRetention",
    );

    try {
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };
      const runOrchestrator = vi.fn().mockResolvedValue(undefined);
      const operations: StartupOperations = {
        validateToolchain: vi.fn().mockResolvedValue(undefined),
        validateGitHubCli: vi.fn().mockResolvedValue(undefined),
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
        runOrchestrator,
      };

      await runStartup(
        createConfig(createProject(repositoryPath)),
        dependencies,
        new AbortController().signal,
        operations,
      );

      expect(cleanup).toHaveBeenCalledWith(
        "/opt/.agent-context",
        14,
        expect.any(Date),
        ["test-project"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs persisted-state temporary-file cleanup before startup operations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);
    const cleanup = vi.spyOn(
      persistedStateTemporaryFiles,
      "cleanupPersistedStateTemporaryFiles",
    );

    try {
      const config = createConfig(createProject(repositoryPath));
      const validateGitHubCli = vi.fn().mockResolvedValue(undefined);
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };
      const runOrchestrator = vi.fn().mockResolvedValue(undefined);
      const operations: StartupOperations = {
        validateToolchain: vi.fn().mockResolvedValue(undefined),
        validateGitHubCli,
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
        runOrchestrator,
      };

      await runStartup(
        config,
        dependencies,
        new AbortController().signal,
        operations,
      );

      expect(cleanup).toHaveBeenCalledWith(
        config.projects,
        config.workflow.contextRoot,
      );
      expect(validateGitHubCli.mock.invocationCallOrder[0]).toBeLessThan(
        cleanup.mock.invocationCallOrder[0]!,
      );
    } finally {
      cleanup.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a confirmed invalid repository before polling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);

    try {
      const runGit = vi
        .fn<RunGit>()
        .mockRejectedValue(new Error("fatal: not a git repository"));
      const runOrchestrator = vi.fn().mockResolvedValue(undefined);
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(runGit),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };
      const operations: StartupOperations = {
        validateToolchain: vi.fn().mockResolvedValue(undefined),
        validateGitHubCli: vi.fn().mockResolvedValue(undefined),
        validateProjectTrello: vi.fn().mockResolvedValue(undefined),
        runOrchestrator,
      };

      await expect(
        runStartup(
          createConfig(createProject(repositoryPath)),
          dependencies,
          new AbortController().signal,
          operations,
        ),
      ).rejects.toThrow("is not a valid Git repository");
      expect(operations.validateProjectTrello).not.toHaveBeenCalled();
      expect(runOrchestrator).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an unavailable project's processing gated while another project passes readiness", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-readiness-"));
    const pathA = path.join(root, "repo-a");
    const pathB = path.join(root, "repo-b");
    fs.mkdirSync(pathA);
    fs.mkdirSync(pathB);
    const projectA = createProject(pathA);
    const projectB = {
      ...createProject(pathB),
      id: "project-b",
      trello: {
        ...createProject(pathB).trello,
        boardId: "board-b",
      },
      repository: {
        ...createProject(pathB).repository,
        github: "owner/repository-b",
      },
    };
    const config = {
      ...createConfig(projectA),
      projects: [projectA, projectB],
    };
    const git = new GitClient(
      vi.fn<RunGit>().mockImplementation(async (cwd, args) => {
        if (args[0] === "remote")
          return cwd === pathA
            ? "https://github.com/owner/repository.git"
            : "https://github.com/owner/repository-b.git";
        return "true";
      }),
    );
    const validateGitHub = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectResourceError(
          "unavailable",
          "GitHub temporarily unavailable",
        ),
      )
      .mockResolvedValue(undefined);
    const validateTrello = vi.fn().mockResolvedValue(undefined);
    const runOrchestrator = vi.fn<StartupOperations["runOrchestrator"]>();
    runOrchestrator.mockImplementation(async (...args) => {
      const retryReadiness = args[8];
      await retryReadiness?.({} as TrelloClient, projectA);
      await retryReadiness?.({} as TrelloClient, projectB);
    });
    const dependencies: StartupDependencies = {
      trello: {} as TrelloClient,
      git,
      github: {} as GitHubClient,
      opencode: {} as OpenCodeClient,
      commands: new CommandRunner(vi.fn<RunCommand>()),
    };
    await runStartup(config, dependencies, new AbortController().signal, {
      validateToolchain: vi.fn().mockResolvedValue(undefined),
      validateGitHubCli: vi.fn().mockResolvedValue(undefined),
      validateProjectGitHub: validateGitHub,
      validateProjectTrello: validateTrello,
      runOrchestrator,
    });
    expect(validateTrello).toHaveBeenCalledTimes(2);
    expect(runOrchestrator).toHaveBeenCalledOnce();
    expect(validateGitHub).toHaveBeenCalledTimes(3);
    expect(validateTrello).toHaveBeenCalledTimes(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses normal project processing when gh compatibility validation fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);

    try {
      const githubCompatibilityError = new Error(
        "GitHub CLI compatibility validation failed: installed gh version 2.39.0 is unsupported",
      );
      const runGit = validRepositoryGit();
      const validateGitHubCli = vi
        .fn()
        .mockRejectedValue(githubCompatibilityError);
      const validateProjectTrello = vi.fn().mockResolvedValue(undefined);
      const runOrchestrator = vi.fn().mockResolvedValue(undefined);
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(runGit),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };

      await expect(
        runStartup(
          createConfig(createProject(repositoryPath)),
          dependencies,
          new AbortController().signal,
          {
            validateToolchain: vi.fn().mockResolvedValue(undefined),
            validateGitHubCli,
            validateProjectTrello,
            validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
            runOrchestrator,
          },
        ),
      ).rejects.toBe(githubCompatibilityError);

      expect(validateGitHubCli).toHaveBeenCalledWith(
        dependencies.github,
        expect.any(Array),
      );
      expect(runGit).not.toHaveBeenCalled();
      expect(validateProjectTrello).not.toHaveBeenCalled();
      expect(runOrchestrator).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defers transient Trello validation failures to the polling worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-"));
    const repositoryPath = path.join(root, "repository");
    fs.mkdirSync(repositoryPath);

    try {
      const project = createProject(repositoryPath);
      const validateProjectTrello = vi
        .fn()
        .mockRejectedValueOnce(
          new TrelloRequestError(
            "board lookup",
            "Trello request failed: 503 Unavailable",
            { status: 503, retryable: true },
          ),
        )
        .mockResolvedValue(undefined);
      const runOrchestrator = vi.fn<StartupOperations["runOrchestrator"]>();
      runOrchestrator.mockImplementation(async (...args) => {
        const deferredValidation = args[8];
        await deferredValidation?.({} as TrelloClient, project);
      });
      const dependencies: StartupDependencies = {
        trello: {} as TrelloClient,
        git: new GitClient(validRepositoryGit()),
        github: {} as GitHubClient,
        opencode: {} as OpenCodeClient,
        commands: new CommandRunner(vi.fn<RunCommand>()),
      };

      await runStartup(
        createConfig(project),
        dependencies,
        new AbortController().signal,
        {
          validateToolchain: vi.fn().mockResolvedValue(undefined),
          validateGitHubCli: vi.fn().mockResolvedValue(undefined),
          validateProjectTrello,
          validateProjectGitHub: vi.fn().mockResolvedValue(undefined),
          runOrchestrator,
        },
      );

      expect(runOrchestrator).toHaveBeenCalledOnce();
      expect(runOrchestrator.mock.calls[0]?.[8]).toBeDefined();
      expect(validateProjectTrello).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
