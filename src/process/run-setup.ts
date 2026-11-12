import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CommandRunner, CommandRunResult } from "./command-runner.js";
import { CommandRunAbortedError } from "./command-runner.js";
import type { GitClient } from "../git/git-client.js";
import { toFailureError } from "../orchestrator/failure-diagnostic.js";
import { WorkflowError } from "../orchestrator/workflow-error.js";

/** Content-addressed worktree inventory, including ignored and untracked files. */
export async function captureSetupEffects(
  gitClient: GitClient,
  worktreePath: string,
  signal?: AbortSignal,
  finishAfterAbort = false,
): Promise<Buffer> {
  if (!finishAfterAbort) signal?.throwIfAborted();
  const root = fs.realpathSync(worktreePath);
  const gitSignal = finishAfterAbort && signal?.aborted ? new AbortController().signal : signal;
  const readGit = async <T>(read: () => Promise<T>): Promise<T> => {
    if (!finishAfterAbort) signal?.throwIfAborted();
    const result = await read();
    if (!finishAfterAbort) signal?.throwIfAborted();
    return result;
  };
  const files: {
    path: string;
    kind: string;
    mode: number;
    bytes?: number;
    sha256?: string;
    target?: string;
  }[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        files.push({
          path: relative,
          kind: "symlink",
          mode: stat.mode & 0o7777,
          target: fs.readlinkSync(absolute),
        });
      } else if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const content = fs.readFileSync(absolute);
        files.push({
          path: relative,
          kind: "file",
          mode: stat.mode & 0o7777,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else
        files.push({
          path: relative,
          kind: "special",
          mode: stat.mode & 0o7777,
        });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const evidence = {
    worktree: root,
    branch: await readGit(() => gitClient.getCurrentBranch(root, gitSignal)),
    head: await readGit(() => gitClient.getHeadSha(root, gitSignal)),
    status: await readGit(() => gitClient.getStatus(root, gitSignal)),
    tracked: await readGit(() => gitClient.getHeadTrackedFiles(root, gitSignal)),
    committable: await readGit(() => gitClient.getCommittableChangedPaths(root, gitSignal)),
    untracked: await readGit(() => gitClient.getUntrackedFiles(root, gitSignal)),
    ignored: await readGit(() => gitClient.getIgnoredFiles(root, gitSignal)),
    files,
  };
  return Buffer.from(JSON.stringify(evidence), "utf8");
}

export function assertSetupInventoryIdentity(
  value: unknown,
  worktreePath: string,
  expectedBranch: string,
): asserts value is {
  worktree: string;
  branch: string;
  head: string;
  files: {
    path: string;
    kind: string;
    mode: number;
    sha256?: string;
    bytes?: number;
    target?: string;
  }[];
  tracked: string[];
  committable: string[];
  untracked: string[];
  ignored: string[];
  status: string;
} {
  if (typeof value !== "object" || value === null)
    throw new Error("Setup inventory artifact is malformed");
  const inventory = value as Record<string, unknown>;
  if (
    typeof inventory.worktree !== "string" ||
    path.resolve(inventory.worktree) !== fs.realpathSync(worktreePath) ||
    inventory.branch !== expectedBranch ||
    typeof inventory.head !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(inventory.head) ||
    !Array.isArray(inventory.files) ||
    !Array.isArray(inventory.tracked) ||
    !Array.isArray(inventory.committable) ||
    !Array.isArray(inventory.untracked) ||
    !Array.isArray(inventory.ignored) ||
    typeof inventory.status !== "string"
  )
    throw new Error("Setup inventory worktree identity or inventory is invalid");
  for (const file of inventory.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof (file as Record<string, unknown>).path !== "string" ||
      path.isAbsolute((file as { path: string }).path) ||
      (file as { path: string }).path.split(/[\\/]/u).includes("..")
    )
      throw new Error("Setup inventory contains an invalid file identity");
    const entry = file as Record<string, unknown>;
    if (
      typeof entry.mode !== "number" ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o7777
    )
      throw new Error("Setup inventory contains invalid file mode identity");
    if (
      entry.kind === "file" &&
      (typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
        typeof entry.bytes !== "number" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0)
    )
      throw new Error("Setup inventory contains invalid file content identity");
  }
}

export async function runRepositorySetup(
  commands: CommandRunner,
  options: {
    cwd: string;
    command: string;
    timeoutMilliseconds: number;
    signal?: AbortSignal;
    sessionLogPath: string;
    sessionLabel: string;
    onExecutionStarted?: (executionId: string) => void;
    artifactDirectory?: string;
  },
): Promise<CommandRunResult> {
  try {
    return await commands.run({
      cwd: options.cwd,
      command: options.command,
      timeoutMilliseconds: options.timeoutMilliseconds,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sessionLogPath: options.sessionLogPath,
      sessionLabel: options.sessionLabel,
      ...(options.artifactDirectory === undefined
        ? {}
        : { artifactDirectory: options.artifactDirectory }),
      ...(options.onExecutionStarted === undefined
        ? {}
        : { onExecutionStarted: options.onExecutionStarted }),
    });
  } catch (error) {
    if (error instanceof CommandRunAbortedError) {
      throw error;
    }

    const setupError = toFailureError(error);

    throw new WorkflowError("Setup", setupError.message, { cause: error });
  }
}
