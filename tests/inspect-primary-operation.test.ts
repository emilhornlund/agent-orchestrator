import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import {
  beginPrimaryExecution,
  bindPrimaryExecutionEvidence,
  completePrimaryExecution,
} from "../src/task-session/primary-operation-ledger.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
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
  const artifactRoot = path.join(
    root,
    "artifacts",
    "card",
    "process-executions",
  );
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
    cwd,
    artifactRoot,
    metadataPath,
    identity: { trustedRoot: path.join(root, "artifacts"), cwd },
    entry,
  };
}
describe("inspectPrimaryOperationEvidence", () => {
  it("recognizes bound finalized stopped evidence", async () => {
    const f = fixture();
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toMatchObject({
      status: "stopped-after-dispatch",
      operationId: "op",
      execution: 1,
      sessionId: "session",
    });
  });
  it("treats running, missing, corrupt, and mismatched evidence as unknown", async () => {
    const f = fixture("running");
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
    fs.unlinkSync(f.metadataPath);
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
    fs.writeFileSync(f.metadataPath, "{");
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
    fs.writeFileSync(
      f.metadataPath,
      JSON.stringify({
        executionId: "other",
        cwd: f.cwd,
        status: "nonzero",
        treeStopped: true,
      }),
    );
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
  });
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
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
  });
  it("requires explicit not-dispatched evidence for refund", async () => {
    const f = fixture("not-dispatched");
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "never-dispatched" });
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
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "never-dispatched" });
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
    expect(
      await inspectPrimaryOperationEvidence(f.store, "card", "op", f.identity),
    ).toEqual({ status: "unknown" });
  });
});
