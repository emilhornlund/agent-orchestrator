import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../security/redact-secrets.js";
import type { ChildProcess } from "node:child_process";

let runtimeRoot: string | undefined;
let lifecycleSignal: AbortSignal | undefined;
const operationSignal = new AsyncLocalStorage<AbortSignal>();
export function withProcessCancellationSignal<T>(signal: AbortSignal, operation: () => T): T {
  return operationSignal.run(signal, operation);
}
let secretValues: readonly string[] = [];
const registeredSecrets = new Set<string>();
const containedControls = new Map<
  number,
  { send: (signal: NodeJS.Signals) => boolean; startIdentity: string | undefined }
>();
export function registerContainedProcessControl(
  pid: number,
  send: (signal: NodeJS.Signals) => boolean,
): () => void {
  const entry = { send, startIdentity: processStartIdentity(pid) };
  containedControls.set(pid, entry);
  return () => {
    if (containedControls.get(pid) === entry) containedControls.delete(pid);
  };
}
let operationTimeoutMilliseconds = 2 * 60 * 1_000;
const ambiguityHandler = new AsyncLocalStorage<(pid: number | undefined) => void>();
export interface ProcessArtifactEvent {
  type: "process-started" | "process-finished";
  executionId: string;
  startedAt: string;
  finishedAt?: string;
  durationMilliseconds?: number;
  status?: string;
  stdoutArtifact: string;
  stderrArtifact: string;
  metadataArtifact: string;
}

const taskArtifactContext = new AsyncLocalStorage<{
  root: string;
  projectId: string;
  cardId: string;
  attemptId: string;
  recordEvent?: (event: ProcessArtifactEvent) => void;
}>();

function processStartIdentity(pid: number | undefined): string | undefined {
  if (pid === undefined || process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    const startTicks = fields[19];
    return startTicks && /^\d+$/u.test(startTicks) ? startTicks : undefined;
  } catch {
    return undefined;
  }
}

/** `null` is uncertainty (including unsupported platforms), never proof of absence. */
export function isSameProcessInstance(pid: number, expectedStartIdentity: unknown): boolean | null {
  if (typeof expectedStartIdentity !== "string") return null;
  const actual = processStartIdentity(pid);
  if (actual === undefined) return null;
  return actual === expectedStartIdentity;
}

export interface ProcessExecutionEvidence {
  executionId: string;
  command: string;
  cwd: string;
  status: string;
  treeStopped?: boolean;
  dispatchState?: string;
  exitCode?: number;
}

export function isVerifiedStoppedExecution(
  value: unknown,
  expected: { executionId: string; command: string; cwd: string },
): value is ProcessExecutionEvidence {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  if (
    evidence.executionId !== expected.executionId ||
    evidence.command !== expected.command ||
    typeof evidence.cwd !== "string" ||
    path.resolve(evidence.cwd) !== path.resolve(expected.cwd) ||
    typeof evidence.status !== "string"
  )
    return false;
  return (
    evidence.status === "not-dispatched" ||
    (evidence.treeStopped === true &&
      ["nonzero", "timeout", "interrupted", "spawn-failure"].includes(evidence.status)) ||
    (evidence.status === "spawn-failure" && evidence.dispatchState === "not-dispatched")
  );
}

export function isVerifiedSuccessfulExecution(
  value: unknown,
  expected: { executionId: string; command: string; cwd: string },
): value is ProcessExecutionEvidence {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return (
    evidence.executionId === expected.executionId &&
    evidence.command === expected.command &&
    typeof evidence.cwd === "string" &&
    path.resolve(evidence.cwd) === path.resolve(expected.cwd) &&
    evidence.status === "success" &&
    evidence.exitCode === 0 &&
    evidence.treeStopped === true
  );
}

export function withTaskProcessArtifacts<T>(
  context: {
    root: string;
    projectId: string;
    cardId: string;
    attemptId: string;
    recordEvent?: (event: ProcessArtifactEvent) => void;
  },
  operation: () => T,
): T {
  return taskArtifactContext.run(context, operation);
}

export function withProcessGroupAmbiguityHandler<T>(
  handler: (pid: number | undefined) => void,
  operation: () => T,
): T {
  return ambiguityHandler.run(handler, operation);
}

/** A process cannot retain more than this much combined stream evidence. */
export const PROCESS_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;

export class ProcessEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessEvidenceError";
  }
}

export const PROCESS_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;

export class ProcessOutputLimitError extends Error {
  constructor(
    stream: "stdout" | "stderr",
    limit = PROCESS_CAPTURE_MAX_BYTES,
    executionId?: string,
  ) {
    super(
      `Process ${stream} exceeded the ${limit}-byte output limit${executionId === undefined ? "" : `; diagnostics: process-executions/${executionId}/${stream}.txt`}`,
    );
    this.name = "ProcessOutputLimitError";
  }
}

export type ProcessFailureClassification = "spawn-failure" | "nonzero" | "timeout" | "interrupted";
const processFailureDiagnostics = new WeakMap<ProcessExecutionError, string>();

/** Safe public process failure; raw diagnostics remain in the execution artifact. */
export class ProcessExecutionError extends Error {
  constructor(
    tool: string,
    public readonly executionId: string,
    public readonly classification: ProcessFailureClassification,
    public readonly exitCode?: number,
    public readonly signal?: NodeJS.Signals,
    diagnostic?: string,
  ) {
    const state =
      classification === "nonzero"
        ? `exited with code ${exitCode ?? 1}${signal === undefined ? "" : ` (${signal})`}`
        : classification.replace("-", " ");
    super(`${tool} ${state}; diagnostics: process-executions/${executionId}/stderr.txt`);
    this.name = "ProcessExecutionError";
    if (diagnostic !== undefined) processFailureDiagnostics.set(this, diagnostic);
  }
}

export function getProcessFailureDiagnostic(error: ProcessExecutionError): string | undefined {
  return processFailureDiagnostics.get(error);
}

/** Retain complete output or reject; callers must never parse a prefix. */
export function appendBoundedOutput(
  current: string,
  text: string,
  stream: "stdout" | "stderr",
  limit = PROCESS_CAPTURE_MAX_BYTES,
): string {
  if (Buffer.byteLength(current) + Buffer.byteLength(text) > limit)
    throw new ProcessOutputLimitError(stream, limit);
  return current + text;
}

/** Configure process execution evidence and cancellation for the production runtime. */
export function configureProcessRuntime(options: {
  runtimeRoot: string;
  signal: AbortSignal;
  secretValues?: readonly string[];
  operationTimeoutMilliseconds?: number;
}): void {
  runtimeRoot = path.resolve(options.runtimeRoot);
  lifecycleSignal = options.signal;
  secretValues = options.secretValues ?? [];
  for (const value of secretValues) if (value.length > 0) registeredSecrets.add(value);
  operationTimeoutMilliseconds =
    options.operationTimeoutMilliseconds ?? operationTimeoutMilliseconds;
}

export function getProcessRuntime(): {
  artifactRoot: string;
  signal?: AbortSignal;
  secretValues: readonly string[];
  operationTimeoutMilliseconds: number;
} {
  const signal = operationSignal.getStore() ?? lifecycleSignal;
  return {
    artifactRoot: runtimeRoot ?? path.join(os.tmpdir(), "agent-orchestrator-process-artifacts"),
    ...(signal === undefined ? {} : { signal }),
    secretValues: [...new Set([...secretValues, ...registeredSecrets])],
    operationTimeoutMilliseconds,
  };
}

/** Register credentials created at runtime (for example scoped App tokens). */
export function registerProcessSecrets(values: readonly string[]): void {
  for (const value of values) if (value.length > 0) registeredSecrets.add(value);
}

export function beginProcessEvidence(
  command: string,
  cwd: string,
  secrets: readonly string[] = [],
  artifactRootOverride?: string,
) {
  const taskContext = taskArtifactContext.getStore();
  const executionsRoot = artifactRootOverride
    ? artifactRootOverride
    : taskContext
      ? path.join(
          taskContext.root,
          "artifacts",
          encodeURIComponent(taskContext.projectId),
          encodeURIComponent(taskContext.cardId),
          encodeURIComponent(taskContext.attemptId),
          "process-executions",
        )
      : path.join(getProcessRuntime().artifactRoot, "process-executions");
  const executionId = randomUUID();
  const directory = path.join(executionsRoot, executionId);
  const stdoutPath = path.join(directory, "stdout.txt");
  const stderrPath = path.join(directory, "stderr.txt");
  const startedAt = new Date().toISOString();
  const startedMilliseconds = Date.now();
  const safeCommand = redactSecrets(command, secrets);
  const safeCwd = redactSecrets(cwd, secrets);
  const metadataPath = path.join(directory, "execution.json");
  taskContext?.recordEvent?.({
    type: "process-started",
    executionId,
    startedAt,
    stdoutArtifact: stdoutPath,
    stderrArtifact: stderrPath,
    metadataArtifact: metadataPath,
  });
  const writeMetadata = (metadata: Record<string, unknown>) =>
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify({ executionId, command: safeCommand, cwd: safeCwd, startedAt, stdoutArtifact: stdoutPath, stderrArtifact: stderrPath, ...metadata }, null, 2)}\n`,
      { mode: 0o600 },
    );
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stdoutPath, "", { mode: 0o600 });
    fs.writeFileSync(stderrPath, "", { mode: 0o600 });
    writeMetadata({ status: "running", dispatchState: "dispatch-pending" });
  } catch (error) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Preserve initialization failure. */
    }
    throw new ProcessEvidenceError("Could not initialize process evidence", {
      cause: error,
    });
  }
  let bytesWritten = 0;
  let finished = false;
  let failure: ProcessEvidenceError | undefined;
  let dispatchIdentity: Record<string, unknown> = {};
  return {
    executionId,
    metadataPath,
    artifactRoot: executionsRoot,
    dispatched(pid: number | undefined, containment?: "linux-pid-namespace") {
      const startIdentity = processStartIdentity(pid);
      dispatchIdentity = {
        pid,
        ...(startIdentity === undefined ? {} : { pidStartIdentity: startIdentity }),
        ...(containment === undefined ? {} : { containment }),
      };
      writeMetadata({
        status: "running",
        dispatchState: "dispatched",
        pid,
        ...(startIdentity === undefined ? {} : { pidStartIdentity: startIdentity }),
        ...(containment === undefined ? {} : { containment }),
      });
    },
    get failure() {
      return failure;
    },
    append(stream: "stdout" | "stderr", text: string) {
      if (finished || failure !== undefined) return;
      const bytes = Buffer.byteLength(text);
      if (bytesWritten + bytes > PROCESS_EVIDENCE_MAX_BYTES) {
        failure = new ProcessEvidenceError(
          `Process evidence exceeded ${PROCESS_EVIDENCE_MAX_BYTES} bytes`,
        );
        return;
      }
      try {
        fs.appendFileSync(stream === "stdout" ? stdoutPath : stderrPath, text);
        bytesWritten += bytes;
      } catch (error) {
        failure = new ProcessEvidenceError("Could not append process evidence", { cause: error });
      }
    },
    finish(status: string, fields: Record<string, unknown> = {}) {
      if (finished) return;
      finished = true;
      try {
        const finishedAt = new Date().toISOString();
        const durationMilliseconds = Date.now() - startedMilliseconds;
        const { result, ...summary } = fields;
        let finalStatus = status;
        let resultArtifact: { path: string; sha256: string } | undefined;
        if (result !== undefined) {
          const bytes = Buffer.from(JSON.stringify(result));
          if (bytes.byteLength > 700 * 1024) finalStatus = "evidence-failure";
          else {
            const resultPath = path.join(directory, "result.json");
            const temporary = `${resultPath}.${randomUUID()}.tmp`;
            fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
            fs.renameSync(temporary, resultPath);
            resultArtifact = {
              path: "result.json",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }
        }
        writeMetadata({
          ...dispatchIdentity,
          finishedAt,
          durationMilliseconds,
          status: finalStatus,
          ...(status === "not-dispatched" ||
          (status === "spawn-failure" && fields.pid === undefined)
            ? { dispatchState: "not-dispatched" }
            : { dispatchState: "dispatched" }),
          treeStopped:
            status === "timeout" ||
            status === "interrupted" ||
            status === "nonzero" ||
            status === "success",
          ...summary,
          ...(resultArtifact === undefined ? {} : { resultArtifact }),
        });
        taskContext?.recordEvent?.({
          type: "process-finished",
          executionId,
          startedAt,
          finishedAt,
          durationMilliseconds,
          status: finalStatus,
          stdoutArtifact: stdoutPath,
          stderrArtifact: stderrPath,
          metadataArtifact: metadataPath,
        });
      } catch (error) {
        throw new ProcessEvidenceError("Could not finalize process evidence", {
          cause: error,
        });
      }
    },
  };
}

export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback?: (signal: NodeJS.Signals) => boolean,
): void {
  if (pid === undefined || process.platform === "win32") {
    fallback?.(signal);
    return;
  }
  const contained = containedControls.get(pid);
  if (contained) {
    if (["SIGTERM", "SIGINT"].includes(signal) && contained.send(signal)) return;
    if (isSameProcessInstance(pid, contained.startIdentity) !== true) {
      fallback?.(signal);
      return;
    }
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) fallback?.(signal);
  }
}

export function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The process group could not be proven safe to release after bounded cleanup. */
export class ProcessGroupTerminationError extends Error {
  constructor(pid: number | undefined) {
    super(`Unable to verify termination of owned process group ${pid ?? "unknown"}`);
    this.name = "ProcessGroupTerminationError";
  }
}

/** A hard-killed supervisor must close within a bounded period. If it does not,
 * retain ownership through the existing ambiguity fence, never invent stop proof. */
export function guardProcessClose(
  child: Pick<ChildProcess, "pid" | "once">,
  onUnknown: (error: ProcessGroupTerminationError) => void,
) {
  const onAmbiguity = ambiguityHandler.getStore();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const dispose = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  child.once("close", () => {
    closed = true;
    dispose();
  });
  return {
    dispose,
    afterHardKill() {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        onAmbiguity?.(child.pid);
        onUnknown(new ProcessGroupTerminationError(child.pid));
      }, 2_000);
    },
  };
}

// Linux keeps orphaned zombies visible to kill(-pgid, 0) until their parent
// reaps them. They cannot execute or write, so verification must distinguish
// those entries from live group members.
function hasLiveLinuxGroupMember(pid: number): boolean | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return undefined;
  }
  let found = false;
  let uncertain = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") uncertain = true;
      continue;
    }
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      uncertain = true;
      continue;
    }
    const fields = stat.slice(closeParen + 2).split(" ");
    const state = fields[0];
    const processGroup = Number(fields[2]);
    if (!/^[A-Z]$/.test(state ?? "") || !Number.isSafeInteger(processGroup)) {
      uncertain = true;
      continue;
    }
    if (processGroup === pid && state !== "Z" && state !== "X") found = true;
  }
  return found ? true : uncertain ? undefined : false;
}

function hasLiveGroupMember(pid: number | undefined): boolean | undefined {
  if (pid === undefined || process.platform === "win32") return false;
  if (process.platform === "linux") return hasLiveLinuxGroupMember(pid);
  return processGroupExists(pid);
}

/** Do not relinquish execution ownership merely because the group leader closed its pipes. */
export async function drainProcessGroup(
  pid: number | undefined,
  fallback: (signal: NodeJS.Signals) => boolean,
  graceMilliseconds = 5_000,
): Promise<void> {
  if (!processGroupExists(pid)) return;
  signalProcessGroup(pid, "SIGTERM", fallback);
  const deadline = Date.now() + Math.max(0, graceMilliseconds);
  while (Date.now() < deadline && processGroupExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processGroupExists(pid)) signalProcessGroup(pid, "SIGKILL", fallback);
  const killDeadline = Date.now() + Math.max(250, Math.min(graceMilliseconds, 2_000));
  while (Date.now() < killDeadline) {
    const live = hasLiveGroupMember(pid);
    if (live === false) return;
    if (live === undefined) {
      ambiguityHandler.getStore()?.(pid);
      throw new ProcessGroupTerminationError(pid);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const live = hasLiveGroupMember(pid);
  if (live !== false) {
    ambiguityHandler.getStore()?.(pid);
    throw new ProcessGroupTerminationError(pid);
  }
}
