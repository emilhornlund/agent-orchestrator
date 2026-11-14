import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectRunAuthority } from "./project-run-authority.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { runTaskResources } from "./task-resources.js";

const common = {
  kind: z.literal("operator-confirmed-stopped-startup"),
  attemptId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  worktreePath: z.string().min(1),
  confirmedStopped: z.literal(true),
  sessionInventory: z.enum(["absent", "existing-session-verified"]),
  sessionId: z.string().nullable().optional(),
  observedAt: z.iso.datetime(),
};
const legacySchema = z.strictObject({ version: z.literal(1), ...common });
const schema = z.strictObject({
  version: z.literal(2),
  ...common,
  cardId: z.string().min(1),
  executions: z
    .array(
      z.strictObject({
        executionId: z.string().min(1),
        metadataSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .max(256),
});

function executionDirectory(authority: ProjectRunAuthority, cardId: string): string {
  return path.join(
    authority.store.storageRoot,
    "artifacts",
    encodeURIComponent(authority.projectId),
    encodeURIComponent(cardId),
    encodeURIComponent(authority.store.attemptId),
    "process-executions",
  );
}

/** Called only after the operator's explicit stopped-tree assertion and all
 * startup-recovery ownership guards. Bind the assertion to exact metadata bytes. */
export function recordStartupStopAttestation(options: {
  authority: ProjectRunAuthority;
  task: TaskExecutionRecord;
  sessionId?: string;
}): void {
  const { authority, task } = options;
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  if (
    run.cardId !== task.cardId ||
    Object.keys(task.primaryOperations ?? {}).length > 0 ||
    task.pullRequest
  )
    throw new Error("Startup stop assertion does not match an unpublished initial attempt");
  const worktreePath = runTaskResources(run).path;
  const directory = executionDirectory(authority, task.cardId);
  const executions: z.infer<typeof schema>["executions"] = [];
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (parent) {
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    )
      throw new Error("Unsafe startup execution evidence directory");
    for (const id of fs.readdirSync(directory)) {
      const file = path.join(directory, id, "execution.json");
      if (fs.realpathSync(path.dirname(file)) !== path.dirname(file))
        throw new Error("Unsafe startup execution evidence path");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        throw new Error("Unsafe startup execution metadata");
      const bytes = fs.readFileSync(file);
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid startup execution metadata");
      const value = raw as Record<string, unknown>;
      if (
        value.executionId !== id ||
        value.cwd !== worktreePath ||
        typeof value.command !== "string" ||
        !/^opencode run(?: |$)/u.test(value.command) ||
        value.treeStopped === true
      )
        continue;
      executions.push({
        executionId: id,
        metadataSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (executions.length > 256)
        throw new Error("Startup assertion exceeds its bounded execution scope");
    }
  }
  const proof = schema.parse({
    version: 2,
    kind: "operator-confirmed-stopped-startup",
    attemptId: run.attemptId,
    cardId: task.cardId,
    taskRevision: task.revision,
    worktreePath,
    confirmedStopped: true,
    observedAt: new Date().toISOString(),
    sessionInventory: options.sessionId === undefined ? "absent" : "existing-session-verified",
    sessionId: options.sessionId ?? null,
    executions,
  });
  const artifact = authority.store.writeArtifact(
    Buffer.from(JSON.stringify(proof)),
    "application/json",
  );
  authority.store.referenceMutationArtifact(
    authority.store.read()!.revision,
    authority.ownerGeneration,
    artifact,
  );
}

/** Recognize scoped operator proof without rewriting or ignoring old process
 * metadata. Legacy v1 assertions apply only to the original missing-finalization
 * startup signature, unchanged since the assertion, never to later task work. */
export function startupStopProofForExecution(options: {
  authority: ProjectRunAuthority;
  task: TaskExecutionRecord;
  file: string;
  metadata: Record<string, unknown>;
}): string | null {
  const { authority, task, file, metadata } = options;
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  const expectedDirectory = executionDirectory(authority, task.cardId);
  if (
    path.dirname(path.dirname(file)) !== expectedDirectory ||
    path.basename(path.dirname(file)) !== metadata.executionId ||
    metadata.cwd !== runTaskResources(run).path ||
    typeof metadata.command !== "string" ||
    !/^opencode run(?: |$)/u.test(metadata.command)
  )
    return null;
  const directory = path.join(run.pinned.storageRoot, "artifacts", run.attemptId);
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !parent ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  )
    return null;
  const metadataStat = fs.lstatSync(file);
  if (
    !metadataStat.isFile() ||
    metadataStat.isSymbolicLink() ||
    metadataStat.size > 64 * 1024 ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    return null;
  const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const name of fs.readdirSync(directory)) {
    if (!/^sha256-[a-f0-9]{64}$/u.test(name)) continue;
    const candidate = path.join(directory, name);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
    const id = `sha256:${name.slice(7)}`;
    let bytes: Buffer;
    let raw: unknown;
    try {
      bytes = authority.store.readArtifact(id);
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    const parsed = schema.safeParse(raw);
    const legacy = parsed.success ? null : legacySchema.safeParse(raw);
    const proof = parsed.success ? parsed.data : legacy?.success ? legacy.data : null;
    if (
      !proof ||
      proof.attemptId !== run.attemptId ||
      proof.worktreePath !== metadata.cwd ||
      proof.taskRevision > task.revision ||
      Date.parse(proof.observedAt) < Date.parse(task.createdAt)
    )
      continue;
    let matches: boolean;
    if (parsed.success) {
      matches =
        parsed.data.cardId === task.cardId &&
        parsed.data.executions.some(
          (execution) =>
            execution.executionId === metadata.executionId && execution.metadataSha256 === digest,
        );
    } else {
      const observed = Date.parse(proof.observedAt);
      const started = typeof metadata.startedAt === "string" ? Date.parse(metadata.startedAt) : NaN;
      matches =
        metadata.status === "running" &&
        metadata.dispatchState === "dispatch-pending" &&
        metadata.pid === undefined &&
        Number.isFinite(started) &&
        started >= Date.parse(task.createdAt) &&
        started <= observed &&
        metadataStat.mtimeMs <= observed &&
        !Object.values(task.primaryOperations ?? {}).some(
          (operation) => operation.processExecutionId === metadata.executionId,
        );
    }
    if (!matches) continue;
    if (!run.artifacts.some((artifact) => artifact.id === id)) {
      const artifact = authority.store.writeArtifact(bytes!, "application/json");
      authority.store.referenceMutationArtifact(
        authority.store.read()!.revision,
        authority.ownerGeneration,
        artifact,
      );
    }
    return id;
  }
  return null;
}
