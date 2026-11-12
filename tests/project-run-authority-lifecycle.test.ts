import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../src/coordination/project-registry.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { RunRegistry } from "../src/task-session/run-store.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { persistEssentialDependencyWait } from "../src/orchestrator/run-orchestrator.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(result);
  return result;
}

describe("ProjectRunAuthority preparing lifecycle", () => {
  it("publishes refinement before external work, blocks another claim, then releases on verified Backlog completion", async () => {
    const coordinationRoot = directory("project-authority-coordination-");
    const runtimeRoot = directory("project-authority-runtime-");
    const repositoryPath = directory("project-authority-repository-");
    const worktreeRoot = directory("project-authority-worktrees-");
    provisionCoordinationNamespace(coordinationRoot, "lifecycle-test");
    const project = {
      id: "project-one",
      trello: {
        boardId: "board-one",
        backlogListId: "backlog",
        readyListId: "ready",
        workingListId: "working",
        reviewListId: "review",
        failedListId: "failed",
        doneListId: "done",
        refinementLabelId: "refine",
        featureLabelId: "feature",
        improvementLabelId: "improve",
        bugLabelId: "bug",
      },
      repository: {
        github: "owner/repository",
        path: repositoryPath,
        defaultBranch: "main",
        worktreeRoot,
      },
    } as ProjectConfig;
    const config = {
      projects: [project],
      workflow: {
        pollIntervalSeconds: 1,
        logRetentionDays: 14,
        contextRetentionDays: 14,
        contextRoot: runtimeRoot,
        coordinationRoot,
        coordinationNamespaceId: "lifecycle-test",
      },
    } as Config;
    const pinned = {
      integrationId: JSON.stringify({
        trelloBoardId: "board-one",
        githubRepository: "owner/repository",
      }),
      projectId: project.id,
      boardId: "board-one",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        failed: "failed",
        done: "done",
        backlog: "backlog",
      },
      repository: "owner/repository",
      repositoryPath,
      worktreeRoot,
      storageRoot: runtimeRoot,
    };
    let lease = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board-one", githubRepository: "owner/repository" },
      "lifecycle-test",
    );
    try {
      await verifyAndPinProjects(config, [lease]);
      const refinement = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "card-refine",
        taskKind: "refinement",
        pinned,
        projectLease: lease,
        coordinationRoot,
      });
      const first = refinement.store.read();
      expect(first?.lifecycle).toBe("preparing");
      expect(first?.taskKind).toBe("refinement");
      expect(first?.resources[0]?.path).toBe(path.join(worktreeRoot, "card-refine"));
      expect(first?.resources[1]?.path).toBe("refs/heads/agent/card-refine");
      expect(fs.existsSync(first?.resources[0]?.path ?? "")).toBe(false);
      const pointer = new RunRegistry(runtimeRoot, pinned.integrationId, {
        integrationId: pinned.integrationId,
        instanceId: lease.instanceId,
        token: lease.token,
        assertHeld: () => lease.assertHeld(),
      }).reconcile();
      expect(pointer?.attemptId).toBe(first?.attemptId);

      refinement.claim();
      expect(refinement.store.read()?.lifecycle).toBe("refinement");
      await expect(
        ProjectRunAuthority.createPreparingAttempt({
          projectId: project.id,
          cardId: "card-implementation",
          taskKind: "implementation",
          pinned,
          projectLease: lease,
          coordinationRoot,
        }),
      ).rejects.toThrow("still occupying");

      await refinement.run(() =>
        refinement.completeRefinement({
          observationId: "refinement-complete-readback",
          observedAt: new Date().toISOString(),
          trelloObservationId: "backlog-readback",
          trelloVerifiedAt: new Date().toISOString(),
        }),
      );
      expect(refinement.store.read()?.lifecycle).toBe("refined");

      const implementation = await ProjectRunAuthority.createPreparingAttempt({
        projectId: project.id,
        cardId: "card-implementation",
        taskKind: "implementation",
        pinned,
        projectLease: lease,
        coordinationRoot,
      });
      expect(implementation.store.read()?.lifecycle).toBe("preparing");
      implementation.claim();
      expect(implementation.store.read()?.lifecycle).toBe("planning");
      const implementationAttemptId = implementation.store.read()!.attemptId;
      await lease.release();
      lease = await acquireProjectOwnership(
        coordinationRoot,
        { trelloBoardId: "board-one", githubRepository: "owner/repository" },
        "lifecycle-test",
      );
      const resumed = await ProjectRunAuthority.resumeAttempt({
        projectId: project.id,
        attemptId: implementationAttemptId,
        pinned,
        projectLease: lease,
        coordinationRoot,
      });
      expect(resumed.store.read()?.owner.generation).toBe(2);
      resumed.run(() =>
        resumed.mutate(
          "resume-projection",
          null,
          () => ({ value: { resumed: true }, result: undefined }),
          (value) => value,
        ),
      );
      expect(resumed.read("resume-projection", (value) => value)).toEqual({
        resumed: true,
      });
      const taskStore = new TaskExecutionStore(runtimeRoot, project, resumed);
      const now = new Date().toISOString();
      const task = taskStore.create({
        version: 1,
        projectId: project.id,
        cardId: "card-implementation",
        phase: "planning",
        operationKey: "operation-recovery",
        revision: 1,
        retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
        createdAt: now,
        updatedAt: now,
      });
      const notificationId = persistEssentialDependencyWait(
        resumed,
        task.cardId,
        1_000,
        "github:read",
      );
      expect(notificationId).toBe("project-one/card-implementation/operation-recovery/dependency");
      expect(resumed.store.read()).toMatchObject({
        lifecycle: "waiting",
        checkpoint: "planning",
        wait: {
          reason: "Essential dependency unavailable: github:read",
          dependency: "dependency",
        },
      });
      const secondId = persistEssentialDependencyWait(
        resumed,
        task.cardId,
        1_000,
        "github:another-read",
      );
      expect(secondId).toBe(notificationId);
      expect(taskStore.read(task.cardId)?.recoveryWait?.attempts).toBe(2);
      const latestWait = taskStore.read(task.cardId)!;
      taskStore.compareAndSwap(task.cardId, latestWait.revision, {
        ...latestWait,
        recoveryWait: undefined,
        revision: latestWait.revision + 1,
        updatedAt: new Date(Date.now() + 2).toISOString(),
      });
      expect(resumed.store.read()).toMatchObject({
        lifecycle: "planning",
        wait: { reason: null },
      });
    } finally {
      await lease.release();
    }
  });
});
