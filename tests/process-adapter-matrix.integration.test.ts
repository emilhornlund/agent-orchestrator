import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitClient } from "../src/git/git-client.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunInterruptedError, CommandRunner } from "../src/process/command-runner.js";
import {
  configureProcessRuntime,
  withTaskProcessArtifacts,
  type ProcessArtifactEvent,
} from "../src/process/process-runtime.js";
import { validateGitAndOpenCode } from "../src/startup/validate-toolchain.js";
import { ensureRepository } from "../src/git/ensure-repository.js";
import type { ProjectConfig } from "../src/config/config.js";
import { execFileSync } from "node:child_process";
import { configureLoggerRuntime, Logger } from "../src/logging/logger.js";

type Family = "git" | "gh" | "opencode" | "command";
type Case = "nonzero" | "crash" | "partial" | "timeout" | "abort" | "spawn-failure";

const families: Family[] = ["git", "gh", "opencode", "command"];
const cases: Case[] = ["nonzero", "crash", "partial", "timeout", "abort", "spawn-failure"];

function executableScript(family: Family, scenario: Case): string {
  const outMarker = `RAW_OUT_${family}_${scenario}`;
  const errMarker = `RAW_ERR_${family}_${scenario}`;
  const partialOut =
    family === "gh"
      ? `https://github.com/owner/repository/pull/1?marker=${outMarker}\n`
      : `${outMarker}:partial-stream`;
  const stdoutChunks =
    scenario === "abort"
      ? [`${outMarker}:partial-before-abort`]
      : scenario === "partial"
        ? [
            partialOut.slice(0, Math.ceil(partialOut.length / 2)),
            partialOut.slice(Math.ceil(partialOut.length / 2)),
          ]
        : [`${outMarker}\n`];
  const stderrChunks =
    scenario === "abort"
      ? [`${errMarker}:partial-before-abort`]
      : scenario === "partial"
        ? [`${errMarker}:partial-`, "stderr-stream"]
        : [`${errMarker}\n`];
  const emit = (stream: "stdout" | "stderr", chunks: string[]) =>
    `const write${stream === "stdout" ? "Out" : "Err"}=(value)=>new Promise(resolve=>process.${stream}.write(value,resolve)); const ${stream}Writes=${JSON.stringify(chunks)}.map(write${stream === "stdout" ? "Out" : "Err"});`;
  let afterWrite: string;
  if (scenario === "nonzero") afterWrite = "process.exit(9);";
  else if (scenario === "crash") afterWrite = 'process.kill(process.pid,"SIGTERM");';
  else if (scenario === "abort")
    afterWrite = `process.on("SIGTERM",()=>process.exit(0)); setTimeout(()=>{process.stdout.write("LATE_OUT_${family}_abort");process.stderr.write("LATE_ERR_${family}_abort")},1500); setInterval(()=>{},30_000);`;
  else if (scenario === "timeout")
    afterWrite = 'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},30_000);';
  else afterWrite = "process.exit(0);";
  return `#!${process.execPath}\n${emit("stdout", stdoutChunks)} ${emit("stderr", stderrChunks)} Promise.all([...stdoutWrites,...stderrWrites]).then(()=>{${afterWrite}});\n`;
}

function fixtureMarkers(family: Family, scenario: Case) {
  return {
    stdout: `RAW_OUT_${family}_${scenario}`,
    stderr: `RAW_ERR_${family}_${scenario}`,
  };
}

describe("production child adapter outcome matrix", () => {
  const roots: string[] = [];
  const originalPath = process.env.PATH;
  const originalVitest = process.env.VITEST;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    configureLoggerRuntime(os.tmpdir());
    configureProcessRuntime({
      runtimeRoot: os.tmpdir(),
      signal: new AbortController().signal,
      operationTimeoutMilliseconds: 120_000,
    });
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(family: Family, scenario: Case, root: string, retainCommandShell = false) {
    const runtimeRoot = path.join(root, "runtime");
    const binaries = path.join(root, "bin");
    fs.mkdirSync(binaries, { recursive: true });
    const executable = family === "command" ? "fixture-command" : family;
    if (scenario !== "spawn-failure") {
      const filename = path.join(binaries, executable);
      fs.writeFileSync(filename, executableScript(family, scenario), {
        mode: 0o700,
      });
      fs.chmodSync(filename, 0o700);
    }
    process.env.PATH = binaries;
    const abort = new AbortController();
    const timeoutMilliseconds =
      scenario === "abort" ? 30_000 : scenario === "timeout" ? 100 : 5_000;
    configureProcessRuntime({
      runtimeRoot,
      signal: abort.signal,
      operationTimeoutMilliseconds: timeoutMilliseconds,
    });
    const artifactDirectory = path.join(root, "command-artifacts");
    const timeline: ProcessArtifactEvent[] = [];
    const request = withTaskProcessArtifacts(
      {
        root: runtimeRoot,
        projectId: `matrix-${family}`,
        cardId: `card-${scenario}`,
        attemptId: `attempt-${family}-${scenario}`,
        recordEvent: (event) => timeline.push(event),
      },
      () => {
        if (family === "git") return new GitClient().getStatus(root);
        if (family === "gh")
          return new GitHubClient().findPullRequest({
            cwd: root,
            repository: "owner/repository",
            headBranch: "agent/adapter-matrix",
          });
        if (family === "opencode")
          return new OpenCodeClient().run({
            cwd: root,
            model: "test/model",
            variant: "test",
            timeoutMilliseconds,
            prompt: "offline process matrix",
            signal: abort.signal,
          });
        return new CommandRunner().run({
          cwd: root,
          // Exercise an actual signal on the supervised PID, independently of
          // whether /bin/sh optimizes its final command into an implicit exec.
          command:
            scenario === "crash"
              ? retainCommandShell
                ? `${executable}; status=$?; exit "$status"`
                : `exec ${executable}`
              : executable,
          timeoutMilliseconds,
          captureOutput: true,
          suppressOutput: true,
          signal: abort.signal,
          artifactDirectory,
        });
      },
    );
    if (scenario === "abort") setTimeout(() => abort.abort("matrix-abort"), 200);
    const artifactRoot =
      family === "command"
        ? artifactDirectory
        : path.join(
            runtimeRoot,
            "artifacts",
            `matrix-${family}`,
            `card-${scenario}`,
            `attempt-${family}-${scenario}`,
            "process-executions",
          );
    return { request, artifactRoot, scenario, timeline };
  }

  async function inspectArtifact(artifactRoot: string) {
    const entries = fs.readdirSync(artifactRoot);
    expect(entries).toHaveLength(1);
    const executionDirectory = path.join(artifactRoot, entries[0]!);
    return {
      metadata: JSON.parse(
        fs.readFileSync(path.join(executionDirectory, "execution.json"), "utf8"),
      ) as {
        executionId: string;
        status: string;
        exitCode?: number;
        signal?: string;
        pid?: number;
      },
      stdout: fs.readFileSync(path.join(executionDirectory, "stdout.txt"), "utf8"),
      stderr: fs.readFileSync(path.join(executionDirectory, "stderr.txt"), "utf8"),
    };
  }

  it("records a retained shell's numeric child-crash status without inventing a supervisor signal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-shell-crash-"));
    roots.push(root);
    const { request, artifactRoot, timeline } = await run("command", "crash", root, true);
    await expect(request).resolves.toMatchObject({ exitCode: 143 });
    const evidence = await inspectArtifact(artifactRoot);
    expect(evidence.metadata).toMatchObject({
      status: "nonzero",
      exitCode: 143,
    });
    expect(evidence.metadata.signal).toBeUndefined();
    expect(evidence.stdout).toBe("RAW_OUT_command_crash\n");
    expect(evidence.stderr).toContain("RAW_ERR_command_crash\n");
    expect(timeline.map((event) => event.type)).toEqual(["process-started", "process-finished"]);
    expect(timeline[1]).toMatchObject({
      executionId: evidence.metadata.executionId,
      status: "nonzero",
    });
  });

  it.each(families.flatMap((family) => cases.map((scenario) => [family, scenario] as const)))(
    "records %s %s from a real executable",
    async (family, scenario) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-matrix-"));
      roots.push(root);
      const { request, artifactRoot, timeline } = await run(family, scenario, root);
      if (scenario === "partial") {
        const result = await request;
        expect(result).toBeDefined();
      } else if (scenario === "nonzero" || scenario === "crash") {
        if (family === "command" && scenario === "crash") {
          await expect(request).rejects.toBeInstanceOf(CommandRunInterruptedError);
        } else if (family === "command" || family === "opencode") {
          await expect(request).resolves.toMatchObject({
            exitCode: scenario === "crash" ? 1 : 9,
          });
        } else {
          await expect(request).rejects.toBeDefined();
        }
      } else if (scenario === "spawn-failure") {
        if (family === "command") {
          await expect(request).resolves.toMatchObject({ exitCode: 127 });
        } else {
          await expect(request).rejects.toBeDefined();
        }
      } else {
        await expect(request).rejects.toBeDefined();
      }

      const evidence = await inspectArtifact(artifactRoot);
      const expectedStatus =
        scenario === "partial"
          ? "success"
          : scenario === "crash" && family === "command"
            ? "interrupted"
            : scenario === "nonzero" || scenario === "crash"
              ? "nonzero"
              : scenario === "spawn-failure"
                ? family === "command"
                  ? "nonzero"
                  : "spawn-failure"
                : scenario === "timeout"
                  ? "timeout"
                  : "interrupted";
      expect(evidence.metadata.status).toBe(expectedStatus);
      const markers = fixtureMarkers(family, scenario);
      if (scenario === "spawn-failure") {
        expect(evidence.stdout).toBe("");
        expect(evidence.stderr).not.toContain(markers.stdout);
        expect(evidence.stderr).not.toContain(markers.stderr);
        if (family === "command") expect(evidence.stderr).toContain("not found");
      } else if (scenario === "partial") {
        const expectedStdout =
          family === "gh"
            ? `https://github.com/owner/repository/pull/1?marker=${markers.stdout}\n`
            : `${markers.stdout}:partial-stream`;
        expect(evidence.stdout).toBe(expectedStdout);
        expect(evidence.stderr).toBe(`${markers.stderr}:partial-stderr-stream`);
      } else if (scenario === "abort") {
        expect(evidence.stdout).toBe(`${markers.stdout}:partial-before-abort`);
        expect(evidence.stderr).toBe(`${markers.stderr}:partial-before-abort`);
      } else if (scenario === "timeout") {
        // The deadline includes executable/namespace startup. A timeout may
        // precede either write; retain whatever prefix actually arrived while
        // requiring authoritative timeout and process-tree stop evidence.
        expect(`${markers.stdout}\n`.startsWith(evidence.stdout)).toBe(true);
        expect(`${markers.stderr}\n`.startsWith(evidence.stderr)).toBe(true);
        expect(evidence.metadata).toMatchObject({ status: "timeout", treeStopped: true });
      } else {
        expect(evidence.stdout).toBe(`${markers.stdout}\n`);
        if (family === "command" && scenario === "crash")
          expect(evidence.stderr.startsWith(`${markers.stderr}\n`)).toBe(true);
        else expect(evidence.stderr).toBe(`${markers.stderr}\n`);
        expect(evidence.stderr).not.toContain(markers.stdout);
      }
      if (scenario === "nonzero") expect(evidence.metadata.exitCode).toBe(9);
      if (scenario === "crash" && family === "command") {
        expect(evidence.metadata.exitCode).toBeUndefined();
        expect(evidence.metadata.signal).toBe("SIGTERM");
      }
      if (scenario === "crash" && family !== "command")
        expect(evidence.metadata.signal).toBe("SIGTERM");
      const start = timeline.find((event) => event.type === "process-started");
      const finish = timeline.find((event) => event.type === "process-finished");
      expect(timeline.map((event) => event.type)).toEqual(["process-started", "process-finished"]);
      expect(start).toMatchObject({
        executionId: evidence.metadata.executionId,
        stdoutArtifact: expect.stringContaining("stdout.txt"),
        stderrArtifact: expect.stringContaining("stderr.txt"),
      });
      expect(finish).toMatchObject({
        executionId: evidence.metadata.executionId,
        status: expectedStatus,
      });
      expect(JSON.stringify(timeline)).not.toContain(markers.stdout);
      expect(JSON.stringify(timeline)).not.toContain(markers.stderr);
      const metadataText = fs.readFileSync(
        path.join(artifactRoot, evidence.metadata.executionId!, "execution.json"),
        "utf8",
      );
      expect(metadataText).not.toContain(markers.stdout);
      expect(metadataText).not.toContain(markers.stderr);

      const previousVitest = process.env.VITEST;
      const loggerRoot = path.join(root, "logger-runtime");
      const consoleDiagnostics: string[] = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
        consoleDiagnostics.push(values.join(" "));
      });
      configureLoggerRuntime(loggerRoot);
      process.env.VITEST = "false";
      try {
        const diagnostic = new Logger({
          projectId: `matrix-${family}`,
          cardId: `card-${scenario}`,
        });
        if (expectedStatus === "success")
          diagnostic.info(
            `Process ${family} ${scenario} completed; diagnostics: process-executions/${evidence.metadata.executionId}/stdout.txt`,
          );
        else
          diagnostic.error(
            `Process ${family} ${scenario} ended ${expectedStatus}; diagnostics: process-executions/${evidence.metadata.executionId}/stderr.txt`,
          );
      } finally {
        consoleError.mockRestore();
        if (previousVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = previousVitest;
      }
      const loggerFiles = fs.readdirSync(path.join(loggerRoot, "orchestrator-logs"));
      expect(loggerFiles).toHaveLength(1);
      const loggerText = fs.readFileSync(
        path.join(loggerRoot, "orchestrator-logs", loggerFiles[0]!),
        "utf8",
      );
      expect(loggerText).toContain(`Process ${family} ${scenario}`);
      expect(loggerText).toContain(evidence.metadata.executionId);
      expect(loggerText).not.toContain(markers.stdout);
      expect(loggerText).not.toContain(markers.stderr);
      for (const diagnostic of consoleDiagnostics) {
        expect(diagnostic).not.toContain(markers.stdout);
        expect(diagnostic).not.toContain(markers.stderr);
      }
    },
    15_000,
  );

  it.each(families)(
    "%s does not settle before killing a pipe-closed SIGTERM-resistant descendant",
    async (family) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "descendant-matrix-"));
      roots.push(root);
      const binaries = path.join(root, "bin");
      fs.mkdirSync(binaries);
      const sentinel = path.join(root, "sentinel");
      const executable = family === "command" ? "fixture-command" : family;
      const outMarker = `RAW_OUT_${family}_pipe-close`;
      const errMarker = `RAW_ERR_${family}_pipe-close`;
      const leaderOutput =
        family === "gh"
          ? `process.stdout.write("https://github.com/owner/repository/pull/1?marker=${outMarker}\\n");`
          : `process.stdout.write(${JSON.stringify(`${outMarker}\n`)});`;
      const leaderError = `process.stderr.write(${JSON.stringify(`${errMarker}\n`)});`;
      const descendant = `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(sentinel)},"start\\n"); setInterval(()=>fs.appendFileSync(${JSON.stringify(sentinel)},"write\\n"),10);`;
      fs.writeFileSync(
        path.join(binaries, executable),
        `#!${process.execPath}\nconst fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"}).unref(); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(sentinel)})){clearInterval(wait); ${leaderOutput} ${leaderError} process.exit(0);}},5);\n`,
        { mode: 0o700 },
      );
      process.env.PATH = binaries;
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        operationTimeoutMilliseconds: 15_000,
      });
      let request: Promise<unknown>;
      if (family === "git") request = new GitClient().getStatus(root);
      else if (family === "gh")
        request = new GitHubClient().findPullRequest({
          cwd: root,
          repository: "owner/repository",
          headBranch: "agent/sentinel",
        });
      else if (family === "opencode")
        request = new OpenCodeClient().run({
          cwd: root,
          model: "test/model",
          variant: "test",
          prompt: "pipe close descendant fixture",
          timeoutMilliseconds: 15_000,
          signal: new AbortController().signal,
        });
      else
        request = new CommandRunner().run({
          cwd: root,
          command: executable,
          timeoutMilliseconds: 15_000,
          artifactDirectory: path.join(root, "command-artifacts"),
          captureOutput: true,
          suppressOutput: true,
        });

      await expect(request).resolves.toBeDefined();
      const before = fs.statSync(sentinel).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fs.statSync(sentinel).size).toBe(before);
      const artifactRoot =
        family === "command"
          ? path.join(root, "command-artifacts")
          : path.join(runtimeRoot, "process-executions");
      const evidence = await inspectArtifact(artifactRoot);
      expect(evidence.metadata.status).toBe("success");
      expect(evidence.stdout).toContain(outMarker);
      expect(evidence.stderr).toBe(`${errMarker}\n`);
      expect(evidence.stdout).not.toContain(errMarker);
      expect(evidence.stderr).not.toContain(outMarker);
    },
    15_000,
  );

  it.each(["git", "gh", "opencode"] as const)(
    "%s decodes independently split UTF-8 streams before redaction and flushes malformed tails",
    async (family) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "utf8-streams-"));
      roots.push(root);
      const binaries = path.join(root, "bin");
      fs.mkdirSync(binaries);
      const secret = "秘密🔐";
      const out = `out: café:${secret}:終\n`;
      const err = `err: λ:${secret}:雪\n`;
      const script = `#!${process.execPath}\nconst out=Buffer.from(${JSON.stringify(out)}); const err=Buffer.from(${JSON.stringify(err)}); for(let i=0;i<out.length;i++) process.stdout.write(out.subarray(i,i+1)); for(let i=0;i<err.length;i++) process.stderr.write(err.subarray(i,i+1)); process.stdout.write(Buffer.from([0xe2,0x82]));\n`;
      fs.writeFileSync(path.join(binaries, family), script, { mode: 0o700 });
      process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        operationTimeoutMilliseconds: 10_000,
        secretValues: [secret],
      });
      const operation =
        family === "git"
          ? new GitClient().getStatus(root)
          : family === "gh"
            ? new GitHubClient().findPullRequest({
                cwd: root,
                repository: "owner/repository",
                headBranch: "agent/utf8",
              })
            : new OpenCodeClient().run({
                cwd: root,
                model: "test/model",
                variant: "test",
                prompt: "utf8 fixture",
                timeoutMilliseconds: 10_000,
                signal: new AbortController().signal,
              });
      if (family === "gh")
        await expect(operation).rejects.toThrow("GitHub CLI returned an invalid pull request URL");
      else await expect(operation).resolves.toBeDefined();

      const evidence = await inspectArtifact(path.join(runtimeRoot, "process-executions"));
      expect(evidence.stdout).toBe(`out: café:[REDACTED]:終\n�`);
      expect(evidence.stderr).toBe(`err: λ:[REDACTED]:雪\n`);
      expect(evidence.stdout).not.toContain(secret);
      expect(evidence.stderr).not.toContain(secret);
      expect(() => JSON.parse(JSON.stringify({ out: evidence.stdout }))).not.toThrow();
    },
    15_000,
  );

  it.each(["git", "opencode"] as const)(
    "%s records a zero-exit-on-SIGTERM capture overflow as evidence-failure",
    async (family) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-overflow-"));
      roots.push(root);
      const binaries = path.join(root, "bin");
      fs.mkdirSync(binaries);
      const filename = path.join(binaries, family);
      const outMarker = `RAW_OUT_${family}_capture-overflow`;
      const errMarker = `RAW_ERR_${family}_capture-overflow`;
      fs.writeFileSync(
        filename,
        `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(0)); process.stderr.write(${JSON.stringify(errMarker)},()=>{process.stdout.write(${JSON.stringify(outMarker)});process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 120));});\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        operationTimeoutMilliseconds: 30_000,
      });
      const request =
        family === "git"
          ? new GitClient().getStatus(root)
          : new OpenCodeClient().run({
              cwd: root,
              model: "test/model",
              variant: "test",
              prompt: "overflow fixture",
              timeoutMilliseconds: 30_000,
              signal: new AbortController().signal,
            });
      await expect(request).rejects.toBeDefined();
      const evidence = await inspectArtifact(path.join(runtimeRoot, "process-executions"));
      expect(evidence.metadata).toMatchObject({
        status: "evidence-failure",
        exitCode: 0,
      });
      expect(evidence.stderr).toBe(errMarker);
      expect(evidence.stdout.startsWith(outMarker)).toBe(true);
      expect(evidence.stdout).not.toContain(errMarker);
      expect(evidence.stderr).not.toContain(outMarker);
    },
  );

  it("runs real startup compatibility probes through CommandRunner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-probes-"));
    roots.push(root);
    const binaries = path.join(root, "bin");
    fs.mkdirSync(binaries);
    const commandList =
      "branch cat-file commit diff fetch ls-remote merge-base push rev-parse status worktree";
    fs.writeFileSync(
      path.join(binaries, "git"),
      `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==="--version") console.log("git version 2.45.0"); else if(args[0]==="--list-cmds=main") console.log(${JSON.stringify(commandList)}); else process.exit(2);\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(binaries, "opencode"),
      `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==="--version") console.log("1.2.0"); else if(args[0]==="run" && args[1]==="--help") console.log("--auto --pure --model --variant --dir --session --format --title"); else process.exit(2);\n`,
      { mode: 0o700 },
    );
    process.env.PATH = binaries;
    const bubblewrap = (originalPath ?? "")
      .split(path.delimiter)
      .map((directory) => path.join(directory, "bwrap"))
      .find((candidate) => fs.existsSync(candidate));
    if (!bubblewrap) throw new Error("test host does not provide Bubblewrap on PATH");
    fs.symlinkSync(bubblewrap, path.join(binaries, "bwrap"));
    configureProcessRuntime({
      runtimeRoot: path.join(root, "runtime"),
      signal: new AbortController().signal,
      operationTimeoutMilliseconds: 1_000,
    });
    await expect(validateGitAndOpenCode(new CommandRunner(), 1_000)).resolves.toBeUndefined();
    const records = fs.readdirSync(path.join(root, "runtime", "process-executions"));
    expect(records).toHaveLength(5);
    for (const entry of records) {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(root, "runtime", "process-executions", entry, "execution.json"),
          "utf8",
        ),
      ) as { status: string };
      expect(metadata.status).toBe("success");
    }
  });

  it("clones a local disposable repository through ensureRepository's real CommandRunner call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-caller-"));
    roots.push(root);
    const systemGit = (originalPath ?? "")
      .split(path.delimiter)
      .map((directory) => path.join(directory, "git"))
      .find((candidate) => fs.existsSync(candidate));
    if (!systemGit) throw new Error("test host does not provide Git on PATH");
    const source = path.join(root, "source");
    const destination = path.join(root, "clone");
    fs.mkdirSync(source);
    execFileSync(systemGit, ["init", "--quiet", source]);
    fs.writeFileSync(path.join(source, "fixture.txt"), "offline clone\n");
    execFileSync(systemGit, [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "add",
      "fixture.txt",
    ]);
    execFileSync(systemGit, [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const binaries = path.join(root, "bin");
    fs.mkdirSync(binaries);
    fs.writeFileSync(
      path.join(binaries, "git"),
      `#!${process.execPath}\nconst {spawnSync}=require("node:child_process"); const result=spawnSync(${JSON.stringify(systemGit)},process.argv.slice(2),{stdio:"inherit"}); process.exit(result.status??1);\n`,
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(binaries, "gh"),
      `#!${process.execPath}\nconst {spawnSync}=require("node:child_process"); const args=process.argv.slice(2); const result=spawnSync(${JSON.stringify(systemGit)},["clone",args[2],args[3]],{stdio:"inherit"}); process.exit(result.status??1);\n`,
      { mode: 0o700 },
    );
    process.env.PATH = binaries;
    configureProcessRuntime({
      runtimeRoot: path.join(root, "runtime"),
      signal: new AbortController().signal,
    });
    const project = {
      id: "local-clone-fixture",
      repository: { github: source, path: destination },
    } as unknown as ProjectConfig;
    const syntheticCredentials = {
      resolve: async () => ({
        mode: "github-app" as const,
        environment: { GH_TOKEN: "synthetic-offline-token" },
        secretValues: ["synthetic-offline-token"],
      }),
    } as unknown as import("../src/github/github-credential-provider.js").GitHubCredentialProvider;
    await ensureRepository(new GitClient(), new CommandRunner(), project, syntheticCredentials);
    expect(fs.readFileSync(path.join(destination, "fixture.txt"), "utf8")).toBe("offline clone\n");
    const executions = fs.readdirSync(path.join(root, "runtime", "process-executions"));
    expect(executions).toHaveLength(2);
  });

  it.each([
    ["nonzero", "nonzero"],
    ["missing", "spawn-failure"],
    ["hung", "timeout"],
  ] as const)(
    "captures flock %s through actual project lease acquisition",
    async (fault, status) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "flock-matrix-"));
      roots.push(root);
      const coordination = path.join(root, "coordination");
      fs.mkdirSync(coordination);
      provisionCoordinationNamespace(coordination, "flock-matrix");
      const binaries = path.join(root, "bin");
      fs.mkdirSync(binaries);
      if (fault !== "missing") {
        const behavior =
          fault === "nonzero" ? "process.exit(7);" : "setInterval(() => {}, 30_000);";
        fs.writeFileSync(path.join(binaries, "flock"), `#!${process.execPath}\n${behavior}\n`, {
          mode: 0o700,
        });
      }
      process.env.PATH = binaries;
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
        operationTimeoutMilliseconds: fault === "hung" ? 50 : 5_000,
      });
      await expect(
        acquireProjectOwnership(
          coordination,
          { trelloBoardId: "flock-board", githubRepository: "flock/repo" },
          "flock-matrix",
        ),
      ).rejects.toBeDefined();
      const entries = fs.readdirSync(path.join(runtimeRoot, "process-executions"));
      expect(entries).toHaveLength(1);
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(runtimeRoot, "process-executions", entries[0]!, "execution.json"),
          "utf8",
        ),
      ) as { status: string };
      expect(metadata.status).toBe(status);
    },
  );

  it("records real flock contention, release, and reacquisition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flock-contention-"));
    roots.push(root);
    const coordination = path.join(root, "coordination");
    fs.mkdirSync(coordination);
    provisionCoordinationNamespace(coordination, "real-flock");
    const runtimeRoot = path.join(root, "runtime");
    configureProcessRuntime({
      runtimeRoot,
      signal: new AbortController().signal,
    });
    process.env.PATH = originalPath;
    const identity = {
      trelloBoardId: "real-board",
      githubRepository: "real/repo",
    };
    const first = await acquireProjectOwnership(coordination, identity, "real-flock");
    await expect(acquireProjectOwnership(coordination, identity, "real-flock")).rejects.toThrow(
      /already held/,
    );
    await first.release();
    const replacement = await acquireProjectOwnership(coordination, identity, "real-flock");
    replacement.assertHeld();
    await replacement.release();
    const statuses = fs
      .readdirSync(path.join(runtimeRoot, "process-executions"))
      .map(
        (entry) =>
          (
            JSON.parse(
              fs.readFileSync(
                path.join(runtimeRoot, "process-executions", entry, "execution.json"),
                "utf8",
              ),
            ) as { status: string }
          ).status,
      );
    expect(statuses).toContain("lock-acquired");
    expect(statuses).toContain("lock-contended");
  });

  it.each(["git", "opencode"] as const)(
    "%s persists evidence-failure metadata when the stream recorder fails",
    async (family) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-failure-"));
      roots.push(root);
      const binaries = path.join(root, "bin");
      fs.mkdirSync(binaries);
      const filename = path.join(binaries, family);
      const outMarker = `RAW_OUT_${family}_recorder-failure`;
      const errMarker = `RAW_ERR_${family}_recorder-failure`;
      fs.writeFileSync(
        filename,
        `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(0)); process.stderr.write(${JSON.stringify(errMarker)},()=>process.stdout.write(${JSON.stringify(outMarker)})); setInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
      const runtimeRoot = path.join(root, "runtime");
      configureProcessRuntime({
        runtimeRoot,
        signal: new AbortController().signal,
      });
      const append = fs.appendFileSync;
      vi.spyOn(fs, "appendFileSync").mockImplementation((file, data, options) => {
        if (String(file).includes("process-executions") && String(file).endsWith("stdout.txt"))
          throw new Error("injected recorder failure");
        return append.call(fs, file, data, options);
      });
      const request =
        family === "git"
          ? new GitClient().getStatus(root)
          : new OpenCodeClient().run({
              cwd: root,
              model: "test/model",
              variant: "test",
              prompt: "recorder fixture",
              timeoutMilliseconds: 10_000,
              signal: new AbortController().signal,
            });
      await expect(request).rejects.toBeDefined();
      vi.restoreAllMocks();
      const evidence = await inspectArtifact(path.join(runtimeRoot, "process-executions"));
      expect(evidence.metadata.status).toBe("evidence-failure");
      expect(evidence.stdout).toBe("");
      expect(evidence.stderr).toBe(errMarker);
      expect(evidence.stderr).not.toContain(outMarker);
    },
  );
});
