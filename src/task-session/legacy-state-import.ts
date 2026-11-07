import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import { parseLegacyCommitState } from "../orchestrator/trusted-commit-state.js";
import { parseTaskMutationQueue } from "./task-mutation-queue.js";
import { parseStoredTaskPlan } from "./task-plan-store.js";
import { parseFeedbackLedger } from "./feedback-ledger.js";
import { parsePrMaintenanceStore } from "./pr-maintenance-store.js";
import { readPreparedConflict } from "../orchestrator/prepared-conflict-state.js";
import { parseTaskMutationBlock } from "../orchestrator/task-mutation-block-store.js";
import { loadReconciliationBlock } from "../orchestrator/reconciliation-block-storage.js";
import { parseTaskExecutionRecord } from "./task-execution-record.js";
import {
  parseRunRecord,
  type RunRecord,
  type RunLifecycleState,
} from "./run-record.js";
import { RunRegistry, RunStore, type RunStoreLease } from "./run-store.js";
import { ProjectRunAuthority } from "./project-run-authority.js";

export interface LegacySourceRecord {
  readonly family: string;
  readonly path: string;
  readonly projectId: string;
  readonly cardId: string | null;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly parsed: unknown;
}

export function legacyAttemptId(taskInput: unknown): string {
  const task = parseTaskExecutionRecord(taskInput);
  return `legacy-${createHash("sha256")
    .update(`${task.projectId}\0${task.cardId}\0${task.createdAt}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function buildLegacyCompatibilityProjection(
  sources: readonly LegacySourceRecord[],
  projectId: string,
  cardId: string,
): Record<string, unknown> {
  const compatibility: Record<string, unknown> = {};
  for (const source of sources) {
    let key: string | undefined;
    let value: unknown;
    switch (source.family) {
      case "task-executions":
        if (source.cardId !== cardId) continue;
        key = `task-execution-${cardId}`;
        value = parseTaskExecutionRecord(source.parsed);
        break;
      case "task-mutation-queues":
        key = ProjectRunAuthority.queueKey(projectId);
        value = parseTaskMutationQueue(source.parsed);
        break;
      case "task-mutation-blocks":
        key = ProjectRunAuthority.mutationBlocksKey(projectId);
        value = parseTaskMutationBlock(source.parsed);
        break;
      case "task-plans":
        if (source.cardId !== cardId) continue;
        key = ProjectRunAuthority.taskKey("task-plan", cardId);
        value = parseStoredTaskPlan(source.parsed);
        break;
      case "feedback-ledgers":
        if (source.cardId !== cardId) continue;
        key = ProjectRunAuthority.taskKey("feedback-ledger", cardId);
        value = parseFeedbackLedger(source.parsed);
        break;
      case "pr-maintenance":
        key = ProjectRunAuthority.taskKey("maintenance", projectId);
        value = parsePrMaintenanceStore(source.parsed, projectId);
        break;
      case "reconciliation-block":
        key = ProjectRunAuthority.reconciliationBlockKey(projectId);
        value = source.parsed;
        break;
      case "trusted-commits":
      case "pending-commits":
      case "rejected-commits": {
        if (source.cardId !== cardId) continue;
        const state = parseLegacyCommitState(source.parsed);
        key = ProjectRunAuthority.commitKey(state.kind, cardId);
        value = state;
        break;
      }
      case "prepared-conflicts":
        if (source.cardId !== cardId) continue;
        key = `prepared-conflict-${cardId}`;
        value = source.parsed;
        break;
      case "session-artifacts":
        // These bytes are preserved in the immutable migration artifact and
        // remain linked through the validated task source manifest.
        continue;
      default:
        throw new Error(
          `No canonical compatibility projection is defined for legacy family ${source.family}`,
        );
    }
    if (key === undefined) continue;
    if (Object.hasOwn(compatibility, key))
      throw new Error(`Duplicate legacy compatibility projection ${key}`);
    compatibility[key] = value;
  }
  if (!Object.hasOwn(compatibility, `task-execution-${cardId}`))
    throw new Error(
      "Legacy compatibility snapshot is missing task execution state",
    );
  return compatibility;
}

function readSafeDirectory(directory: string): fs.Dirent[] | null {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of path
    .relative(parsed.root, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe legacy directory component: ${current}`);
  }
  return fs.readdirSync(absolute, { withFileTypes: true });
}

/** Inventory using the application's real storage topology. Root-based stores
 * use runtimeRoot; commit and prepared-conflict evidence use worktreeRoot. */
export function inventoryLegacyProject(options: {
  readonly runtimeRoot: string;
  readonly project: ProjectConfig;
}): { records: LegacySourceRecord[]; blockers: string[] } {
  if (!path.isAbsolute(options.runtimeRoot))
    throw new Error("Runtime root must be absolute");
  const { runtimeRoot, project } = options;
  const roots: { family: string; directory: string }[] = [
    {
      family: "task-executions",
      directory: path.join(runtimeRoot, "task-executions", project.id),
    },
    {
      family: "task-mutation-queues",
      directory: path.join(runtimeRoot, "task-mutation-queues"),
    },
    {
      family: "task-mutation-blocks",
      directory: path.join(runtimeRoot, "task-mutation-queues"),
    },
    {
      family: "task-plans",
      directory: path.join(runtimeRoot, "task-plans", project.id),
    },
    {
      family: "feedback-ledgers",
      directory: path.join(runtimeRoot, "feedback-ledgers", project.id),
    },
    {
      family: "pr-maintenance",
      directory: path.join(runtimeRoot, "pr-maintenance"),
    },
    {
      family: "reconciliation-block",
      directory: path.join(runtimeRoot, project.id),
    },
    {
      family: "trusted-commits",
      directory: path.join(
        project.repository.worktreeRoot,
        ".orchestrator",
        "trusted-commits",
        project.id,
      ),
    },
    {
      family: "pending-commits",
      directory: path.join(
        project.repository.worktreeRoot,
        ".orchestrator",
        "pending-commits",
        project.id,
      ),
    },
    {
      family: "rejected-commits",
      directory: path.join(
        project.repository.worktreeRoot,
        ".orchestrator",
        "rejected-commits",
        project.id,
      ),
    },
    {
      family: "prepared-conflicts",
      directory: path.join(
        project.repository.worktreeRoot,
        ".orchestrator",
        "prepared-conflicts",
        project.id,
      ),
    },
  ];
  const records: LegacySourceRecord[] = [];
  const blockers: string[] = [];
  const add = (family: string, file: string): void => {
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8 * 1024 * 1024
      )
        throw new Error("unsafe, non-file, symlink, or oversized source");
      const bytes = fs.readFileSync(file);
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      let projectId: string;
      let cardId: string | null = null;
      if (family === "task-executions") {
        const data = parseTaskExecutionRecord(parsed);
        projectId = data.projectId;
        cardId = data.cardId;
      } else if (family === "task-mutation-queues") {
        const data = parseTaskMutationQueue(parsed);
        projectId = data.projectId;
      } else if (family === "task-mutation-blocks") {
        const data = parseTaskMutationBlock(parsed);
        projectId = data.projectId;
      } else if (family === "task-plans") {
        const data = parseStoredTaskPlan(parsed);
        projectId = data.plan.projectId;
        cardId = data.plan.cardId;
      } else if (family === "feedback-ledgers") {
        const data = parseFeedbackLedger(parsed);
        projectId = data.projectId;
        cardId = data.cardId;
      } else if (family === "pr-maintenance") {
        const data = parsePrMaintenanceStore(parsed, project.id);
        projectId = data.projectId;
      } else if (
        family === "trusted-commits" ||
        family === "pending-commits" ||
        family === "rejected-commits"
      ) {
        const data = parseLegacyCommitState(parsed);
        projectId = data.projectId;
        cardId = data.cardId;
        if (data.kind !== family.replace(/s$/u, ""))
          throw new Error("commit kind/path family mismatch");
        if (
          data.taskBranch !== `agent/${data.cardId}` ||
          data.defaultBranch !== project.repository.defaultBranch ||
          path.basename(file, ".json") !== data.cardId
        )
          throw new Error(
            "commit state path/branch does not match configured project and card",
          );
      } else if (family === "prepared-conflicts") {
        cardId = path.basename(file, ".json");
        const data = readPreparedConflict(project, cardId);
        if (!data)
          throw new Error("prepared conflict disappeared during inventory");
        projectId = data.projectId;
      } else if (family === "reconciliation-block") {
        const loaded = loadReconciliationBlock(runtimeRoot, project.id);
        if (loaded.status !== "loaded")
          throw new Error(
            `reconciliation blocker could not be validated: ${loaded.status}`,
          );
        projectId = loaded.block.projectId;
        cardId = loaded.block.cardId ?? null;
      } else {
        const data = z
          .object({ version: z.literal(1), projectId: z.string().min(1) })
          .passthrough()
          .parse(parsed);
        projectId = data.projectId;
        if ("cardId" in data && typeof data.cardId === "string")
          cardId = data.cardId;
      }
      if (projectId !== project.id) {
        throw new Error(
          `project association ${projectId} conflicts with configured ${project.id}`,
        );
      }
      if (
        cardId &&
        [
          "task-executions",
          "task-plans",
          "feedback-ledgers",
          "trusted-commits",
          "pending-commits",
          "rejected-commits",
          "prepared-conflicts",
        ].includes(family) &&
        path.basename(file, ".json") !== cardId
      )
        throw new Error(`card identity ${cardId} does not match filename`);
      records.push({
        family,
        path: file,
        projectId,
        cardId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
        parsed,
      });
    } catch (error) {
      blockers.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  for (const { family, directory } of roots) {
    const selectedName =
      family === "task-mutation-queues"
        ? `${project.id}.json`
        : family === "task-mutation-blocks"
          ? `${project.id}.block.json`
          : family === "pr-maintenance"
            ? `${project.id}.json`
            : family === "reconciliation-block"
              ? "reconciliation-block.json"
              : undefined;
    if (selectedName !== undefined) {
      try {
        const entries = readSafeDirectory(directory);
        if (!entries) continue;
        const selected = path.join(directory, selectedName);
        const stat = fs.lstatSync(selected, { throwIfNoEntry: false });
        if (stat) add(family, selected);
      } catch (error) {
        blockers.push(
          `${directory}/${selectedName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = readSafeDirectory(directory) ?? [];
    } catch (error) {
      blockers.push(`${directory}: ${String(error)}`);
      continue;
    }
    for (const entry of entries) {
      const cardScoped = [
        "task-executions",
        "task-plans",
        "feedback-ledgers",
        "trusted-commits",
        "pending-commits",
        "rejected-commits",
        "prepared-conflicts",
      ].includes(family);
      if (cardScoped && entry.name.endsWith(".json")) {
        add(family, path.join(directory, entry.name));
        continue;
      }
      if (entry.isSymbolicLink()) {
        blockers.push(`${path.join(directory, entry.name)}: symlink refused`);
        continue;
      }
      if (
        !entry.isFile() ||
        !(
          entry.name.endsWith(".json") ||
          (family === "reconciliation-block" &&
            entry.name === "reconciliation-block.json")
        )
      )
        continue;
      if (
        family === "task-mutation-queues" &&
        entry.name.endsWith(".block.json")
      )
        continue;
      if (
        family === "task-mutation-blocks" &&
        !entry.name.endsWith(".block.json")
      )
        continue;
      add(family, path.join(directory, entry.name));
    }
  }
  const taskCards = new Set(
    records.filter((r) => r.family === "task-executions").map((r) => r.cardId),
  );
  for (const record of records) {
    const parsed = record.parsed as Record<string, unknown>;
    const associatedCards =
      record.family === "task-mutation-queues" && Array.isArray(parsed.events)
        ? parsed.events.flatMap((event) =>
            event &&
            typeof event === "object" &&
            "cardId" in event &&
            typeof event.cardId === "string"
              ? [event.cardId]
              : [],
          )
        : record.family === "pr-maintenance" && Array.isArray(parsed.operations)
          ? parsed.operations.flatMap((operation) =>
              operation &&
              typeof operation === "object" &&
              "cardId" in operation &&
              typeof operation.cardId === "string"
                ? [operation.cardId]
                : [],
            )
          : [];
    for (const cardId of associatedCards)
      if (!taskCards.has(cardId))
        blockers.push(
          `${record.path}: orphan ${record.family} state for card ${cardId}; project migration blocked`,
        );
  }
  for (const record of records)
    if (record.cardId && !taskCards.has(record.cardId))
      blockers.push(
        `${record.path}: orphan ${record.family} state for card ${record.cardId}; project migration blocked`,
      );
  for (const record of [...records]) {
    const raw = record.parsed as { sessionLogPaths?: unknown };
    if (!Array.isArray(raw.sessionLogPaths)) continue;
    for (const referenced of raw.sessionLogPaths) {
      if (
        typeof referenced !== "string" ||
        !referenced ||
        referenced.trim() !== referenced
      ) {
        blockers.push(
          `${record.path}: invalid referenced session artifact path`,
        );
        continue;
      }
      const referencePath = path.resolve(runtimeRoot, referenced);
      try {
        const stat = fs.lstatSync(referencePath);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 8 * 1024 * 1024
        )
          throw new Error("unsafe or oversized referenced artifact");
        const bytes = fs.readFileSync(referencePath);
        records.push({
          family: "session-artifacts",
          path: referencePath,
          projectId: project.id,
          cardId: record.cardId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes,
          parsed: null,
        });
      } catch (error) {
        blockers.push(
          `${record.path}: referenced artifact ${referencePath} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const byCard = new Map<string, LegacySourceRecord[]>();
  for (const record of records) {
    if (record.cardId)
      byCard.set(record.cardId, [...(byCard.get(record.cardId) ?? []), record]);
    const data = record.parsed as { operations?: unknown } | null;
    if (
      record.family === "pr-maintenance" &&
      data &&
      Array.isArray(data.operations)
    )
      for (const raw of data.operations) {
        if (
          !raw ||
          typeof raw !== "object" ||
          !("cardId" in raw) ||
          typeof raw.cardId !== "string"
        )
          continue;
        const operation = raw as {
          cardId: string;
          pullRequest?: unknown;
          expectedRemoteHead?: unknown;
        };
        const associated: LegacySourceRecord = {
          ...record,
          cardId: operation.cardId,
          parsed: {
            pullRequest: {
              ...(operation.pullRequest as Record<string, unknown>),
              headSha: operation.expectedRemoteHead,
            },
          },
        };
        byCard.set(operation.cardId, [
          ...(byCard.get(operation.cardId) ?? []),
          associated,
        ]);
      }
  }
  for (const [card, values] of byCard) {
    const identities = new Map<string, { url?: string; head?: string }>();
    const addIdentity = (number: unknown, url: unknown, head: unknown) => {
      if (number === undefined || number === null) return;
      const key = String(number);
      const next = {
        ...(typeof url === "string" ? { url } : {}),
        ...(typeof head === "string" ? { head } : {}),
      };
      const prior = identities.get(key);
      if (
        prior &&
        ((prior.url && next.url && prior.url !== next.url) ||
          (prior.head && next.head && prior.head !== next.head))
      )
        blockers.push(
          `${card}: conflicting PR URL or head identity across legacy records`,
        );
      identities.set(key, { ...prior, ...next });
    };
    for (const record of values) {
      if (!record.parsed || typeof record.parsed !== "object") continue;
      const data = record.parsed as Record<string, unknown>;
      const pr = data.pullRequest as
        { number?: unknown; url?: unknown; headSha?: unknown } | undefined;
      addIdentity(pr?.number, pr?.url, pr?.headSha);
      const recovery = data.externalRecovery as
        | {
            pullRequestNumber?: unknown;
            pullRequestUrl?: unknown;
            implementationCommit?: unknown;
          }
        | undefined;
      addIdentity(
        recovery?.pullRequestNumber,
        recovery?.pullRequestUrl,
        recovery?.implementationCommit,
      );
      if (Array.isArray(data.operations))
        for (const operation of data.operations) {
          if (!operation || typeof operation !== "object") continue;
          const op = operation as {
            cardId?: unknown;
            pullRequest?: unknown;
            expectedRemoteHead?: unknown;
          };
          const maintenancePr = op.pullRequest as
            { number?: unknown; url?: unknown } | undefined;
          if (op.cardId === card)
            addIdentity(
              maintenancePr?.number,
              maintenancePr?.url,
              op.expectedRemoteHead,
            );
        }
    }
    if (identities.size > 1)
      blockers.push(`${card}: conflicting PR numbers across legacy records`);
  }
  const taskByCard = new Map(
    records
      .filter((record) => record.family === "task-executions" && record.cardId)
      .map((record) => [
        record.cardId!,
        record.parsed as {
          pullRequest?: { number?: unknown; url?: unknown; headSha?: unknown };
          externalRecovery?: {
            pullRequestNumber?: unknown;
            pullRequestUrl?: unknown;
            implementationCommit?: unknown;
          };
        },
      ]),
  );
  for (const record of records.filter(
    (source) => source.family === "pr-maintenance",
  )) {
    const source = record.parsed as {
      operations?: {
        cardId?: string;
        pullRequest?: { number?: unknown; url?: unknown };
        expectedRemoteHead?: unknown;
      }[];
    };
    for (const operation of source.operations ?? []) {
      if (!operation.cardId || !operation.pullRequest) continue;
      const task = taskByCard.get(operation.cardId);
      if (!task) continue;
      const taskPr = task.pullRequest;
      const recovery = task.externalRecovery;
      const number = taskPr?.number ?? recovery?.pullRequestNumber;
      const url = taskPr?.url ?? recovery?.pullRequestUrl;
      const head = taskPr?.headSha ?? recovery?.implementationCommit;
      if (
        (number !== undefined && number !== operation.pullRequest.number) ||
        (url !== undefined && url !== operation.pullRequest.url) ||
        (head !== undefined &&
          operation.expectedRemoteHead !== undefined &&
          head !== operation.expectedRemoteHead)
      )
        blockers.push(
          `${operation.cardId}: conflicting PR number, URL, or head between task and maintenance records`,
        );
    }
  }
  return {
    records: records.sort((a, b) => a.path.localeCompare(b.path)),
    blockers: [...new Set(blockers)].sort(),
  };
}

export interface LegacyArtifactInput {
  readonly reference: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

/** Convert a validated v1 task record to a conservative resumable snapshot.
 * Legacy progress is evidence, not proof of completion: even `done` is held for
 * reconciliation. References to all sibling persistence are embedded verbatim
 * in the immutable migration artifact for subsequent family-specific import. */
export function buildLegacyRunSnapshot(input: {
  readonly rawTask: unknown;
  readonly sources: readonly LegacySourceRecord[];
  readonly pinned: RunRecord["pinned"];
  readonly lease: RunStoreLease;
  readonly now?: Date;
}): {
  record: RunRecord;
  artifacts: readonly { content: Uint8Array; mediaType?: string }[];
} {
  const task = parseTaskExecutionRecord(input.rawTask);
  if (task.projectId !== input.pinned.projectId)
    throw new Error(
      "Legacy task project differs from pinned canonical project",
    );
  if (input.lease.integrationId !== input.pinned.integrationId)
    throw new Error("Legacy import requires the matching canonical lease");
  const taskSource = input.sources.filter(
    (source) =>
      source.family === "task-executions" && source.cardId === task.cardId,
  );
  if (
    taskSource.length !== 1 ||
    JSON.stringify(taskSource[0]?.parsed) !== JSON.stringify(input.rawTask)
  )
    throw new Error(
      "Migration must derive task state from exactly one inventoried original task file",
    );
  for (const source of input.sources) {
    const actualHash = createHash("sha256").update(source.bytes).digest("hex");
    if (actualHash !== source.sha256)
      throw new Error(`Source hash mismatch: ${source.path}`);
    if (source.family !== "session-artifacts") {
      const decoded: unknown = JSON.parse(
        Buffer.from(source.bytes).toString("utf8"),
      );
      if (JSON.stringify(decoded) !== JSON.stringify(source.parsed))
        throw new Error(
          `Parsed source differs from original bytes: ${source.path}`,
        );
    }
  }
  const sortedSources = [...input.sources].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const sourceManifest = sortedSources.map(
    ({ path: sourcePath, family, projectId, cardId, sha256 }) => ({
      path: sourcePath,
      family,
      projectId,
      cardId,
      sha256,
    }),
  );
  const sourceManifestHash = createHash("sha256")
    .update(JSON.stringify(sourceManifest))
    .digest("hex");
  const artifact = {
    content: Buffer.from(
      JSON.stringify({
        version: 1,
        sourceManifest,
        sources: sortedSources.map((source) => ({
          ...sourceManifest.find((entry) => entry.path === source.path),
          bytesBase64: Buffer.from(source.bytes).toString("base64"),
        })),
      }),
    ),
    mediaType: "application/vnd.agent-orchestrator.legacy-snapshot+json",
  };
  const timestamp = input.now ?? new Date();
  const stamp = timestamp.toISOString();
  const attemptId = legacyAttemptId(task);
  const sourcePhase: Record<string, RunLifecycleState> = {
    planning: "planning",
    implementation: "implementation",
    validation: "validation",
    review: "review",
    publication: "publication",
    ci: "ci",
    "human-feedback": "human-feedback",
    "attention-required": "waiting",
    done: "human-review",
  };
  const mapped = sourcePhase[task.phase];
  if (!mapped)
    throw new Error(`Unsupported legacy phase: ${String(task.phase)}`);
  const checkpoint = mapped === "waiting" ? "implementation" : mapped;
  const artifactDigest = createHash("sha256")
    .update(artifact.content)
    .digest("hex");
  const artifactPath = path.join(
    input.pinned.storageRoot,
    "artifacts",
    attemptId,
    `sha256-${artifactDigest}`,
  );
  const hasPr =
    task.pullRequest !== undefined || task.externalRecovery !== undefined;
  const primarySession = task.primarySessionId;
  const compatibility = buildLegacyCompatibilityProjection(
    input.sources,
    task.projectId,
    task.cardId,
  );
  const hasPreparedConflict = input.sources.some(
    (source) =>
      source.family === "prepared-conflicts" && source.cardId === task.cardId,
  );
  const recoveryDisposition =
    task.phase === "attention-required" ||
    task.phase === "done" ||
    hasPreparedConflict
      ? "operator-reconciliation-required"
      : "task-session-reconcile";
  const run = parseRunRecord({
    version: 1,
    revision: 1,
    projectId: task.projectId,
    cardId: task.cardId,
    attemptId,
    pinned: input.pinned,
    lifecycle: "waiting",
    checkpoint,
    publicationState: hasPr ? "unknown" : "none",
    operation: {
      id: task.operationKey,
      kind: `task-phase-${task.phase}`,
      generation: 1,
    },
    wait: {
      reason: hasPreparedConflict
        ? "legacy-prepared-conflict-reconciliation"
        : task.phase === "done"
          ? "legacy-terminal-unverified"
          : task.phase === "attention-required"
            ? "legacy-attention-required"
            : "legacy-execution-reconciliation",
      dependency:
        recoveryDisposition === "task-session-reconcile"
          ? "task-session"
          : "operator",
      since: stamp,
      retryAt: null,
    },
    owner: {
      instanceId: input.lease.instanceId,
      token: input.lease.token,
      generation: 1,
    },
    resources: [
      ...(task.expectedBranch
        ? [
            {
              kind: "git-branch",
              id: `legacy-branch-${createHash("sha256").update(task.expectedBranch).digest("hex").slice(0, 16)}`,
              path: task.expectedBranch,
              provenance: "legacy-task-record",
            },
          ]
        : []),
      ...(task.pullRequest
        ? [
            {
              kind: "pull-request",
              id: String(task.pullRequest.number),
              path: task.pullRequest.url,
              provenance: "legacy-task-record",
            },
          ]
        : []),
    ],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: primarySession ? { primary: primarySession } : {},
    artifacts: [
      {
        id: `sha256:${artifactDigest}`,
        path: artifactPath,
        bytes: artifact.content.byteLength,
        mediaType: artifact.mediaType,
      },
    ],
    expectedTrelloListId: null,
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {
      sourceVersion: 1,
      sourcePhase: task.phase,
      sourceRevision: task.revision,
      sourceUpdatedAt: task.updatedAt,
      retryCounters: task.retryCounters,
      legacyTaskRecord: task,
      sessionCreationStatus: task.sessionCreationStatus ?? null,
      pullRequest: task.pullRequest ?? null,
      externalRecovery: task.externalRecovery ?? null,
      sourceManifestHash,
      sourceManifest,
      recoveryDisposition,
    },
    compatibility,
    updatedAt: stamp,
  });
  return { record: run, artifacts: [artifact] };
}

/** Idempotent candidate install under lease; callers publish registry pointer only
 * after success. A pre-existing candidate is verified rather than overwritten. */
export function importLegacyRun(
  store: RunStore,
  candidate: ReturnType<typeof buildLegacyRunSnapshot>,
): RunRecord {
  const existing = store.read();
  if (existing) {
    assertManifestIntegrity(existing);
    store.assertLeaseForImport();
    if (
      existing.attemptId !== candidate.record.attemptId ||
      existing.legacy.sourceManifestHash !==
        candidate.record.legacy.sourceManifestHash
    )
      throw new Error(
        "Conflicting imported candidate exists; preserve and reconcile",
      );
    return existing;
  }
  return store.importSnapshot(candidate.record, candidate.artifacts);
}

function assertManifestIntegrity(record: RunRecord): void {
  const manifest = record.legacy.sourceManifest;
  const claimed = record.legacy.sourceManifestHash;
  if (!Array.isArray(manifest) || typeof claimed !== "string")
    throw new Error("Imported candidate lacks source manifest provenance");
  const computed = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  if (computed !== claimed)
    throw new Error("Imported source manifest hash mismatch");
  const artifact = record.artifacts.find(
    (item) =>
      item.mediaType ===
      "application/vnd.agent-orchestrator.legacy-snapshot+json",
  );
  if (!artifact)
    throw new Error("Imported source snapshot artifact is missing");
  const snapshot: unknown = JSON.parse(fs.readFileSync(artifact.path, "utf8"));
  const envelope = z
    .strictObject({
      version: z.literal(1),
      sourceManifest: z.array(z.unknown()),
      sources: z.array(
        z.strictObject({
          path: z.string(),
          family: z.string(),
          projectId: z.string(),
          cardId: z.string().nullable(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          bytesBase64: z.string(),
        }),
      ),
    })
    .parse(snapshot);
  if (JSON.stringify(envelope.sourceManifest) !== JSON.stringify(manifest))
    throw new Error(
      "Snapshot artifact manifest differs from candidate provenance",
    );
  const seenPaths = new Set<string>();
  const manifestByPath = new Map<
    string,
    {
      family?: unknown;
      projectId?: unknown;
      cardId?: unknown;
      sha256?: unknown;
    }
  >();
  for (const item of manifest) {
    if (
      !item ||
      typeof item !== "object" ||
      !("path" in item) ||
      typeof item.path !== "string" ||
      manifestByPath.has(item.path)
    )
      throw new Error("Malformed or duplicate source manifest entry");
    manifestByPath.set(
      item.path,
      item as {
        family?: unknown;
        projectId?: unknown;
        cardId?: unknown;
        sha256?: unknown;
      },
    );
  }
  let matchingTaskCount = 0;
  for (const source of envelope.sources) {
    if (seenPaths.has(source.path))
      throw new Error("Duplicate source path in import snapshot");
    seenPaths.add(source.path);
    const manifestEntry = manifestByPath.get(source.path);
    if (
      !manifestEntry ||
      manifestEntry.family !== source.family ||
      manifestEntry.projectId !== source.projectId ||
      manifestEntry.cardId !== source.cardId ||
      manifestEntry.sha256 !== source.sha256
    )
      throw new Error(
        `Source snapshot does not match manifest entry: ${source.path}`,
      );
    const bytes = Buffer.from(source.bytesBase64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      throw new Error(`Snapshot source hash mismatch: ${source.path}`);
    if (
      source.family === "task-executions" &&
      source.cardId === record.cardId
    ) {
      const task = parseTaskExecutionRecord(
        JSON.parse(bytes.toString("utf8")) as unknown,
      );
      if (
        task.projectId !== record.projectId ||
        JSON.stringify(task) !== JSON.stringify(record.legacy.legacyTaskRecord)
      )
        throw new Error(
          "Snapshot task source does not match preserved task identity",
        );
      matchingTaskCount += 1;
    }
  }
  if (seenPaths.size !== manifestByPath.size)
    throw new Error("Source snapshot is missing manifest entries");
  if (matchingTaskCount !== 1)
    throw new Error(
      "Snapshot must contain exactly one matching task authority",
    );
}

interface MigrationMarker {
  version: 1;
  integrationId: string;
  attemptId: string;
  manifestHash: string;
  sourceManifest: unknown;
  expectedPrior: ReturnType<RunRegistry["read"]>;
  stage:
    | "snapshots-complete"
    | "candidate-installed"
    | "pointer-published"
    | "complete"
    | "artifacts-durable"
    | "candidate-durable"
    | "pointer-durable";
}

const registryPointerSchema = z.strictObject({
  version: z.literal(1),
  integrationId: z.string().min(1),
  attemptId: z.string().min(1),
  generation: z.number().int().positive().safe(),
});

function ensureSafeDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of path
    .relative(parsed.root, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        const parent = fs.openSync(path.dirname(current), "r");
        try {
          fs.fsyncSync(parent);
        } finally {
          fs.closeSync(parent);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe migration directory: ${current}`);
  }
}

function writeMigrationMarker(file: string, marker: MigrationMarker): void {
  ensureSafeDirectory(path.dirname(file));
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Unsafe migration marker target; original preserved");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(marker)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function readMigrationMarker(file: string): unknown {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error(
        "Unsafe or oversized migration marker; preserve project blockage",
      );
    return JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Recoverable local-only handoff. The callback is a deterministic crash-test
 * barrier and runs after each durable boundary; this protocol never dispatches
 * an external mutation. Existing records require an explicit fenced takeover. */
export function migrateLegacyAttempt(options: {
  store: RunStore;
  registry: RunRegistry;
  lease: RunStoreLease;
  candidate: ReturnType<typeof buildLegacyRunSnapshot>;
  markerRoot: string;
  afterDurableStage?: (stage: MigrationMarker["stage"]) => void;
}): RunRecord {
  options.lease.assertHeld();
  const { store, registry, candidate, lease } = options;
  const stagedArtifacts = store.stageImportArtifacts(candidate.artifacts);
  if (
    JSON.stringify(stagedArtifacts) !==
    JSON.stringify(candidate.record.artifacts)
  )
    throw new Error(
      "Staged snapshot artifacts do not match candidate manifest; migration blocked",
    );
  options.afterDurableStage?.("artifacts-durable");
  const sourceManifest = candidate.record.legacy.sourceManifest;
  const manifestHash = String(candidate.record.legacy.sourceManifestHash);
  assertManifestIntegrity(candidate.record);
  const markerId = createHash("sha256")
    .update(`${lease.integrationId}:${candidate.record.attemptId}`)
    .digest("hex");
  const markerPath = path.join(
    options.markerRoot,
    "migrations",
    `${markerId}.json`,
  );
  ensureSafeDirectory(path.dirname(markerPath));
  const expectedPrior = registry.read();
  let marker: MigrationMarker;
  if (fs.existsSync(markerPath)) {
    const parsed = readMigrationMarker(markerPath);
    const schema = z.strictObject({
      version: z.literal(1),
      integrationId: z.string(),
      attemptId: z.string(),
      manifestHash: z.string(),
      sourceManifest: z.unknown(),
      expectedPrior: registryPointerSchema.nullable(),
      stage: z.enum([
        "snapshots-complete",
        "candidate-installed",
        "pointer-published",
        "complete",
        "artifacts-durable",
        "candidate-durable",
        "pointer-durable",
      ]),
    });
    const validated = schema.parse(parsed);
    if (
      validated.integrationId !== lease.integrationId ||
      validated.attemptId !== candidate.record.attemptId ||
      validated.manifestHash !== manifestHash ||
      JSON.stringify(validated.sourceManifest) !==
        JSON.stringify(sourceManifest)
    )
      throw new Error(
        "Conflicting migration marker; preserve project blockage",
      );
    marker = validated as MigrationMarker;
  } else {
    marker = {
      version: 1,
      integrationId: lease.integrationId,
      attemptId: candidate.record.attemptId,
      manifestHash,
      sourceManifest,
      expectedPrior,
      stage: "snapshots-complete",
    };
    writeMigrationMarker(markerPath, marker);
    options.afterDurableStage?.(marker.stage);
  }
  let current = store.read();
  if (!current && marker.stage !== "snapshots-complete")
    throw new Error(
      "Migration marker records an installed/published candidate that is missing; stale legacy state will not be re-imported",
    );
  if (!current && expectedPrior?.attemptId === marker.attemptId)
    throw new Error(
      "Registry points to a missing migrated attempt; preserve project blockage",
    );
  if (current) {
    assertManifestIntegrity(current);
    if (
      current.attemptId !== candidate.record.attemptId ||
      current.legacy.sourceManifestHash !== manifestHash
    )
      throw new Error(
        "Installed candidate provenance conflicts; ownership unchanged",
      );
  }
  if (
    current &&
    (current.owner.instanceId !== lease.instanceId ||
      current.owner.token !== lease.token)
  ) {
    current = store.takeOwnership(
      current.revision,
      current.owner.generation,
      lease.token,
    );
  }
  if (!current) {
    store.importSnapshot(candidate.record, candidate.artifacts);
    options.afterDurableStage?.("candidate-durable");
  } else if (
    current.attemptId !== marker.attemptId ||
    current.legacy.sourceManifestHash !== marker.manifestHash
  )
    throw new Error(
      "Installed candidate conflicts with migration source manifest",
    );
  if (marker.stage === "snapshots-complete") {
    marker = { ...marker, stage: "candidate-installed" };
    writeMigrationMarker(markerPath, marker);
    options.afterDurableStage?.(marker.stage);
  }
  const pointer = registry.read();
  if (pointer?.attemptId !== marker.attemptId) {
    registry.handoff(
      store,
      marker.expectedPrior,
      marker.expectedPrior ? marker.expectedPrior.generation + 1 : 1,
    );
    options.afterDurableStage?.("pointer-durable");
  }
  if (marker.stage === "candidate-installed") {
    marker = { ...marker, stage: "pointer-published" };
    writeMigrationMarker(markerPath, marker);
    options.afterDurableStage?.(marker.stage);
  }
  registry.reconcile();
  if (marker.stage !== "complete") {
    marker = { ...marker, stage: "complete" };
    writeMigrationMarker(markerPath, marker);
    options.afterDurableStage?.(marker.stage);
  }
  return store.assertLeaseForImport();
}

/** Production-facing T3 orchestration entry point: exact configured paths,
 * family validation and cross-record blockers must pass before any candidate or
 * pointer can be created. */
export function migrateLegacyProject(options: {
  runtimeRoot: string;
  project: ProjectConfig;
  pinned: RunRecord["pinned"];
  lease: RunStoreLease;
  store: RunStore;
  storeForAttempt?: (attemptId: string) => RunStore;
  registry: RunRegistry;
  now?: Date;
  afterDurableStage?: (stage: MigrationMarker["stage"]) => void;
}): { status: "imported"; record: RunRecord } | { status: "no-legacy-task" } {
  const inventory = inventoryLegacyProject({
    runtimeRoot: options.runtimeRoot,
    project: options.project,
  });
  if (inventory.blockers.length)
    throw new Error(
      `Legacy project migration blocked: ${inventory.blockers.join("; ")}`,
    );
  const tasks = inventory.records.filter(
    (source) => source.family === "task-executions",
  );
  if (tasks.length === 0) {
    if (inventory.records.length)
      throw new Error(
        "Legacy records exist without a task authority; project claim blocked",
      );
    return { status: "no-legacy-task" };
  }
  if (tasks.length !== 1)
    throw new Error(
      "Multiple legacy task records require explicit project-level reconciliation",
    );
  const task = tasks[0]!;
  const candidate = buildLegacyRunSnapshot({
    rawTask: task.parsed,
    sources: inventory.records,
    pinned: options.pinned,
    lease: options.lease,
    ...(options.now ? { now: options.now } : {}),
  });
  const markerId = createHash("sha256")
    .update(`${options.lease.integrationId}:${candidate.record.attemptId}`)
    .digest("hex");
  const markerPath = path.join(
    options.pinned.storageRoot,
    "migrations",
    `${markerId}.json`,
  );
  const currentPointer = options.registry.read();
  if (fs.existsSync(markerPath)) {
    const marker = z
      .object({
        version: z.literal(1),
        integrationId: z.string(),
        attemptId: z.string(),
        manifestHash: z.string(),
        stage: z.enum([
          "snapshots-complete",
          "candidate-installed",
          "pointer-published",
          "complete",
          "artifacts-durable",
          "candidate-durable",
          "pointer-durable",
        ]),
      })
      .passthrough()
      .parse(readMigrationMarker(markerPath));
    if (
      marker.integrationId !== options.lease.integrationId ||
      marker.attemptId !== candidate.record.attemptId ||
      marker.manifestHash !== candidate.record.legacy.sourceManifestHash
    )
      throw new Error(
        "Legacy migration marker identity conflicts with source snapshot",
      );
    if (
      marker.stage === "complete" &&
      currentPointer?.attemptId === candidate.record.attemptId
    ) {
      const existingStore = RunStore.openWithPersistedIdentity(
        options.pinned.storageRoot,
        candidate.record.attemptId,
        options.lease,
      );
      if (!existingStore)
        throw new Error("Completed migration candidate disappeared");
      const existing = existingStore.read();
      if (
        !existing ||
        existing.legacy.sourceManifestHash !==
          candidate.record.legacy.sourceManifestHash
      )
        throw new Error(
          "Completed legacy migration marker does not match its durable candidate",
        );
      return { status: "imported", record: existing };
    }
    if (
      marker.stage === "complete" &&
      currentPointer !== null &&
      currentPointer.attemptId !== candidate.record.attemptId
    )
      return { status: "no-legacy-task" };
  }
  const record = migrateLegacyAttempt({
    store:
      options.storeForAttempt?.(candidate.record.attemptId) ?? options.store,
    registry: options.registry,
    lease: options.lease,
    candidate,
    markerRoot: options.pinned.storageRoot,
    ...(options.afterDurableStage
      ? { afterDurableStage: options.afterDurableStage }
      : {}),
  });
  return { status: "imported", record };
}
