import type { Config, ProjectConfig } from "../config/config.js";
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
import {
  projectUsingHostPin,
  reconcilePinnedProjectAttempt,
} from "../startup/run-startup.js";

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
): Promise<ProjectRunOperatorContext> {
  const coordinationRoot = config.workflow.coordinationRoot;
  const namespaceId = config.workflow.coordinationNamespaceId;
  if (!coordinationRoot || !namespaceId)
    throw new Error(
      "Operator recovery requires the configured host coordination namespace",
    );
  const lease = await acquireProjectOwnership(
    coordinationRoot,
    {
      trelloBoardId: project.trello.boardId,
      githubRepository: project.repository.github,
    },
    namespaceId,
  );
  try {
    const candidates = await readProjectPinCandidates(
      coordinationRoot,
      project.id,
    );
    let pin: HostProjectPin | undefined = candidates[0];
    let effectiveProject = project;
    if (pin?.activeAttempt || pin?.pendingAttempt) {
      effectiveProject = projectUsingHostPin(project, pin);
    } else {
      pin = (
        await verifyAndPinProjects({ ...config, projects: [project] }, [lease])
      ).find((candidate) => candidate.projectId === project.id);
    }
    if (!pin) throw new Error(`No host project pin exists for ${project.id}`);
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
