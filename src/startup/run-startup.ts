import path from "node:path";
import type { Config } from "../config/config.js";
import { canonicalizeGitHubRepository } from "../config/config.js";
import { ensureRepository } from "../git/ensure-repository.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import { GitHubCredentialProvider } from "../github/github-credential-provider.js";
import { withGitHubOperationProject } from "../github/github-operation-context.js";
import { cleanupCardContextRetention } from "../context/card-context-retention.js";
import { cleanupLogRetention } from "../logging/log-retention.js";
import { logger } from "../logging/logger.js";
import type { EmailNotifier } from "../notifications/email-notifier.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  getTrelloRequestOperation,
  isRetryableTrelloError,
  type TrelloClient,
} from "../trello/trello-client.js";
import { validateProjectTrello } from "../trello/validate-project-trello.js";

import { runOrchestrator } from "../orchestrator/run-orchestrator.js";
import { cleanupPersistedStateTemporaryFiles } from "../orchestrator/persisted-state-temporary-files.js";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../coordination/project-ownership.js";
import {
  prepareProjectAttempt,
  readHistoricalProjectPins,
  readProjectPinCandidates,
  type HostProjectPin,
  updateProjectActiveAttempt,
  verifyAndPinProjects,
} from "../coordination/project-registry.js";
import { validateGitAndOpenCode } from "./validate-toolchain.js";
import { ProjectResourceError } from "./project-resource-error.js";
import {
  RunRegistry,
  RunStore,
  type RunStoreLease,
} from "../task-session/run-store.js";
import {
  inventoryLegacyProject,
  legacyAttemptId,
  migrateLegacyProject,
} from "../task-session/legacy-state-import.js";
import {
  isConclusiveOperationResolution,
  type RunRecord,
} from "../task-session/run-record.js";
import {
  ProjectRunAuthority,
  type ProjectRunWorkerContext,
} from "../task-session/project-run-authority.js";

type DeferredTrelloValidation = (
  trello: TrelloClient,
  project: Config["projects"][number],
) => Promise<void>;

export interface StartupDependencies {
  trello: TrelloClient;
  git: GitClient;
  github: GitHubClient;
  opencode: OpenCodeClient;
  commands: CommandRunner;
  githubCredentials?: GitHubCredentialProvider;
  emailNotifier?: EmailNotifier;
}

export interface StartupOperations {
  validateToolchain?: (
    commands: CommandRunner,
    timeoutMilliseconds?: number,
  ) => Promise<void>;
  validateGitHubCli: (
    github: GitHubClient,
    projects: Config["projects"],
  ) => Promise<void>;
  validateProjectTrello: typeof validateProjectTrello;
  validateProjectGitHub?: (
    github: GitHubClient,
    project: Config["projects"][number],
  ) => Promise<void>;
  runOrchestrator: typeof runOrchestrator;
}

const defaultStartupOperations: StartupOperations = {
  validateToolchain: validateGitAndOpenCode,
  validateGitHubCli: (github, projects) =>
    github.validateCliCompatibility(projects),
  validateProjectTrello,
  validateProjectGitHub: (github, project) =>
    github.validateRepositoryAccess(project),
  runOrchestrator,
};

function runBestEffortStartupCleanup(
  operation: string,
  cleanup: () => void,
): void {
  try {
    cleanup();
  } catch (error) {
    try {
      logger.warn(
        `Startup housekeeping cleanup warning during ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Cleanup and logging failures must not prevent independent startup work.
    }
  }
}

export function pinnedIdentityFromHostPin(
  pin: HostProjectPin,
): RunRecord["pinned"] {
  return {
    integrationId: pin.integrationId,
    projectId: pin.projectId,
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
}

export function projectUsingHostPin(
  project: Config["projects"][number],
  pin: HostProjectPin,
): Config["projects"][number] & { contextRoot: string } {
  return {
    ...project,
    trello: pin.trello,
    repository: {
      ...project.repository,
      github: pin.repository.github,
      path: pin.repository.path,
      defaultBranch: pin.repository.defaultBranch,
      worktreeRoot: pin.repository.worktreeRoot,
    },
    contextRoot: pin.storageRoot,
  };
}

function projectMatchesHostPin(
  project: Config["projects"][number],
  pin: HostProjectPin,
  storageRoot: string,
): boolean {
  return (
    pin.projectId === project.id &&
    pin.integrationId ===
      JSON.stringify({
        trelloBoardId: project.trello.boardId.trim(),
        githubRepository: canonicalizeGitHubRepository(
          project.repository.github,
        ),
      }) &&
    JSON.stringify(pin.trello) === JSON.stringify(project.trello) &&
    pin.repository.github ===
      canonicalizeGitHubRepository(project.repository.github) &&
    pin.repository.path === path.resolve(project.repository.path) &&
    pin.repository.defaultBranch === project.repository.defaultBranch &&
    pin.repository.worktreeRoot ===
      path.resolve(project.repository.worktreeRoot) &&
    pin.storageRoot === path.resolve(storageRoot)
  );
}

function isVerifiedTerminal(record: RunRecord): boolean {
  return (
    ["done", "refined", "failed", "cancelled"].includes(record.lifecycle) &&
    record.terminalSync === "verified" &&
    record.terminalEvidence !== null &&
    record.pendingOperations.every(isConclusiveOperationResolution)
  );
}

function runLeaseForPin(
  pin: HostProjectPin,
  lease: ProjectOwnershipLease,
): RunStoreLease {
  const integrationId = JSON.stringify({
    trelloBoardId: lease.identity.trelloBoardId,
    githubRepository: lease.identity.githubRepository,
  });
  if (integrationId !== pin.integrationId)
    throw new Error(
      `Lease identity does not match pinned project ${pin.projectId}`,
    );
  return {
    integrationId,
    instanceId: lease.instanceId,
    token: lease.token,
    assertHeld: () => lease.assertHeld(),
  };
}

export async function reconcilePinnedProjectAttempt(options: {
  config: Config;
  project: Config["projects"][number];
  pin: HostProjectPin;
  lease: ProjectOwnershipLease;
  skipLegacyImport?: boolean;
}): Promise<RunRecord | null> {
  const { config, project, pin, lease } = options;
  const skipLegacyImport =
    options.skipLegacyImport === true ||
    (
      await readHistoricalProjectPins(
        config.workflow.coordinationRoot!,
        project.id,
      )
    ).some(
      (historical) =>
        historical.storageRoot === pin.storageRoot &&
        historical.integrationId !== pin.integrationId,
    );
  const pinned = pinnedIdentityFromHostPin(pin);
  const runLease = runLeaseForPin(pin, lease);
  const registry = new RunRegistry(
    pin.storageRoot,
    pin.integrationId,
    runLease,
  );

  if (pin.pendingAttempt) {
    const candidateStore = new RunStore(
      pin.storageRoot,
      pin.pendingAttempt.attemptId,
      pinned,
      runLease,
    );
    let candidate = candidateStore.read();
    // A durable canonical candidate is authoritative provenance. In particular,
    // ordinary legacy files retained after an earlier import must not be used
    // to identify a newly-created (random-ID) handoff.
    if (candidate && candidate.attemptId !== pin.pendingAttempt.attemptId)
      throw new Error("Pending candidate identity differs from host handoff");
    if (!candidate || typeof candidate.legacy.sourceManifestHash === "string") {
      if (skipLegacyImport) {
        if (!candidate)
          throw new Error(
            `Pending attempt ${pin.pendingAttempt.attemptId} has no durable candidate; preserved for explicit recovery`,
          );
      } else {
        const inventory = inventoryLegacyProject({
          runtimeRoot: pin.storageRoot,
          project: projectUsingHostPin(project, pin),
        });
        if (inventory.blockers.length)
          throw new Error(
            `Pending project attempt cannot be safely inspected: ${inventory.blockers.join("; ")}`,
          );
        const taskSources = inventory.records.filter(
          (source) => source.family === "task-executions",
        );
        if (taskSources.length > 1)
          throw new Error("Pending legacy migration has multiple task sources");
        if (
          taskSources.length === 1 &&
          legacyAttemptId(taskSources[0]!.parsed) !==
            pin.pendingAttempt.attemptId
        )
          throw new Error(
            "Pending attempt identity does not match deterministic legacy migration candidate",
          );
        if (taskSources.length === 1) {
          migrateLegacyProject({
            runtimeRoot: pin.storageRoot,
            project: projectUsingHostPin(project, pin),
            pinned,
            lease: runLease,
            store: new RunStore(
              pin.storageRoot,
              pin.pendingAttempt.attemptId,
              pinned,
              runLease,
            ),
            storeForAttempt: (attemptId) =>
              new RunStore(pin.storageRoot, attemptId, pinned, runLease),
            registry,
          });
        } else if (!candidate) {
          throw new Error(
            `Pending attempt ${pin.pendingAttempt.attemptId} has no durable candidate; preserved for explicit recovery`,
          );
        }
      }
    }
    candidate = candidateStore.read();
    if (!candidate)
      throw new Error(
        `Pending attempt ${pin.pendingAttempt.attemptId} has no durable candidate; preserved for explicit recovery`,
      );
    if (
      candidate.owner.instanceId !== runLease.instanceId ||
      candidate.owner.token !== runLease.token
    )
      candidate = candidateStore.takeOwnership(
        candidate.revision,
        candidate.owner.generation,
        runLease.token,
      );
    const prior = registry.read();
    if (prior?.attemptId !== candidate.attemptId) {
      if (prior) {
        const priorStore = RunStore.openWithPersistedIdentity(
          pin.storageRoot,
          prior.attemptId,
          runLease,
        );
        const priorRecord = priorStore?.read();
        if (
          !priorRecord ||
          !["done", "refined", "failed", "cancelled"].includes(
            priorRecord.lifecycle,
          ) ||
          priorRecord.terminalSync !== "verified"
        )
          throw new Error(
            `Pending attempt cannot replace nonterminal registry owner ${prior.attemptId}`,
          );
        registry.handoff(candidateStore, prior, prior.generation + 1);
      } else {
        registry.handoff(candidateStore, null, 1);
      }
    }
    await updateProjectActiveAttempt(
      config.workflow.coordinationRoot!,
      project.id,
      lease,
      { attemptId: candidate.attemptId, storageRoot: pin.storageRoot },
    );
  } else {
    const existingPointer = registry.read();
    let priorIsTerminal = existingPointer === null;
    if (existingPointer) {
      const priorStore = RunStore.openWithPersistedIdentity(
        pin.storageRoot,
        existingPointer.attemptId,
        runLease,
      );
      const priorRecord = priorStore?.read();
      priorIsTerminal = Boolean(
        priorRecord &&
        ["done", "refined", "failed", "cancelled"].includes(
          priorRecord.lifecycle,
        ) &&
        priorRecord.terminalSync === "verified" &&
        priorRecord.pendingOperations.every(isConclusiveOperationResolution),
      );
      if (!priorRecord)
        throw new Error(
          `Prior attempt ${existingPointer.attemptId} is missing`,
        );
      if (priorIsTerminal && pin.activeAttempt !== null)
        await updateProjectActiveAttempt(
          config.workflow.coordinationRoot!,
          project.id,
          lease,
          null,
        );
    }
    if (skipLegacyImport) {
      // Source files at a shared runtime root may belong to a different pinned
      // integration. Their archived canonical attempt is proof, not authority
      // to import them under the new integration identity.
    } else if (existingPointer && !priorIsTerminal) {
      // The old canonical attempt remains authoritative; do not attempt a
      // legacy import or publish another candidate over it.
    } else {
      if (!existingPointer) {
        const inventory = inventoryLegacyProject({
          runtimeRoot: pin.storageRoot,
          project: projectUsingHostPin(project, pin),
        });
        if (inventory.blockers.length)
          throw new Error(
            `Legacy project migration blocked: ${inventory.blockers.join("; ")}`,
          );
        const taskSources = inventory.records.filter(
          (source) => source.family === "task-executions",
        );
        if (taskSources.length === 1) {
          const attemptId = legacyAttemptId(taskSources[0]!.parsed);
          await prepareProjectAttempt(
            config.workflow.coordinationRoot!,
            project.id,
            lease,
            { attemptId, storageRoot: pin.storageRoot },
          );
        }
      }
      migrateLegacyProject({
        runtimeRoot: pin.storageRoot,
        project: projectUsingHostPin(project, pin),
        pinned,
        lease: runLease,
        store: new RunStore(
          pin.storageRoot,
          `migration-${project.id}`,
          pinned,
          runLease,
        ),
        storeForAttempt: (attemptId) =>
          new RunStore(pin.storageRoot, attemptId, pinned, runLease),
        registry,
      });
    }
  }

  const pointer = registry.reconcile();
  if (!pointer) {
    if (pin.activeAttempt)
      throw new Error(
        `Host registry references active attempt ${pin.activeAttempt.attemptId} without a canonical registry pointer`,
      );
    return null;
  }
  if (pin.activeAttempt && pin.activeAttempt.attemptId !== pointer.attemptId)
    throw new Error(
      `Host active attempt ${pin.activeAttempt.attemptId} differs from canonical pointer ${pointer.attemptId}`,
    );
  const currentStore = RunStore.openWithPersistedIdentity(
    pin.storageRoot,
    pointer.attemptId,
    runLease,
  );
  return currentStore?.read() ?? null;
}

async function assertHistoricalPinsTerminal(
  coordinationRoot: string,
  namespaceId: string,
  pins: readonly HostProjectPin[],
): Promise<void> {
  for (const pin of pins) {
    if (pin.activeAttempt !== null || pin.pendingAttempt)
      throw new Error(
        `Historical pin ${pin.projectId} still has an active or pending attempt; resource reconfiguration is deferred`,
      );
    const lease = await acquireProjectOwnership(
      coordinationRoot,
      {
        trelloBoardId: pin.trello.boardId,
        githubRepository: pin.repository.github,
      },
      namespaceId,
    );
    try {
      const runLease = {
        integrationId: pin.integrationId,
        instanceId: lease.instanceId,
        token: lease.token,
        assertHeld: () => lease.assertHeld(),
      };
      const registry = new RunRegistry(
        pin.storageRoot,
        pin.integrationId,
        runLease,
      );
      const pointer = registry.reconcile();
      if (!pointer) continue;
      const pointedStore = RunStore.openWithPersistedIdentity(
        pin.storageRoot,
        pointer.attemptId,
        runLease,
      );
      const attempt = pointedStore?.read();
      if (
        !attempt ||
        !["done", "refined", "failed", "cancelled"].includes(
          attempt.lifecycle,
        ) ||
        attempt.terminalSync !== "verified" ||
        !attempt.pendingOperations.every(isConclusiveOperationResolution)
      )
        throw new Error(
          `Historical attempt ${pointer.attemptId} is not conclusively terminal; refusing resource relocation`,
        );
    } finally {
      await lease.release();
    }
  }
}

export async function runStartup(
  config: Config,
  dependencies: StartupDependencies,
  signal: AbortSignal,
  operations: StartupOperations = defaultStartupOperations,
): Promise<void> {
  // Ownership precedes even startup housekeeping: cleanup and bootstrap can
  // mutate files used by a task. Hold all configured integrations until every
  // worker has stopped, rather than acquiring ownership after bootstrap.
  const coordinationRoot = config.workflow.coordinationRoot;
  const namespaceId = config.workflow.coordinationNamespaceId;
  if (!coordinationRoot || !namespaceId) {
    throw new Error(
      "A provisioned coordinationRoot and coordinationNamespaceId are required",
    );
  }
  const previousPins = new Map<string, HostProjectPin>();
  for (const project of config.projects) {
    const candidates = await readProjectPinCandidates(
      coordinationRoot,
      project.id,
    );
    const currentPin = candidates[0];
    if (currentPin) previousPins.set(project.id, currentPin);
  }
  const leases: ProjectOwnershipLease[] = [];
  try {
    for (const project of config.projects) {
      const prior = previousPins.get(project.id);
      const identity = prior
        ? {
            trelloBoardId: prior.trello.boardId,
            githubRepository: prior.repository.github,
          }
        : {
            trelloBoardId: project.trello.boardId,
            githubRepository: project.repository.github,
          };
      leases.push(
        await acquireProjectOwnership(coordinationRoot, identity, namespaceId),
      );
    }
    const assertOwnership = (): void =>
      leases.forEach((lease) => lease.assertHeld());
    assertOwnership();
    const validateToolchain = () =>
      (operations.validateToolchain ?? validateGitAndOpenCode)(
        dependencies.commands,
        (config.projects[0]?.opencode.timeoutMinutes ?? 5) * 60_000,
      );
    if (config.projects[0] && leases[0])
      await ProjectRunAuthority.withProjectLease(
        config.projects[0].id,
        () => leases[0]!.assertHeld(),
        (pid) => leases[0]!.markProcessGroupAmbiguous(pid),
        validateToolchain,
      );
    else await validateToolchain();
    assertOwnership();
    await ProjectRunAuthority.withProjectLeases(
      config.projects.map((project, index) => ({
        projectId: project.id,
        assertHeld: () => leases[index]!.assertHeld(),
        markTerminationAmbiguous: (pid) =>
          leases[index]!.markProcessGroupAmbiguous(pid),
      })),
      () => operations.validateGitHubCli(dependencies.github, config.projects),
    );
    assertOwnership();
    const projectRunContexts = new Map<string, ProjectRunWorkerContext>();
    const effectiveProjects: (Config["projects"][number] & {
      contextRoot?: string;
    })[] = [];
    // Reconcile/import durable attempt state while the canonical integration
    // leases are held. This is deliberately before any poll worker can inspect
    // Ready cards or write one of the compatibility projections.
    for (const [index, project] of config.projects.entries()) {
      projectRunContexts.set(project.id, {});
      let runtimeProject: Config["projects"][number] & {
        contextRoot?: string;
      } = project;
      try {
        let lease = leases[index]!;
        lease.assertHeld();
        const priorPin = previousPins.get(project.id);
        let skipLegacyImport = false;
        const configurationMatches =
          priorPin !== undefined &&
          projectMatchesHostPin(project, priorPin, config.workflow.contextRoot);
        let pin = priorPin;
        if (priorPin) runtimeProject = projectUsingHostPin(project, priorPin);
        else {
          pin = (
            await verifyAndPinProjects({ ...config, projects: [project] }, [
              lease,
            ])
          )[0];
        }
        if (!pin) throw new Error(`Missing host project pin for ${project.id}`);
        skipLegacyImport = (
          await readHistoricalProjectPins(coordinationRoot, project.id)
        ).some(
          (historical) =>
            historical.storageRoot === pin!.storageRoot &&
            historical.integrationId !== pin!.integrationId,
        );

        let current = await reconcilePinnedProjectAttempt({
          config,
          project: runtimeProject,
          pin,
          lease,
          skipLegacyImport,
        });
        if (current && !isVerifiedTerminal(current)) {
          await updateProjectActiveAttempt(
            coordinationRoot,
            project.id,
            lease,
            { attemptId: current.attemptId, storageRoot: pin.storageRoot },
          );
          projectRunContexts.set(
            project.id,
            !configurationMatches && priorPin
              ? {
                  projectLease: lease,
                  pinned: current.pinned,
                  coordinationRoot,
                  blockedReason: `Configured resources changed while attempt ${current.attemptId} remains active; keep the original pins and restart after verified terminal completion`,
                }
              : {
                  projectLease: lease,
                  pinned: current.pinned,
                  coordinationRoot,
                  authority: await ProjectRunAuthority.resumeAttempt({
                    projectId: project.id,
                    attemptId: current.attemptId,
                    pinned: current.pinned,
                    projectLease: lease,
                    coordinationRoot,
                  }),
                },
          );
          effectiveProjects.push(runtimeProject);
          continue;
        }

        if (pin.activeAttempt !== null)
          await updateProjectActiveAttempt(
            coordinationRoot,
            project.id,
            lease,
            null,
          );

        if (priorPin && !configurationMatches) {
          await lease.release();
          await assertHistoricalPinsTerminal(
            coordinationRoot,
            namespaceId,
            await readHistoricalProjectPins(coordinationRoot, project.id),
          );
          lease = await acquireProjectOwnership(
            coordinationRoot,
            {
              trelloBoardId: project.trello.boardId,
              githubRepository: project.repository.github,
            },
            namespaceId,
          );
          leases[index] = lease;
          runtimeProject = project;
          pin = (
            await verifyAndPinProjects({ ...config, projects: [project] }, [
              lease,
            ])
          )[0];
          if (!pin)
            throw new Error(
              `Updated host project pin is missing for ${project.id}`,
            );
          current = await reconcilePinnedProjectAttempt({
            config,
            project: runtimeProject,
            pin,
            lease,
            skipLegacyImport:
              skipLegacyImport ||
              (priorPin.storageRoot === pin.storageRoot &&
                priorPin.integrationId !== pin.integrationId),
          });
          if (current && !isVerifiedTerminal(current)) {
            await updateProjectActiveAttempt(
              coordinationRoot,
              project.id,
              lease,
              { attemptId: current.attemptId, storageRoot: pin.storageRoot },
            );
            projectRunContexts.set(project.id, {
              projectLease: lease,
              pinned: current.pinned,
              coordinationRoot,
              authority: await ProjectRunAuthority.resumeAttempt({
                projectId: project.id,
                attemptId: current.attemptId,
                pinned: current.pinned,
                projectLease: lease,
                coordinationRoot,
              }),
            });
          }
        } else if (priorPin) {
          await verifyAndPinProjects(
            {
              ...config,
              projects: [runtimeProject],
              workflow: { ...config.workflow, contextRoot: pin.storageRoot },
            },
            [lease],
          );
        }
        projectRunContexts.set(project.id, {
          ...projectRunContexts.get(project.id),
          projectLease: lease,
          pinned:
            current && !isVerifiedTerminal(current)
              ? current.pinned
              : pinnedIdentityFromHostPin(pin),
          coordinationRoot,
        });
        effectiveProjects.push(runtimeProject);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        projectRunContexts.set(project.id, {
          ...projectRunContexts.get(project.id),
          blockedReason: reason,
        });
        logger
          .child({ projectId: project.id })
          .error(
            `Canonical attempt reconciliation failed; isolating this project while other projects continue: ${reason}`,
          );
        effectiveProjects.push(runtimeProject);
      }
    }
    runBestEffortStartupCleanup("log retention", () =>
      cleanupLogRetention(
        config.workflow.logRetentionDays,
        new Date(),
        [
          ...new Set([
            config.workflow.contextRoot,
            ...[...previousPins.values()].map((pin) => pin.storageRoot),
          ]),
        ],
        [...projectRunContexts.values()]
          .flatMap((context) =>
            context.pinned
              ? [context.authority?.store.read()?.attemptId ?? ""]
              : [],
          )
          .filter(Boolean),
      ),
    );
    runBestEffortStartupCleanup("card context retention", () =>
      cleanupCardContextRetention(
        config.workflow.contextRoot,
        config.workflow.contextRetentionDays,
        new Date(),
        config.projects.map((project) => project.id),
      ),
    );
    runBestEffortStartupCleanup("persisted-state temporary files", () =>
      cleanupPersistedStateTemporaryFiles(
        config.projects,
        config.workflow.contextRoot,
      ),
    );

    const githubCredentials =
      dependencies.githubCredentials ?? new GitHubCredentialProvider();

    const leaseByProjectId = new Map(
      config.projects.map((project, index) => [project.id, leases[index]!]),
    );
    const pendingProjectValidations = new Set<string>();
    for (const project of effectiveProjects) {
      if (signal.aborted) {
        return;
      }

      const lease = leaseByProjectId.get(project.id)!;
      lease.assertHeld();

      try {
        await withGitHubOperationProject(project, () =>
          ProjectRunAuthority.withProjectLease(
            project.id,
            () => lease.assertHeld(),
            (pid) => lease.markProcessGroupAmbiguous(pid),
            async () => {
              await ensureRepository(
                dependencies.git,
                dependencies.commands,
                project,
                githubCredentials,
              );
              await (
                operations.validateProjectGitHub ??
                defaultStartupOperations.validateProjectGitHub!
              )(dependencies.github, project);
            },
          ),
        );
        await ProjectRunAuthority.withProjectLease(
          project.id,
          () => lease.assertHeld(),
          (pid) => lease.markProcessGroupAmbiguous(pid),
          () => operations.validateProjectTrello(dependencies.trello, project),
        );
      } catch (error) {
        if (
          error instanceof ProjectResourceError &&
          error.disposition === "invalid"
        )
          throw error;
        if (
          !(error instanceof ProjectResourceError) &&
          !isRetryableTrelloError(error)
        ) {
          throw error;
        }

        pendingProjectValidations.add(project.id);

        logger
          .child({ projectId: project.id })
          .warn(
            `Startup project resource validation is blocked for ${error instanceof ProjectResourceError ? error.disposition : (getTrelloRequestOperation(error) ?? "Trello resource")}; this project will retry validation before processing: ${error instanceof Error ? error.message : String(error)}`,
          );

        continue;
      }

      logger.child({ projectId: project.id }).event("Project resources: OK");
    }

    if (signal.aborted) {
      return;
    }
    assertOwnership();

    const deferredTrelloValidation: DeferredTrelloValidation | undefined =
      pendingProjectValidations.size === 0
        ? undefined
        : async (trello, project) => {
            if (!pendingProjectValidations.has(project.id)) {
              return;
            }

            const lease = leaseByProjectId.get(project.id);
            if (!lease)
              throw new Error(`No project lease exists for ${project.id}`);
            await withGitHubOperationProject(project, () =>
              ProjectRunAuthority.withProjectLease(
                project.id,
                () => lease.assertHeld(),
                (pid) => lease.markProcessGroupAmbiguous(pid),
                async () => {
                  await ensureRepository(
                    dependencies.git,
                    dependencies.commands,
                    project,
                    githubCredentials,
                  );
                  await (
                    operations.validateProjectGitHub ??
                    defaultStartupOperations.validateProjectGitHub!
                  )(dependencies.github, project);
                },
              ),
            );
            await ProjectRunAuthority.withProjectLease(
              project.id,
              () => lease.assertHeld(),
              (pid) => lease.markProcessGroupAmbiguous(pid),
              () => operations.validateProjectTrello(trello, project),
            );
            pendingProjectValidations.delete(project.id);
            logger
              .child({ projectId: project.id })
              .event("Trello configuration: OK");
          };

    const runtimeConfig = { ...config, projects: effectiveProjects };

    if (dependencies.emailNotifier === undefined) {
      if (deferredTrelloValidation === undefined) {
        await operations.runOrchestrator(
          dependencies.trello,
          dependencies.git,
          dependencies.github,
          dependencies.opencode,
          dependencies.commands,
          runtimeConfig,
          signal,
          undefined,
          undefined,
          projectRunContexts,
        );
      } else {
        await operations.runOrchestrator(
          dependencies.trello,
          dependencies.git,
          dependencies.github,
          dependencies.opencode,
          dependencies.commands,
          runtimeConfig,
          signal,
          undefined,
          deferredTrelloValidation,
          projectRunContexts,
        );
      }
    } else {
      if (deferredTrelloValidation === undefined) {
        await operations.runOrchestrator(
          dependencies.trello,
          dependencies.git,
          dependencies.github,
          dependencies.opencode,
          dependencies.commands,
          runtimeConfig,
          signal,
          dependencies.emailNotifier,
          undefined,
          projectRunContexts,
        );
      } else {
        await operations.runOrchestrator(
          dependencies.trello,
          dependencies.git,
          dependencies.github,
          dependencies.opencode,
          dependencies.commands,
          runtimeConfig,
          signal,
          dependencies.emailNotifier,
          deferredTrelloValidation,
          projectRunContexts,
        );
      }
    }
  } finally {
    await Promise.all(leases.reverse().map((lease) => lease.release()));
  }
}
