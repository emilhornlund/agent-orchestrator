import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import { prepareVerbatimCommitMessage } from "../git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
} from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import type {
  MutationEvent,
  MutationIntent,
} from "../task-session/durable-mutation.js";
import { mutationProvenNotDelivered } from "../task-session/durable-mutation.js";
import { ProcessExecutionError } from "../process/process-runtime.js";
import { TrelloRequestError } from "../trello/trello-client.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { transitionTaskExecutionRecord } from "../task-session/task-execution-transition.js";
import {
  readPendingCommitState,
  writeTrustedCommitState,
} from "./trusted-commit-state.js";
import type { PublishCardOptions } from "./publish-card.js";
import { prepareInitialPublicationBody } from "./publish-card.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import { getElapsedWorkflowTime } from "./workflow-duration.js";
import { getTaskSessionSourceSnapshotIdentity } from "../task-session/source-snapshot.js";
import { assertOwnedTaskWorktreePath } from "../task-session/run-task-session-implementation.js";
import { logger } from "../logging/logger.js";
import {
  notifyAttentionRequired,
  notifyHumanReview,
  type EmailNotifier,
} from "../notifications/email-notifier.js";

// A publication checkpoint is an immutable, sanitized dispatch payload, not a
// second authority. It lives inside the fenced RunStore compatibility envelope.
const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu);
const nonBlank = z.string().refine((value) => value.trim().length > 0);
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  cardId: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: nonBlank,
  title: nonBlank,
  cardUrl: z.string(),
  cardDescription: z.string(),
  body: nonBlank,
  draft: z.boolean(),
  reviewResult: z.string(),
  remediationResult: z.string(),
  message: nonBlank.optional(),
  commitSha: gitSha.optional(),
  executionId: z.string().nullable(),
  executionGeneration: z.number().int().nonnegative().safe(),
  retryAt: z.string().datetime().nullable(),
  attention: z.boolean(),
  completed: z.boolean(),
  startedAt: z.string().datetime(),
  attentionNotified: z.boolean(),
  waitingReason: z.enum(["recheck", "dependency-or-conflict"]).nullable(),
  diagnostic: z.string().max(2000).nullable(),
  descriptionPending: z.boolean(),
  verifiedFacts: z.array(z.string()),
  sourceIdentity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  elapsedWorkflowTime: z.string().nullable().optional(),
  gitDestinations: z
    .strictObject({ fetch: nonBlank, push: nonBlank })
    .optional(),
  commitCleanup: z.literal("verbatim").optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
const key = "initial-publication-v1";
export const PUBLICATION_RECHECK_MS = 15_000;
export class PublicationWaitingError extends Error {
  constructor() {
    super("Initial publication is awaiting controlled reconciliation");
  }
}
/** Only orchestrator-authored reasons may enter structured diagnostics. */
class PublicationSafetyError extends Error {}
/** Raised only by the local guard before invoking a concrete transport writer. */
class PublicationNotSentError extends PublicationSafetyError {}

function authorityFor(project: ProjectConfig): ProjectRunAuthority {
  const authority = ProjectRunAuthority.current(project.id);
  if (!authority)
    throw new Error("Initial publication requires durable attempt authority");
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (
    run.pinned.repository !== project.repository.github ||
    run.pinned.boardId !== project.trello.boardId ||
    run.pinned.repositoryPath !== project.repository.path ||
    run.pinned.worktreeRoot !== project.repository.worktreeRoot ||
    run.pinned.lists.review !== project.trello.reviewListId ||
    run.pinned.lists.working !== project.trello.workingListId ||
    run.pinned.lists.ready !== project.trello.readyListId ||
    run.pinned.lists.backlog !== project.trello.backlogListId ||
    run.pinned.lists.done !== project.trello.doneListId ||
    run.pinned.lists.failed !== project.trello.failedListId ||
    ("contextRoot" in project && project.contextRoot !== run.pinned.storageRoot)
  )
    throw new Error("Publication configuration differs from attempt pins");
  return authority;
}

function save(authority: ProjectRunAuthority, checkpoint: Checkpoint): void {
  authority.mutate(
    key,
    null,
    () => ({ value: checkpoint, result: undefined }),
    checkpointSchema.parse,
  );
}

/** Begins only at a verified publication boundary. Never fabricate this for an
 * already uncertain legacy write. Payloads are sanitized BEFORE hashing/saving. */
export function beginInitialPublication(
  options:
    | PublishCardOptions
    | (Omit<PublishCardOptions, "commitSha"> & { commitMessage: string }),
  body: string,
  sourceIdentity: string,
): void {
  const { project, card, branch } = options;
  const authority = authorityFor(project);
  const run = authority.store.read()!;
  if (
    run.cardId !== card.id ||
    branch !== `agent/${card.id}` ||
    options.worktreePath !== path.join(run.pinned.worktreeRoot, card.id) ||
    run.lifecycle !== "publication"
  )
    throw new Error("Initial publication ownership/checkpoint mismatch");
  if (authority.read(key, checkpointSchema.parse)) return;
  if ("commitSha" in options)
    throw new Error(
      "Legacy initial publication has no durable dispatch provenance; preserve the trusted commit and reconcile explicitly",
    );
  if (
    readPendingCommitState(project, card.id) !== null ||
    run.pendingOperations.some(
      (entry) =>
        !entry.mutation &&
        (!["completed", "failed", "cancelled"].includes(entry.status) ||
          ["github-pr-create", "git-commit", "git-push"].includes(entry.kind)),
    )
  )
    throw new Error(
      "Legacy uncertain publication must be preserved for reconciliation",
    );
  save(authority, {
    version: 1,
    cardId: card.id,
    branch,
    baseBranch: project.repository.defaultBranch,
    title: sanitizeControlledText(card.name),
    body: sanitizeControlledText(body),
    cardUrl: sanitizeControlledText(card.url),
    cardDescription: sanitizeControlledText(card.desc),
    reviewResult: sanitizeControlledText(options.reviewResult),
    remediationResult: sanitizeControlledText(options.remediationResult),
    draft:
      options.exhaustedReview !== undefined ||
      options.reviewResult !== "Passed",
    message: prepareVerbatimCommitMessage(
      sanitizeControlledText(options.commitMessage),
    ),
    commitCleanup: "verbatim",
    executionId: run.operation.id,
    executionGeneration: run.operation.generation,
    retryAt: null,
    attention: false,
    completed: false,
    startedAt: new Date().toISOString(),
    attentionNotified: false,
    waitingReason: null,
    diagnostic: null,
    descriptionPending:
      "commitMessage" in options && options.opencode !== undefined,
    verifiedFacts: (options.verifiedDescriptionFacts?.() ?? []).map(
      sanitizeControlledText,
    ),
    sourceIdentity,
  });
}

/** Concrete publication reconciler. One send at most after a possible acceptance;
 * negative observations never establish non-delivery. Read failures are unknown,
 * not absent. Each pass is bounded; normal project polling supplies the clock. */
export async function resumeInitialPublication(options: {
  project: ProjectConfig;
  git: GitClient;
  github: GitHubClient;
  trello: TrelloClient;
  signal?: AbortSignal;
  emailNotifier?: EmailNotifier;
  opencode?: OpenCodeClient;
}): Promise<boolean> {
  const authority = ProjectRunAuthority.current(options.project.id);
  if (!authority) return false;
  let checkpoint = authority.read(key, checkpointSchema.parse);
  if (!checkpoint || checkpoint.completed) return false;
  authorityFor(options.project);
  if (checkpoint.baseBranch !== options.project.repository.defaultBranch)
    throw new Error(
      "Publication base branch differs from the original checkpoint",
    );
  if (checkpoint.retryAt && Date.now() < Date.parse(checkpoint.retryAt))
    return true;
  const { project, git, github, trello } = options;
  const run = authority.store.read()!;
  // Crash after the atomic task transition but before queue/checkpoint closure.
  // No external write is repeated; all workflow mutations must already have
  // immutable verification before the final local handoff can be completed.
  if (
    run.lifecycle === "ci" &&
    run.cardId === checkpoint.cardId &&
    run.operation.id === checkpoint.executionId &&
    ["push", "pr", "move", "comment"].every((name) =>
      run.pendingOperations.some(
        (entry) =>
          entry.id === `initial:${name}` && entry.status === "completed",
      ),
    )
  ) {
    const actual = await git.resolvePublicationDestinations(
      path.join(run.pinned.worktreeRoot, checkpoint.cardId),
      run.pinned.repository,
    );
    if (
      !checkpoint.gitDestinations ||
      actual.fetch !== checkpoint.gitDestinations.fetch ||
      actual.push !== checkpoint.gitDestinations.push
    )
      throw new Error(
        "Publication Git destination changed before local recovery handoff",
      );
    const queue = new TaskMutationQueue(
      run.pinned.storageRoot,
      options.project,
    );
    const active = queue.getActive();
    if (active) {
      if (
        active.cardId !== checkpoint.cardId ||
        active.operationKey !== checkpoint.executionId
      )
        throw new Error("Publication queue identity mismatch");
      if (
        !queue.ownsActive(active.eventId) &&
        !queue.claimForRecovery(active.eventId)
      )
        return true;
      queue.complete(active.eventId);
    }
    save(authority, {
      ...checkpoint,
      completed: true,
      retryAt: null,
      waitingReason: null,
      diagnostic: null,
    });
    return true;
  }
  if (
    run.lifecycle !== "publication" ||
    run.cardId !== checkpoint.cardId ||
    run.operation.id !== checkpoint.executionId ||
    run.operation.generation !== checkpoint.executionGeneration
  )
    throw new Error(
      "Publication checkpoint execution was superseded; preserve for reconciliation",
    );
  const publicationQueue = new TaskMutationQueue(
    run.pinned.storageRoot,
    options.project,
  );
  const publicationEvent = publicationQueue.getActive();
  if (
    !publicationEvent ||
    publicationEvent.cardId !== checkpoint.cardId ||
    publicationEvent.operationKey !== checkpoint.executionId
  )
    throw new Error("Publication checkpoint has no matching queue owner");
  if (!publicationQueue.claimForRecovery(publicationEvent.eventId)) return true;
  const cwd = path.join(run.pinned.worktreeRoot, checkpoint.cardId);
  const now = () => new Date().toISOString();
  const next = () =>
    new Date(Date.now() + PUBLICATION_RECHECK_MS).toISOString();
  const assertExecution = () => {
    const current = authority.store.assertCurrentLease(
      authority.ownerGeneration,
    );
    if (
      current.lifecycle !== "publication" ||
      current.operation.id !== checkpoint!.executionId ||
      current.operation.generation !== checkpoint!.executionGeneration
    )
      throw new PublicationSafetyError(
        "Publication execution changed during reconciliation",
      );
  };
  const artifact = (value: unknown): string => {
    const artifact = authority.store.writeArtifact(
      Buffer.from(JSON.stringify(value)),
      "application/json",
    );
    authority.store.referenceMutationArtifact(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      artifact,
    );
    return artifact.id;
  };
  const entry = (id: string) =>
    authority.store.read()!.pendingOperations.find((entry) => entry.id === id);
  const event = (id: string, event: MutationEvent) => {
    const current = authority.store.read()!;
    authority.store.recordMutationEvent(
      current.revision,
      authority.ownerGeneration,
      id,
      entry(id)!.generation,
      event,
      now(),
    );
  };
  const evidence = (id: string, fields: unknown) => ({
    observationId: `${id}:${Date.now()}:${authority.store.read()!.revision}`,
    observedAt: now(),
    artifactId: artifact(fields),
  });
  const step = async (
    name: string,
    kind: MutationIntent["kind"],
    target: string,
    payload: unknown,
    observe: () => Promise<{ id: string; fields: unknown } | null>,
    send: () => Promise<unknown>,
  ): Promise<void> => {
    const id = `initial:${name}`;
    const payloadId = artifact(payload);
    authority.store.persistMutationIntent(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      id,
      { kind, target, correlationId: `${run.attemptId}:${name}`, payloadId },
      now(),
    );
    const operation = entry(id)!;
    if (!operation.mutation)
      throw new PublicationSafetyError("Legacy mutation cannot be resent");
    if (operation.status === "completed") return;
    if (
      operation.mutation.nextRecheckAt &&
      Date.now() < Date.parse(operation.mutation.nextRecheckAt)
    )
      throw new PublicationWaitingError();
    // Never dispatch if an authoritative prerequisite read is unavailable.
    let actual: { id: string; fields: unknown } | null;
    try {
      actual = await observe();
    } catch (error) {
      if (
        operation.mutation.dispatches.length &&
        !mutationProvenNotDelivered(operation.mutation)
      )
        event(id, {
          type: "observe",
          outcome: "uncertain",
          evidence: evidence(id, {
            read: "unavailable or conflicting; not absence",
          }),
          nextRecheckAt: next(),
          attentionRequired: true,
        });
      throw error;
    }
    if (
      operation.mutation.dispatches.length === 0 ||
      mutationProvenNotDelivered(operation.mutation)
    ) {
      // Discovery without dispatch cannot invent a completion. Existing PRs or
      // refs lacking this attempt's intent require explicit legacy reconciliation.
      if (actual)
        throw new PublicationSafetyError(
          `Unjournaled existing ${name}; provenance requires reconciliation`,
        );
      event(id, { type: "dispatch", nextRecheckAt: next() });
      try {
        await authority.dispatch(send);
        event(id, {
          type: "response",
          outcome: "accepted",
          evidence: evidence(id, { response: "accepted; readback required" }),
        });
      } catch (error) {
        authority.assertHeld();
        const proof =
          error instanceof PublicationNotSentError ||
          (error instanceof ProcessExecutionError &&
            error.classification === "spawn-failure")
            ? ("transport-proven-not-sent" as const)
            : error instanceof TrelloRequestError &&
                (kind === "trello-move" || kind === "trello-comment") &&
                error.status !== undefined &&
                [400, 401, 403, 404, 405, 422].includes(error.status)
              ? ("provider-rejected-before-acceptance" as const)
              : undefined;
        event(id, {
          type: "response",
          outcome: proof ? "not-delivered" : "unknown",
          evidence: {
            ...evidence(id, {
              response: proof
                ? "conclusive rejection before acceptance"
                : "unknown; diagnostics in process artifacts",
              ...(error instanceof PublicationNotSentError
                ? {
                    reason:
                      "destination guard rejected before Git push invocation",
                  }
                : {}),
              ...(proof && error instanceof ProcessExecutionError
                ? {
                    executionId: error.executionId,
                    classification: error.classification,
                  }
                : {}),
              ...(proof && error instanceof TrelloRequestError
                ? { operation: error.operation, status: error.status }
                : {}),
            }),
            ...(proof ? { nonDeliveryProof: proof } : {}),
          },
        });
        if (options.signal?.aborted) throw error;
      }
      throw new PublicationWaitingError();
    }
    event(id, {
      type: "observe",
      outcome: actual ? "verified" : "absent",
      evidence: evidence(
        id,
        actual?.fields ?? { observed: "absent; not non-delivery" },
      ),
      ...(actual ? { resourceId: actual.id } : { nextRecheckAt: next() }),
      attentionRequired: !actual,
    });
    if (!actual) throw new PublicationWaitingError();
  };
  try {
    if (options.signal?.aborted) throw new PublicationWaitingError();
    if (checkpoint.commitCleanup !== "verbatim")
      throw new PublicationSafetyError(
        "Legacy publication checkpoint has no explicit commit cleanup proof; preserve for reconciliation",
      );
    assertOwnedTaskWorktreePath(project, cwd);
    const stat = fs.lstatSync(cwd);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await git.getCurrentBranch(cwd)) !== checkpoint.branch ||
      (await git.getCommonGitDirectory(cwd)) !==
        (await git.getCommonGitDirectory(project.repository.path)) ||
      (await git.getRebaseState(cwd)) !== null ||
      (await git.getConflictedPaths(cwd)).length
    )
      throw new PublicationSafetyError(
        "Publication worktree provenance is unsafe",
      );
    const verifyDestinations = async () => {
      const actual = await git.resolvePublicationDestinations(
        cwd,
        run.pinned.repository,
      );
      if (checkpoint!.gitDestinations) {
        if (
          actual.fetch !== checkpoint!.gitDestinations.fetch ||
          actual.push !== checkpoint!.gitDestinations.push
        )
          throw new PublicationSafetyError(
            "Publication Git destination changed from the original checkpoint",
          );
      } else {
        if (entry("initial:push"))
          throw new PublicationSafetyError(
            "Legacy push intent has no concrete destination proof; preserve for reconciliation",
          );
        checkpoint = { ...checkpoint!, gitDestinations: actual };
        save(authority, checkpoint);
      }
      return actual;
    };
    const destinations = await verifyDestinations();
    // Verify Trello's actual list before any publication write. A manual move is
    // not permission to publish or terminal proof. Review is allowed only after
    // the journaled move has been dispatched.
    const inWorking = (await trello.getCards(run.pinned.lists.working)).some(
      (card) =>
        card.id === checkpoint!.cardId &&
        card.idList === run.pinned.lists.working,
    );
    const inReview = (await trello.getCards(run.pinned.lists.review)).some(
      (card) =>
        card.id === checkpoint!.cardId &&
        card.idList === run.pinned.lists.review,
    );
    if (
      !inWorking &&
      !(inReview && entry("initial:move")?.mutation?.dispatches.length)
    )
      throw new PublicationSafetyError("Publication card moved unexpectedly");
    if (
      (await getTaskSessionSourceSnapshotIdentity(git, cwd)) !==
      checkpoint.sourceIdentity
    )
      throw new PublicationSafetyError(
        "Publication source differs from the verified checkpoint",
      );
    if (!checkpoint.commitSha) {
      const commitEntry = entry("initial:commit");
      if (!commitEntry?.mutation?.dispatches.length) {
        const existing = await github.findPullRequestState({
          cwd,
          repository: run.pinned.repository,
          headBranch: checkpoint.branch,
          baseBranch: project.repository.defaultBranch,
          project,
        });
        const remote = await git.getRemoteBranchSha(
          cwd,
          destinations.push,
          checkpoint.branch,
          project,
        );
        if (
          existing !== null ||
          remote !== null ||
          (await git.getCommitCountBetween(
            cwd,
            `origin/${project.repository.defaultBranch}`,
            await git.getHeadSha(cwd),
          )) !== 0
        )
          throw new PublicationSafetyError(
            "Unjournaled publication history exists; refusing another initial commit",
          );
      }
      let payload: {
        parent: string;
        tree: string;
        message: string;
        cleanup: "verbatim";
      };
      if (commitEntry?.mutation) {
        const reference = authority.store
          .read()!
          .artifacts.find(
            (a) => a.id === commitEntry.mutation!.intent.payloadId,
          )!;
        payload = z
          .strictObject({
            parent: gitSha,
            tree: gitSha,
            message: nonBlank,
            cleanup: z.literal("verbatim"),
          })
          .parse(JSON.parse(fs.readFileSync(reference.path, "utf8")));
      } else {
        await git.stageAll(cwd);
        payload = {
          parent: gitSha.parse(await git.getHeadSha(cwd)),
          tree: gitSha.parse(await git.getIndexTreeSha(cwd)),
          message: checkpoint.message!,
          cleanup: "verbatim",
        };
        if (payload.tree === (await git.getCommitTreeSha(cwd)))
          throw new PublicationSafetyError("No meaningful changes to commit");
      }
      await step(
        "commit",
        "git-commit",
        `refs/heads/${checkpoint.branch}`,
        payload,
        async () => {
          const head = await git.getHeadSha(cwd);
          if (head === payload.parent) {
            if (
              (await git.getIndexTreeSha(cwd)) !== payload.tree ||
              (await git.getDiff(cwd)).length ||
              (await git.getUntrackedFiles(cwd)).length
            )
              throw new PublicationSafetyError(
                "Commit source/index differs from the original publication intent",
              );
            return null;
          }
          if (
            (await git.getCommitParentShas(cwd)).join(" ") !== payload.parent ||
            (await git.getCommitTreeSha(cwd)) !== payload.tree ||
            (await git.getVerbatimCommitMessage(cwd)) !== payload.message ||
            (await git.getStatus(cwd)).trim()
          )
            throw new PublicationSafetyError(
              "Commit discovery conflicts with original intent",
            );
          return { id: head, fields: { head, ...payload } };
        },
        async () => {
          const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), "publication-message-"),
          );
          try {
            const file = path.join(directory, "message");
            fs.writeFileSync(file, payload.message, { mode: 0o600 });
            await git.commit(
              cwd,
              file,
              project.repository.gitIdentity,
              payload.cleanup,
            );
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        },
      );
      const verifiedCommit = entry(
        "initial:commit",
      )?.mutation?.observations.find(
        (observation) => observation.outcome === "verified",
      )?.resourceId;
      if (!verifiedCommit || (await git.getHeadSha(cwd)) !== verifiedCommit)
        throw new PublicationSafetyError(
          "Current commit differs from immutable journal verification",
        );
      checkpoint = { ...checkpoint, commitSha: verifiedCommit };
      save(authority, checkpoint);
    }
    const sha = checkpoint.commitSha;
    if (
      (await git.getHeadSha(cwd)) !== sha ||
      (await git.getStatus(cwd)).trim()
    )
      throw new PublicationSafetyError("Publication commit changed");
    writeTrustedCommitState(project, checkpoint.cardId, {
      version: 1,
      kind: "trusted-commit",
      projectId: project.id,
      cardId: checkpoint.cardId,
      taskBranch: checkpoint.branch,
      defaultBranch: project.repository.defaultBranch,
      commitSha: sha,
    });
    if (checkpoint.descriptionPending) {
      if (!options.opencode)
        throw new PublicationSafetyError(
          "Publication presentation client unavailable",
        );
      const storedTask = new TaskExecutionStore(
        run.pinned.storageRoot,
        project,
      ).read(checkpoint.cardId);
      const exhaustedReview =
        storedTask?.reviewRepair?.status === "exhausted"
          ? storedTask.reviewRepair.finalReview
          : undefined;
      const body = await prepareInitialPublicationBody({
        project,
        git,
        github,
        trello,
        opencode: options.opencode,
        card: {
          id: checkpoint.cardId,
          name: checkpoint.title,
          url: checkpoint.cardUrl,
          desc: checkpoint.cardDescription,
          idList: run.pinned.lists.working,
          idLabels: [],
        },
        worktreePath: cwd,
        branch: checkpoint.branch,
        reviewResult: checkpoint.reviewResult,
        remediationResult: checkpoint.remediationResult,
        verifiedDescriptionFacts: () => checkpoint!.verifiedFacts,
        ...(exhaustedReview === undefined ? {} : { exhaustedReview }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      checkpoint = {
        ...checkpoint,
        body: sanitizeControlledText(body),
        descriptionPending: false,
      };
      save(authority, checkpoint);
    }
    if (
      (await git.getHeadSha(cwd)) !== sha ||
      (await git.getStatus(cwd)).trim()
    )
      throw new PublicationSafetyError(
        "Publication content changed during presentation preparation",
      );
    const request = {
      cwd,
      repository: run.pinned.repository,
      headBranch: checkpoint.branch,
      baseBranch: project.repository.defaultBranch,
      project,
    };
    // All-state lookup prevents treating a closed PR as permission to recreate a branch.
    const find = async (): Promise<PullRequestState | null> => {
      const pr = await github.findPullRequestState(request);
      if (!pr) return null;
      const [owner, repository] = run.pinned.repository.split("/");
      const number = Number(new URL(pr.url).pathname.split("/").at(-1));
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        pr.url.toLowerCase() !==
          `https://github.com/${run.pinned.repository}/pull/${number}` ||
        pr.state !== "OPEN" ||
        pr.headRefOid !== sha ||
        pr.headRefName !== checkpoint!.branch ||
        pr.baseRefName !== project.repository.defaultBranch ||
        pr.headRepository?.name.toLowerCase() !== repository ||
        pr.headRepositoryOwner?.login.toLowerCase() !== owner
      )
        throw new PublicationSafetyError(
          "PR discovery identity/outcome conflicts with publication",
        );
      return pr;
    };
    if (!entry("initial:push")?.mutation?.dispatches.length && (await find()))
      throw new PublicationSafetyError(
        "Unjournaled PR exists; refusing branch mutation",
      );
    if (!entry("initial:push")?.mutation?.dispatches.length) {
      await verifyDestinations();
      await git.fetch(
        cwd,
        destinations.fetch,
        `refs/heads/${project.repository.defaultBranch}:refs/remotes/origin/${project.repository.defaultBranch}`,
        project,
      );
    }
    await step(
      "push",
      "git-push",
      `${destinations.push}#refs/heads/${checkpoint.branch}`,
      { sha, destinations, branch: checkpoint.branch },
      async () => {
        await verifyDestinations();
        const remote = await git.getRemoteBranchSha(
          cwd,
          destinations.push,
          checkpoint!.branch,
          project,
        );
        if (remote === sha)
          return {
            id: sha,
            fields: {
              remote,
              destination: destinations.push,
              branch: checkpoint!.branch,
            },
          };
        if (remote !== null)
          throw new PublicationSafetyError(
            "Initial publication remote branch conflicts with intent",
          );
        return null;
      },
      async () => {
        try {
          await verifyDestinations();
        } catch {
          throw new PublicationNotSentError(
            "Publication destination guard stopped dispatch before invoking Git push",
          );
        }
        await git.push(cwd, destinations.push, checkpoint!.branch, project);
      },
    );
    const marker = `<!-- agent-orchestrator-publication:${run.attemptId} -->`;
    await verifyDestinations();
    if (
      (await git.getRemoteBranchSha(
        cwd,
        destinations.push,
        checkpoint.branch,
        project,
      )) !== sha
    )
      throw new PublicationSafetyError(
        "Verified publication remote head changed; no replacement push or PR will be dispatched",
      );
    const body = `${checkpoint.body}\n\n${marker}`;
    await step(
      "pr",
      "github-pr-create",
      run.pinned.repository,
      {
        base: request.baseBranch,
        head: checkpoint.branch,
        title: checkpoint.title,
        body,
        draft: checkpoint.draft,
      },
      async () => {
        const pr = await find();
        if (!pr) return null;
        const fields = await github.getPullRequestPublicationFields({
          ...request,
          pullRequestUrl: pr.url,
        });
        if (
          fields.body !== body ||
          fields.title !== checkpoint!.title ||
          fields.isDraft !== checkpoint!.draft
        )
          throw new PublicationSafetyError(
            "PR fields differ from original publication intent",
          );
        return {
          id: pr.url,
          fields: {
            url: pr.url,
            head: pr.headRefOid,
            base: pr.baseRefName,
            branch: pr.headRefName,
            ...fields,
          },
        };
      },
      () =>
        github.createPullRequest({
          ...request,
          title: checkpoint!.title,
          body,
          draft: checkpoint!.draft,
        }),
    );
    const pr = await find();
    if (!pr) throw new PublicationSafetyError("Verified PR is unavailable");
    if (
      entry("initial:pr")?.mutation?.observations.find(
        (observation) => observation.outcome === "verified",
      )?.resourceId !== pr.url
    )
      throw new PublicationSafetyError(
        "Current PR differs from immutable journal verification",
      );
    const taskStore = new TaskExecutionStore(run.pinned.storageRoot, project);
    assertExecution();
    let task = taskStore.read(checkpoint.cardId);
    if (!task || task.phase !== "publication")
      throw new PublicationSafetyError("Publication projection missing");
    const identity = {
      number: Number(new URL(pr.url).pathname.split("/").at(-1)),
      url: pr.url,
      headSha: sha,
    };
    if (
      task.pullRequest &&
      JSON.stringify(task.pullRequest) !== JSON.stringify(identity)
    )
      throw new PublicationSafetyError(
        "Persisted PR identity conflicts with discovery",
      );
    if (!task.pullRequest)
      task = taskStore.compareAndSwap(task.cardId, task.revision, {
        ...task,
        pullRequest: identity,
        revision: task.revision + 1,
        updatedAt: now(),
      });
    // The actual PR identity is now authoritative BEFORE the first Trello effect.
    await step(
      "move",
      "trello-move",
      checkpoint.cardId,
      { listId: run.pinned.lists.review },
      async () => {
        if (!(await find()))
          throw new PublicationSafetyError(
            "PR unavailable before Trello synchronization",
          );
        const cards = await trello.getCards(run.pinned.lists.review);
        const actual = cards.find(
          (card) =>
            card.id === checkpoint!.cardId &&
            card.idList === run.pinned.lists.review,
        );
        return actual
          ? {
              id: `${actual.id}:${actual.idList}`,
              fields: { cardId: actual.id, listId: actual.idList },
            }
          : null;
      },
      () => trello.moveCard(checkpoint!.cardId, run.pinned.lists.review),
    );
    const commentMarker = `[agent-orchestrator-publication:${run.attemptId}]`;
    if (checkpoint.elapsedWorkflowTime === undefined) {
      const elapsed = await getElapsedWorkflowTime(
        trello,
        project,
        checkpoint.cardId,
        logger.child({ projectId: project.id, cardId: checkpoint.cardId }),
      );
      checkpoint = {
        ...checkpoint,
        elapsedWorkflowTime:
          elapsed === undefined ? null : sanitizeControlledText(elapsed),
      };
      save(authority, checkpoint);
    }
    const comment = sanitizeControlledText(
      [
        "Agent Orchestrator completed publication.",
        `PR: ${pr.url}`,
        `Commit: ${sha}`,
        `Draft: ${checkpoint.draft}`,
        `Review: ${checkpoint.reviewResult}`,
        `Remediation: ${checkpoint.remediationResult}`,
        ...(checkpoint.elapsedWorkflowTime
          ? [`Elapsed workflow time: ${checkpoint.elapsedWorkflowTime}`]
          : []),
        commentMarker,
      ].join("\n"),
    );
    await step(
      "comment",
      "trello-comment",
      checkpoint.cardId,
      { text: comment },
      async () => {
        const comments = await trello.getCardComments(checkpoint!.cardId);
        const matching = comments.filter(
          (candidate) => candidate.text === comment,
        );
        if (matching.length > 1)
          throw new PublicationSafetyError(
            "Publication comment correlation is ambiguous",
          );
        return matching[0] ? { id: matching[0].id, fields: matching[0] } : null;
      },
      () => trello.addComment(checkpoint!.cardId, comment),
    );
    if (
      !(await find()) ||
      !(await trello.getCards(run.pinned.lists.review)).some(
        (card) =>
          card.id === checkpoint!.cardId &&
          card.idList === run.pinned.lists.review,
      )
    )
      throw new PublicationSafetyError(
        "Publication destination changed before completion",
      );
    task = taskStore.read(checkpoint.cardId)!;
    assertExecution();
    taskStore.compareAndSwap(
      task.cardId,
      task.revision,
      transitionTaskExecutionRecord(task, {
        type: "publication-completed",
        eventId: `${task.operationKey}:publication-completed`,
        projectId: project.id,
        cardId: task.cardId,
        operationKey: task.operationKey,
        occurredAt: now(),
        pullRequest: identity,
      }),
    );
    publicationQueue.complete(publicationEvent.eventId);
    save(authority, {
      ...checkpoint,
      completed: true,
      retryAt: null,
      waitingReason: null,
      diagnostic: null,
    });
    if (
      options.emailNotifier &&
      (options.emailNotifier.isEventEnabled?.("humanReview") ?? true) &&
      taskStore.claimHumanReviewNotification(task.cardId, sha)
    )
      await notifyHumanReview(
        options.emailNotifier,
        {
          project,
          card: {
            id: task.cardId,
            name: checkpoint.title,
            url: checkpoint.cardUrl,
            desc: "",
            idList: run.pinned.lists.review,
            idLabels: [],
          },
          pullRequestUrl: pr.url,
          commitSha: sha,
          reviewResult: checkpoint.reviewResult,
          remediationResult: checkpoint.remediationResult,
          publicationContext: `Verified initial publication; draft: ${checkpoint.draft}.`,
          ...(checkpoint.elapsedWorkflowTime
            ? { elapsedWorkflowTime: checkpoint.elapsedWorkflowTime }
            : {}),
        },
        logger.child({ projectId: project.id, cardId: task.cardId }),
      );
    return true;
  } catch (error) {
    authority.assertHeld();
    // Do not copy arbitrary exception/process text into durable payloads or logs.
    const attention =
      Date.now() - Date.parse(checkpoint.startedAt) >= 5 * 60_000;
    const waitingReason =
      error instanceof PublicationWaitingError
        ? "recheck"
        : "dependency-or-conflict";
    const diagnostic =
      error instanceof PublicationSafetyError
        ? error.message
        : error instanceof PublicationWaitingError
          ? "Awaiting due independent readback"
          : "Publication dependency/evidence unavailable; inspect process artifacts and journal";
    if (checkpoint.waitingReason !== waitingReason)
      logger
        .child({ projectId: project.id, cardId: checkpoint.cardId })
        .warn(
          `Initial publication waiting (${waitingReason}); next controlled check in ${PUBLICATION_RECHECK_MS}ms. Inspect journal payloads, observations and process artifacts; no uncertain effect will be resent.`,
        );
    save(authority, {
      ...checkpoint,
      retryAt: next(),
      attention,
      waitingReason,
      diagnostic,
      attentionNotified: checkpoint.attentionNotified || attention,
    });
    if (attention && !checkpoint.attentionNotified)
      await notifyAttentionRequired(
        options.emailNotifier,
        {
          project,
          cardIds: [checkpoint.cardId],
          category: "Git/GitHub",
          reason:
            "Initial publication remains uncertain; ownership and artifacts are preserved and controlled reconciliation continues.",
        },
        logger.child({ projectId: project.id, cardId: checkpoint.cardId }),
      );
    if (options.signal?.aborted) throw error;
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof SyntaxError
    )
      throw error;
    return true;
  } finally {
    // Yield only this invocation's execution token, not project/task ownership.
    // The failed queue event remains the active event and is reclaimable on the
    // next paced poll. No subsequent card can be selected through this handoff.
    if (publicationQueue.ownsActive(publicationEvent.eventId))
      publicationQueue.fail(publicationEvent.eventId);
  }
}
