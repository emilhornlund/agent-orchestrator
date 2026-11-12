import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Config } from "../config/config.js";
import { canonicalizeGitHubRepository } from "../config/config.js";
import { withProjectRegistryLock, type ProjectOwnershipLease } from "./project-ownership.js";

export class ProjectRegistryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistryConflictError";
  }
}

export interface HostProjectPin {
  readonly projectId: string;
  readonly integrationId: string;
  readonly trello: Config["projects"][number]["trello"];
  readonly repository: {
    readonly github: string;
    readonly path: string;
    readonly defaultBranch: string;
    readonly worktreeRoot: string;
  };
  readonly storageRoot: string;
  readonly activeAttempt: {
    readonly attemptId: string;
    readonly storageRoot: string;
  } | null;
  readonly pendingAttempt?: {
    readonly attemptId: string;
    readonly storageRoot: string;
    readonly creation?: "preparing";
  } | null;
}

interface ProjectRegistryRecord {
  readonly version: 1;
  readonly generation: number;
  readonly projects: readonly HostProjectPin[];
  readonly historicalPins?: readonly HostProjectPin[];
}

const registryFile = "projects.registry.json";

function pins(config: Config): HostProjectPin[] {
  return config.projects.map((project) => ({
    projectId: project.id,
    integrationId: JSON.stringify({
      trelloBoardId: project.trello.boardId.trim(),
      githubRepository: canonicalizeGitHubRepository(project.repository.github),
    }),
    trello: project.trello,
    repository: {
      github: canonicalizeGitHubRepository(project.repository.github),
      path: path.resolve(project.repository.path),
      defaultBranch: project.repository.defaultBranch,
      worktreeRoot: path.resolve(project.repository.worktreeRoot),
    },
    storageRoot: path.resolve(config.workflow.contextRoot),
    activeAttempt: null,
  }));
}

const maxRegistryBytes = 4 * 1024 * 1024;
const maxProjects = 500;
const maxText = 4096;

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxText &&
    !/[\0\r\n]/.test(value)
  );
}

function validAbsolutePath(value: unknown): value is string {
  return validText(value) && path.isAbsolute(value) && path.resolve(value) === value;
}

function validateRecord(
  value: unknown,
  file: string,
  allowRepeatedProjectIds = false,
): ProjectRegistryRecord {
  const malformed = (): never => {
    throw new ProjectRegistryConflictError(`Malformed project registry preserved: ${file}`);
  };
  if (typeof value !== "object" || value === null) return malformed();
  const record = value as Partial<ProjectRegistryRecord>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation ?? 0) < 1 ||
    !Array.isArray(record.projects) ||
    record.projects.length > maxProjects
  )
    return malformed();
  const ids = new Set<string>();
  for (const item of record.projects) {
    if (typeof item !== "object" || item === null) return malformed();
    const entry = item as HostProjectPin;
    if (
      !validText(entry.projectId) ||
      !validText(entry.integrationId) ||
      !validAbsolutePath(entry.storageRoot) ||
      !entry.trello ||
      typeof entry.trello !== "object" ||
      !entry.repository ||
      typeof entry.repository !== "object" ||
      !validText(entry.repository.github) ||
      !validAbsolutePath(entry.repository.path) ||
      !validText(entry.repository.defaultBranch) ||
      !validAbsolutePath(entry.repository.worktreeRoot) ||
      (!allowRepeatedProjectIds && ids.has(entry.projectId))
    )
      return malformed();
    ids.add(entry.projectId);
    const trello = entry.trello as unknown as Record<string, unknown>;
    if (Object.values(trello).some((field) => !validText(field))) return malformed();
    if (
      entry.integrationId !==
        JSON.stringify({
          trelloBoardId: entry.trello.boardId.trim(),
          githubRepository: canonicalizeGitHubRepository(entry.repository.github),
        }) ||
      entry.repository.github !== canonicalizeGitHubRepository(entry.repository.github)
    )
      return malformed();
    if (entry.activeAttempt !== null) {
      if (
        !entry.activeAttempt ||
        !validText(entry.activeAttempt.attemptId) ||
        !validAbsolutePath(entry.activeAttempt.storageRoot)
      )
        return malformed();
    }
    if (
      entry.pendingAttempt !== undefined &&
      entry.pendingAttempt !== null &&
      (!validText(entry.pendingAttempt.attemptId) ||
        !validAbsolutePath(entry.pendingAttempt.storageRoot))
    )
      return malformed();
  }
  if (
    record.historicalPins !== undefined &&
    (!Array.isArray(record.historicalPins) || record.historicalPins.length > maxProjects * 10)
  )
    return malformed();
  if (record.historicalPins?.length) {
    validateRecord({ version: 1, generation: 1, projects: record.historicalPins }, file, true);
  }
  return record as ProjectRegistryRecord;
}

function read(file: string): ProjectRegistryRecord | null {
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let value: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > maxRegistryBytes)
        throw new ProjectRegistryConflictError(`Unsafe project registry preserved: ${file}`);
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    return validateRecord(value, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new ProjectRegistryConflictError(`Unsafe project registry preserved: ${file}`);
    throw error;
  }
}

function persist(file: string, record: ProjectRegistryRecord): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function immutablePinIdentity(pin: HostProjectPin): string {
  return JSON.stringify({
    projectId: pin.projectId,
    integrationId: pin.integrationId,
    trello: pin.trello,
    repository: pin.repository,
    storageRoot: pin.storageRoot,
  });
}

/** Pins stable execution identity across aliases and runtime-root changes. */
export async function verifyAndPinProjects(
  config: Config,
  leases: readonly ProjectOwnershipLease[],
): Promise<readonly HostProjectPin[]> {
  const root = config.workflow.coordinationRoot;
  if (!root)
    throw new ProjectRegistryConflictError(
      "coordinationRoot is required for the host project registry",
    );
  const file = path.join(path.resolve(root), registryFile);
  const expected = pins(config);
  const caps = new Map(
    leases.map((lease) => [
      JSON.stringify({
        trelloBoardId: lease.identity.trelloBoardId,
        githubRepository: canonicalizeGitHubRepository(lease.identity.githubRepository),
      }),
      lease,
    ]),
  );
  for (const entry of expected)
    if (!caps.has(entry.integrationId))
      throw new ProjectRegistryConflictError(
        `No matching ownership lease for project "${entry.projectId}"`,
      );
  return withProjectRegistryLock(root, () => {
    const current = read(file);
    const inventory = [...(current?.projects ?? [])];
    const historicalPins = [...(current?.historicalPins ?? [])];
    for (const next of expected) {
      const index = inventory.findIndex((old) => old.projectId === next.projectId);
      const prior = index < 0 ? undefined : inventory[index];
      if (prior?.activeAttempt && immutablePinIdentity(prior) !== immutablePinIdentity(next))
        throw new ProjectRegistryConflictError(
          `Active project "${next.projectId}" cannot be removed, redirected, or relocated`,
        );
      if (prior?.pendingAttempt && immutablePinIdentity(prior) !== immutablePinIdentity(next))
        throw new ProjectRegistryConflictError(
          `Project "${next.projectId}" has an interrupted attempt handoff that must be recovered before configuration changes`,
        );
      if (prior && prior.activeAttempt === null) {
        // Inactive pins may be corrected by a verified new startup snapshot.
      }
      const collision = inventory.find(
        (old) =>
          old.projectId !== next.projectId &&
          (old.activeAttempt !== null ||
            (old.pendingAttempt !== null && old.pendingAttempt !== undefined)) &&
          (old.integrationId === next.integrationId ||
            old.repository.github === next.repository.github ||
            old.trello.boardId === next.trello.boardId),
      );
      if (collision)
        throw new ProjectRegistryConflictError(
          `Project "${next.projectId}" redirects a pinned integration`,
        );
      const replacement = {
        ...next,
        activeAttempt: prior?.activeAttempt ?? null,
        pendingAttempt: prior?.pendingAttempt ?? null,
      };
      if (index < 0) inventory.push(replacement);
      else {
        if (
          prior &&
          JSON.stringify({
            ...prior,
            activeAttempt: null,
            pendingAttempt: null,
          }) !==
            JSON.stringify({
              ...replacement,
              activeAttempt: null,
              pendingAttempt: null,
            })
        )
          historicalPins.push(prior);
        inventory[index] = replacement;
      }
    }
    // Preserve unrelated host inventory. A project absent from this process's
    // configuration is not implicitly owned by this deployment.
    const projects = inventory;
    if (projects.length > maxProjects)
      throw new ProjectRegistryConflictError(
        "Host project registry exceeds the supported project limit",
      );
    persist(file, {
      version: 1,
      generation: (current?.generation ?? 0) + 1,
      projects,
      historicalPins,
    });
    return expected.map((entry) => projects.find((pin) => pin.projectId === entry.projectId)!);
  });
}

export async function updateProjectActiveAttempt(
  coordinationRoot: string,
  projectId: string,
  lease: ProjectOwnershipLease,
  activeAttempt: HostProjectPin["activeAttempt"],
): Promise<void> {
  lease.assertHeld();
  const expectedIntegrationId = JSON.stringify({
    trelloBoardId: lease.identity.trelloBoardId.trim(),
    githubRepository: canonicalizeGitHubRepository(lease.identity.githubRepository),
  });
  const file = path.join(path.resolve(coordinationRoot), registryFile);
  await withProjectRegistryLock(coordinationRoot, () => {
    lease.assertHeld();
    const current = read(file);
    if (!current)
      throw new ProjectRegistryConflictError(
        "Host project pins must exist before publishing an active attempt",
      );
    const index = current.projects.findIndex((entry) => entry.projectId === projectId);
    if (index < 0) throw new ProjectRegistryConflictError(`Project "${projectId}" is not pinned`);
    const prior = current.projects[index]!;
    if (prior.integrationId !== expectedIntegrationId)
      throw new ProjectRegistryConflictError(
        `Lease identity does not authorize project "${projectId}"`,
      );
    if (activeAttempt && activeAttempt.storageRoot !== prior.storageRoot)
      throw new ProjectRegistryConflictError(
        `Active attempt storage must match the pinned storage root for project "${projectId}"`,
      );
    if (
      activeAttempt !== null &&
      prior.activeAttempt !== null &&
      JSON.stringify(prior.activeAttempt) !== JSON.stringify(activeAttempt)
    )
      throw new ProjectRegistryConflictError(
        `Project "${projectId}" already has another active attempt reference`,
      );
    const projects = [...current.projects];
    projects[index] = { ...prior, activeAttempt, pendingAttempt: null };
    persist(file, { ...current, generation: current.generation + 1, projects });
    lease.assertHeld();
  });
}

/** Persist the destination and attempt identity before creating durable run state. */
export async function prepareProjectAttempt(
  coordinationRoot: string,
  projectId: string,
  lease: ProjectOwnershipLease,
  candidate: NonNullable<HostProjectPin["pendingAttempt"]>,
): Promise<void> {
  lease.assertHeld();
  await withProjectRegistryLock(coordinationRoot, () => {
    lease.assertHeld();
    const file = path.join(path.resolve(coordinationRoot), registryFile);
    const current = read(file);
    const index = current?.projects.findIndex((entry) => entry.projectId === projectId) ?? -1;
    if (!current || index < 0)
      throw new ProjectRegistryConflictError(`Project "${projectId}" is not pinned`);
    const prior = current.projects[index]!;
    const identity = JSON.stringify({
      trelloBoardId: lease.identity.trelloBoardId.trim(),
      githubRepository: canonicalizeGitHubRepository(lease.identity.githubRepository),
    });
    if (prior.integrationId !== identity)
      throw new ProjectRegistryConflictError(
        `Lease identity does not authorize project "${projectId}"`,
      );
    if (candidate.storageRoot !== prior.storageRoot)
      throw new ProjectRegistryConflictError(
        `Pending attempt storage must match the pinned storage root for project "${projectId}"`,
      );
    if (prior.activeAttempt && prior.activeAttempt.attemptId !== candidate.attemptId)
      throw new ProjectRegistryConflictError(
        `Project "${projectId}" already has another active attempt`,
      );
    if (prior.pendingAttempt && JSON.stringify(prior.pendingAttempt) !== JSON.stringify(candidate))
      throw new ProjectRegistryConflictError(
        `Project "${projectId}" has another pending attempt handoff`,
      );
    const projects = [...current.projects];
    projects[index] = { ...prior, pendingAttempt: candidate };
    persist(file, { ...current, generation: current.generation + 1, projects });
    lease.assertHeld();
  });
}

/** Historical pins are retained so callers can inspect old attempt stores before reconfiguration. */
export async function readHistoricalProjectPins(
  coordinationRoot: string,
  projectId: string,
): Promise<readonly HostProjectPin[]> {
  return withProjectRegistryLock(coordinationRoot, () => {
    const record = read(path.join(path.resolve(coordinationRoot), registryFile));
    if (!record) return [];
    return (record.historicalPins ?? []).filter((pin) => pin.projectId === projectId);
  });
}

/** Returns current and archived validated pins for safe attempt-store recovery. */
export async function readProjectPinCandidates(
  coordinationRoot: string,
  projectId: string,
): Promise<readonly HostProjectPin[]> {
  return withProjectRegistryLock(coordinationRoot, () => {
    const record = read(path.join(path.resolve(coordinationRoot), registryFile));
    if (!record) return [];
    const current = record.projects.find((pin) => pin.projectId === projectId);
    return [
      ...(current ? [current] : []),
      ...(record.historicalPins ?? []).filter((pin) => pin.projectId === projectId),
    ];
  });
}
