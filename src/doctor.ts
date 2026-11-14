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

export interface DoctorCheck {
  id:
    | "configuration"
    | "git"
    | "github-cli"
    | "opencode"
    | "external-integrations"
    | "runtime-prerequisites";
  status: "passed" | "failed" | "skipped";
  summary: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  requiredLocalChecksPassed: boolean;
  runtimeReadiness: "not-verified";
  checks: DoctorCheck[];
}

export interface DoctorArguments {
  json: boolean;
  configPath: string;
}

export function parseDoctorArguments(args: readonly string[]): DoctorArguments | undefined {
  let json = false;
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json" && !json) {
      json = true;
    } else if (argument === "--config" && configPath === undefined) {
      const value = args[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) return undefined;
      configPath = value;
      index += 1;
    } else {
      return undefined;
    }
  }
  return { json, configPath: configPath ?? "config.yaml" };
}

export async function runDoctor(
  dependencies: DoctorDependencies = {
    loadConfig,
    runProbe: runDoctorProbe,
    write: (line) => console.log(line),
  },
  args: readonly string[] = [],
): Promise<number> {
  const { write } = dependencies;
  const options = parseDoctorArguments(args);
  if (!options) {
    write("Usage: yarn doctor [--json] [--config PATH]");
    return 1;
  }
  const { json, configPath } = options;
  // Quote custom paths so control characters cannot inject diagnostic lines.
  const configLabel = configPath === "config.yaml" ? configPath : JSON.stringify(configPath);
  const results: DoctorCheck[] = [];
  const record = (
    id: DoctorCheck["id"],
    name: string,
    status: DoctorCheck["status"],
    summary: string,
  ) => {
    results.push({ id, status, summary });
    if (!json) write(`${status.toUpperCase()} ${name}: ${summary}`);
  };
  let failed = false;
  if (!json) write("Agent Orchestrator local environment diagnostics");
  try {
    dependencies.loadConfig(configPath, { suppressWarnings: true });
    record("configuration", "Configuration", "passed", `${configLabel} exists and is valid.`);
  } catch (error) {
    failed = true;
    // Parser errors may contain source excerpts; schema errors may contain input values.
    const message = error instanceof Error ? error.message : "";
    const detail = message.startsWith("Config file not found:")
      ? `${configLabel} is missing; copy config.example.yaml to ${configLabel} and configure it.`
      : message.startsWith("Invalid YAML:")
        ? `${configLabel} contains invalid YAML; correct its syntax.`
        : message.startsWith("Invalid configuration:")
          ? `${configLabel} has invalid settings; check required fields and supported values against config.example.yaml and docs/configuration.md.`
          : `cannot read ${configLabel}; check file access and permissions.`;
    record("configuration", "Configuration", "failed", detail);
  }

  const commands = { run: dependencies.runProbe };
  const checks: readonly [DoctorCheck["id"], string, () => Promise<void>][] = [
    ["git", "Git", () => validateGit(commands, probeTimeoutMilliseconds)],
    [
      "github-cli",
      "GitHub CLI",
      () =>
        validateGitHubCliCompatibility(async (args) => {
          // The shared validator includes underlying exception messages. Never let
          // arbitrary probe errors enter that message in either output format.
          let result: CommandRunResult;
          try {
            result = await dependencies.runProbe({
              cwd: process.cwd(),
              command: ["gh", ...args].join(" "),
            });
          } catch {
            throw new Error("local probe failed; check installation and PATH, then retry");
          }
          if (result.exitCode !== 0) throw new Error("local probe exited unsuccessfully");
          return `${result.output ?? ""}\n${result.errorOutput ?? ""}`;
        }, []),
    ],
    ["opencode", "OpenCode", () => validateOpenCode(commands, probeTimeoutMilliseconds)],
  ];
  for (const [id, name, check] of checks) {
    try {
      await check();
      record(
        id,
        name,
        "passed",
        "installed version and required executable capabilities are compatible.",
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
      record(id, name, "failed", detail);
    }
  }
  record(
    "external-integrations",
    "External integrations",
    "skipped",
    "authentication, permissions, connectivity, and service operation are not checked.",
  );
  record(
    "runtime-prerequisites",
    "Remaining runtime prerequisites",
    "skipped",
    "isolation namespaces, coordination provisioning, runtime filesystem permissions, and credential configuration are not checked.",
  );
  if (json) {
    const report: DoctorReport = {
      schemaVersion: 1,
      requiredLocalChecksPassed: !failed,
      runtimeReadiness: "not-verified",
      checks: results,
    };
    write(JSON.stringify(report));
  } else {
    write(
      failed
        ? "Required local checks failed. Address the failures above."
        : "Required local checks passed.",
    );
    write("These local checks do not establish complete runtime readiness.");
  }
  return failed ? 1 : 0;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  void runDoctor(undefined, process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      console.error("FAILED Diagnostics: unable to complete local checks.");
      process.exitCode = 1;
    },
  );
}
