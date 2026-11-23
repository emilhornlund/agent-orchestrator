import type { Config, ProjectConfig } from "../config/config.js";
import path from "node:path";
import { canonicalizeGitHubRepository } from "../config/config.js";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../coordination/project-ownership.js";
import {
  readProjectPinCandidates,
  verifyAndPinProjects,
  type HostProjectPin,
} from "../coordination/project-registry.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { RunRegistry, RunStore } from "../task-session/run-store.js";
import { projectUsingHostPin, reconcilePinnedProjectAttempt } from "../startup/run-startup.js";

export interface ProjectRunOperatorContext {
  readonly lease: ProjectOwnershipLease;
  readonly authority: ProjectRunAuthority;
  run<T>(operation: () => T): T;
  release(): Promise<void>;
}

/** Obtain the same host lease, registry pin, migration result, and attempt
 * authority as a service worker before any operator command may mutate state. */
export async function acquireProjectRunOperatorContext(
  config: Config,
  project: ProjectConfig,
  inspectionOnly = false,
): Promise<ProjectRunOperatorContext> {
  const coordinationRoot = config.workflow.coordinationRoot;
  const namespaceId = config.workflow.coordinationNamespaceId;
  if (!coordinationRoot || !namespaceId)
    throw new Error("Operator recovery requires the configured host coordination namespace");
  const lease = await acquireProjectOwnership(
    coordinationRoot,
    {
      trelloBoardId: project.trello.boardId,
      githubRepository: project.repository.github,
    },
    namespaceId,
  );
  try {
    const candidates = await readProjectPinCandidates(coordinationRoot, project.id);
    let pin: HostProjectPin | undefined = candidates[0];
    let effectiveProject = project;
    if (pin?.activeAttempt || pin?.pendingAttempt) {
      if (
        JSON.stringify(project.trello) !== JSON.stringify(pin.trello) ||
        canonicalizeGitHubRepository(project.repository.github) !== pin.repository.github ||
        path.resolve(project.repository.path) !== pin.repository.path ||
        project.repository.defaultBranch !== pin.repository.defaultBranch ||
        path.resolve(project.repository.worktreeRoot) !== pin.repository.worktreeRoot ||
        path.resolve(config.workflow.contextRoot) !== pin.storageRoot
      ) {
        throw new Error(
          `Project ${project.id} configuration is incompatible with its active host pin; operator recovery made no changes`,
        );
      }
      effectiveProject = projectUsingHostPin(project, pin);
    } else {
      if (inspectionOnly)
        throw new Error("No pinned canonical attempt is available for inspection");
      pin = (await verifyAndPinProjects({ ...config, projects: [project] }, [lease])).find(
        (candidate) => candidate.projectId === project.id,
      );
    }
    if (!pin) throw new Error(`No host project pin exists for ${project.id}`);
    if (inspectionOnly) {
      if (!pin.activeAttempt || pin.pendingAttempt)
        throw new Error("Project attempt handoff is not settled");
      const integrationId = JSON.stringify({
        trelloBoardId: lease.identity.trelloBoardId,
        githubRepository: lease.identity.githubRepository,
      });
      const readerLease = {
        integrationId,
        instanceId: lease.instanceId,
        token: lease.token,
        assertHeld: () => lease.assertHeld(),
      };
      const pointer = new RunRegistry(pin.storageRoot, integrationId, readerLease).reconcile();
      if (!pointer || pointer.attemptId !== pin.activeAttempt.attemptId)
        throw new Error("Pinned and canonical attempt identities differ; inspection refused");
      const previous = RunStore.openWithPersistedIdentity(
        pin.storageRoot,
        pointer.attemptId,
        readerLease,
      )?.read();
      if (
        !previous ||
        previous.projectId !== project.id ||
        previous.pinned.boardId !== project.trello.boardId ||
        previous.pinned.repository !== project.repository.github ||
        previous.pinned.repositoryPath !== project.repository.path ||
        previous.pinned.worktreeRoot !== project.repository.worktreeRoot
      )
        throw new Error(
          "Canonical attempt pins do not match the configured project; inspection refused",
        );
      const store = new RunStore(pin.storageRoot, pointer.attemptId, previous.pinned, {
        ...readerLease,
        instanceId: previous.owner.instanceId,
        token: previous.owner.token,
      });
      const authority = new ProjectRunAuthority(
        project.id,
        store,
        previous.owner.generation,
        undefined,
        (pid) => lease.markProcessGroupAmbiguous(pid),
        previous.cardId,
      );
      return {
        lease,
        authority,
        run: (operation) => authority.run(operation),
        release: () => lease.release(),
      };
    }
    const effectiveConfig = {
      ...config,
      projects: [effectiveProject],
      workflow: { ...config.workflow, contextRoot: pin.storageRoot },
    };
    const attempt = await reconcilePinnedProjectAttempt({
      config: effectiveConfig,
      project: effectiveProject,
      pin,
      lease,
    });
    if (!attempt)
      throw new Error(
        `Project ${project.id} has no canonical attempt to recover; operator command made no changes`,
      );
    const authority = await ProjectRunAuthority.resumeAttempt({
      projectId: project.id,
      attemptId: attempt.attemptId,
      pinned: attempt.pinned,
      projectLease: lease,
      coordinationRoot,
    });
    return {
      lease,
      authority,
      run: (operation) => authority.run(operation),
      release: () => lease.release(),
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
}
