import path from "node:path";
import type { CommandRunner } from "../process/command-runner.js";

interface ListedOpenCodeSession {
  id: string;
  directory: string;
}

export class OpenCodeSessionListError extends Error {
  public readonly executionId?: string;
  public readonly stdoutArtifactReference?: string;

  constructor(
    message: string,
    origin?: { executionId?: string; stdoutArtifactReference?: string },
  ) {
    super(message);
    this.name = "OpenCodeSessionListError";
    if (origin?.executionId !== undefined) this.executionId = origin.executionId;
    if (origin?.stdoutArtifactReference !== undefined)
      this.stdoutArtifactReference = origin.stdoutArtifactReference;
  }
}

export function parseOpenCodeSessionList(output: string): ListedOpenCodeSession[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    // Parser messages may include the untrusted session-list stdout.
    throw new Error("OpenCode session list was not valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("OpenCode session list was not a JSON array");

  return value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      !("directory" in entry) ||
      typeof entry.directory !== "string" ||
      !path.isAbsolute(entry.directory)
    ) {
      throw new Error(`OpenCode session list entry ${index} is malformed`);
    }
    return { id: entry.id, directory: path.resolve(entry.directory) };
  });
}

/** A stopped initial dispatch may be retried only after ruling out an unbound session. */
export async function inspectUnboundOpenCodeSessions(options: {
  commands: CommandRunner;
  cwd: string;
  signal: AbortSignal;
  timeoutMilliseconds: number;
}): Promise<"absent" | "present" | "unknown"> {
  try {
    const result = await options.commands.run({
      cwd: options.cwd,
      command: "opencode session list --format json --pure --max-count 10000",
      signal: options.signal,
      timeoutMilliseconds: options.timeoutMilliseconds,
      captureOutput: true,
      capturePolicy: "complete",
      maxCaptureOutputLength: 4 * 1024 * 1024,
      suppressOutput: true,
    });
    if (result.exitCode !== 0 || result.output === undefined) return "unknown";
    const sessions = parseOpenCodeSessionList(result.output);
    if (sessions.length >= 10_000) return "unknown";
    return sessions.some((session) => session.directory === path.resolve(options.cwd))
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  }
}

/** Return null when session availability cannot be authoritatively checked. */
export async function inspectPrimaryOpenCodeSession(options: {
  commands: CommandRunner;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  timeoutMilliseconds: number;
}): Promise<"reachable" | "confirmed-absent" | "conflict" | "unknown"> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options.sessionId)) return "unknown";
  try {
    const result = await options.commands.run({
      cwd: options.cwd,
      command: "opencode session list --format json --pure --max-count 10000",
      signal: options.signal,
      timeoutMilliseconds: options.timeoutMilliseconds,
      captureOutput: true,
      capturePolicy: "complete",
      maxCaptureOutputLength: 4 * 1024 * 1024,
      suppressOutput: true,
    });
    if (result.exitCode !== 0 || result.output === undefined) return "unknown";
    let sessions: ListedOpenCodeSession[];
    try {
      sessions = parseOpenCodeSessionList(result.output);
    } catch (error) {
      throw new OpenCodeSessionListError(
        error instanceof Error ? error.message : "OpenCode session list was malformed",
        result,
      );
    }
    if (sessions.length >= 10_000) return "unknown";
    const matching = sessions.filter(({ id }) => id === options.sessionId);
    if (matching.length > 1) return "conflict";
    if (matching.length === 0) return "confirmed-absent";
    return matching[0]!.directory === path.resolve(options.cwd) ? "reachable" : "conflict";
  } catch (error) {
    if (options.signal.aborted)
      // Do not retain the runner error: it may contain untrusted child output.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("OpenCode session inspection aborted");
    if (error instanceof OpenCodeSessionListError) throw error;
    return "unknown";
  }
}
