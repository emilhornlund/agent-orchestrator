import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { CommandRunner } from "../src/process/command-runner.js";
import { GitClient } from "../src/git/git-client.js";
import { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import {
  configureProcessRuntime,
  isSameProcessInstance,
  signalProcessGroup,
} from "../src/process/process-runtime.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtures: { root: string; controller: AbortController; launchers: ChildProcess[] }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort();
    for (const child of f.launchers)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const executions = path.join(f.root, "runtime", "process-executions");
    if (fs.existsSync(executions))
      for (const id of fs.readdirSync(executions)) {
        const file = path.join(executions, id, "execution.json");
        if (!fs.existsSync(file)) continue;
        const evidence = JSON.parse(fs.readFileSync(file, "utf8")) as {
          pid?: number;
          pidStartIdentity?: string;
        };
        if (evidence.pid && isSameProcessInstance(evidence.pid, evidence.pidStartIdentity) === true)
          signalProcessGroup(evidence.pid, "SIGKILL");
      }
    // Also release owned fixture writers if a regression removes containment.
    // Match the unique fixture path, never a namespace-local PID as a host PID.
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(pid)) continue;
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (args.includes(f.root)) process.kill(Number(pid), "SIGKILL");
      } catch {
        /* Owned process exited, or unrelated process is inaccessible. */
      }
    }
    await delay(25);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  configureProcessRuntime({ runtimeRoot: os.tmpdir(), signal: new AbortController().signal });
});

async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Owned containment fixture did not start");
    await delay(10);
  }
}

function fixture(mode: "success" | "abort" | "timeout") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-containment-"));
  const bin = path.join(root, "bin"),
    runtime = path.join(root, "runtime");
  fs.mkdirSync(bin);
  const controller = new AbortController();
  const launchers: ChildProcess[] = [];
  fixtures.push({ root, controller, launchers });
  const sentinel = path.join(root, "sentinel");
  const writer = `const fs=require('node:fs'); process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(sentinel)},'start\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(sentinel)},'write\\n'),10);`;
  const detached = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  for (const family of ["command", "git", "gh", "opencode"]) {
    const output = family === "gh" ? "https://github.com/owner/repo/pull/1" : "completed";
    fs.writeFileSync(
      path.join(bin, family === "command" ? "fixture-command" : family),
      `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',${JSON.stringify(detached)}],{detached:true,stdio:'ignore'}).unref();
const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(sentinel)}))return;clearInterval(poll);
${mode === "success" ? `process.stdout.write(${JSON.stringify(output)});process.exit(0);` : "setInterval(()=>{},1000);"}},5);
`,
      { mode: 0o700 },
    );
  }
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  configureProcessRuntime({
    runtimeRoot: runtime,
    signal: controller.signal,
    operationTimeoutMilliseconds: 1000,
  });
  const execute = (family: string): Promise<unknown> => {
    if (family === "git") return new GitClient().getStatus(root);
    if (family === "gh")
      return new GitHubClient().findPullRequest({
        cwd: root,
        repository: "owner/repo",
        headBranch: "agent/task",
      });
    if (family === "opencode")
      return new OpenCodeClient().run({
        cwd: root,
        model: "openai/test",
        prompt: "fixture",
        timeoutMilliseconds: 1000,
        signal: controller.signal,
      });
    return new CommandRunner().run({
      cwd: root,
      command: "fixture-command",
      captureOutput: true,
      suppressOutput: true,
    });
  };
  const evidence = () => {
    const dir = path.join(runtime, "process-executions");
    const ids = fs.readdirSync(dir);
    expect(ids).toHaveLength(1);
    return JSON.parse(fs.readFileSync(path.join(dir, ids[0]!, "execution.json"), "utf8")) as Record<
      string,
      unknown
    >;
  };
  return { root, bin, runtime, sentinel, controller, launchers, execute, evidence };
}

it.each(["command", "git", "gh", "opencode"])(
  "contains detached grandchildren after normal %s completion",
  async (family) => {
    const f = fixture("success");
    await f.execute(family);
    await waitForFile(f.sentinel);
    const size = fs.statSync(f.sentinel).size;
    await delay(150);
    expect(fs.statSync(f.sentinel).size).toBe(size);
    expect(f.evidence()).toMatchObject({
      status: "success",
      containment: "linux-pid-namespace",
      treeStopped: true,
    });
  },
);

it.each(["command", "git", "gh", "opencode"])(
  "stops detached TERM-resistant grandchildren on %s cancellation",
  async (family) => {
    const f = fixture("abort");
    const operation = f.execute(family);
    const outcome = operation.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await waitForFile(f.sentinel);
      f.controller.abort("signal");
      expect((await outcome).error).toBeInstanceOf(Error);
    } finally {
      f.controller.abort("signal");
      await outcome;
    }
    const size = fs.statSync(f.sentinel).size;
    await delay(150);
    expect(fs.statSync(f.sentinel).size).toBe(size);
    expect(f.evidence()).toMatchObject({
      status: "interrupted",
      containment: "linux-pid-namespace",
      treeStopped: true,
    });
  },
);

it.each(["command", "git", "gh", "opencode"])(
  "stops detached grandchildren at the %s operation timeout",
  async (family) => {
    const f = fixture("timeout");
    await expect(f.execute(family)).rejects.toBeInstanceOf(Error);
    const size = fs.statSync(f.sentinel).size;
    await delay(150);
    expect(fs.statSync(f.sentinel).size).toBe(size);
    expect(f.evidence()).toMatchObject({
      status: "timeout",
      containment: "linux-pid-namespace",
      treeStopped: true,
    });
  },
);

it("kernel containment stops task writers after the controller is killed without graceful shutdown", async () => {
  const f = fixture("abort");
  const script = `import {CommandRunner} from ${JSON.stringify(new URL("../src/process/command-runner.ts", import.meta.url).href)};
import {configureProcessRuntime} from ${JSON.stringify(new URL("../src/process/process-runtime.ts", import.meta.url).href)};
configureProcessRuntime({runtimeRoot:${JSON.stringify(f.runtime)},signal:new AbortController().signal});
await new CommandRunner().run({cwd:${JSON.stringify(f.root)},command:'fixture-command',suppressOutput:true});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  f.launchers.push(child);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await waitForFile(f.sentinel);
  child.kill("SIGKILL");
  await closed;
  await delay(150);
  const size = fs.statSync(f.sentinel).size;
  await delay(150);
  expect(fs.statSync(f.sentinel).size).toBe(size);
  expect(f.evidence().treeStopped).not.toBe(true);
});

it("does not expose supervisor status or cancellation channels as payload descriptors", async () => {
  const f = fixture("success");
  fs.writeFileSync(
    path.join(f.bin, "fixture-command"),
    `#!${process.execPath}
const fs=require('node:fs');
for(const fd of [3,4]){try{fs.writeSync(fd,'PAYLOAD_CANNOT_FORGE_SUPERVISOR_STATUS\\n')}catch{}}
console.log('payload completed');`,
    { mode: 0o700 },
  );
  await expect(f.execute("command")).resolves.toMatchObject({
    exitCode: 0,
    output: "payload completed\n",
  });
  expect(f.evidence()).toMatchObject({ status: "success", payloadSpawned: true });
});
