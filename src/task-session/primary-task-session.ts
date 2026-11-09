import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type {
  OpenCodeClient,
  OpenCodeRunOptions,
  OpenCodeRunResult,
} from "../opencode/opencode-client.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import { getSessionLogPath } from "../logging/session-log.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import {
  PrimaryOperationWaitingError,
  runPrimaryOperation,
} from "./run-primary-operation.js";
import type { PendingPrimaryInspection } from "./run-primary-operation.js";
import { reconcilePendingPrimaryExecution } from "./primary-operation-ledger.js";
import { bindPrimaryExecutionEvidence } from "./primary-operation-ledger.js";
import { sanitizePrimarySessionContextBundle } from "./build-primary-session-context.js";

export class PrimaryTaskSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrimaryTaskSessionError";
  }
}

export class PrimarySessionReconstructionRequiredError extends PrimaryTaskSessionError {
  readonly operationId: string | undefined;
  constructor(message: string, operationId?: string) {
    super(message);
    this.name = "PrimarySessionReconstructionRequiredError";
    this.operationId = operationId;
  }
}

export type PrimaryExecutionIdentity =
  | {
      role: "primary";
      operationId: string;
      activity: string;
      inspectPending: (
        entry: NonNullable<
          NonNullable<TaskExecutionRecord["primaryOperations"]>[string]
        >,
      ) => Promise<PendingPrimaryInspection>;
    }
  | { role: "advisory"; operationId: string }
  | {
      role: "reconstruction";
      operationId: string;
      readOnlyAcknowledged: true;
      inspectPending?: (
        entry: NonNullable<
          NonNullable<TaskExecutionRecord["primaryOperations"]>[string]
        >,
      ) => Promise<PendingPrimaryInspection>;
      inspectOwningPrimary?: (
        entry: NonNullable<
          NonNullable<TaskExecutionRecord["primaryOperations"]>[string]
        >,
      ) => Promise<PendingPrimaryInspection>;
    };

function nextTimestamp(previousTimestamp: string): string {
  const previousMilliseconds = Date.parse(previousTimestamp);
  const now = Date.now();
  return new Date(Math.max(now, previousMilliseconds + 1)).toISOString();
}

function nextRevision(record: TaskExecutionRecord): number {
  return record.revision + 1;
}

function updateSessionCreationStatus(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  status: "creating" | "ambiguous",
): TaskExecutionRecord {
  return store.compareAndSwap(record.cardId, record.revision, {
    ...record,
    sessionCreationStatus: status,
    revision: nextRevision(record),
    updatedAt: nextTimestamp(record.updatedAt),
  });
}

export async function runWithPrimaryTaskSession(
  store: TaskExecutionStore,
  openCode: OpenCodeClient,
  projectId: string,
  cardId: string,
  runOptions: Omit<OpenCodeRunOptions, "sessionId" | "captureSessionId">,
  recovery: PrimarySessionRecoveryOptions = {},
  execution: PrimaryExecutionIdentity,
): Promise<OpenCodeRunResult> {
  runOptions = {
    ...runOptions,
    sessionLogPath:
      runOptions.sessionLogPath ?? getSessionLogPath(projectId, cardId),
  };
  const record = store.read(cardId);

  if (record === null) {
    throw new PrimaryTaskSessionError(
      `Cannot run OpenCode without a task execution record for ${projectId}/${cardId}`,
    );
  }

  if (record.projectId !== projectId || record.cardId !== cardId) {
    throw new PrimaryTaskSessionError(
      `Task execution record ownership does not match ${projectId}/${cardId}`,
    );
  }

  if (
    record.sessionCreationStatus === "creating" ||
    record.sessionCreationStatus === "ambiguous"
  ) {
    throw new PrimaryTaskSessionError(
      `Primary OpenCode session creation is ambiguous for ${projectId}/${cardId}; refusing to create a replacement`,
    );
  }
  if (
    record.sessionRecovery?.status === "replacement-ambiguous" ||
    record.sessionRecovery?.status === "replacement-creating" ||
    record.sessionRecovery?.status === "reconstruction-blocked"
  )
    throw new PrimaryTaskSessionError(
      `Primary session replacement is ambiguous for ${projectId}/${cardId}; refusing duplicate creation`,
    );

  if (record.primarySessionId !== undefined) {
    if (recovery.inspect !== undefined) {
      const available = await recovery.inspect(record.primarySessionId);
      if (available === "unknown" || available === "conflict") {
        if (execution.role !== "advisory")
          throw new PrimaryOperationWaitingError(execution.operationId);
        throw new PrimaryTaskSessionError(
          `Primary OpenCode session inspection returned ${available}; preserving original session and waiting`,
        );
      }
      if (available === "confirmed-absent") {
        const baseline = recovery.baseline;
        if (baseline === undefined)
          throw new PrimarySessionReconstructionRequiredError(
            "Primary session is absent; reconstruction handoff requires a fresh repository baseline",
          );
        const priorBaseline = record.sessionRecovery?.reconstructionBaseline;
        if (
          record.sessionRecovery?.status !== "reconstruction-verified" &&
          priorBaseline !== undefined &&
          !sameFingerprint(priorBaseline, baseline)
        )
          throw persistReconstructionBlock(
            store,
            record,
            "Preserved repository state changed since reconstruction intent was persisted",
          );
        const bundle = recovery.context ?? (await recovery.buildContext?.());
        if (
          bundle === undefined ||
          !isReconstructable(bundle) ||
          !contextIdentityMatches(
            bundle,
            projectId,
            cardId,
            runOptions.cwd,
            recovery.attemptId,
          )
        ) {
          throw new PrimaryTaskSessionError(
            "Original primary session is confirmed absent, but reconstructable task context is unavailable",
          );
        }
        if (execution.role !== "reconstruction")
          throw new PrimarySessionReconstructionRequiredError(
            "Primary session is confirmed absent; run the dedicated read-only reconstruction acknowledgement before primary dispatch",
            execution.role === "primary" ? execution.operationId : undefined,
          );
        if (!execution.readOnlyAcknowledged || !runOptions.readOnly)
          throw new PrimaryTaskSessionError(
            "Replacement session creation requires an explicit read-only reconstruction acknowledgement",
          );
        const persisted = persistRecoveryContext(
          recovery.contextDirectory,
          bundle,
          recovery.forbiddenPaths,
          recovery.persistArtifact,
        );
        const recovering = store.compareAndSwap(cardId, record.revision, {
          ...record,
          sessionRecovery: {
            ...record.sessionRecovery,
            originalSessionId:
              record.sessionRecovery?.originalSessionId ??
              record.primarySessionId,
            status: "replacement-creating",
            reconstructionBaseline: baseline,
            contextReference: persisted.reference,
            contextPath: persisted.path,
            contextLineage: [
              ...(record.sessionRecovery?.contextLineage ?? []),
              {
                reference: persisted.reference,
                path: persisted.path,
                capturedAt: new Date().toISOString(),
              },
            ],
            ...(record.sessionRecovery?.replacementSessionIds === undefined
              ? {}
              : {
                  replacementSessionIds:
                    record.sessionRecovery.replacementSessionIds,
                }),
          },
          revision: nextRevision(record),
          updatedAt: nextTimestamp(record.updatedAt),
        });
        try {
          const replacement = await openCode.run({
            ...runOptions,
            prompt: `${runOptions.prompt}\n\nReconstructed task context (sha256 ${persisted.reference}):\n${persisted.contents}`,
            captureSessionId: true,
          });
          if (replacement.sessionId === undefined)
            throw new Error("Replacement session ID was not captured");
          store.compareAndSwap(cardId, recovering.revision, {
            ...recovering,
            primarySessionId: replacement.sessionId,
            sessionCreationStatus: "bound",
            sessionRecovery: {
              ...recovering.sessionRecovery!,
              status: "replacement-bound",
              replacementSessionIds: [
                ...(recovering.sessionRecovery?.replacementSessionIds ?? []),
                replacement.sessionId,
              ],
            },
            revision: nextRevision(recovering),
            updatedAt: nextTimestamp(recovering.updatedAt),
          });
          return replacement;
        } catch (error) {
          const current = store.read(cardId);
          if (
            current !== null &&
            current.sessionRecovery?.status === "replacement-creating"
          ) {
            store.compareAndSwap(cardId, current.revision, {
              ...current,
              sessionRecovery: {
                ...current.sessionRecovery,
                status: "replacement-ambiguous",
              },
              revision: nextRevision(current),
              updatedAt: nextTimestamp(current.updatedAt),
            });
          }
          throw new PrimaryTaskSessionError(
            "Replacement primary session outcome is ambiguous; refusing duplicate creation",
            { cause: error },
          );
        }
      }
    }
    const sessionId = record.primarySessionId;
    const dispatchAvailability =
      recovery.inspect === undefined
        ? "reachable"
        : await recovery.inspect(sessionId);
    if (
      dispatchAvailability === "unknown" ||
      dispatchAvailability === "conflict"
    ) {
      if (execution.role !== "advisory")
        throw new PrimaryOperationWaitingError(execution.operationId);
      throw new PrimaryTaskSessionError(
        `Primary OpenCode session inspection returned ${dispatchAvailability} at the dispatch boundary; preserving state and waiting`,
      );
    }
    if (dispatchAvailability === "confirmed-absent") {
      if (execution.role === "primary")
        throw new PrimarySessionReconstructionRequiredError(
          "Primary session was confirmed absent immediately before dispatch; reconstruct context before retrying",
          execution.operationId,
        );
      throw new PrimaryTaskSessionError(
        "Primary session was confirmed absent at the dispatch boundary; refusing to continue",
      );
    }
    if (dispatchAvailability === "reachable") {
      if (
        record.sessionRecovery?.status === "replacement-bound" ||
        record.sessionRecovery?.status === "reconstruction-process-failed"
      ) {
        const baseline = recovery.baseline;
        const persistedBaseline = record.sessionRecovery.reconstructionBaseline;
        if (baseline === undefined || persistedBaseline === undefined)
          throw persistReconstructionBlock(
            store,
            record,
            "Persisted reconstruction baseline is unavailable; refusing to establish a new baseline",
          );
        if (!sameFingerprint(persistedBaseline, baseline))
          throw persistReconstructionBlock(
            store,
            record,
            "Preserved repository state changed after replacement binding",
          );
        const bundle = recovery.context ?? (await recovery.buildContext?.());
        if (
          bundle === undefined ||
          !isReconstructable(bundle) ||
          !contextIdentityMatches(
            bundle,
            projectId,
            cardId,
            runOptions.cwd,
            recovery.attemptId,
          )
        )
          throw new PrimaryTaskSessionError(
            "Bound replacement requires validated reconstruction context",
          );
        const persisted = persistRecoveryContext(
          recovery.contextDirectory,
          bundle,
          recovery.forbiddenPaths,
          recovery.persistArtifact,
        );
        const current = store.read(cardId);
        if (current === null || current.primarySessionId !== sessionId)
          throw new PrimaryTaskSessionError(
            "Primary session changed while persisting reconstruction context",
          );
        store.compareAndSwap(cardId, current.revision, {
          ...current,
          sessionRecovery: {
            ...current.sessionRecovery!,
            contextReference: persisted.reference,
            contextPath: persisted.path,
            contextLineage: [
              ...(current.sessionRecovery?.contextLineage ?? []),
              {
                reference: persisted.reference,
                path: persisted.path,
                capturedAt: new Date().toISOString(),
              },
            ],
          },
          revision: nextRevision(current),
          updatedAt: nextTimestamp(current.updatedAt),
        });
        runOptions = {
          ...runOptions,
          prompt: `${runOptions.prompt}\n\nReconstructed task context (sha256 ${persisted.reference}):\n${persisted.contents}`,
        };
      }
      const execute = () => openCode.run({ ...runOptions, sessionId });
      if (execution.role === "advisory") return execute();
      if (execution.role === "reconstruction") {
        if (!execution.readOnlyAcknowledged || !runOptions.readOnly)
          throw new PrimaryTaskSessionError(
            "Reconstruction requires an explicit read-only acknowledgement",
          );
        for (;;) {
          const current = store.read(cardId);
          const unresolved = Object.values(
            current?.primaryOperations ?? {},
          ).find(
            (operation) =>
              operation !== undefined &&
              ["intent", "dispatched", "ambiguous"].includes(operation.status),
          );
          if (
            unresolved === undefined ||
            unresolved.id === execution.operationId
          )
            break;
          if (execution.inspectOwningPrimary === undefined)
            throw new PrimaryOperationWaitingError(unresolved.id);
          let inspection: PendingPrimaryInspection;
          try {
            inspection = await execution.inspectOwningPrimary(unresolved);
          } catch (error) {
            throw new PrimaryOperationWaitingError(unresolved.id, {
              cause: error,
            });
          }
          if (
            inspection.status === "unknown" ||
            inspection.status === "running"
          )
            throw new PrimaryOperationWaitingError(unresolved.id);
          if (inspection.status === "never-dispatched") {
            reconcilePendingPrimaryExecution(
              store,
              cardId,
              unresolved.id,
              "not-dispatched",
            );
          } else if (inspection.status === "stopped-after-dispatch") {
            if (
              inspection.operationId !== unresolved.id ||
              inspection.execution !== unresolved.executions ||
              inspection.sessionId !== unresolved.lastSessionId
            )
              throw new PrimaryOperationWaitingError(unresolved.id);
            reconcilePendingPrimaryExecution(
              store,
              cardId,
              unresolved.id,
              "stopped",
            );
          } else {
            if (inspection.result.exitCode !== 0)
              throw new PrimaryOperationWaitingError(unresolved.id);
            reconcilePendingPrimaryExecution(
              store,
              cardId,
              unresolved.id,
              "completed",
              inspection.result,
            );
          }
        }
        return runPrimaryOperation({
          store,
          cardId,
          operationId: execution.operationId,
          activity: "reconstruction-acknowledgement",
          role: "reconstruction",
          sessionId,
          execute: () =>
            openCode.run({
              ...runOptions,
              sessionId,
              onExecutionPrepared: async (evidence) => {
                const current =
                  store.read(cardId)?.primaryOperations?.[
                    execution.operationId
                  ];
                if (!current)
                  throw new PrimaryTaskSessionError(
                    "Reserved reconstruction acknowledgement disappeared before process evidence binding",
                  );
                bindPrimaryExecutionEvidence(
                  store,
                  cardId,
                  execution.operationId,
                  current.executions,
                  evidence,
                );
                await runOptions.onExecutionPrepared?.(evidence);
              },
            }),
          inspectPending:
            execution.inspectPending ?? (async () => ({ status: "unknown" })),
        });
      }
      return runPrimaryOperation({
        store,
        cardId,
        operationId: execution.operationId,
        activity: execution.activity,
        sessionId,
        execute: () =>
          openCode.run({
            ...runOptions,
            sessionId,
            onExecutionPrepared: async (evidence) => {
              const current =
                store.read(cardId)?.primaryOperations?.[execution.operationId];
              if (!current)
                throw new PrimaryTaskSessionError(
                  "Reserved primary operation disappeared before process evidence binding",
                );
              bindPrimaryExecutionEvidence(
                store,
                cardId,
                execution.operationId,
                current.executions,
                evidence,
              );
              await runOptions.onExecutionPrepared?.(evidence);
            },
          }),
        inspectPending: execution.inspectPending,
      });
    }
    throw new PrimaryTaskSessionError(
      "Primary session reconnect was not confirmed; refusing unsafe recovery",
    );
  }

  if (record.phase !== "planning") {
    throw new PrimaryTaskSessionError(
      `Cannot create a primary OpenCode session during the ${record.phase} phase`,
    );
  }

  const creatingRecord = updateSessionCreationStatus(store, record, "creating");
  let result: OpenCodeRunResult;

  try {
    result = await openCode.run({ ...runOptions, captureSessionId: true });

    if (result.sessionId === undefined) {
      throw new PrimaryTaskSessionError(
        "OpenCode did not return the created primary session ID",
      );
    }
  } catch (error) {
    try {
      updateSessionCreationStatus(store, creatingRecord, "ambiguous");
    } catch (stateError) {
      throw new PrimaryTaskSessionError(
        `Primary OpenCode session creation outcome is ambiguous for ${projectId}/${cardId}, and ambiguity could not be persisted`,
        { cause: new AggregateError([error, stateError]) },
      );
    }

    throw new PrimaryTaskSessionError(
      `Primary OpenCode session creation outcome is ambiguous for ${projectId}/${cardId}`,
      { cause: error },
    );
  }

  try {
    store.compareAndSwap(cardId, creatingRecord.revision, {
      ...creatingRecord,
      primarySessionId: result.sessionId,
      sessionCreationStatus: "bound",
      revision: nextRevision(creatingRecord),
      updatedAt: nextTimestamp(creatingRecord.updatedAt),
    });
    return result;
  } catch (error) {
    throw new PrimaryTaskSessionError(
      `Created primary OpenCode session could not be bound safely for ${projectId}/${cardId}; refusing to create a replacement`,
      { cause: error },
    );
  }
}

export interface PrimarySessionContextBundle {
  version: 1;
  projectId: string;
  cardId: string;
  attemptId: string;
  repositoryPath: string;
  repositoryHead: string;
  card: { title: string; description: string; current: true };
  plan: { status: "available" | "absent"; content?: string };
  attachmentManifest: { status: "available" | "absent"; content?: string };
  currentDiff: string;
  history: string;
  feedback: {
    status: "available" | "absent";
    references: string[];
    content?: string;
  };
}

export interface PrimarySessionRecoveryOptions {
  inspect?: (
    sessionId: string,
  ) => Promise<"reachable" | "confirmed-absent" | "conflict" | "unknown">;
  context?: PrimarySessionContextBundle;
  buildContext?: () => Promise<PrimarySessionContextBundle>;
  baseline?: PrimarySessionRepositoryFingerprint;
  contextDirectory?: string;
  forbiddenPaths?: string[];
  persistArtifact?: (content: Uint8Array) => {
    reference: string;
    path: string;
  };
  attemptId?: string;
}

export interface PrimarySessionRepositoryFingerprint {
  sourceIdentity: string;
  head: string;
  branch: string;
  branchRef: string | null;
  refsIdentity: string;
}

export function assertPrimarySessionReconstructionReadOnly(
  before: PrimarySessionRepositoryFingerprint,
  after: PrimarySessionRepositoryFingerprint,
): void {
  if (
    before.sourceIdentity !== after.sourceIdentity ||
    before.head !== after.head ||
    before.branch !== after.branch ||
    before.branchRef !== after.branchRef ||
    before.refsIdentity !== after.refsIdentity
  )
    throw new PrimaryTaskSessionError(
      "Primary session reconstruction violated its read-only repository boundary",
    );
}

function sameFingerprint(
  first: PrimarySessionRepositoryFingerprint,
  second: PrimarySessionRepositoryFingerprint,
): boolean {
  return (
    first.sourceIdentity === second.sourceIdentity &&
    first.head === second.head &&
    first.branch === second.branch &&
    first.branchRef === second.branchRef &&
    first.refsIdentity === second.refsIdentity
  );
}

function persistReconstructionBlock(
  store: TaskExecutionStore,
  record: TaskExecutionRecord,
  reason: string,
): PrimaryTaskSessionError {
  store.compareAndSwap(record.cardId, record.revision, {
    ...record,
    sessionRecovery: {
      ...(record.sessionRecovery ?? {
        originalSessionId: record.primarySessionId!,
        status: "reconstruction-blocked" as const,
      }),
      status: "reconstruction-blocked",
      blockReason: reason,
    },
    revision: nextRevision(record),
    updatedAt: nextTimestamp(record.updatedAt),
  });
  return new PrimaryTaskSessionError(reason);
}

function contextIdentityMatches(
  bundle: PrimarySessionContextBundle,
  projectId: string,
  cardId: string,
  cwd: string,
  attemptId: string | undefined,
): boolean {
  return (
    bundle.projectId === projectId &&
    bundle.cardId === cardId &&
    path.resolve(bundle.repositoryPath) === path.resolve(cwd) &&
    (attemptId === undefined || bundle.attemptId === attemptId)
  );
}

function isReconstructable(bundle: PrimarySessionContextBundle): boolean {
  return (
    bundle.version === 1 &&
    bundle.projectId.length > 0 &&
    bundle.cardId.length > 0 &&
    bundle.attemptId.length > 0 &&
    path.isAbsolute(bundle.repositoryPath) &&
    /^[0-9a-f]{40,64}$/iu.test(bundle.repositoryHead) &&
    bundle.card.current === true &&
    bundle.card.title.trim().length > 0 &&
    (bundle.plan.status === "absent" ||
      (bundle.plan.status === "available" &&
        typeof bundle.plan.content === "string" &&
        bundle.plan.content.length > 0)) &&
    (bundle.attachmentManifest.status === "absent" ||
      (bundle.attachmentManifest.status === "available" &&
        typeof bundle.attachmentManifest.content === "string" &&
        bundle.attachmentManifest.content.length > 0)) &&
    bundle.currentDiff.length > 0 &&
    bundle.history.length > 0 &&
    (bundle.feedback.status === "absent" ||
      (bundle.feedback.status === "available" &&
        bundle.feedback.references.length > 0 &&
        typeof bundle.feedback.content === "string" &&
        bundle.feedback.content.length > 0))
  );
}

function persistRecoveryContext(
  directory: string | undefined,
  bundle: PrimarySessionContextBundle,
  forbiddenPaths: string[] = [],
  persistArtifact?: PrimarySessionRecoveryOptions["persistArtifact"],
): { reference: string; path: string; contents: string } {
  bundle = sanitizePrimarySessionContextBundle(bundle);
  const contents = `${JSON.stringify(bundle)}\n`;
  if (Buffer.byteLength(contents) > 8 * 1024 * 1024)
    throw new PrimaryTaskSessionError("Recovery context exceeds size limit");
  if (persistArtifact !== undefined) {
    const artifact = persistArtifact(Buffer.from(contents, "utf8"));
    assertRecoveryArtifactPath(artifact.path, forbiddenPaths);
    const reference = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    if (artifact.reference !== reference)
      throw new PrimaryTaskSessionError(
        "Recovery context artifact identity mismatch",
      );
    return { ...artifact, contents, reference };
  }
  if (forbiddenPaths.length < 2)
    throw new PrimaryTaskSessionError(
      "Repository and worktree exclusions are required for recovery artifacts",
    );
  if (directory === undefined || !path.isAbsolute(directory))
    throw new PrimaryTaskSessionError(
      "A durable absolute recovery context directory is required",
    );
  const resolved = path.resolve(directory);
  if (
    forbiddenPaths.some(
      (item) =>
        resolved === path.resolve(item) ||
        resolved.startsWith(`${path.resolve(item)}${path.sep}`),
    )
  )
    throw new PrimaryTaskSessionError(
      "Recovery context directory overlaps a repository/worktree",
    );
  const reference = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  let ancestor = path.parse(resolved).root;
  for (const component of path
    .relative(ancestor, resolved)
    .split(path.sep)
    .filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    const existing = fs.lstatSync(ancestor, { throwIfNoEntry: false });
    if (
      existing?.isSymbolicLink() ||
      (existing !== undefined && !existing.isDirectory())
    )
      throw new PrimaryTaskSessionError(
        "Recovery context path contains an unsafe component",
      );
  }
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) {
    const parentFd = fs.openSync(path.dirname(directory), "r");
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  }
  const filePath = path.join(directory, `${reference.slice(7)}.json`);
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new PrimaryTaskSessionError("Unsafe recovery context directory");
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8 * 1024 * 1024 ||
      createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") !==
        reference.slice(7)
    )
      throw new PrimaryTaskSessionError(
        "Existing recovery context artifact is unsafe or corrupt",
      );
  } else {
    const temporaryPath = path.join(
      directory,
      `.${reference.slice(7)}.${randomUUID()}.tmp`,
    );
    const fd = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      const existing = fs.readFileSync(filePath);
      if (
        createHash("sha256").update(existing).digest("hex") !==
        reference.slice(7)
      )
        throw new PrimaryTaskSessionError(
          "Concurrent recovery context artifact is corrupt",
        );
    } finally {
      fs.unlinkSync(temporaryPath);
    }
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
  return { reference, path: filePath, contents };
}

function assertRecoveryArtifactPath(
  candidate: string,
  forbiddenPaths: string[],
): void {
  if (forbiddenPaths.length < 2)
    throw new PrimaryTaskSessionError(
      "Repository and worktree exclusions are required for recovery artifacts",
    );
  const resolved = path.resolve(candidate);
  if (
    forbiddenPaths.some((item) => {
      const root = path.resolve(item);
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    })
  )
    throw new PrimaryTaskSessionError(
      "Recovery context artifact overlaps a repository or worktree",
    );
}
