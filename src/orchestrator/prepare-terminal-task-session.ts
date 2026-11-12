import fs from "node:fs";
import { assertTerminalArtifactIsolation } from "../git/terminal-artifact-isolation.js";
import { taskResources } from "../task-session/task-resources.js";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectConfig } from "../config/config.js";
import type { PullRequestState } from "../github/github-client.js";
import type { GitClient } from "../git/git-client.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  recordTerminalPrFence,
  readTerminalPrFence,
  otherTaskWriterIsActive,
  markTerminalWritersStopped,
  terminalStopProofValid,
} from "../task-session/terminal-pr-fence.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { logger } from "../logging/logger.js";
import { isConclusiveOperationResolution } from "../task-session/run-record.js";

function metadata(root: string, file: string): Record<string, unknown> | null {
  try {
    const relative = path.relative(root, file);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      fs.realpathSync(root) !== root
    )
      return null;
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function notDispatched(value: Record<string, unknown>): boolean {
  return (
    value.status === "not-dispatched" ||
    (value.status === "spawn-failure" &&
      value.dispatchState === "not-dispatched" &&
      value.pid === undefined)
  );
}
function stopped(value: Record<string, unknown>): boolean {
  return (
    notDispatched(value) ||
    (value.treeStopped === true &&
      ["success", "nonzero", "timeout", "interrupted"].includes(String(value.status)))
  );
}

/** Establish actual stopped executions before releasing a queue owner or touching
 * terminal Trello/cleanup effects. Absence of PID, group or metadata is not proof. */
export async function prepareTerminalTaskSession(options: {
  project: ProjectConfig;
  taskStore: TaskExecutionStore;
  queue: TaskMutationQueue;
  git: Pick<
    GitClient,
    | "getHeadSha"
    | "getStatus"
    | "getCurrentBranch"
    | "isAncestor"
    | "branchExists"
    | "getCommonGitDirectory"
  >;
  headContinuityVerified?: boolean;
  cardId: string;
  pullRequest: PullRequestState;
}): Promise<{ ready: boolean; preserveArtifacts: boolean }> {
  const { project, taskStore, queue, cardId, pullRequest } = options;
  const task = taskStore.read(cardId);
  if (!task?.pullRequest || task.pullRequest.url !== pullRequest.url)
    throw new Error("Terminal outcome lost its task binding");
  const [owner, repository] = project.repository.github.split("/");
  if (
    pullRequest.state === "OPEN" ||
    !pullRequest.headRefOid ||
    pullRequest.headRefName !== task.expectedBranch ||
    pullRequest.baseRefName !== project.repository.defaultBranch ||
    pullRequest.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase() ||
    pullRequest.headRepository?.name.toLowerCase() !== repository?.toLowerCase() ||
    (pullRequest.state === "MERGED") !== (pullRequest.mergedAt !== null)
  )
    throw new Error("Terminal PR outcome has ambiguous repository or branch identity");
  const authority = ProjectRunAuthority.current(project.id);
  const active = queue.getActive();
  const preserve =
    (active !== null && active.kind !== "terminal-pr") ||
    task.pullRequest.headSha !== pullRequest.headRefOid ||
    ["active", "failed"].includes(task.feedbackRemediation?.status ?? "") ||
    (task.feedbackRemediation?.status === "changed" &&
      !["ci", "human-feedback", "done"].includes(task.phase)) ||
    task.ciRepair?.activePrimaryOperation !== undefined ||
    task.phase === "publication";
  const inspectArtifacts = async () => {
    try {
      const worktree = taskResources(project, cardId).path;
      const owner = ProjectRunAuthority.current(project.id);
      if (owner) {
        const resources = owner.store.read()!.resources;
        if (
          !resources.some(
            (resource) => resource.kind === "worktree" && resource.path === worktree,
          ) ||
          !resources.some(
            (resource) =>
              resource.kind === "branch" &&
              resource.path === `refs/heads/${task.expectedBranch ?? `agent/${cardId}`}`,
          )
        )
          return true;
      }
      const stat = fs.lstatSync(worktree, { throwIfNoEntry: false });
      if (!stat)
        return await options.git.branchExists(
          project.repository.path,
          task.expectedBranch ?? `agent/${cardId}`,
        );
      if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
      if (
        (await options.git.getCurrentBranch(worktree)) !== task.expectedBranch ||
        (await options.git.getStatus(worktree)).trim() !== ""
      )
        return true;
      const head = await options.git.getHeadSha(worktree);
      if (head === task.pullRequest!.headSha && options.headContinuityVerified) return false;
      return (
        head !== pullRequest.headRefOid &&
        !(await options.git.isAncestor(worktree, head, pullRequest.headRefOid!))
      );
    } catch {
      return true;
    }
  };
  if (authority)
    recordTerminalPrFence(authority, task, pullRequest, preserve, project.repository.defaultBranch);
  const fence = readTerminalPrFence(authority);
  const waiting = () => {
    logger
      .child({ projectId: project.id, cardId })
      .info(
        "Human PR outcome retains ownership while execution-stop or dispatched-effect evidence is unresolved",
      );
    return {
      ready: false,
      preserveArtifacts: fence?.preserveArtifacts ?? preserve,
    };
  };
  if (authority && otherTaskWriterIsActive(authority)) return waiting();
  if (
    authority &&
    authority.store
      .read()!
      .pendingOperations.some((entry) => !isConclusiveOperationResolution(entry))
  )
    return waiting();
  if (authority && terminalStopProofValid(authority)) {
    await assertTerminalArtifactIsolation(project, options.git);
    const preserveArtifacts = await inspectArtifacts();
    if (fence!.preserveArtifacts !== preserveArtifacts)
      markTerminalWritersStopped(authority, fence!.proofArtifact!, preserveArtifacts);
    queue.cancelAfterTerminal(cardId);
    return {
      ready: true,
      preserveArtifacts: readTerminalPrFence(authority)!.preserveArtifacts,
    };
  }
  const root = path.resolve(authority?.store.storageRoot ?? getProcessRuntime().artifactRoot);
  let checkedEvidenceRecords = 0;
  const digest = createHash("sha256");
  const checked = (file: string) => {
    checkedEvidenceRecords++;
    digest.update(file).update(createHash("sha256").update(fs.readFileSync(file)).digest());
  };
  if (authority) {
    const directory = path.join(
      root,
      "artifacts",
      encodeURIComponent(project.id),
      encodeURIComponent(cardId),
      encodeURIComponent(authority.store.attemptId),
      "process-executions",
    );
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return waiting();
      for (const id of fs.readdirSync(directory)) {
        const file = path.join(directory, id, "execution.json");
        const value = metadata(root, file);
        if (!value || value.executionId !== id || !stopped(value)) return waiting();
        checked(file);
      }
    }
  }
  const cancellations: { id: string; neverDispatched: boolean }[] = [];
  for (const operation of Object.values(task.primaryOperations ?? {})) {
    if (
      ["completed", "exhausted", "cancelled"].includes(operation.status) ||
      (operation.status === "failed" && operation.retrySafe === true)
    )
      continue;
    if (operation.status === "intent" && operation.executions === 0) {
      cancellations.push({ id: operation.id, neverDispatched: true });
      continue;
    }
    if (!operation.processMetadataPath || !operation.processExecutionId) return waiting();
    const value = metadata(root, operation.processMetadataPath);
    if (
      !value ||
      value.executionId !== operation.processExecutionId ||
      value.cwd !== taskResources(project, cardId).path ||
      typeof value.command !== "string" ||
      !value.command.startsWith("opencode run") ||
      !stopped(value)
    )
      return waiting();
    checked(operation.processMetadataPath);
    cancellations.push({
      id: operation.id,
      neverDispatched: notDispatched(value),
    });
  }
  const preserveArtifacts = await inspectArtifacts();
  if (authority) await assertTerminalArtifactIsolation(project, options.git);
  const proof = authority?.store.writeArtifact(
    Buffer.from(
      JSON.stringify({
        cardId,
        kind: "task-processes-stopped",
        checkedEvidenceRecords,
        digest: digest.digest("hex"),
        cancellations,
      }),
    ),
    "application/json",
  );
  if (authority && proof)
    authority.store.referenceMutationArtifact(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      proof,
    );
  if (cancellations.length > 0 || task.feedbackCardMove !== undefined) {
    const current = taskStore.read(cardId)!;
    const operations = { ...current.primaryOperations };
    for (const cancellation of cancellations) {
      const entry = operations[cancellation.id]!;
      operations[entry.id] = {
        ...entry,
        status: "cancelled",
        executions: cancellation.neverDispatched
          ? Math.max(0, entry.executions - 1)
          : entry.executions,
        retrySafe: false,
        diagnostic: "Human PR outcome cancelled the operation after verified execution stop",
        updatedAt: new Date().toISOString(),
        cancellationEvidence: {
          source: cancellation.neverDispatched ? "never-dispatched" : "stopped-after-dispatch",
          observedAt: new Date().toISOString(),
          pullRequestUrl: pullRequest.url,
          ...(proof ? { proofArtifact: proof.id } : {}),
        },
      };
    }
    taskStore.compareAndSwap(cardId, current.revision, {
      ...current,
      primaryOperations: operations,
      feedbackCardMove: undefined,
      revision: current.revision + 1,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
    });
  }
  if (authority && proof) {
    markTerminalWritersStopped(authority, proof.id, preserveArtifacts);
    queue.cancelAfterTerminal(cardId);
  } else {
    const pending = queue.getActive();
    if (pending && pending.kind !== "terminal-pr") {
      const owner = queue.claimForRecovery(pending.eventId);
      if (!owner) return waiting();
      queue.complete(owner.eventId);
    }
    for (const entry of queue.list())
      if (
        entry.cardId === cardId &&
        entry.status === "queued" &&
        ["feedback", "ci-repair", "pr-maintenance"].includes(entry.kind)
      )
        queue.retireSupersededObservation(entry.eventId);
  }
  return {
    ready: true,
    preserveArtifacts: readTerminalPrFence(authority)?.preserveArtifacts ?? preserveArtifacts,
  };
}
