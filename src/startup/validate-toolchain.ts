import type { CommandRunner } from "../process/command-runner.js";

export const MINIMUM_GIT_VERSION = "2.30.0";
export const MINIMUM_OPENCODE_VERSION = "1.0.0";

export class ToolchainCompatibilityError extends Error {
  constructor(tool: string, detail: string, cause?: unknown) {
    super(`${tool} startup compatibility check failed: ${detail}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "ToolchainCompatibilityError";
  }
}

type Version = readonly [number, number, number];
function parseVersion(output: string, tool: string): Version | undefined {
  const expression =
    tool === "Git"
      ? /^git version (\d+)\.(\d+)\.(\d+)(?:\.windows\.\d+)?\s*$/m
      : /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$/im;
  const match = expression.exec(output);
  if (!match) return undefined;
  const values = [Number(match[1]), Number(match[2]), Number(match[3])];
  return values.every(Number.isSafeInteger)
    ? (values as unknown as Version)
    : undefined;
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

async function probe(
  commands: CommandRunner,
  executable: "git" | "opencode",
  args: readonly string[],
  timeoutMilliseconds: number,
): Promise<string> {
  let result;
  try {
    result = await commands.run({
      cwd: process.cwd(),
      command: [executable, ...args].join(" "),
      timeoutMilliseconds,
      captureOutput: true,
      suppressOutput: true,
    });
  } catch (error) {
    throw new ToolchainCompatibilityError(
      executable,
      "executable is missing or inaccessible; verify it is installed and on PATH",
      error,
    );
  }
  if (!result || result.exitCode !== 0)
    throw new ToolchainCompatibilityError(
      executable,
      `probe exited with code ${result?.exitCode ?? "no result"}`,
    );
  return result.output ?? "";
}

async function validateVersion(
  commands: CommandRunner,
  executable: "git" | "opencode",
  minimum: string,
  displayName: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const output = await probe(
    commands,
    executable,
    ["--version"],
    timeoutMilliseconds,
  );
  const installed = parseVersion(output, displayName);
  const required = parseVersion(
    displayName === "Git" ? `git version ${minimum}` : minimum,
    displayName,
  );
  if (!installed || !required)
    throw new ToolchainCompatibilityError(
      displayName,
      `malformed version output; expected version ${minimum} or newer`,
    );
  if (compare(installed, required) < 0)
    throw new ToolchainCompatibilityError(
      displayName,
      `installed version ${installed.join(".")} is unsupported; require ${minimum} or newer`,
    );
}

/** Checks only capabilities actually consumed by this application. */
export async function validateGitAndOpenCode(
  commands: CommandRunner,
  timeoutMilliseconds = 5 * 60_000,
): Promise<void> {
  await validateVersion(
    commands,
    "git",
    MINIMUM_GIT_VERSION,
    "Git",
    timeoutMilliseconds,
  );
  await validateVersion(
    commands,
    "opencode",
    MINIMUM_OPENCODE_VERSION,
    "OpenCode",
    timeoutMilliseconds,
  );
  const gitCommands = await probe(
    commands,
    "git",
    ["--list-cmds=main"],
    timeoutMilliseconds,
  );
  const requiredGitCommands = [
    "branch",
    "cat-file",
    "commit",
    "diff",
    "fetch",
    "ls-remote",
    "merge-base",
    "push",
    "rev-parse",
    "status",
    "worktree",
  ];
  const availableGitCommands = new Set(gitCommands.trim().split(/\s+/u));
  const missingGitCommands = requiredGitCommands.filter(
    (command) => !availableGitCommands.has(command),
  );
  if (missingGitCommands.length)
    throw new ToolchainCompatibilityError(
      "Git",
      `installation is missing required commands: ${missingGitCommands.join(", ")}`,
    );
  const help = await probe(
    commands,
    "opencode",
    ["run", "--help"],
    timeoutMilliseconds,
  );
  const required = [
    "--auto",
    "--model",
    "--variant",
    "--dir",
    "--session",
    "--format",
  ];
  const missing = required.filter((option) => !help.includes(option));
  if (missing.length)
    throw new ToolchainCompatibilityError(
      "OpenCode",
      `run command is missing required options: ${missing.join(", ")}`,
    );
}
