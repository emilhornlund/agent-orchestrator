import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { runDoctor, runDoctorProbe } from "../src/doctor.js";
import { GITHUB_CLI_COMMAND_CAPABILITIES } from "../src/github/github-cli-compatibility.js";
import type { CommandRunOptions, CommandRunResult } from "../src/process/command-runner.js";

const example = fs.readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8");
const responses: Record<string, string> = {
  "git --version": "git version 2.30.0",
  "git --list-cmds=main":
    "branch cat-file commit diff fetch ls-remote merge-base push rev-parse status worktree",
  "opencode --version": "1.0.0",
  "opencode run --help": "--auto --pure --model --variant --dir --session --format --title",
  "gh --version": "gh version 2.40.0",
  ...Object.fromEntries(
    GITHUB_CLI_COMMAND_CAPABILITIES.map((capability) => [
      ["gh", ...capability.args].join(" "),
      capability.requiredHelpOptions.join(" "),
    ]),
  ),
};

async function diagnose(
  overrides: Record<string, string | Error | CommandRunResult> = {},
  configuration = () => parseConfig(example),
  args: readonly string[] = [],
) {
  const lines: string[] = [];
  const runProbe = vi.fn(async ({ command }: CommandRunOptions) => {
    const value = overrides[command] ?? responses[command];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected command: ${command}`);
    return typeof value === "string" ? { exitCode: 0, output: value } : value;
  });
  const exitCode = await runDoctor(
    {
      loadConfig: configuration,
      runProbe,
      write: (line) => lines.push(line),
    },
    args,
  );
  return { exitCode, output: lines.join("\n"), runProbe };
}

describe("local environment diagnostics", () => {
  it("emits a deterministic versioned JSON report with explicit skipped checks", async () => {
    const result = await diagnose({}, undefined, ["--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output);
    expect(report).toEqual({
      schemaVersion: 1,
      requiredLocalChecksPassed: true,
      runtimeReadiness: "not-verified",
      checks: [
        { id: "configuration", status: "passed", summary: "config.yaml exists and is valid." },
        ...["git", "github-cli", "opencode"].map((id) => ({
          id,
          status: "passed",
          summary: "installed version and required executable capabilities are compatible.",
        })),
        {
          id: "external-integrations",
          status: "skipped",
          summary: expect.stringContaining("not checked"),
        },
        {
          id: "runtime-prerequisites",
          status: "skipped",
          summary: expect.stringContaining("not checked"),
        },
      ],
    });
    expect((await diagnose({}, undefined, ["--json"])).output).toBe(result.output);
  });

  it.each([{ args: [] }, { args: ["--json"] }])(
    "sanitizes arbitrary probe exceptions in mode $args",
    async ({ args }) => {
      const result = await diagnose(
        {
          "git --version": new Error("sensitive-probe-exception"),
          "gh --version": new Error("sensitive-probe-exception"),
          "opencode --version": new Error("sensitive-probe-exception"),
        },
        undefined,
        args,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain("sensitive-probe-exception");
      expect(result.output).toContain("PATH");
    },
  );

  it.each([["--unknown"], ["file"], ["--json", "--unknown"], ["--json", "--json"]])(
    "rejects unsupported arguments before loading configuration or probing: %j",
    async (...args) => {
      const loadConfig = vi.fn();
      const runProbe = vi.fn();
      const write = vi.fn();
      expect(await runDoctor({ loadConfig, runProbe, write }, args)).toBe(1);
      expect(write).toHaveBeenCalledExactlyOnceWith("Usage: yarn doctor [--json]");
      expect(loadConfig).not.toHaveBeenCalled();
      expect(runProbe).not.toHaveBeenCalled();
    },
  );

  it("reports compatible local checks without claiming integration or runtime readiness", async () => {
    const result = await diagnose();
    expect(result.exitCode).toBe(0);
    for (const name of ["Configuration", "Git", "GitHub CLI", "OpenCode"]) {
      expect(result.output).toContain(`PASSED ${name}:`);
    }
    expect(result.output).toContain("SKIPPED External integrations:");
    expect(result.output).toContain("SKIPPED Remaining runtime prerequisites:");
    expect(result.output).toContain("do not establish complete runtime readiness");
    expect(result.runProbe.mock.calls.map(([options]) => options.command).sort()).toEqual(
      Object.keys(responses).sort(),
    );
  });

  it.each([
    ["git --version", "git version 2.29.9", "require 2.30.0"],
    ["gh --version", "gh version 2.39.9", "require gh 2.40.0"],
    ["gh --version", "gh version 2.39.9-secret-version-value", "require gh 2.40.0"],
    ["opencode --version", "0.99.0", "require 1.0.0"],
    ["git --version", "secret-version-value", "malformed version"],
    ["gh --version", "secret-version-value", "malformed output"],
    ["opencode --version", "secret-version-value", "malformed version"],
    ["git --list-cmds=main", "branch", "missing required commands"],
    ["gh pr list --help", "secret-help-value", "missing required options"],
    ["opencode run --help", "secret-help-value", "missing required options"],
  ])("explains incompatible %s results", async (command, response, explanation) => {
    for (const args of [[], ["--json"]]) {
      const result = await diagnose({ [command]: response }, undefined, args);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(explanation);
      expect(result.output).not.toContain("secret-");
      if (args.length) {
        expect(JSON.parse(result.output).requiredLocalChecksPassed).toBe(false);
      }
    }
  });

  it.each(["git --version", "gh --version", "opencode --version"])(
    "handles unavailable %s and continues other checks",
    async (command) => {
      const result = await diagnose({
        [command]: new Error("local probe failed; check installation and PATH, then retry"),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("PATH");
      expect(result.runProbe.mock.calls.map(([options]) => options.command)).toContain(
        "opencode --version",
      );
    },
  );

  it("reports multiple failures and unsuccessful probes", async () => {
    const result = await diagnose({
      "git --version": { exitCode: 1 },
      "gh --version": { exitCode: 1 },
      "opencode --version": { exitCode: 1 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAILED Git:");
    expect(result.output).toContain("FAILED GitHub CLI:");
    expect(result.output).toContain("FAILED OpenCode:");
  });

  it.each([
    [
      "missing",
      () => loadConfig("/nonexistent-doctor-config/config.yaml"),
      "copy config.example.yaml",
    ],
    [
      "unreadable",
      () => {
        throw new Error("EACCES secret-config-value");
      },
      "permissions",
    ],
    ["malformed YAML", () => parseConfig("secret-config-value: [\n"), "correct its syntax"],
    [
      "invalid settings",
      () => parseConfig("projects: []\nsecret-config-value: true"),
      "required fields",
    ],
  ])("handles %s configuration safely", async (_name, configuration, explanation) => {
    const result = await diagnose({}, configuration);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAILED Configuration:");
    expect(result.output).toContain(explanation);
    expect(result.output).not.toContain("secret-config-value");
    expect(result.output).toContain("PASSED OpenCode:");
  });

  it("rejects commands outside the diagnostic probe allowlist", async () => {
    await expect(
      runDoctorProbe({ cwd: process.cwd(), command: "opencode run task" }),
    ).rejects.toThrow("Unsupported local diagnostic probe");
  });

  it("suppresses only opt-in parser warnings while preserving syntax and schema validation", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const warningYaml = `${example}\nsecret: !doctor-tag sensitive-config-value\n`;
    try {
      expect(() => parseConfig(warningYaml)).toThrow("Invalid configuration:");
      expect(emitWarning).toHaveBeenCalledTimes(1);
      emitWarning.mockClear();
      expect(() => parseConfig(warningYaml, { suppressWarnings: true })).toThrow(
        "Invalid configuration:",
      );
      expect(() => parseConfig("secret: [", { suppressWarnings: true })).toThrow("Invalid YAML:");
      expect(() =>
        parseConfig(`${example}\n---\nsecret: value`, { suppressWarnings: true }),
      ).toThrow("Invalid YAML:");
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });
});

describe("standalone doctor entrypoint", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects invalid arguments at the entrypoint without probing", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-arguments-"));
    for (const executable of ["git", "gh", "opencode"]) {
      fs.writeFileSync(
        path.join(root, executable),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync('probe-started', 'unexpected');\n`,
        { mode: 0o755 },
      );
    }
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.resolve("src/doctor.ts"),
          "--json",
          "--unknown",
        ],
        {
          cwd: root,
          env: { ...process.env, PATH: root },
          timeout: 10_000,
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "Usage: yarn doctor [--json]\n",
      stderr: "",
    });
    expect(fs.existsSync(path.join(root, "probe-started"))).toBe(false);
  });

  it.each(
    [
      { scenario: "success", configuration: example, failure: false, configFailure: false },
      {
        scenario: "executable failure",
        configuration: example,
        failure: true,
        configFailure: false,
      },
      {
        scenario: "schema failure with YAML warning",
        configuration: `${example}\nsecret: !doctor-tag sensitive-config-value\n`,
        failure: false,
        configFailure: true,
      },
      {
        scenario: "valid configuration with YAML warning",
        configuration: example.replace('"project"', '!doctor-tag "sensitive-config-value"'),
        failure: false,
        configFailure: false,
      },
      {
        scenario: "YAML syntax failure",
        configuration: "secret: [sensitive-config-value",
        failure: false,
        configFailure: true,
      },
    ].flatMap((scenario) => [false, true].map((json) => ({ ...scenario, json }))),
  )(
    "is read-only and protects both output streams ($scenario, json=$json)",
    async ({ configuration, failure, configFailure, json }) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(root, "config.yaml"), configuration);
      for (const executable of ["git", "gh", "opencode"]) {
        fs.writeFileSync(
          path.join(bin, executable),
          `#!${process.execPath}\nconst responses = ${JSON.stringify(responses)};\nconst key = ${JSON.stringify(executable)} + ' ' + process.argv.slice(2).join(' ');\nif (${failure} && ${JSON.stringify(executable)} === 'gh') { console.error('secret-process-output'); process.exit(1); }\nif (!(key in responses)) process.exit(9);\nconsole.log(responses[key]);\n`,
          { mode: 0o755 },
        );
      }
      const snapshot = () =>
        fs
          .readdirSync(root!, { recursive: true })
          .map(String)
          .sort()
          .map((entry) => {
            const filename = path.join(root!, entry);
            return [
              entry,
              fs.statSync(filename).isFile() ? fs.readFileSync(filename, "utf8") : null,
            ];
          });
      const before = snapshot();
      const run = promisify(execFile);
      const entrypoint = path.resolve("src/doctor.ts");
      const tsx = import.meta.resolve("tsx");
      let stdout: string;
      let stderr: string;
      let exitCode = 0;
      try {
        const result = await run(
          process.execPath,
          ["--import", tsx, entrypoint, ...(json ? ["--json"] : [])],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: bin,
              HOME: root,
              XDG_DATA_HOME: root,
              XDG_CACHE_HOME: root,
            },
            timeout: 10_000,
          },
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const result = error as Error & { code: number; stdout: string; stderr: string };
        exitCode = result.code;
        stdout = result.stdout;
        stderr = result.stderr;
      }
      expect(exitCode).toBe(failure || configFailure ? 1 : 0);
      if (json) {
        const report = JSON.parse(stdout);
        expect(report.schemaVersion).toBe(1);
        expect(report.requiredLocalChecksPassed).toBe(!failure && !configFailure);
        expect(report.runtimeReadiness).toBe("not-verified");
        expect(
          report.checks.map((check: { id: string; status: string }) => [check.id, check.status]),
        ).toEqual([
          ["configuration", configFailure ? "failed" : "passed"],
          ["git", "passed"],
          ["github-cli", failure ? "failed" : "passed"],
          ["opencode", "passed"],
          ["external-integrations", "skipped"],
          ["runtime-prerequisites", "skipped"],
        ]);
      } else {
        expect(stdout).toContain(failure ? "FAILED GitHub CLI:" : "PASSED GitHub CLI:");
        expect(stdout).toContain(configFailure ? "FAILED Configuration:" : "PASSED Configuration:");
        expect(stdout).toContain(
          failure || configFailure
            ? "Required local checks failed."
            : "Required local checks passed.",
        );
        expect(stdout).toContain("PASSED OpenCode:");
      }
      expect(stdout + stderr).not.toContain("secret-process-output");
      expect(stdout + stderr).not.toContain("sensitive-config-value");
      expect(stderr).toBe("");
      expect(snapshot()).toEqual(before);
    },
  );
});
