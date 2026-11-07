import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly closed: Promise<ProcessResult>;
}

/** Spawn a process in its own process group and attach close/error observation immediately. */
export function spawnOwnedProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): OwnedProcess {
  if (process.platform === "win32")
    throw new Error(
      "Owned process-group lifecycle requires POSIX process groups",
    );
  const child = spawn(command, args, { ...options, detached: true });
  const closed = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, pid: child.pid, closed };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function stopOwnedGroup(
  owned: OwnedProcess,
  termGraceMs: number,
  killGraceMs: number,
): Promise<void> {
  if (owned.pid === undefined) return;
  if (!groupExists(owned.pid)) return;
  signalGroup(owned.pid, "SIGTERM");
  if (await waitForGroupGone(owned.pid, termGraceMs)) return;
  signalGroup(owned.pid, "SIGKILL");
  if (!(await waitForGroupGone(owned.pid, killGraceMs)))
    throw new Error(`Owned process group ${owned.pid} remains after SIGKILL`);
}

/** Await close and ensure no process in this owned group outlives its owner. */
export async function waitForOwnedProcess(
  owned: OwnedProcess,
  options: { timeoutMs: number; termGraceMs?: number; killGraceMs?: number },
): Promise<ProcessResult> {
  const { timeoutMs, termGraceMs = 500, killGraceMs = 1_000 } = options;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([owned.closed, timeout]);
    // A wrapper may exit while a child still holds the group's lifetime.
    if (owned.pid !== undefined && groupExists(owned.pid))
      await stopOwnedGroup(owned, termGraceMs, killGraceMs);
    return result;
  } catch (error) {
    if (timedOut) {
      await stopOwnedGroup(owned, termGraceMs, killGraceMs);
      // The direct child may have exited while a descendant remained; its close was
      // observed at spawn time and does not imply that the group is gone.
      await owned.closed;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Legacy direct-child observer. New harness code should use spawnOwnedProcess. */
export function waitForProcess(
  child: ChildProcess,
  options: { timeoutMs: number; termGraceMs?: number; killGraceMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const { timeoutMs, termGraceMs = 500, killGraceMs = 500 } = options;
    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        escalation = setTimeout(() => {
          if (!settled)
            finishError(new Error("Child did not close after SIGKILL"));
        }, killGraceMs);
      }, termGraceMs);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      child.off("error", finishError);
      child.off("close", finishClose);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) reject(new Error(`Process timed out after ${timeoutMs}ms`));
      else resolve({ code, signal });
    };
    child.once("error", finishError);
    child.once("close", finishClose);
    if (child.exitCode !== null || child.signalCode !== null)
      finishClose(child.exitCode, child.signalCode);
  });
}

export async function runBounded(
  command: string,
  args: string[],
  options: SpawnOptions & {
    timeoutMs?: number;
    termGraceMs?: number;
    killGraceMs?: number;
  },
): Promise<ProcessResult> {
  const {
    timeoutMs = 30_000,
    termGraceMs = 500,
    killGraceMs = 1_000,
    ...spawnOptions
  } = options;
  const owned = spawnOwnedProcess(command, args, spawnOptions);
  return waitForOwnedProcess(owned, { timeoutMs, termGraceMs, killGraceMs });
}
