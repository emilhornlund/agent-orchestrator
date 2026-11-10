import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/task-session/run-record.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

describe("run history and retention survive process restart", () => {
  it("reconstructs transitions independently and retains active Human Review evidence", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "process-history-restart-"),
    );
    try {
      const runtimeRoot = path.join(root, "runtime");
      const activeLog = path.join(
        runtimeRoot,
        "artifacts",
        "history-project",
        "history-card",
        "attempt-history-restart",
        "active-child.log",
      );
      const expiredLog = path.join(
        runtimeRoot,
        "artifacts",
        "history-project",
        "prior-card",
        "prior-attempt",
        "expired-child.log",
      );
      const loggerFile = path.join(
        runtimeRoot,
        "orchestrator-logs",
        `orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
      );
      fs.mkdirSync(path.dirname(activeLog), { recursive: true });
      fs.mkdirSync(path.dirname(expiredLog), { recursive: true });
      fs.writeFileSync(activeLog, "active process evidence\n");
      fs.writeFileSync(expiredLog, "unreferenced expired evidence\n");
      const oldTime = new Date(Date.now() - 40 * millisecondsPerDay);
      fs.utimesSync(activeLog, oldTime, oldTime);
      fs.utimesSync(expiredLog, oldTime, oldTime);

      const pinned = {
        integrationId: JSON.stringify({
          trelloBoardId: "history-board",
          githubRepository: "owner/history",
        }),
        projectId: "history-project",
        boardId: "history-board",
        lists: {
          ready: "ready",
          working: "working",
          review: "human-review",
          failed: "failed",
          done: "done",
          backlog: "backlog",
        },
        repository: "owner/history",
        repositoryPath: path.join(root, "repo"),
        worktreeRoot: path.join(root, "worktrees"),
        storageRoot: runtimeRoot,
      } as const;
      const record: RunRecord = {
        version: 1,
        revision: 1,
        projectId: pinned.projectId,
        cardId: "history-card",
        attemptId: "attempt-history-restart",
        taskKind: "implementation",
        pinned,
        lifecycle: "ready",
        checkpoint: "ready",
        publicationState: "none",
        operation: {
          id: "operation-history-1",
          kind: "fixture-operation",
          generation: 1,
        },
        wait: { reason: null, dependency: null, since: null, retryAt: null },
        owner: {
          instanceId: "history-instance",
          token: "history-lease",
          generation: 1,
        },
        resources: [
          {
            kind: "child-process-log",
            id: "active-history-log",
            path: activeLog,
            provenance: "synthetic-adapter-matrix",
          },
        ],
        pendingOperations: [
          {
            id: "operation-history-1",
            kind: "fixture-operation",
            status: "running",
            generation: 1,
            expectedRevision: 1,
            prerequisites: [],
            intent: { offlineFixture: true },
          },
        ],
        queue: [],
        budgets: {},
        sessions: { primary: "opencode-history-session" },
        artifacts: [],
        expectedTrelloListId: null,
        terminalSync: "not-applicable",
        terminalEvidence: null,
        legacy: {},
        compatibility: {},
        updatedAt: new Date().toISOString(),
      };

      const storeSource = path.resolve("src/task-session/run-store.ts");
      const retentionSource = path.resolve("src/logging/log-retention.ts");
      const loggerSource = path.resolve("src/logging/logger.ts");
      const childScript = `
        import fs from "node:fs";
        import path from "node:path";
        import { RunStore } from ${JSON.stringify(storeSource)};
        import { cleanupLogRetention } from ${JSON.stringify(retentionSource)};
        import { configureLoggerRuntime, Logger } from ${JSON.stringify(loggerSource)};
        const mode = process.argv[1];
        const root = process.argv[2];
        const runtimeRoot = process.argv[3];
        const payload = JSON.parse(process.argv[4]);
        const lease = { integrationId: payload.record.pinned.integrationId, instanceId: "history-instance", token: "history-lease", assertHeld() {} };
        const store = new RunStore(runtimeRoot, "attempt-history-restart", payload.record.pinned, lease);
        if (mode === "write") {
          let current = store.create(payload.record);
          const advance = (event, from, to, update = value => value, final = false) => {
            const operation = current.operation;
            const nextId = "operation-history-" + (operation.generation + 1);
            const completion = "completion-" + operation.id;
            const transitionUpdate = value => {
              const completed = value.pendingOperations.map(item => item.id === operation.id
                ? { ...item, status: "completed", completionEvidence: completion }
                : item);
              return update({
                ...value,
                operation: final
                  ? { id: null, kind: null, generation: 0 }
                  : { id: nextId, kind: "fixture-operation", generation: operation.generation + 1 },
                pendingOperations: final ? completed : [...completed, {
                  id: nextId,
                  kind: "fixture-operation",
                  status: "running",
                  generation: operation.generation + 1,
                  expectedRevision: value.revision + 1,
                  prerequisites: [],
                  intent: { offlineFixture: true },
                }],
              });
            };
            current = store.transition(
              current.revision,
              1,
              { id: operation.id, generation: operation.generation },
              event,
              from,
              to,
              transitionUpdate,
              completion,
            );
          };
          advance("claim", "ready", "planning");
          advance("plan-approved", "planning", "implementation");
          advance("implementation-completed", "implementation", "validation");
          advance("validation-failed", "validation", "publication");
          advance("publication-completed", "publication", "ci", value => ({ ...value, publicationState: "open" }));
          advance("ci-observed", "ci", "human-review", value => value, true);
          process.stdout.write(JSON.stringify({ revision: current.revision, lifecycle: current.lifecycle }));
        } else {
          const current = store.read();
          if (!current) throw new Error("active record missing after restart");
          configureLoggerRuntime(runtimeRoot);
          cleanupLogRetention(30, new Date(Date.now() + 41 * ${millisecondsPerDay}), [runtimeRoot]);
          new Logger({ projectId: current.projectId, cardId: current.cardId }).error("restart recovery inspected active Human Review state; diagnostics retained");
          const loggerFilesBeforeRetention = fs.readdirSync(path.join(runtimeRoot, "orchestrator-logs"));
          const timelinePath = path.join(runtimeRoot, "history", encodeURIComponent(current.projectId), encodeURIComponent(current.cardId), encodeURIComponent(current.attemptId), "events.jsonl");
          const timeline = fs.readFileSync(timelinePath, "utf8").trim().split("\\n").map(line => JSON.parse(line));
          process.stdout.write(JSON.stringify({
            revision: current.revision,
            lifecycle: current.lifecycle,
            checkpoint: current.checkpoint,
            publicationState: current.publicationState,
        sessionReferences: current.sessions,
            resourceReferences: current.resources,
            timeline,
            activeLogExists: fs.existsSync(payload.activeLog),
            expiredLogExists: fs.existsSync(payload.expiredLog),
            loggerFilesBeforeRetention,
            loggerFileExistsAfterRetention: fs.existsSync(payload.loggerFile),
          }));
        }
      `;
      const launch = (mode: "write" | "restart") =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            childScript,
            mode,
            root,
            runtimeRoot,
            JSON.stringify({ record, activeLog, expiredLog, loggerFile }),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 15_000,
            env: { VITEST: "false" },
          },
        );

      const initialProcess = JSON.parse(launch("write")) as {
        revision: number;
        lifecycle: string;
      };
      expect(initialProcess.lifecycle).toBe("human-review");
      const afterRestart = JSON.parse(launch("restart")) as {
        revision: number;
        lifecycle: string;
        checkpoint: string;
        publicationState: string;
        sessionReferences: Record<string, string>;
        resourceReferences: Array<{ path: string }>;
        timeline: Array<{
          type: string;
          kind: string;
          summary?: { code?: string; artifactReferences?: string[] };
          transition?: string;
          attemptId: string;
          revision: number;
          timestamp: string;
          startedAt: string;
          elapsedMilliseconds: number;
        }>;
        activeLogExists: boolean;
        expiredLogExists: boolean;
        loggerFilesBeforeRetention: string[];
        loggerFileExistsAfterRetention: boolean;
      };

      expect(afterRestart).toMatchObject({
        revision: initialProcess.revision,
        lifecycle: "human-review",
        checkpoint: "human-review",
        publicationState: "open",
        sessionReferences: { primary: "opencode-history-session" },
        activeLogExists: true,
        expiredLogExists: false,
      });
      expect(afterRestart.loggerFilesBeforeRetention).toContain(
        path.basename(loggerFile),
      );
      expect(afterRestart.loggerFileExistsAfterRetention).toBe(true);
      expect(
        afterRestart.resourceReferences.map((reference) => reference.path),
      ).toContain(activeLog);
      expect(
        afterRestart.timeline
          .map((event) => event.transition ?? event.kind)
          .filter(Boolean),
      ).toEqual([
        "attempt-created",
        "claim",
        "plan-approved",
        "implementation-completed",
        "validation-failed",
        "publication-completed",
        "ci-observed",
      ]);
      expect(
        afterRestart.timeline
          .map((event) => event.revision)
          .filter((revision) => revision !== undefined),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      for (const event of afterRestart.timeline.filter(
        (entry) => entry.attemptId !== undefined,
      )) {
        expect(event.attemptId).toBe("attempt-history-restart");
        expect(Date.parse(event.timestamp)).not.toBeNaN();
        expect(Date.parse(event.startedAt)).not.toBeNaN();
        expect(event.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
      }
      const loggerFiles = fs.readdirSync(
        path.join(runtimeRoot, "orchestrator-logs"),
      );
      expect(loggerFiles).toContain(path.basename(loggerFile));
      expect(
        fs.readFileSync(
          path.join(runtimeRoot, "orchestrator-logs", loggerFiles[0]!),
          "utf8",
        ),
      ).toContain("restart recovery inspected active Human Review state");
      expect(
        afterRestart.timeline.filter(
          (event) => event.type === "workflow-diagnostic",
        ),
      ).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
