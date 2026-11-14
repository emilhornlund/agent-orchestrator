import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/config.js";
import {
  GitHubCliCompatibilityError,
  MINIMUM_SUPPORTED_GITHUB_CLI_VERSION,
  validateGitHubCliCompatibility,
} from "./github/github-cli-compatibility.js";
import type { CommandRunOptions, CommandRunResult } from "./process/command-runner.js";
import {
  ToolchainCompatibilityError,
  validateGit,
  validateOpenCode,
} from "./startup/validate-toolchain.js";

const probeTimeoutMilliseconds = 10_000;

/** Local probes deliberately bypass CommandRunner's durable process evidence and logging. */
export function runDoctorProbe(options: CommandRunOptions): Promise<CommandRunResult> {
  const [executable, ...args] = options.command.split(" ");
  const allowed =
    /^(git --(?:version|list-cmds=main)|opencode (?:--version|run --help)|gh (?:--version|(?:repo (?:clone|view)|pr (?:list|create)|api) --help))$/u;
  if (!executable || !allowed.test(options.command)) {
    return Promise.reject(new Error("Unsupported local diagnostic probe"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        timeout: probeTimeoutMilliseconds,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          // Never forward executable output or environment values through error messages.
          reject(new Error("local probe failed; check installation and PATH, then retry"));
        } else {
          resolve({ exitCode: 0, output: stdout, errorOutput: stderr });
        }
      },
    );
  });
}

export interface DoctorDependencies {
  loadConfig: typeof loadConfig;
  runProbe: typeof runDoctorProbe;
  write: (line: string) => void;
}

export async function runDoctor(
  dependencies: DoctorDependencies = {
    loadConfig: () => loadConfig("config.yaml", { suppressWarnings: true }),
    runProbe: runDoctorProbe,
    write: (line) => console.log(line),
  },
): Promise<number> {
  const { write } = dependencies;
  let failed = false;
  write("Agent Orchestrator local environment diagnostics");
  try {
    dependencies.loadConfig();
    write("PASSED Configuration: config.yaml exists and is valid.");
  } catch (error) {
    failed = true;
    // Parser errors may contain source excerpts; schema errors may contain input values.
    const message = error instanceof Error ? error.message : "";
    const detail = message.startsWith("Config file not found:")
      ? "config.yaml is missing; copy config.example.yaml to config.yaml and configure it."
      : message.startsWith("Invalid YAML:")
        ? "config.yaml contains invalid YAML; correct its syntax."
        : message.startsWith("Invalid configuration:")
          ? "config.yaml has invalid settings; check required fields and supported values against config.example.yaml and docs/configuration.md."
          : "cannot read config.yaml; check file access and permissions.";
    write(`FAILED Configuration: ${detail}`);
  }

  const commands = { run: dependencies.runProbe };
  const checks: readonly [string, () => Promise<void>][] = [
    ["Git", () => validateGit(commands, probeTimeoutMilliseconds)],
    [
      "GitHub CLI",
      () =>
        validateGitHubCliCompatibility(async (args) => {
          const result = await dependencies.runProbe({
            cwd: process.cwd(),
            command: ["gh", ...args].join(" "),
          });
          if (result.exitCode !== 0) throw new Error("local probe exited unsuccessfully");
          return `${result.output ?? ""}\n${result.errorOutput ?? ""}`;
        }, []),
    ],
    ["OpenCode", () => validateOpenCode(commands, probeTimeoutMilliseconds)],
  ];
  for (const [name, check] of checks) {
    try {
      await check();
      write(
        `PASSED ${name}: installed version and required executable capabilities are compatible.`,
      );
    } catch (error) {
      failed = true;
      const detail =
        error instanceof GitHubCliCompatibilityError && error.message.includes("is unsupported;")
          ? `installed gh version is unsupported; require gh ${MINIMUM_SUPPORTED_GITHUB_CLI_VERSION} or newer.`
          : error instanceof ToolchainCompatibilityError ||
              error instanceof GitHubCliCompatibilityError
            ? error.message
            : "local check failed; verify installation and PATH.";
      write(`FAILED ${name}: ${detail}`);
    }
  }
  write(
    "SKIPPED External integrations: authentication, permissions, connectivity, and service operation are not checked.",
  );
  write(
    "SKIPPED Remaining runtime prerequisites: isolation namespaces, coordination provisioning, runtime filesystem permissions, and credential configuration are not checked.",
  );
  write(
    failed
      ? "Required local checks failed. Address the failures above."
      : "Required local checks passed.",
  );
  write("These local checks do not establish complete runtime readiness.");
  return failed ? 1 : 0;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  void runDoctor().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      console.error("FAILED Diagnostics: unable to complete local checks.");
      process.exitCode = 1;
    },
  );
}
