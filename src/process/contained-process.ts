import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import os from "node:os";
import { ProcessEvidenceError, registerContainedProcessControl } from "./process-runtime.js";

export const processSupervisorPath = fileURLToPath(
  new URL("../../scripts/contained-process-supervisor.mjs", import.meta.url),
);

// Resolve the service's containment binary before any task-specific environment
// is installed. A task PATH must not replace the process supervisor.
function resolveBubblewrap(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "bwrap");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      /* Try the next service PATH entry. */
    }
  }
  return undefined;
}
const bubblewrap = resolveBubblewrap();

function rootIsReadOnly(): boolean {
  try {
    const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    const root = mounts.map((line) => line.split(" ")).find((fields) => fields[4] === "/");
    if (!root?.[5]) throw new Error("Root mount unavailable");
    return root[5].split(",").includes("ro");
  } catch {
    throw new ProcessContainmentUnavailableError();
  }
}

export class ProcessContainmentUnavailableError extends Error {
  constructor() {
    super(
      "Managed execution requires Linux Bubblewrap with working PID/user/mount namespaces; install bwrap and permit the startup isolation probe",
    );
    this.name = "ProcessContainmentUnavailableError";
  }
}

/** Preserve filesystem/network access, but contain ALL descendants, including
 * setsid()/detached children. PID-namespace init death is kernel-enforced cleanup.
 * Writable OpenCode dispatch uses its stricter filesystem sandbox instead. */
export function containedProcess(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (process.platform !== "linux" || !bubblewrap) throw new ProcessContainmentUnavailableError();
  if (command.includes("\0") || args.some((argument) => argument.includes("\0")))
    throw new Error("Managed command contains an unsupported NUL argument");
  return {
    command: bubblewrap,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--as-pid-1",
      "--bind",
      "/",
      "/",
      "--dev-bind",
      "/dev",
      "/dev",
      "--proc",
      "/proc",
      ...(rootIsReadOnly() ? ["--remount-ro", "/"] : []),
      "--",
      process.execPath,
      processSupervisorPath,
      command,
      ...args,
    ],
  };
}

/** Credential stdout stays in memory and has no public status channel. The
 * ordinary Bubblewrap init still contains descendants and bounds its lifetime. */
export function containedCredentialRead(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const dispatch = containedProcess(command, args);
  dispatch.args = dispatch.args.filter((argument) => argument !== "--as-pid-1");
  const separator = dispatch.args.indexOf("--");
  dispatch.args = [...dispatch.args.slice(0, separator + 1), command, ...args];
  return dispatch;
}

export interface ContainedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawned: boolean | undefined;
  supervisorCode: number | null;
}

/** Separate bounded control/status channels preserve payload semantics without
 * trusting stdout/stderr or killing a cooperative payload through its monitor. */
export function observeContainedProcess(child: ChildProcess, onFailure: (error: Error) => void) {
  const status = child.stdio?.[3] as Readable | null | undefined;
  const control = child.stdio?.[4] as Writable | null | undefined;
  let pending = "";
  let started = false;
  let result: { code: number | null; signal: NodeJS.Signals | null; spawned: boolean } | undefined;
  let failure: Error | undefined;
  const invalid = () => {
    if (failure) return;
    failure = new ProcessEvidenceError("Contained process status is incomplete or malformed");
    onFailure(failure);
  };
  status?.on("data", (chunk: Buffer | string) => {
    if (failure) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(pending) + Buffer.byteLength(text) > 4096) {
      invalid();
      return;
    }
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          invalid();
          return;
        }
        const record = value as Record<string, unknown>;
        if (record.type === "started" && !started && !result) {
          started = true;
          continue;
        }
        if (
          record.type !== "result" ||
          result ||
          typeof record.spawned !== "boolean" ||
          (record.spawned && !started) ||
          !(
            record.code === null ||
            (Number.isInteger(record.code) &&
              (record.code as number) >= 0 &&
              (record.code as number) <= 255)
          ) ||
          !(
            record.signal === null ||
            (typeof record.signal === "string" &&
              Object.hasOwn(os.constants.signals, record.signal))
          ) ||
          (record.spawned && (record.code === null) === (record.signal === null)) ||
          (!record.spawned && (started || record.code !== null || record.signal !== null))
        ) {
          invalid();
          return;
        }
        result = {
          code: record.code as number | null,
          signal: record.signal as NodeJS.Signals | null,
          spawned: record.spawned,
        };
      } catch {
        invalid();
        return;
      }
    }
  });
  status?.on("error", invalid);
  control?.on("error", () => {
    /* The hard-kill deadline still supervises parent loss. */
  });
  const unregister =
    child.pid === undefined || !control
      ? () => undefined
      : registerContainedProcessControl(child.pid, (signal) => {
          if (control.destroyed || !control.writable) return false;
          control.write(`${JSON.stringify({ signal })}\n`);
          return true;
        });
  child.once("close", unregister);
  return {
    result(code: number | null, signal: NodeJS.Signals | null | undefined): ContainedProcessResult {
      if (failure || pending.trim().length > 0)
        throw failure ?? new ProcessEvidenceError("Contained process status was truncated");
      if (result) return { ...result, supervisorCode: code };
      if (signal) return { code: null, signal, spawned: undefined, supervisorCode: code };
      throw new ProcessEvidenceError(
        "Contained process supervisor closed without a verified payload result",
      );
    },
  };
}
