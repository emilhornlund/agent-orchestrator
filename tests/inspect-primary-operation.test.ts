import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  beginPrimaryExecution,
  bindPrimaryExecutionEvidence,
  completePrimaryExecution,
  reconcilePendingPrimaryExecution,
} from "../src/task-session/primary-operation-ledger.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(status = "nonzero") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-primary-"));
  roots.push(root);
  const project = {
    id: "project",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  fs.mkdirSync(path.join(root, "state"));
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  const now = new Date().toISOString();
  store.create({
    version: 1,
    projectId: "project",
    cardId: "card",
    phase: "planning",
    operationKey: "op",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: now,
    updatedAt: now,
  });
  const cwd = project.repository.path;
  const artifactRoot = path.join(root, "artifacts", "card", "process-executions");
  fs.mkdirSync(path.join(artifactRoot, "exec"), { recursive: true });
  const metadataPath = path.join(artifactRoot, "exec", "execution.json");
  beginPrimaryExecution(store, "card", "op", "work", "session");
  bindPrimaryExecutionEvidence(store, "card", "op", 1, {
    executionId: "exec",
    metadataPath,
    artifactRoot,
  });
  const entry = store.read("card")!.primaryOperations!.op!;
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      executionId: "exec",
      cwd,
      status,
      treeStopped: true,
      exitCode: 1,
    }),
  );
  if (status !== "running")
    completePrimaryExecution(store, "card", "op", "failed", {
      exitCode: 1,
      output: "",
      errorOutput: "",
    });
  return {
    root,
    store,
    project,
    cwd,
    artifactRoot,
    metadataPath,
    identity: { trustedRoot: path.join(root, "artifacts"), cwd },
    entry,
  };
}
describe("inspectPrimaryOperationEvidence", () => {
  it("resumes repeated cooperative shutdowns without charging the genuine failure allowance", async () => {
    const f = fixture("running");
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        beginPrimaryExecution(f.store, "card", "op", "work", "session");
        const directory = path.join(f.artifactRoot, `exec-${attempt}`);
        fs.mkdirSync(directory);
        bindPrimaryExecutionEvidence(f.store, "card", "op", attempt, {
          executionId: `exec-${attempt}`,
          metadataPath: path.join(directory, "execution.json"),
          artifactRoot: f.artifactRoot,
        });
      }
      const entry = f.store.read("card")!.primaryOperations!.op!;
      fs.writeFileSync(
        entry.processMetadataPath!,
        JSON.stringify({
          executionId: entry.processExecutionId,
          cwd: f.cwd,
          sessionId: "session",
          status: "interrupted",
          treeStopped: true,
          exitCode: 0,
        }),
      );
      completePrimaryExecution(f.store, "card", "op", "ambiguous");
      const proof = await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity);
      expect(proof).toMatchObject({
        status: "stopped-after-dispatch",
        failureClassification: "cancelled",
      });
      if (proof.status !== "stopped-after-dispatch") throw new Error("Expected stopped proof");
      reconcilePendingPrimaryExecution(
        f.store,
        "card",
        "op",
        "stopped",
        undefined,
        proof.failureClassification,
      );
      reconcilePendingPrimaryExecution(
        f.store,
        "card",
        "op",
        "stopped",
        undefined,
        proof.failureClassification,
      );
      expect(f.store.read("card")!.primaryOperations!.op).toMatchObject({
        executions: attempt,
        failureExecutions: 0,
        cancelledExecutions: attempt,
        status: "failed",
        retrySafe: true,
      });
    }
  });
  it("recovers only hash- and execution-bound outage classification evidence", async () => {
    const f = fixture();
    const result = {
      exitCode: 1,
      output: '{"type":"error"}',
      errorOutput: "",
      processExecutionId: "exec",
      sessionId: "session",
      failureClassification: "dependency-outage",
    };
    const bytes = Buffer.from(JSON.stringify(result));
    fs.writeFileSync(path.join(path.dirname(f.metadataPath), "result.json"), bytes);
    fs.writeFileSync(
      f.metadataPath,
      JSON.stringify({
        executionId: "exec",
        cwd: f.cwd,
        sessionId: "session",
        status: "nonzero",
        treeStopped: true,
        exitCode: 1,
        failureClassification: "dependency-outage",
        resultArtifact: {
          path: "result.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
    );
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toMatchObject({
      status: "stopped-after-dispatch",
      failureClassification: "dependency-outage",
    });
    fs.writeFileSync(path.join(path.dirname(f.metadataPath), "result.json"), "{}");
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
  });
  it.each([
    [
      "metadata session differs from ledger",
      { metadataSessionId: "other" },
      { sessionId: "other" },
    ],
    ["payload session differs from ledger", {}, { sessionId: "other" }],
    ["payload exit code is not an integer", {}, { exitCode: "1" }],
    ["metadata exit code is not an integer", { exitCode: null }, {}],
    ["payload and metadata exit codes differ", { exitCode: 2 }, {}],
    ["classification omitted from metadata", { omitMetadataClassification: true }, {}],
    ["classification omitted from payload", {}, { omitPayloadClassification: true }],
  ])(
    "rejects correctly hashed semantically mismatched outage evidence: %s",
    async (_label, metadataOverrides, payloadOverrides) => {
      const f = fixture();
      const metaOptions = metadataOverrides as Record<string, unknown>;
      const resultOptions = payloadOverrides as Record<string, unknown>;
      const result: Record<string, unknown> = {
        exitCode: 1,
        output: "provider unavailable",
        errorOutput: "",
        processExecutionId: "exec",
        sessionId: resultOptions.sessionId ?? "session",
        failureClassification: "dependency-outage",
        ...(resultOptions.exitCode === undefined ? {} : { exitCode: resultOptions.exitCode }),
      };
      if (resultOptions.omitPayloadClassification === true) delete result.failureClassification;
      const bytes = Buffer.from(JSON.stringify(result));
      fs.writeFileSync(path.join(path.dirname(f.metadataPath), "result.json"), bytes);
      const metadata: Record<string, unknown> = {
        executionId: "exec",
        cwd: f.cwd,
        sessionId: "session",
        status: "nonzero",
        treeStopped: true,
        exitCode: 1,
        failureClassification: "dependency-outage",
        resultArtifact: {
          path: "result.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
      if (metaOptions.metadataSessionId !== undefined)
        metadata.sessionId = metaOptions.metadataSessionId;
      if (metaOptions.exitCode !== undefined) metadata.exitCode = metaOptions.exitCode;
      if (metaOptions.omitMetadataClassification === true) delete metadata.failureClassification;
      fs.writeFileSync(f.metadataPath, JSON.stringify(metadata));
      expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
        status: "unknown",
      });
    },
  );
  it("recognizes bound finalized stopped evidence", async () => {
    const f = fixture();
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toMatchObject({
      status: "stopped-after-dispatch",
      operationId: "op",
      execution: 1,
      sessionId: "session",
    });
  });
  it("treats running, missing, corrupt, and mismatched evidence as unknown", async () => {
    const f = fixture("running");
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
    fs.unlinkSync(f.metadataPath);
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
    fs.writeFileSync(f.metadataPath, "{");
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
    fs.writeFileSync(
      f.metadataPath,
      JSON.stringify({
        executionId: "other",
        cwd: f.cwd,
        status: "nonzero",
        treeStopped: true,
      }),
    );
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
  });
  it.skipIf(process.platform !== "linux")(
    "keeps live-owner, live-process-group, and unverifiable-namespace cases unknown",
    async () => {
      const f = fixture("running");
      const processStart = (pid: number) => {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      };
      const liveGroupLeader = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      try {
        const leaderPid = liveGroupLeader.pid;
        if (leaderPid === undefined) throw new Error("missing process pid");
        const base = {
          executionId: "exec",
          cwd: f.cwd,
          status: "running",
          dispatchState: "dispatched",
          supervisorPid: process.pid,
          supervisorStartIdentity: processStart(process.pid),
          pid: leaderPid,
          pidStartIdentity: processStart(leaderPid),
          processGroupId: leaderPid,
          hostBootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
        };
        fs.writeFileSync(f.metadataPath, JSON.stringify(base));
        expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
          status: "unknown",
        });
        fs.writeFileSync(
          f.metadataPath,
          JSON.stringify({ ...base, pidNamespace: "pid:[unverifiable]" }),
        );
        expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
          status: "unknown",
        });
      } finally {
        if (liveGroupLeader.pid !== undefined) {
          liveGroupLeader.kill("SIGKILL");
          await new Promise<void>((resolve) => liveGroupLeader.once("close", () => resolve()));
        }
      }
    },
  );
  it("rejects unsafe metadata symlink paths", async () => {
    const f = fixture();
    fs.unlinkSync(f.metadataPath);
    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(
      outside,
      JSON.stringify({
        executionId: "exec",
        cwd: f.cwd,
        status: "nonzero",
        treeStopped: true,
      }),
    );
    fs.symlinkSync(outside, f.metadataPath);
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
  });
  it("requires explicit not-dispatched evidence for refund", async () => {
    const f = fixture("not-dispatched");
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "never-dispatched",
    });
  });
  it("recognizes process-runtime spawn-failure proof only with no child pid", async () => {
    const f = fixture("spawn-failure");
    fs.writeFileSync(
      f.metadataPath,
      JSON.stringify({
        executionId: "exec",
        cwd: f.cwd,
        status: "spawn-failure",
        dispatchState: "not-dispatched",
        treeStopped: true,
      }),
    );
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "never-dispatched",
    });
    fs.writeFileSync(
      f.metadataPath,
      JSON.stringify({
        executionId: "exec",
        cwd: f.cwd,
        status: "spawn-failure",
        dispatchState: "not-dispatched",
        pid: 123,
        treeStopped: true,
      }),
    );
    expect(await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity)).toEqual({
      status: "unknown",
    });
  });
  it.skipIf(process.platform !== "linux")(
    "keeps orphaned running metadata ambiguous when a setsid descendant escapes the process group",
    async () => {
      const f = fixture("running");
      const sentinel = path.join(f.root, "escaped-descendant.txt");
      const supervisorScript = `
      import { spawn } from "node:child_process";
      import { beginProcessEvidence } from ${JSON.stringify(new URL("../src/process/process-runtime.ts", import.meta.url).href)};
      import { bindPrimaryExecutionEvidence } from ${JSON.stringify(new URL("../src/task-session/primary-operation-ledger.ts", import.meta.url).href)};
      import { TaskExecutionStore } from ${JSON.stringify(new URL("../src/task-session/task-execution-store.ts", import.meta.url).href)};
      const f = JSON.parse(process.env.FIXTURE);
      const store = new TaskExecutionStore(f.state, f.project);
      const evidence = beginProcessEvidence("scripted primary", f.cwd, [], f.artifactRoot);
      bindPrimaryExecutionEvidence(store, "card", "op", 1, { executionId: evidence.executionId, metadataPath: evidence.metadataPath, artifactRoot: evidence.artifactRoot });
      const escapedScript = ${JSON.stringify(`const fs=require('node:fs');const end=Date.now()+1800;const write=()=>{fs.appendFileSync(${JSON.stringify(sentinel)},'x');if(Date.now()<end)setTimeout(write,15)};write();`)};
      const primaryCode = "const {spawn}=require('node:child_process');spawn(process.execPath,['-e'," + JSON.stringify(escapedScript) + "],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},900);";
      const child = spawn(process.execPath, ["-e", primaryCode], { detached: true, stdio: "ignore" });
      evidence.dispatched(child.pid);
      process.stdout.write(JSON.stringify({ pid: process.pid, group: child.pid }));
      setInterval(() => {}, 1000);
    `;
      const supervisor = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", supervisorScript],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            FIXTURE: JSON.stringify({
              state: path.join(f.root, "state"),
              project: f.project,
              cwd: f.cwd,
              artifactRoot: f.artifactRoot,
            }),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      supervisor.stdout.setEncoding("utf8").on("data", (part: string) => {
        stdout += part;
      });
      supervisor.stderr.setEncoding("utf8").on("data", (part: string) => {
        stderr += part;
      });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`supervisor did not bind process evidence: ${stderr}`)),
          10_000,
        );
        supervisor.stdout.on("data", () => {
          if (stdout.includes("}")) {
            clearTimeout(deadline);
            resolve();
          }
        });
        supervisor.once("error", reject);
      });
      const spawned = JSON.parse(stdout) as { pid: number; group: number };
      supervisor.kill("SIGKILL");
      await new Promise<void>((resolve) => supervisor.once("close", () => resolve()));
      const attemptFile = path.join(f.root, "retry-count");
      const childScript = `
      import fs from "node:fs";
      import { TaskExecutionStore } from ${JSON.stringify(new URL("../src/task-session/task-execution-store.ts", import.meta.url).href)};
      import { runPrimaryOperation } from ${JSON.stringify(new URL("../src/task-session/run-primary-operation.ts", import.meta.url).href)};
      import { inspectPrimaryOperationEvidence } from ${JSON.stringify(new URL("../src/task-session/inspect-primary-operation.ts", import.meta.url).href)};
      const f = JSON.parse(process.env.FIXTURE); const store = new TaskExecutionStore(f.state, f.project);
      let dispatched = false;
      try { await runPrimaryOperation({ store, cardId: "card", operationId: "op", activity: "work", sessionId: "session", execute: async () => { dispatched = true; fs.appendFileSync(f.attemptFile, "x"); return { exitCode: 0, output: "retried", errorOutput: "", sessionId: "session" }; }, inspectPending: () => inspectPrimaryOperationEvidence(store, "card", "op", { trustedRoot: f.trustedRoot, cwd: f.cwd }) }); } catch {}
      process.stdout.write(JSON.stringify({ dispatched, entry: store.read("card").primaryOperations.op }));
    `;
      const inspectFresh = () =>
        spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            FIXTURE: JSON.stringify({
              state: path.join(f.root, "state"),
              project: f.project,
              cwd: f.cwd,
              trustedRoot: path.join(f.root, "artifacts"),
              attemptFile,
            }),
          },
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const whileAlive = inspectFresh();
      expect(whileAlive.status, whileAlive.stderr).toBe(0);
      expect(JSON.parse(whileAlive.stdout)).toMatchObject({
        dispatched: false,
        entry: { executions: 1, status: "ambiguous" },
      });
      const firstSize = fs.statSync(sentinel).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fs.statSync(sentinel).size).toBeGreaterThan(firstSize);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const escapedGroupStopped = inspectFresh();
      expect(escapedGroupStopped.status, escapedGroupStopped.stderr).toBe(0);
      expect(JSON.parse(escapedGroupStopped.stdout)).toMatchObject({
        dispatched: false,
        entry: { executions: 1, status: "ambiguous" },
      });
      expect(fs.statSync(sentinel).size).toBeGreaterThan(firstSize);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const afterEscapeStopped = inspectFresh();
      expect(afterEscapeStopped.status, afterEscapeStopped.stderr).toBe(0);
      expect(JSON.parse(afterEscapeStopped.stdout)).toMatchObject({
        dispatched: false,
        entry: { executions: 1, status: "ambiguous" },
      });
      expect(fs.existsSync(attemptFile)).toBe(false);
      expect(spawned.group).toBeGreaterThan(0);
    },
    30_000,
  );
});
