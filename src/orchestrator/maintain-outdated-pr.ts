import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import fs from "node:fs";
import { taskResources } from "../task-session/task-resources.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrMaintenanceOperation } from "../task-session/pr-maintenance-operation.js";
import { captureSetupEffects } from "../process/run-setup.js";
import {
  setupFileIdentity,
  type SetupInventory,
} from "../process/setup-commit-scope.js";
import { getTaskSessionSourceSnapshotIdentity } from "../task-session/source-snapshot.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { recordTerminalPrFence } from "../task-session/terminal-pr-fence.js";
import { getSessionLogPath } from "../logging/session-log.js";
import { presentExternalDiagnostic } from "../security/bounded-diagnostic.js";
import { refreshPrAutomationOutcome } from "./refresh-pr-automation-outcome.js";
import type { ManagedPullRequestStatus } from "../github/pull-request-status.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import type { TaskSessionValidationResult } from "../task-session/run-task-session-validation.js";
import type { PrMaintenanceStore } from "../task-session/pr-maintenance-store.js";
import type { TaskExecutionRecord } from "../task-session/task-execution-record.js";
import type { TaskExecutionStore } from "../task-session/task-execution-store.js";
import type { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import type { CommandRunner } from "../process/command-runner.js";

export interface MaintainOutdatedPrOptions {
  project: ProjectConfig;
  card: TrelloCard;
  task: TaskExecutionRecord;
  worktreePath: string;
  git: GitClient;
  github: Pick<
    GitHubClient,
    | "findPullRequestState"
    | "getBaseBranchHeadSha"
    | "findChangesRequestedPullRequest"
    | "getPullRequestConversationComments"
    | "ensurePullRequestDraft"
    | "getPullRequestDescription"
    | "editPullRequestDescription"
    | "updatePullRequestDescriptionStatus"
  >;
  commands: CommandRunner;
  mutationQueue: TaskMutationQueue;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  signal: AbortSignal;
  requirementIds: readonly string[];
  eligible: boolean;
  hasRequestedChanges: boolean;
  hasUnresolvedFeedback: boolean;
  review: (input: {
    contentIdentity: string;
    preparedHead: string;
    baseHead: string;
    requirementIds: readonly string[];
    validation: TaskSessionValidationResult;
    coverage: TaskSessionValidationResult | null;
    signal: AbortSignal;
  }) => Promise<ImplementationReviewResult>;
  remediateConflict?: (input: {
    conflictedPaths: readonly string[];
    merge: { originalHead: string; targetHead: string };
    operationId: string;
    attempt: number;
    signal: AbortSignal;
  }) => Promise<void>;
}

type MaintenanceResult = "deferred" | "completed" | "blocked" | "terminal";

async function activity(
  options: MaintainOutdatedPrOptions,
  status: ManagedPullRequestStatus | null,
): Promise<void> {
  await options.github.updatePullRequestDescriptionStatus({
    cwd: options.project.repository.path,
    repository: options.project.repository.github,
    pullRequestUrl: options.task.pullRequest!.url,
    project: options.project,
    status,
  });
}

async function reportBlocked(
  options: MaintainOutdatedPrOptions,
  diagnostic: string,
): Promise<"blocked"> {
  await refreshPrAutomationOutcome({
    github: options.github,
    project: options.project,
    card: options.card,
    pullRequestUrl: options.task.pullRequest!.url,
    headSha: options.task.pullRequest!.headSha!,
    draft: true,
    facts: [
      diagnostic,
      "Published history, unshipped commits, merge state and dirty output are preserved; no safe update is claimed.",
    ],
  });
  await activity(options, null);
  return "blocked";
}

async function inventory(
  options: MaintainOutdatedPrOptions,
): Promise<SetupInventory> {
  // This JSON is produced by our own inventory, not an external response.
  return JSON.parse(
    (await captureSetupEffects(options.git, options.worktreePath)).toString(
      "utf8",
    ),
  ) as SetupInventory;
}

function files(inventory: SetupInventory): Map<string, string> {
  return new Map(
    inventory.files.map((file) => [file.path, setupFileIdentity(file)]),
  );
}

async function checkPreserved(
  options: MaintainOutdatedPrOptions,
  operation: PrMaintenanceOperation,
): Promise<void> {
  const current = files(await inventory(options));
  for (const file of operation.localPreparation?.preservedFiles ?? [])
    if ((current.get(file.path) ?? "absent") !== file.identity)
      throw new Error(
        "Preserved dirty setup or untracked output changed during maintenance; retaining all state",
      );
}

async function checkConflictPreservation(
  options: MaintainOutdatedPrOptions,
  operation: PrMaintenanceOperation,
  kind: "merge" | "conflict" = "conflict",
): Promise<boolean> {
  const baseline =
    kind === "merge"
      ? operation.localPreparation?.mergeBaseline
      : operation.localPreparation?.conflictBaseline;
  if (!baseline) return false;
  const allowed =
    (kind === "merge"
      ? operation.localPreparation?.mergeAllowedPaths
      : operation.localPreparation?.conflictedPaths) ?? [];
  const saved = z
    .strictObject({
      files: z.array(z.tuple([z.string(), z.string()])),
      index: z.string(),
    })
    .parse(
      options.taskStore.readPrimaryResultArtifact({
        bytes: baseline.bytes,
        ...(baseline.path === undefined ? {} : { path: baseline.path }),
        reference: baseline.reference as `sha256:${string}`,
      }),
    );
  const before = new Map(saved.files),
    after = files(await inventory(options));
  for (const file of new Set([...before.keys(), ...after.keys()]))
    if (!allowed.includes(file) && before.get(file) !== after.get(file))
      throw new Error(
        "Conflict assistance changed a non-conflict path; preserving work without publication",
      );
  const unrelated = (entries: string) =>
    entries
      .split("\0")
      .filter(
        (entry) =>
          entry && !allowed.includes(entry.slice(entry.indexOf("\t") + 1)),
      )
      .sort();
  if (
    JSON.stringify(unrelated(saved.index)) !==
    JSON.stringify(
      unrelated(await options.git.getIndexEntries(options.worktreePath)),
    )
  )
    throw new Error(
      "Conflict assistance changed the non-conflict index; preserving work",
    );
  return allowed.some((file) => before.get(file) !== after.get(file));
}

async function observeOpen(
  options: MaintainOutdatedPrOptions,
  allowedHeads: readonly string[],
): Promise<boolean> {
  options.signal.throwIfAborted();
  const pr = await options.github.findPullRequestState({
    cwd: options.worktreePath,
    repository: options.project.repository.github,
    headBranch: taskResources(options.project, options.card.id).branch,
    baseBranch: options.project.repository.defaultBranch,
    project: options.project,
  });
  if (!pr || pr.url !== options.task.pullRequest?.url)
    throw new Error("Maintenance PR identity cannot be established");
  if (pr.state !== "OPEN") {
    const authority = ProjectRunAuthority.current(options.project.id);
    if (authority)
      recordTerminalPrFence(
        authority,
        options.task,
        pr,
        true,
        options.project.repository.defaultBranch,
      );
    await activity(options, null);
    return false;
  }
  if (
    !pr.headRefOid ||
    !allowedHeads.includes(pr.headRefOid) ||
    pr.headRefName !== taskResources(options.project, options.card.id).branch ||
    pr.baseRefName !== options.project.repository.defaultBranch
  )
    throw new Error(
      "Maintenance PR branch, base or published head changed; preserving local work",
    );
  const [owner, repository] = options.project.repository.github.split("/");
  if (
    pr.headRepository?.name.toLowerCase() !== repository?.toLowerCase() ||
    pr.headRepositoryOwner?.login.toLowerCase() !== owner?.toLowerCase()
  )
    throw new Error("Maintenance PR repository ownership changed");
  return true;
}

async function verifyQuality(
  options: MaintainOutdatedPrOptions,
  operation: PrMaintenanceOperation,
): Promise<void> {
  const preparedHead = operation.localPreparation!.resultingHead!;
  const contentIdentity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  const previous = operation.qualityVerification;
  if (
    previous?.contentIdentity === contentIdentity &&
    previous.preparedHead === preparedHead &&
    previous.status !== "running"
  )
    return;
  const attempts =
    previous?.contentIdentity === contentIdentity
      ? (previous.attempts ?? 0)
      : 0;
  const startedAt = new Date().toISOString();
  const record = (
    update: Partial<NonNullable<PrMaintenanceOperation["qualityVerification"]>>,
  ) =>
    options.maintenanceStore.recordQualityVerification(
      operation.operationId,
      operation,
      {
        status: "uncertain",
        preparedHead,
        contentIdentity,
        startedAt,
        attempts: Math.min(attempts + 1, 3),
        ...update,
      },
    );
  if (attempts >= 3) {
    record({
      diagnostic: "Maintenance advisory execution allowance exhausted",
      completedAt: new Date().toISOString(),
    });
    return;
  }
  record({ status: "running" });
  const run = async (
    command: string | undefined,
    label: string,
  ): Promise<TaskSessionValidationResult> => {
    const startedAt = new Date().toISOString();
    const common = { command: command ?? "", startedAt, contentIdentity };
    if (!command)
      return {
        ...common,
        completedAt: startedAt,
        status: "skipped",
        exitCode: null,
        timedOut: false,
        aborted: false,
        diagnostic: "Not configured",
      };
    try {
      const result = await options.commands.run({
        cwd: options.worktreePath,
        command,
        timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
        signal: options.signal,
        sessionLogPath: getSessionLogPath(options.project.id, options.card.id),
        sessionLabel: label,
        captureOutput: true,
      });
      return {
        ...common,
        completedAt: new Date().toISOString(),
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        timedOut: false,
        aborted: false,
        diagnostic: presentExternalDiagnostic(
          [result.output, result.errorOutput].filter(Boolean).join("\n"),
        ),
      };
    } catch (error) {
      options.signal.throwIfAborted();
      return {
        ...common,
        completedAt: new Date().toISOString(),
        status: "uncertain",
        exitCode: null,
        timedOut: false,
        aborted: false,
        diagnostic: presentExternalDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  };
  const validation = await run(
    options.project.repository.validationCommand,
    "PR maintenance validation",
  );
  const coverage =
    options.project.repository.coverageCommand === undefined
      ? null
      : await run(
          options.project.repository.coverageCommand,
          "PR maintenance coverage",
        );
  let review: ImplementationReviewResult | null = null;
  let diagnostic: string | undefined;
  try {
    review = await options.review({
      contentIdentity,
      preparedHead,
      baseHead: operation.targetBaseHead,
      requirementIds: options.requirementIds,
      validation,
      coverage,
      signal: options.signal,
    });
  } catch (error) {
    options.signal.throwIfAborted();
    diagnostic = presentExternalDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    (await options.git.getHeadSha(options.worktreePath)) !== preparedHead ||
    (await getTaskSessionSourceSnapshotIdentity(
      options.git,
      options.worktreePath,
    )) !== contentIdentity
  )
    throw new Error(
      "Maintenance source changed during advisory checks; preserving work without publication",
    );
  const passed =
    validation.status === "passed" &&
    (coverage === null || coverage.status === "passed") &&
    review?.reviewedContentIdentity === contentIdentity &&
    review.verdict === "pass";
  record({
    status: passed ? "passed" : "uncertain",
    validation,
    coverage,
    review,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    completedAt: new Date().toISOString(),
  });
}

/** Additive maintenance owns one queue writer and never reinterprets legacy rebase intents. */
export async function maintainOutdatedPr(
  options: MaintainOutdatedPrOptions,
): Promise<MaintenanceResult> {
  const {
    project,
    card,
    git,
    maintenanceStore: store,
    mutationQueue: queue,
    worktreePath,
  } = options;
  const existing = store
    .inspect()
    .find((item) => !["completed", "cancelled"].includes(item.status));
  if (existing && existing.strategy !== "merge") return "deferred";
  const currentTask = options.taskStore.read(card.id);
  const unresolvedWriter = Object.values(
    currentTask?.primaryOperations ?? {},
  ).some(
    (entry) =>
      entry !== undefined &&
      entry.id !== existing?.localPreparation?.conflictOperationId &&
      (["intent", "dispatched", "ambiguous"].includes(entry.status) ||
        (entry.status === "failed" && entry.retrySafe !== true)),
  );
  if (unresolvedWriter)
    throw new Error("Maintenance is fenced by an unresolved primary writer");
  if (
    !existing &&
    (!options.eligible ||
      options.hasRequestedChanges ||
      options.hasUnresolvedFeedback)
  )
    return "deferred";
  const expected = options.task.pullRequest?.headSha;
  if (
    !expected ||
    options.task.projectId !== project.id ||
    options.task.cardId !== card.id ||
    options.task.expectedBranch !== taskResources(project, card.id).branch
  )
    throw new Error("Maintenance task ownership is ambiguous");
  if (
    path.resolve(worktreePath) !==
      path.join(path.resolve(project.repository.worktreeRoot), card.id) ||
    fs.lstatSync(worktreePath).isSymbolicLink() ||
    fs.realpathSync(worktreePath) ===
      fs.realpathSync(project.repository.path) ||
    (await git.getCommonGitDirectory(worktreePath)) !==
      (await git.getCommonGitDirectory(project.repository.path)) ||
    (await git.getCurrentBranch(worktreePath)) !==
      taskResources(project, card.id).branch
  )
    throw new Error(
      "Maintenance requires the owned isolated task worktree and branch",
    );
  if (await git.getRebaseState(worktreePath))
    return reportBlocked(
      options,
      "An existing rebase prevents additive maintenance; legacy state is not rewritten or discarded.",
    );
  let operation = existing;
  const eventId = `pr-maintenance:${card.id}:${existing?.expectedRemoteHead ?? expected}`;
  queue.enqueue({
    projectId: project.id,
    cardId: card.id,
    eventId,
    operationKey: eventId,
    kind: "pr-maintenance",
    enqueuedAt: options.task.updatedAt,
  });
  if (!queue.claimForRecovery(eventId)) return "deferred";
  try {
    if (
      !(await observeOpen(options, [
        expected,
        ...(operation?.localPreparation?.resultingHead
          ? [operation.localPreparation.resultingHead]
          : []),
      ]))
    )
      return "terminal";
    await activity(options, "synchronizing-target");
    if (!operation) {
      const local = await git.getHeadSha(worktreePath);
      if (
        local !== expected ||
        (await git.getMergeHead(worktreePath)) !== null ||
        (await git.getDiff(worktreePath, true)).trim()
      ) {
        const result = await reportBlocked(
          options,
          "Unattributed local commits, staged output or an existing merge prevent safe automatic publication.",
        );
        return result;
      }
      const target = await options.github.getBaseBranchHeadSha({
        cwd: worktreePath,
        repository: project.repository.github,
        baseBranch: project.repository.defaultBranch,
        project,
      });
      const now = new Date().toISOString();
      operation = store.create({
        strategy: "merge",
        projectId: project.id,
        cardId: card.id,
        pullRequest: {
          number: options.task.pullRequest!.number,
          url: options.task.pullRequest!.url,
        },
        expectedRemoteHead: expected,
        targetBaseHead: target,
        operationId: randomUUID(),
        conflictMaxAttempts: project.opencode.remediation.maxPasses,
        createdAt: now,
        updatedAt: now,
      });
    }
    operation =
      operation.status === "prepared"
        ? store.advance(operation.operationId, "prepared", "active", operation)
        : store.claimForRecovery(operation.operationId, operation);
    const progress = (
      update: Partial<NonNullable<PrMaintenanceOperation["localPreparation"]>>,
    ) => {
      operation = store.recordLocalPreparation(
        operation!.operationId,
        operation!,
        {
          originalHead: operation!.expectedRemoteHead,
          status: "fetching-base",
          ...operation!.localPreparation,
          ...update,
          updatedAt: new Date().toISOString(),
        },
      );
    };
    if (!operation.localPreparation) progress({ status: "fetching-base" });
    if (operation.localPreparation!.status === "fetching-base") {
      await git.fetch(
        worktreePath,
        "origin",
        project.repository.defaultBranch,
        project,
      );
      if (
        (await git.resolveCommitSha(worktreePath, "FETCH_HEAD")) !==
        operation.targetBaseHead
      )
        await git.fetch(
          worktreePath,
          "origin",
          operation.targetBaseHead,
          project,
        );
      if (
        (await git.resolveCommitSha(worktreePath, "FETCH_HEAD")) !==
        operation.targetBaseHead
      )
        throw new Error("Pinned target commit is not available after fetch");
      if ((await git.getDiff(worktreePath, true)).trim())
        throw new Error(
          "Unattributed staged work appeared before merge preparation; preserving it for recovery",
        );
      const current = await inventory(options);
      const currentFiles = files(current);
      const mergeBaseline = options.taskStore.writePrimaryResultArtifact(
        `${operation.operationId}:merge-baseline`,
        {
          files: [...currentFiles],
          index: await git.getIndexEntries(worktreePath),
        },
      );
      progress({
        status: "base-fetched",
        baseHead: operation.targetBaseHead,
        mergeBaseline,
        mergeAllowedPaths: await git.getTargetMergePaths(
          worktreePath,
          operation.targetBaseHead,
        ),
        preservedFiles: current.committable.map((file) => ({
          path: file,
          identity: currentFiles.get(file) ?? "absent",
        })),
      });
    }
    if (operation.localPreparation!.status === "base-fetched")
      progress({
        status: "backing-up",
        backupRef: `refs/orchestrator/maintenance/${operation.operationId}`,
      });
    if (operation.localPreparation!.status === "backing-up") {
      const backup = operation.localPreparation!.backupRef!;
      const found = await git.getRefSha(worktreePath, backup);
      if (found === null)
        await git.createRefIfAbsent(
          worktreePath,
          backup,
          operation.localPreparation!.originalHead,
        );
      else if (found !== operation.localPreparation!.originalHead)
        throw new Error("Maintenance backup ref changed");
      progress({ status: "merging" });
    }
    if (
      ["merging", "conflicted"].includes(operation.localPreparation!.status)
    ) {
      if (
        !operation.localPreparation!.mergeBaseline ||
        operation.localPreparation!.mergeAllowedPaths === undefined
      )
        throw new Error(
          "Interrupted merge lacks its pre-dispatch preservation baseline; retain work for reconciliation",
        );
      await checkConflictPreservation(options, operation, "merge");
      await checkPreserved(options, operation);
      const head = await git.getHeadSha(worktreePath);
      let mergeHead = await git.getMergeHead(worktreePath);
      if (
        head === operation.localPreparation!.originalHead &&
        mergeHead === null
      ) {
        if ((await git.getDiff(worktreePath, true)).trim())
          throw new Error(
            "Unattributed staged work before merge; preserving it without publication",
          );
        if (!(await observeOpen(options, [operation.expectedRemoteHead])))
          return "terminal";
        try {
          await git.mergeTarget(
            worktreePath,
            operation.targetBaseHead,
            project.repository.gitIdentity,
          );
        } catch (error) {
          if (
            (await git.getMergeHead(worktreePath)) !== operation.targetBaseHead
          )
            throw error;
        }
        mergeHead = await git.getMergeHead(worktreePath);
      }
      if (mergeHead !== null) {
        if (
          mergeHead !== operation.targetBaseHead ||
          (await git.getHeadSha(worktreePath)) !==
            operation.localPreparation!.originalHead
        )
          throw new Error("Interrupted merge provenance changed");
        let conflicts = await git.getConflictedPaths(worktreePath);
        if (conflicts.length > 0) {
          const baseline =
            operation.localPreparation!.conflictBaseline ??
            options.taskStore.writePrimaryResultArtifact(
              `${operation.operationId}:conflict-baseline`,
              {
                files: [...files(await inventory(options))],
                index: await git.getIndexEntries(worktreePath),
              },
            );
          progress({
            status: "conflicted",
            conflictedPaths:
              operation.localPreparation!.conflictedPaths ?? conflicts,
            conflictBaseline: baseline,
          });
          if (
            !options.remediateConflict ||
            operation.localPreparation!.conflictStopped === true ||
            (!operation.localPreparation!.conflictOperationId &&
              (operation.conflictRemediationAttempts ?? 0) >=
                (operation.conflictMaxAttempts ??
                  project.opencode.remediation.maxPasses))
          ) {
            store.advance(
              operation.operationId,
              "active",
              "uncertain",
              operation,
            );
            queue.releaseForRecovery(eventId);
            return reportBlocked(
              options,
              "Automatic conflict assistance ended at its bound or made no useful changes. Conflicts remain unresolved for recovery.",
            );
          }
          if (!(await observeOpen(options, [operation.expectedRemoteHead])))
            return "terminal";
          await activity(options, "resolving-conflicts");
          if (!operation.localPreparation!.conflictOperationId) {
            operation = store.recordConflictRemediationAttempt(
              operation.operationId,
              operation,
              baseline,
            );
          }
          await options.remediateConflict({
            conflictedPaths: conflicts,
            merge: {
              originalHead: operation.localPreparation!.originalHead,
              targetHead: operation.targetBaseHead,
            },
            operationId: operation.localPreparation!.conflictOperationId!,
            attempt: operation.conflictRemediationAttempts!,
            signal: options.signal,
          });
          if (!(await checkConflictPreservation(options, operation))) {
            progress({ conflictStopped: true });
            return reportBlocked(
              options,
              "Conflict assistance made no repository changes; unchanged conflict markers were not staged or published.",
            );
          }
          if (
            (await git.getHeadSha(worktreePath)) !==
              operation.localPreparation!.originalHead ||
            (await git.getMergeHead(worktreePath)) !== operation.targetBaseHead
          )
            throw new Error("Conflict assistance changed merge ownership");
          await git.stagePaths(worktreePath, conflicts);
          conflicts = await git.getConflictedPaths(worktreePath);
          if (conflicts.length > 0)
            throw new Error(
              "Merge conflicts remain; preserving recoverable merge",
            );
        }
        await checkPreserved(options, operation);
        await checkConflictPreservation(options, operation);
        await checkConflictPreservation(options, operation, "merge");
        if (!(await observeOpen(options, [operation.expectedRemoteHead])))
          return "terminal";
        progress({ mergeTree: await git.getIndexTreeSha(worktreePath) });
        await git.completeTargetMerge(
          worktreePath,
          project.repository.gitIdentity,
        );
      }
      const resultingHead = await git.getHeadSha(worktreePath);
      if (
        !(await git.isAncestor(
          worktreePath,
          operation.expectedRemoteHead,
          resultingHead,
        )) ||
        !(await git.isAncestor(
          worktreePath,
          operation.targetBaseHead,
          resultingHead,
        ))
      )
        throw new Error(
          "Prepared merge does not preserve published and target ancestry",
        );
      if (resultingHead !== operation.localPreparation!.originalHead) {
        const parents = await git.getCommitParentShas(worktreePath);
        if (
          parents.length !== 2 ||
          parents[0] !== operation.localPreparation!.originalHead ||
          parents[1] !== operation.targetBaseHead ||
          operation.localPreparation!.mergeTree === undefined ||
          (await git.getCommitTreeSha(worktreePath)) !==
            operation.localPreparation!.mergeTree
        )
          throw new Error(
            "Interrupted merge commit cannot be attributed to the saved intent",
          );
      }
      progress({ status: "prepared", resultingHead });
    }
    await checkPreserved(options, operation);
    await activity(options, "validating-pr-changes");
    await verifyQuality(options, operation);
    operation = store.inspect(operation.operationId)!;
    const resultingHead = operation.localPreparation!.resultingHead!;
    if (
      !(await observeOpen(options, [
        operation.expectedRemoteHead,
        resultingHead,
      ]))
    )
      return "terminal";
    const remote = await git.getRemoteBranchSha(
      worktreePath,
      "origin",
      taskResources(project, card.id).branch,
      project,
    );
    if (remote !== resultingHead) {
      if (operation.publication?.status === "push-intended")
        throw new Error(
          "Maintenance push outcome remains uncertain; do not redispatch",
        );
      if (remote !== operation.expectedRemoteHead)
        throw new Error(
          "Remote changed before maintenance push; no branch resurrection or overwrite",
        );
      await options.github.ensurePullRequestDraft({
        cwd: project.repository.path,
        repository: project.repository.github,
        pullRequestUrl: operation.pullRequest.url,
        project,
      });
      await activity(options, "updating-remote");
      if (!(await observeOpen(options, [operation.expectedRemoteHead])))
        return "terminal";
      operation = store.recordPublication(
        operation.operationId,
        operation,
        "push-intended",
        resultingHead,
      );
      try {
        await git.push(
          worktreePath,
          "origin",
          taskResources(project, card.id).branch,
          project,
          resultingHead,
        );
      } catch (error) {
        if (
          !(await observeOpen(options, [
            operation.expectedRemoteHead,
            resultingHead,
          ]))
        )
          return "terminal";
        if (
          (await git.getRemoteBranchSha(
            worktreePath,
            "origin",
            taskResources(project, card.id).branch,
            project,
          )) !== resultingHead
        )
          throw error;
      }
    }
    if (!(await observeOpen(options, [resultingHead]))) return "terminal";
    if (
      (await git.getRemoteBranchSha(
        worktreePath,
        "origin",
        taskResources(project, card.id).branch,
        project,
      )) !== resultingHead
    )
      throw new Error("Maintenance remote publication remains uncertain");
    operation = store.recordPublication(
      operation.operationId,
      operation,
      "verified",
      resultingHead,
    );
    await refreshPrAutomationOutcome({
      github: options.github,
      project,
      card,
      pullRequestUrl: operation.pullRequest.url,
      headSha: resultingHead,
      draft: true,
      facts: [
        `Merged target ${operation.targetBaseHead} additively into published task head ${operation.expectedRemoteHead}; published commit identities are unchanged.`,
        `Current committed task paths: ${await git.getChangedFiles(worktreePath, operation.targetBaseHead)}`,
        `Maintenance validation, coverage and independent review: ${JSON.stringify(operation.qualityVerification)}`,
        "CI for this revision has not yet been verified; the existing PR remains draft pending observation.",
      ],
    });
    const task = options.taskStore.read(card.id);
    if (
      !task ||
      task.operationKey !== options.task.operationKey ||
      task.pullRequest?.url !== operation.pullRequest.url
    )
      throw new Error("Maintenance task changed before publication checkpoint");
    if (task.pullRequest.headSha !== resultingHead)
      options.taskStore.compareAndSwap(card.id, task.revision, {
        ...task,
        pullRequest: { ...task.pullRequest, headSha: resultingHead },
        reviewObservation: undefined,
        revision: task.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(task.updatedAt) + 1),
        ).toISOString(),
      });
    await activity(options, null);
    store.advance(operation.operationId, "active", "completed", operation);
    queue.complete(eventId);
    return "completed";
  } catch (error) {
    if (operation && store.inspect(operation.operationId)?.status === "active")
      store.advance(operation.operationId, "active", "uncertain", operation);
    if (queue.ownsActive(eventId)) queue.releaseForRecovery(eventId);
    const unresolved = Object.values(
      options.taskStore.read(card.id)?.primaryOperations ?? {},
    ).some(
      (entry) =>
        entry && ["intent", "dispatched", "ambiguous"].includes(entry.status),
    );
    try {
      await activity(options, unresolved ? "automation-recovery" : null);
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        "Maintenance failed and activity reconciliation remains pending",
        { cause: statusError },
      );
    }
    throw error;
  } finally {
    if (operation && store.inspect(operation.operationId)?.status === "active")
      store.advance(operation.operationId, "active", "uncertain", operation);
    if (queue.ownsActive(eventId)) queue.releaseForRecovery(eventId);
  }
}

/** Legacy prepared operations are never automatically requeued. */
export function requeueInterruptedPreparedPrMaintenance(_options: {
  project: ProjectConfig;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
}): boolean {
  void _options;
  return false;
}

/** Status labels do not prove unshipped rewritten commits are disposable. */
export function retireFailedUnpublishedPrMaintenance(_options: {
  project: ProjectConfig;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
}): void {
  void _options;
}

/** Keep publication intents and ambiguous effects untouched for operator reconciliation. */
export async function reconcileInterruptedPrMaintenance(_options: {
  project: ProjectConfig;
  taskStore: TaskExecutionStore;
  maintenanceStore: PrMaintenanceStore;
  mutationQueue: TaskMutationQueue;
  github: Pick<GitHubClient, "findPullRequestState">;
}): Promise<void> {
  for (const operation of _options.maintenanceStore.inspect()) {
    if (
      operation.strategy !== "merge" ||
      ["completed", "cancelled"].includes(operation.status) ||
      operation.publication === undefined
    )
      continue;
    const task = _options.taskStore.read(operation.cardId);
    if (
      !task?.pullRequest ||
      task.pullRequest.url !== operation.pullRequest.url
    )
      continue;
    const pr = await _options.github.findPullRequestState({
      cwd: _options.project.repository.path,
      repository: _options.project.repository.github,
      headBranch: taskResources(_options.project, operation.cardId).branch,
      baseBranch: _options.project.repository.defaultBranch,
      project: _options.project,
    });
    if (
      pr?.state === "OPEN" &&
      pr.url === operation.pullRequest.url &&
      pr.headRefOid === operation.publication.resultingHead &&
      pr.headRefName ===
        taskResources(_options.project, operation.cardId).branch &&
      pr.baseRefName === _options.project.repository.defaultBranch &&
      task.pullRequest.headSha === operation.expectedRemoteHead
    ) {
      _options.taskStore.compareAndSwap(task.cardId, task.revision, {
        ...task,
        pullRequest: {
          ...task.pullRequest,
          headSha: operation.publication.resultingHead,
        },
        reviewObservation: undefined,
        revision: task.revision + 1,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(task.updatedAt) + 1),
        ).toISOString(),
      });
    }
  }
}
