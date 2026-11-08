import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { RunStore } from "../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(): TaskExecutionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primary-result-"));
  roots.push(root);
  const project = {
    id: "p",
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "trees"),
    },
  } as ProjectConfig;
  fs.mkdirSync(project.repository.path);
  fs.mkdirSync(project.repository.worktreeRoot);
  return new TaskExecutionStore(path.join(root, "state"), project);
}

describe("primary result artifacts", () => {
  it("round-trips output larger than one MiB and stores separate results", () => {
    const store = makeStore();
    const first = { output: "x".repeat(1024 * 1024 + 100) };
    const a = store.writePrimaryResultArtifact("result-a", first);
    const b = store.writePrimaryResultArtifact("result-b", { output: "other" });
    expect(store.readPrimaryResultArtifact(a)).toEqual(first);
    expect(store.readPrimaryResultArtifact(b)).toEqual({ output: "other" });
    expect(a.reference).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects invalid and oversized identifiers", () => {
    const store = makeStore();
    expect(() => store.writePrimaryResultArtifact("../bad", {})).toThrow();
    expect(() =>
      store.writePrimaryResultArtifact("x".repeat(1025), {}),
    ).toThrow();
  });

  it("rejects corrupt artifacts and symlink paths", () => {
    const store = makeStore();
    const ref = store.writePrimaryResultArtifact("result", { ok: true });
    const fallbackPath = path.join(
      roots.at(-1)!,
      "state",
      "task-executions",
      "p",
      "primary-results",
      `sha256-${ref.reference.slice(7)}`,
    );
    const actualPath = fallbackPath;
    expect(fs.statSync(path.dirname(actualPath)).mode & 0o077).toBe(0);
    expect(fs.statSync(actualPath).mode & 0o077).toBe(0);
    fs.writeFileSync(actualPath, Buffer.from('{"ok":false}'));
    expect(() => store.readPrimaryResultArtifact(ref)).toThrow(
      /digest|corrupt/i,
    );
    expect(() =>
      store.readPrimaryResultArtifact("sha256:" + "0".repeat(64)),
    ).toThrow();
    fs.rmSync(actualPath);
    fs.symlinkSync(path.join(path.dirname(actualPath), "missing"), actualPath);
    expect(() => store.readPrimaryResultArtifact(ref)).toThrow();
  });

  it("round-trips through canonical attempt storage and rejects corruption and ancestor/final symlinks", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "primary-result-authority-"),
    );
    roots.push(root);
    const project = {
      id: "p",
      repository: {
        path: path.join(root, "repo"),
        worktreeRoot: path.join(root, "trees"),
      },
    } as ProjectConfig;
    fs.mkdirSync(project.repository.path);
    fs.mkdirSync(project.repository.worktreeRoot);
    const storageRoot = path.join(root, "state");
    const integrationId = JSON.stringify({
      trelloBoardId: "board",
      githubRepository: "owner/repo",
    });
    const lease = {
      integrationId,
      instanceId: "instance",
      token: "lease-token",
      assertHeld: () => undefined,
    };
    const pinned = {
      integrationId,
      projectId: project.id,
      boardId: "board",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        failed: "failed",
        done: "done",
        backlog: "backlog",
      },
      repository: "owner/repo",
      repositoryPath: project.repository.path,
      worktreeRoot: project.repository.worktreeRoot,
      storageRoot,
    };
    const runStore = new RunStore(storageRoot, "attempt", pinned, lease);
    runStore.create({
      version: 1,
      revision: 1,
      projectId: project.id,
      cardId: "card",
      attemptId: "attempt",
      taskKind: "implementation",
      pinned,
      lifecycle: "planning",
      checkpoint: "planning",
      publicationState: "none",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: {
        instanceId: lease.instanceId,
        token: lease.token,
        generation: 1,
      },
      resources: [],
      pendingOperations: [],
      queue: [],
      budgets: {},
      sessions: {},
      artifacts: [],
      expectedTrelloListId: null,
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: new Date().toISOString(),
    });
    const authority = new ProjectRunAuthority(project.id, runStore, 1);
    const taskStore = new TaskExecutionStore(storageRoot, project, authority);
    const now = new Date().toISOString();
    taskStore.create({
      version: 1,
      projectId: project.id,
      cardId: "card",
      phase: "planning",
      operationKey: "op",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const result = { output: "canonical bytes" };
    const reference = taskStore.writePrimaryResultArtifact(
      "canonical-result",
      result,
    );
    expect(taskStore.readPrimaryResultArtifact(reference)).toEqual(result);
    const artifactPath = path.join(
      storageRoot,
      "artifacts",
      "attempt",
      `sha256-${reference.reference.slice(7)}`,
    );
    fs.writeFileSync(artifactPath, Buffer.from("corrupt bytes"));
    expect(() => taskStore.readPrimaryResultArtifact(reference)).toThrow(
      /digest/i,
    );
    fs.rmSync(artifactPath);
    fs.symlinkSync(path.join(root, "missing-target"), artifactPath);
    expect(() => taskStore.readPrimaryResultArtifact(reference)).toThrow();
    fs.rmSync(artifactPath);
    fs.rmSync(path.join(storageRoot, "artifacts", "attempt"), {
      recursive: true,
    });
    fs.symlinkSync(root, path.join(storageRoot, "artifacts", "attempt"));
    expect(() => taskStore.readPrimaryResultArtifact(reference)).toThrow();
  });
});
