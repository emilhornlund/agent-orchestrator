import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrateLegacyProject } from "../src/task-session/legacy-state-import.js";
import { RunRegistry, RunStore } from "../src/task-session/run-store.js";
import type { ProjectConfig } from "../src/config/config.js";

const fixture = JSON.parse(
  fs.readFileSync("tests/fixtures/p2-prior-writer-v1.json", "utf8"),
) as {
  provenance: { writerCommit: string; artifactVersion: number; schema: string };
  record: Record<string, unknown> & { projectId: string; cardId: string };
};

describe("P2 upgrade from the committed legacy writer", () => {
  it("imports exact v1 TaskExecutionStore output and keeps source bytes and references", () => {
    expect(fixture.provenance).toMatchObject({
      writerCommit: "05319ead1682b47135c67194b1743bee7068fbfd",
      artifactVersion: 1,
      schema: "TaskExecutionRecord v1",
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2-upgrade-"));
    try {
      const runtimeRoot = path.join(root, "runtime");
      const storageRoot = path.join(root, "state");
      const project = {
        id: fixture.record.projectId,
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
          defaultBranch: "main",
        },
      } as unknown as ProjectConfig;
      fs.mkdirSync(path.join(runtimeRoot, "task-executions", project.id), {
        recursive: true,
      });
      fs.mkdirSync(project.repository.path, { recursive: true });
      fs.mkdirSync(project.repository.worktreeRoot, { recursive: true });
      const sourcePath = path.join(
        runtimeRoot,
        "task-executions",
        project.id,
        `${fixture.record.cardId}.json`,
      );
      const sourceBytes = Buffer.from(
        `${JSON.stringify(fixture.record, null, 2)}\n`,
      );
      fs.writeFileSync(sourcePath, sourceBytes);
      const integrationId = JSON.stringify({
        trelloBoardId: "board",
        githubRepository: "example/project",
      });
      const lease = {
        integrationId,
        instanceId: "upgrade-test",
        token: "test-token",
        assertHeld() {},
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
        repository: "example/project",
        repositoryPath: project.repository.path,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot,
      };
      const registry = new RunRegistry(storageRoot, integrationId, lease);
      const migrated = migrateLegacyProject({
        runtimeRoot,
        project,
        pinned,
        lease,
        store: new RunStore(storageRoot, "unused", pinned, lease),
        storeForAttempt: (attemptId) =>
          new RunStore(storageRoot, attemptId, pinned, lease),
        registry,
        now: new Date("2026-11-01T00:00:00.000Z"),
      });
      expect(migrated.status).toBe("imported");
      if (migrated.status !== "imported")
        throw new Error("expected imported legacy writer artifact");
      expect(migrated.record).toMatchObject({
        lifecycle: "waiting",
        checkpoint: "human-feedback",
        wait: { reason: "legacy-execution-reconciliation" },
        sessions: { primary: "session-prior-writer" },
        publicationState: "unknown",
        legacy: { sourceVersion: 1, sourcePhase: "human-feedback" },
      });
      expect(migrated.record.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "git-branch",
            path: "agent/card-prior-writer",
          }),
          expect.objectContaining({
            kind: "pull-request",
            id: "73",
            path: "https://github.com/example/project/pull/73",
          }),
        ]),
      );
      expect(registry.read()?.attemptId).toBe(migrated.record.attemptId);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
      const snapshotRef = migrated.record.artifacts.find(
        (item) =>
          item.mediaType ===
          "application/vnd.agent-orchestrator.legacy-snapshot+json",
      )!;
      const snapshot = JSON.parse(
        fs.readFileSync(snapshotRef.path, "utf8"),
      ) as { sources: { bytesBase64: string; sha256: string }[] };
      expect(snapshot.sources).toHaveLength(1);
      const importedBytes = Buffer.from(
        snapshot.sources[0]!.bytesBase64,
        "base64",
      );
      expect(importedBytes).toEqual(sourceBytes);
      expect(createHash("sha256").update(importedBytes).digest("hex")).toBe(
        snapshot.sources[0]!.sha256,
      );
      expect(snapshot.sources[0]!.sha256).toBe(
        createHash("sha256").update(sourceBytes).digest("hex"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves unsupported source versions and refuses migration before publishing authority", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "p2-upgrade-unsupported-"),
    );
    try {
      const runtimeRoot = path.join(root, "runtime");
      const storageRoot = path.join(root, "state");
      const projectId = fixture.record.projectId;
      const task = { ...fixture.record, version: 99 };
      const taskDirectory = path.join(
        runtimeRoot,
        "task-executions",
        projectId,
      );
      fs.mkdirSync(taskDirectory, { recursive: true });
      const sourcePath = path.join(
        taskDirectory,
        `${fixture.record.cardId}.json`,
      );
      const original = Buffer.from(JSON.stringify(task));
      fs.writeFileSync(sourcePath, original);
      const project = {
        id: projectId,
        repository: {
          path: path.join(root, "repo"),
          worktreeRoot: path.join(root, "worktrees"),
          defaultBranch: "main",
        },
      } as unknown as ProjectConfig;
      const integrationId = "unsupported-version";
      const lease = {
        integrationId,
        instanceId: "upgrade-test",
        token: "test-token",
        assertHeld() {},
      };
      const pinned = {
        integrationId,
        projectId,
        boardId: "board",
        lists: {
          ready: "ready",
          working: "working",
          review: "review",
          failed: "failed",
          done: "done",
          backlog: "backlog",
        },
        repository: "example/project",
        repositoryPath: project.repository.path,
        worktreeRoot: project.repository.worktreeRoot,
        storageRoot,
      };
      const registry = new RunRegistry(storageRoot, integrationId, lease);
      expect(() =>
        migrateLegacyProject({
          runtimeRoot,
          project,
          pinned,
          lease,
          store: new RunStore(storageRoot, "unused", pinned, lease),
          registry,
          storeForAttempt: (attemptId) =>
            new RunStore(storageRoot, attemptId, pinned, lease),
        }),
      ).toThrow(/Legacy project migration blocked/);
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(
        createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
      ).toBe(createHash("sha256").update(original).digest("hex"));
      expect(registry.read()).toBeNull();
      expect(fs.existsSync(path.join(storageRoot, "attempts"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
