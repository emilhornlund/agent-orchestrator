import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnOwnedProcess } from "../scripts/bounded-process.js";
import {
  disposeP2Participants,
  removeP2EvidenceIfClean,
} from "../scripts/p2-participant-cleanup.js";

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const temp of temporaryPaths.splice(0))
    rmSync(temp, { recursive: true, force: true });
});

describe("P2 participant cleanup", () => {
  it("fails cleanup and retains evidence when an exited wrapper's group is unconfirmed", async () => {
    const owned = spawnOwnedProcess(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        stdio: "ignore",
      },
    );
    await owned.closed;
    expect(owned.child.exitCode).toBe(0);

    const participants = new Set([owned.child]);
    const ownedProcesses = new Map([[owned.child, owned]]);
    const temp = mkdtempSync(path.join(os.tmpdir(), "p2-cleanup-evidence-"));
    temporaryPaths.push(temp);
    const evidence = path.join(temp, "failure-evidence.json");
    writeFileSync(evidence, "preserve this evidence");

    await expect(
      disposeP2Participants(participants, ownedProcesses, {
        timeoutMs: 100,
        confirmStopped: async () => {
          throw new Error("simulated owned-group confirmation failure");
        },
      }),
    ).rejects.toThrow(/cleanup was not confirmed/);

    expect(participants.has(owned.child)).toBe(true);
    expect(ownedProcesses.has(owned.child)).toBe(true);
    const removed = removeP2EvidenceIfClean(participants, true, () =>
      rmSync(temp, { recursive: true, force: true }),
    );
    expect(removed).toBe(false);
    expect(existsSync(evidence)).toBe(true);
  });
});
