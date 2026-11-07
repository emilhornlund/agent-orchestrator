import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import {
  prepareProjectAttempt,
  readProjectPinCandidates,
  updateProjectActiveAttempt,
  verifyAndPinProjects,
} from "../src/coordination/project-registry.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { RunRegistry, RunStore } from "../src/task-session/run-store.js";
import { legacyAttemptId } from "../src/task-session/legacy-state-import.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { runOrchestrator } from "../src/orchestrator/run-orchestrator.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";
import {
  runStartup,
  type StartupOperations,
} from "../src/startup/run-startup.js";

let root: string;
const leases: ProjectOwnershipLease[] = [];

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("resuming canonical preparing attempts", () => {
  it.each([
    { taskKind: "implementation", cardId: "implementation-card" },
    { taskKind: "refinement", cardId: "refinement-card" },
  ] as const)(
    "claims and runs the persisted $taskKind attempt under a new lease",
    async ({ taskKind, cardId }) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "preparing-resume-"));
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const storageRoot = path.join(root, "attempts");
      const coordinationRoot = path.join(root, "coordination");
      fs.mkdirSync(repositoryPath);
      fs.mkdirSync(worktreeRoot);
      fs.mkdirSync(coordinationRoot);
      provisionCoordinationNamespace(coordinationRoot, "resume-test");
      const project = {
        id: "resume-project",
        autoMerge: false,
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
          validationCommand: "validate",
          ...(taskKind === "implementation" ? { setupCommand: "setup" } : {}),
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
      } as ProjectConfig;
      const config = {
        projects: [project],
        workflow: {
          contextRoot: storageRoot,
          coordinationRoot,
          coordinationNamespaceId: "resume-test",
          pollIntervalSeconds: 0.001,
          logRetentionDays: 30,
          contextRetentionDays: 30,
        },
      } as Config;

      const oldLease = await acquireProjectOwnership(
        coordinationRoot,
        { trelloBoardId: "board", githubRepository: "owner/repo" },
        "resume-test",
      );
      leases.push(oldLease);
      const hostPin = (await verifyAndPinProjects(config, [oldLease]))[0]!;
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
      const preparing = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId,
        taskKind,
        pinned,
        projectLease: oldLease,
        coordinationRoot,
      });
      const attemptId = preparing.store.read()!.attemptId;
      const originalGeneration = preparing.store.read()!.owner.generation;
      const processRunner = new CommandRunner();
      await preparing.run(() =>
        processRunner.run({
          cwd: root,
          command: `node -e 'process.stdout.write("BEFORE_RESTART_CHILD_MARKER")'`,
        }),
      );
      await oldLease.release();
      leases.splice(leases.indexOf(oldLease), 1);

      const lease = await acquireProjectOwnership(
        coordinationRoot,
        { trelloBoardId: "board", githubRepository: "owner/repo" },
        "resume-test",
      );
      leases.push(lease);
      const authority = await ProjectRunAuthority.resumeAttempt({
        projectId: project.id,
        attemptId,
        pinned,
        projectLease: lease,
        coordinationRoot,
      });
      expect(authority.store.read()).toMatchObject({
        attemptId,
        lifecycle: "preparing",
        owner: { generation: originalGeneration + 1 },
      });
      await authority.run(() =>
        processRunner.run({
          cwd: root,
          command: `node -e 'process.stderr.write("AFTER_RESTART_CHILD_MARKER"); process.exit(11)'`,
        }),
      );

      const card: TrelloCard = {
        id: cardId,
        name: `Resume ${taskKind}`,
        desc: "Resume the persisted task.",
        idList: project.trello.readyListId,
        idLabels: [
          taskKind === "refinement"
            ? project.trello.refinementLabelId
            : project.trello.featureLabelId,
        ],
        url: `https://trello.test/${cardId}`,
      };
      let cardList = project.trello.readyListId;
      const labels = new Set(card.idLabels);
      const effectStates: Array<RunRecord["lifecycle"]> = [];
      const trello = {
        getCards: async (listId: string) =>
          cardList === listId ? [{ ...card, idList: listId }] : [],
        getCard: async () => ({
          ...card,
          idList: cardList,
          idLabels: [...labels],
        }),
        getCardAttachments: async () => [],
        moveCard: async (_id: string, listId: string) => {
          effectStates.push(authority.store.read()!.lifecycle);
          cardList = listId;
          if (
            taskKind === "refinement" &&
            listId === project.trello.backlogListId
          )
            controller.abort();
          return { ...card, idList: listId, idLabels: [...labels] };
        },
        updateCardContent: async () => undefined,
        addLabel: async (_id: string, label: string) => labels.add(label),
        removeLabel: async (_id: string, label: string) => labels.delete(label),
        addComment: async () => undefined,
      } as unknown as TrelloClient;
      const git = {
        fetch: async () => undefined,
        branchExists: async () => false,
        addWorktreeWithNewBranch: async (_repo: string, worktree: string) => {
          effectStates.push(authority.store.read()!.lifecycle);
          fs.mkdirSync(worktree, { recursive: true });
        },
        getStatus: async () => "",
        getCurrentBranch: async () => `agent/${cardId}`,
        getRebaseState: async () => null,
        getConflictedPaths: async () => [],
      } as unknown as GitClient;
      const openCode = {
        run: async (options: { cwd: string }) => {
          effectStates.push(authority.store.read()!.lifecycle);
          const resultPath = getRefinementResultPath(options.cwd);
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              title: "Clarified task",
              description: "Acceptance criteria clarified.",
              type: "feature",
            }),
          );
          return { exitCode: 0, output: "done", errorOutput: "" };
        },
      } as unknown as OpenCodeClient;
      let setupRuns = 0;
      const commands = {
        run: async () => {
          effectStates.push(authority.store.read()!.lifecycle);
          setupRuns += 1;
          controller.abort();
          return { exitCode: 1, output: "setup failed", errorOutput: "" };
        },
      } as unknown as CommandRunner;
      const controller = new AbortController();
      const safetyStop = setTimeout(() => controller.abort(), 1_000);
      const github = {} as GitHubClient;
      const registry = new RunRegistry(storageRoot, pinned.integrationId, {
        integrationId: pinned.integrationId,
        instanceId: lease.instanceId,
        token: lease.token,
        assertHeld: () => lease.assertHeld(),
      });

      await runOrchestrator(
        trello,
        git,
        github,
        openCode,
        commands,
        config,
        controller.signal,
        undefined,
        undefined,
        new Map([
          [
            project.id,
            { authority, projectLease: lease, pinned, coordinationRoot },
          ],
        ]),
      );
      clearTimeout(safetyStop);

      expect(registry.reconcile()?.attemptId).toBe(attemptId);
      expect(authority.store.read()).toMatchObject(
        taskKind === "refinement"
          ? {
              attemptId,
              lifecycle: "refined",
              terminalSync: "verified",
              expectedTrelloListId: project.trello.backlogListId,
            }
          : { attemptId, lifecycle: "planning" },
      );
      expect(cardList).toBe(
        taskKind === "refinement"
          ? project.trello.backlogListId
          : project.trello.workingListId,
      );
      expect(effectStates.length).toBeGreaterThan(0);
      expect(effectStates.every((state) => state !== "preparing")).toBe(true);
      if (taskKind === "implementation")
        expect(fs.existsSync(path.join(worktreeRoot, cardId))).toBe(true);
      const timelinePath = path.join(
        storageRoot,
        "history",
        encodeURIComponent(project.id),
        encodeURIComponent(cardId),
        encodeURIComponent(attemptId),
        "events.jsonl",
      );
      const timeline = fs
        .readFileSync(timelinePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const processEvents = timeline.filter((event) =>
        String(event.type).startsWith("process-"),
      );
      const stateEvents = timeline.filter(
        (event) => event.type === "attempt-state",
      );
      expect(stateEvents.length).toBeGreaterThan(2);
      expect(
        stateEvents.every(
          (event) =>
            typeof event.revision === "number" &&
            typeof event.ownerGeneration === "number" &&
            typeof event.elapsedMilliseconds === "number" &&
            event.attemptId === attemptId &&
            event.after !== null,
        ),
      ).toBe(true);
      expect(
        stateEvents.some(
          (event) =>
            event.transition ===
            (taskKind === "refinement"
              ? "refinement-claimed"
              : "implementation-claimed"),
        ),
      ).toBe(true);
      expect(processEvents.length).toBeGreaterThanOrEqual(4);
      expect(
        processEvents.every(
          (event, index) =>
            event.type ===
            (index % 2 === 0 ? "process-started" : "process-finished"),
        ),
      ).toBe(true);
      expect(processEvents.some((event) => event.status === "success")).toBe(
        true,
      );
      expect(processEvents.some((event) => event.status === "nonzero")).toBe(
        true,
      );
      expect(JSON.stringify(processEvents)).not.toContain("CHILD_MARKER");
      const referencedStreams = processEvents
        .filter((event) => event.type === "process-finished")
        .flatMap((event) => [event.stdoutArtifact, event.stderrArtifact])
        .filter((artifact): artifact is string => typeof artifact === "string")
        .map((artifact) => fs.readFileSync(artifact, "utf8"));
      expect(referencedStreams.join("\n")).toContain(
        "BEFORE_RESTART_CHILD_MARKER",
      );
      expect(referencedStreams.join("\n")).toContain(
        "AFTER_RESTART_CHILD_MARKER",
      );
      expect(
        timeline.some(
          (event) =>
            event.type === "attempt-state" &&
            event.after !== null &&
            typeof event.after === "object" &&
            "lifecycle" in event.after &&
            event.after.lifecycle ===
              (taskKind === "refinement" ? "refined" : "planning"),
        ),
      ).toBe(true);
      if (taskKind === "implementation") {
        expect(setupRuns).toBe(1);
        expect(
          new TaskExecutionStore(storageRoot, project, authority).read(cardId),
        ).toMatchObject({ phase: "planning", setup: { status: "active" } });
      }
    },
    20_000,
  );

  it.each([false, true])(
    "runs the pending fresh attempt after legacy migration and terminal recovery (integration reconfigured: %s)",
    async (reconfigureIntegration) => {
      root = fs.mkdtempSync(
        path.join(os.tmpdir(), "preparing-legacy-handoff-"),
      );
      const repositoryPath = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      const storageRoot = path.join(root, "runtime");
      const coordinationRoot = path.join(root, "coordination");
      fs.mkdirSync(repositoryPath);
      fs.mkdirSync(worktreeRoot);
      fs.mkdirSync(storageRoot);
      fs.mkdirSync(coordinationRoot);
      provisionCoordinationNamespace(coordinationRoot, "legacy-resume");
      const baseProject = {
        id: "legacy-resume-project",
        autoMerge: false,
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
          setupCommand: "setup",
          validationCommand: "validate",
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
      } satisfies ProjectConfig;
      const initialProject = baseProject;
      const initialConfig = {
        projects: [initialProject],
        workflow: {
          contextRoot: storageRoot,
          coordinationRoot,
          coordinationNamespaceId: "legacy-resume",
          pollIntervalSeconds: 0.001,
          logRetentionDays: 30,
          contextRetentionDays: 30,
        },
      } as Config;
      const setupStartup = (
        config: Config,
        orchestrator: StartupOperations["runOrchestrator"],
      ) => {
        const runGit: RunGit = async (_cwd, args) =>
          args[0] === "remote"
            ? `https://github.com/${config.projects[0]!.repository.github}.git`
            : "true";
        return runStartup(
          config,
          {
            trello: {} as TrelloClient,
            git: new GitClient(runGit),
            github: {} as GitHubClient,
            opencode: {} as OpenCodeClient,
            commands: new CommandRunner(async () => ({
              exitCode: 0,
              output: "",
              errorOutput: "",
            })),
          },
          new AbortController().signal,
          {
            validateToolchain: async () => undefined,
            validateGitHubCli: async () => undefined,
            validateProjectTrello: async () => undefined,
            validateProjectGitHub: async () => undefined,
            runOrchestrator: orchestrator,
          },
        );
      };

      const legacyTask: TaskExecutionRecord = {
        version: 1,
        projectId: initialProject.id,
        cardId: "old-legacy-card",
        phase: "planning",
        operationKey: "old-legacy-operation",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      new TaskExecutionStore(storageRoot, initialProject).create(legacyTask);
      const legacyPath = path.join(
        storageRoot,
        "task-executions",
        initialProject.id,
        `${legacyTask.cardId}.json`,
      );
      const originalLegacyBytes = fs.readFileSync(legacyPath);
      const importedId = legacyAttemptId(legacyTask);
      await setupStartup(initialConfig, async () => undefined);
      const importedRecord = JSON.parse(
        fs.readFileSync(
          path.join(storageRoot, "attempts", `${importedId}.json`),
          "utf8",
        ),
      ) as RunRecord;
      expect(importedRecord).toMatchObject({
        attemptId: importedId,
        lifecycle: "waiting",
        legacy: { sourceManifestHash: expect.any(String) },
      });

      const terminalLease = await acquireProjectOwnership(
        coordinationRoot,
        {
          trelloBoardId: initialProject.trello.boardId,
          githubRepository: initialProject.repository.github,
        },
        "legacy-resume",
      );
      let terminalBytes: Buffer;
      try {
        const store = new RunStore(
          storageRoot,
          importedId,
          importedRecord.pinned,
          {
            integrationId: importedRecord.pinned.integrationId,
            instanceId: terminalLease.instanceId,
            token: terminalLease.token,
            assertHeld: () => terminalLease.assertHeld(),
          },
        );
        let record = store.read()!;
        record = store.takeOwnership(
          record.revision,
          record.owner.generation,
          terminalLease.token,
        );
        record = store.transition(
          record.revision,
          record.owner.generation,
          null,
          "failed",
          "waiting",
          "failed",
          (current) => current,
          {
            prOutcome: "no-pr-failure",
            prObservationId: "legacy-attempt-pr-verified",
            prVerifiedAt: new Date().toISOString(),
            trelloListId: importedRecord.pinned.lists.failed,
            trelloObservationId: "legacy-attempt-trello-verified",
            trelloVerifiedAt: new Date().toISOString(),
          },
        );
        expect(record.terminalSync).toBe("verified");
        await updateProjectActiveAttempt(
          coordinationRoot,
          initialProject.id,
          terminalLease,
          null,
        );
        terminalBytes = fs.readFileSync(
          path.join(storageRoot, "attempts", `${importedId}.json`),
        );
      } finally {
        await terminalLease.release();
      }
      expect(fs.readFileSync(legacyPath)).toEqual(originalLegacyBytes);

      let activeConfig = initialConfig;
      if (reconfigureIntegration) {
        const changedProject = {
          ...baseProject,
          trello: { ...baseProject.trello, boardId: "new-board" },
          repository: { ...baseProject.repository, github: "owner/new-repo" },
        };
        activeConfig = { ...initialConfig, projects: [changedProject] };
        await setupStartup(activeConfig, async () => undefined);
      }
      const activeProject = activeConfig.projects[0]!;
      const handoffLease = await acquireProjectOwnership(
        coordinationRoot,
        {
          trelloBoardId: activeProject.trello.boardId,
          githubRepository: activeProject.repository.github,
        },
        "legacy-resume",
      );
      const freshAttemptId = randomUUID();
      let pinned: RunRecord["pinned"];
      try {
        const pin = (
          await readProjectPinCandidates(coordinationRoot, activeProject.id)
        ).find(
          (candidate) =>
            candidate.integrationId ===
            JSON.stringify({
              trelloBoardId: activeProject.trello.boardId,
              githubRepository: activeProject.repository.github,
            }),
        )!;
        expect(pin.storageRoot).toBe(storageRoot);
        pinned = {
          integrationId: pin.integrationId,
          projectId: activeProject.id,
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
          coordinationRoot,
          activeProject.id,
          handoffLease,
          { attemptId: freshAttemptId, storageRoot },
        );
        const leaseIdentity = {
          integrationId: pin.integrationId,
          instanceId: handoffLease.instanceId,
          token: handoffLease.token,
          assertHeld: () => handoffLease.assertHeld(),
        };
        const candidateStore = new RunStore(
          storageRoot,
          freshAttemptId,
          pinned,
          leaseIdentity,
        );
        candidateStore.create({
          version: 1,
          revision: 1,
          projectId: activeProject.id,
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
          storageRoot,
          pin.integrationId,
          leaseIdentity,
        );
        const previousPointer = registry.read();
        registry.handoff(
          candidateStore,
          previousPointer,
          previousPointer ? previousPointer.generation + 1 : 1,
        );
        const hostPending = (
          await readProjectPinCandidates(coordinationRoot, activeProject.id)
        ).find((candidate) => candidate.integrationId === pin.integrationId)!;
        expect(hostPending).toMatchObject({
          pendingAttempt: { attemptId: freshAttemptId },
          activeAttempt: null,
        });
      } finally {
        await handoffLease.release();
      }
      expect(fs.readFileSync(legacyPath)).toEqual(originalLegacyBytes);
      expect(
        fs.readFileSync(
          path.join(storageRoot, "attempts", `${importedId}.json`),
        ),
      ).toEqual(terminalBytes!);

      const freshCard: TrelloCard = {
        id: "fresh-card-after-legacy-import",
        name: "Fresh implementation",
        desc: "Implement a new task.",
        idList: activeProject.trello.readyListId,
        idLabels: [activeProject.trello.featureLabelId],
        url: "https://trello.test/fresh-card-after-legacy-import",
      };
      let listId = activeProject.trello.readyListId;
      let setupRuns = 0;
      const effects: string[] = [];
      let activeLease: ProjectOwnershipLease | undefined;
      let resumedAuthority: ProjectRunAuthority | undefined;
      const trello = {
        getCards: async (list: string) =>
          listId === list ? [{ ...freshCard, idList: list }] : [],
        getCard: async () => ({ ...freshCard, idList: listId }),
        getCardAttachments: async () => [],
        moveCard: async (_id: string, list: string) => {
          effects.push(
            `trello:${resumedAuthority?.store.read()?.lifecycle}:${registryForFreshAttempt().read()?.attemptId}`,
          );
          listId = list;
          return { ...freshCard, idList: list };
        },
      } as unknown as TrelloClient;
      function registryForFreshAttempt(): RunRegistry {
        const currentLease = activeLease!;
        return new RunRegistry(storageRoot, pinned.integrationId, {
          integrationId: pinned.integrationId,
          instanceId: currentLease.instanceId,
          token: currentLease.token,
          assertHeld: () => currentLease.assertHeld(),
        });
      }
      const controller = new AbortController();
      const safetyStop = setTimeout(() => controller.abort(), 1_000);
      const git = {
        isValidRepository: async () => true,
        assertOriginMatches: async () => undefined,
        fetch: async () => undefined,
        branchExists: async () => false,
        addWorktreeWithNewBranch: async (_repo: string, worktree: string) => {
          effects.push(
            `worktree:${resumedAuthority?.store.read()?.lifecycle}:${registryForFreshAttempt().read()?.attemptId}`,
          );
          fs.mkdirSync(worktree, { recursive: true });
        },
        getStatus: async () => "",
        getCurrentBranch: async () => "agent/fresh-card-after-legacy-import",
        getRebaseState: async () => null,
        getConflictedPaths: async () => [],
        pruneWorktrees: async () => undefined,
      } as unknown as GitClient;
      const commands = new CommandRunner(async () => {
        setupRuns += 1;
        effects.push(
          `setup:${resumedAuthority?.store.read()?.lifecycle}:${registryForFreshAttempt().read()?.attemptId}`,
        );
        controller.abort();
        return { exitCode: 1, output: "setup failed", errorOutput: "" };
      });
      let resumedLease: ProjectOwnershipLease | undefined;
      const resumedState: {
        pointer: ReturnType<RunRegistry["read"]>;
        record: RunRecord | null;
        task: ReturnType<TaskExecutionStore["read"]>;
      } = { pointer: null, record: null, task: null };
      const resumedOps: StartupOperations = {
        validateToolchain: async () => undefined,
        validateGitHubCli: async () => undefined,
        validateProjectTrello: async () => undefined,
        validateProjectGitHub: async () => undefined,
        runOrchestrator: async (...args) => {
          const contexts = args[9] as ReadonlyMap<
            string,
            {
              authority?: ProjectRunAuthority;
              projectLease?: ProjectOwnershipLease;
            }
          >;
          const context = contexts.get(activeProject.id)!;
          resumedAuthority = context.authority;
          resumedLease = context.projectLease;
          activeLease = resumedLease;
          await runOrchestrator(...args);
          resumedState.record = resumedAuthority!.store.read();
          resumedState.task = new TaskExecutionStore(
            storageRoot,
            activeProject,
            resumedAuthority!,
          ).read(freshCard.id);
          resumedState.pointer = new RunRegistry(
            storageRoot,
            pinned.integrationId,
            {
              integrationId: pinned.integrationId,
              instanceId: resumedLease!.instanceId,
              token: resumedLease!.token,
              assertHeld: () => resumedLease!.assertHeld(),
            },
          ).read();
        },
      };
      await runStartup(
        activeConfig,
        {
          trello,
          git,
          github: {} as GitHubClient,
          opencode: {
            run: async () => {
              throw new Error("implementation should stop at setup");
            },
          } as unknown as OpenCodeClient,
          commands,
        },
        controller.signal,
        resumedOps,
      );
      clearTimeout(safetyStop);
      expect(resumedState.pointer?.attemptId).toBe(freshAttemptId);
      expect(resumedState.record).toMatchObject({
        attemptId: freshAttemptId,
        lifecycle: "planning",
        owner: { generation: 2 },
      });
      expect(setupRuns).toBe(1);
      expect(effects.length).toBeGreaterThan(0);
      expect(effects.every((effect) => effect.includes(freshAttemptId))).toBe(
        true,
      );
      expect(effects.every((effect) => !effect.includes(":preparing:"))).toBe(
        true,
      );
      expect(effects.every((effect) => effect.includes(":planning:"))).toBe(
        true,
      );
      expect(listId).toBe(activeProject.trello.workingListId);
      expect(resumedState.task).toMatchObject({
        phase: "planning",
        setup: { status: "active" },
      });
      expect(fs.readFileSync(legacyPath)).toEqual(originalLegacyBytes);
      expect(
        fs.readFileSync(
          path.join(storageRoot, "attempts", `${importedId}.json`),
        ),
      ).toEqual(terminalBytes!);
    },
    20_000,
  );
});
