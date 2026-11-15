import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import {
  refinementRecoveryKey,
  refinementRecoverySchema,
  withRefinementRecovery,
} from "../src/refinement/refinement-recovery.js";
import { runTaskResources } from "../src/task-session/task-resources.js";

it("retains recovery budget and deadline when refinement returns after shutdown cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-shutdown-"));
  const f = await notificationAuthorityFixture(root, "shutdown");
  try {
    const checkpoint = {
      internalFailures: 2,
      rechecks: 2,
      reason: "Prior internal failure",
      kind: "internal" as const,
      nextCheckAt: new Date(Date.now() - 1).toISOString(),
    };
    f.authority.mutate(
      refinementRecoveryKey,
      checkpoint,
      () => ({ value: checkpoint, result: undefined }),
      refinementRecoverySchema.parse,
    );
    const controller = new AbortController();
    await f.authority.run(() =>
      withRefinementRecovery({
        project: f.project,
        card: f.card,
        worktreePath: runTaskResources(f.authority.store.read()!).path,
        signal: controller.signal,
        execute: async () => {
          controller.abort();
          // The workflow acknowledges orchestrator cancellation by returning,
          // which is not evidence of successful refinement.
        },
      }),
    );
    expect(f.authority.read(refinementRecoveryKey, refinementRecoverySchema.parse)).toEqual(
      checkpoint,
    );
    expect(f.authority.store.read()?.lifecycle).toBe("refinement");
  } finally {
    await f.lease.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
