import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandRunner,
  type CommandRunResult,
  type RunCommand,
} from "../src/process/command-runner.js";
import {
  MINIMUM_GIT_VERSION,
  ISOLATION_PROBE_COMMAND,
  MINIMUM_OPENCODE_VERSION,
  ToolchainCompatibilityError,
  validateGitAndOpenCode,
} from "../src/startup/validate-toolchain.js";

function runner(responses: Record<string, CommandRunResult | undefined>) {
  const run = vi.fn<RunCommand>().mockImplementation(async ({ command }) => {
    const response = responses[command];
    if (!response) throw new Error("spawn ENOENT");
    return response;
  });
  return { commands: new CommandRunner(run), run };
}

const ok = (output: string) => ({ exitCode: 0, output });
const supported = {
  [ISOLATION_PROBE_COMMAND]: ok(""),
  "git --version": ok(`git version ${MINIMUM_GIT_VERSION}`),
  "git --list-cmds=main": ok(
    "branch cat-file commit diff fetch ls-remote merge-base push rev-parse status worktree",
  ),
  "opencode --version": ok(MINIMUM_OPENCODE_VERSION),
  "opencode run --help": ok("--auto --pure --model --variant --dir --session --format --title"),
};

describe("Git and OpenCode startup compatibility", () => {
  it("accepts supported executable versions and consumed OpenCode capabilities", async () => {
    const { commands, run } = runner(supported);
    await expect(validateGitAndOpenCode(commands)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["stdout", { output: "--auto --pure --model --variant --dir --session --format --title" }],
    ["stderr", { errorOutput: "--auto --pure --model --variant --dir --session --format --title" }],
    [
      "both streams",
      {
        output: "--auto --pure --model --variant",
        errorOutput: "--dir --session --format --title",
      },
    ],
  ])("accepts OpenCode help on %s", async (_label, streams) => {
    const { commands } = runner({
      ...supported,
      "opencode run --help": { exitCode: 0, ...streams },
    });
    await expect(validateGitAndOpenCode(commands)).resolves.toBeUndefined();
  });

  it.each([0, 1])("rejects incomplete OpenCode help with exit code %s", async (exitCode) => {
    const { commands } = runner({
      ...supported,
      "opencode run --help": {
        exitCode,
        output: "--auto --pure --model --variant",
        errorOutput: "--dir --session --title",
      },
    });
    await expect(validateGitAndOpenCode(commands)).rejects.toThrow(
      exitCode === 0
        ? "run command is missing required options: --format"
        : "probe exited with code 1",
    );
  });

  it("uses the supplied project timeout consistently for every startup probe", async () => {
    const { commands, run } = runner(supported);
    await validateGitAndOpenCode(commands, 17_000);
    expect(run.mock.calls.map(([input]) => input.timeoutMilliseconds)).toEqual([
      17_000, 17_000, 17_000, 17_000, 17_000,
    ]);
    const secondProject = runner(supported);
    await validateGitAndOpenCode(secondProject.commands, 83_000);
    expect(secondProject.run.mock.calls.map(([input]) => input.timeoutMilliseconds)).toEqual([
      83_000, 83_000, 83_000, 83_000, 83_000,
    ]);
  });

  it.each([
    ["missing isolation tool", { ...supported, [ISOLATION_PROBE_COMMAND]: undefined }],
    [
      "denied namespaces",
      {
        ...supported,
        [ISOLATION_PROBE_COMMAND]: { exitCode: 1, output: "denied" },
      },
    ],
    ["missing Git", { ...supported, "git --version": undefined }],
    ["incompatible Git", { ...supported, "git --version": ok("git version 2.10.0") }],
    ["malformed Git", { ...supported, "git --version": ok("git is present") }],
    ["missing OpenCode", { ...supported, "opencode --version": undefined }],
    ["incompatible OpenCode", { ...supported, "opencode --version": ok("0.9.0") }],
    ["malformed OpenCode", { ...supported, "opencode --version": ok("development") }],
    ["incompatible capability", { ...supported, "opencode run --help": ok("--model --dir") }],
  ])("rejects %s", async (_label, responses) => {
    const { commands } = runner(responses);
    await expect(validateGitAndOpenCode(commands)).rejects.toBeInstanceOf(
      ToolchainCompatibilityError,
    );
  });

  it("probes actual executable fixtures through PATH", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-fixture-"));
    const previousPath = process.env.PATH;
    const writeExecutable = (name: string, source: string): void => {
      const file = path.join(fixtureRoot, name);
      fs.writeFileSync(file, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
      fs.chmodSync(file, 0o700);
    };
    try {
      writeExecutable(
        "git",
        `if [ "$1" = "--version" ]; then printf 'git version ${MINIMUM_GIT_VERSION}\\n'; else printf 'branch cat-file commit diff fetch ls-remote merge-base push rev-parse status worktree\\n'; fi`,
      );
      writeExecutable(
        "opencode",
        `if [ "$1" = "--version" ]; then printf '${MINIMUM_OPENCODE_VERSION}\\n'; else printf '%03000d' 0; printf '%s\\n' '--auto --pure --model --variant --dir --session --format --title'; printf '%03000d' 0 >&2; fi`,
      );
      writeExecutable("bwrap", "exit 0");
      process.env.PATH = fixtureRoot;
      await expect(validateGitAndOpenCode(new CommandRunner())).resolves.toBeUndefined();

      writeExecutable("opencode", "printf 'malformed\\n'");
      await expect(validateGitAndOpenCode(new CommandRunner())).rejects.toThrow(
        "malformed version output",
      );
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
