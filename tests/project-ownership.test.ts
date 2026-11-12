import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  ProjectOwnershipError,
  withProjectRegistryLock,
} from "../src/coordination/project-ownership.js";
import { canonicalizeGitHubRepository } from "../src/config/config.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { drainProcessGroup } from "../src/process/process-runtime.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoots: string[] = [];
const processes: ChildProcess[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-ownership-"));
  temporaryRoots.push(root);
  provisionCoordinationNamespace(root, "test-host-namespace");
  return root;
}

function childScript(root: string, identity: string): string {
  return `import { acquireProjectOwnership } from ${JSON.stringify(path.resolve(testDirectory, "../src/coordination/project-ownership.ts"))};
const lease = await acquireProjectOwnership(${JSON.stringify(root)}, JSON.parse(${JSON.stringify(identity)}), "test-host-namespace");
console.log("ACQUIRED");
process.stdin.resume();
process.stdin.on("end", async () => { await lease.release(); process.exit(0); });`;
}

function acquisitionOnlyScript(root: string, identity: string): string {
  return `import { acquireProjectOwnership } from ${JSON.stringify(path.resolve(testDirectory, "../src/coordination/project-ownership.ts"))};
try { await acquireProjectOwnership(${JSON.stringify(root)}, JSON.parse(${JSON.stringify(identity)}), "test-host-namespace"); console.log("ACQUIRED"); }
catch (error) { console.log("ERROR:" + (error instanceof Error ? error.message : String(error))); }`;
}

function launchHolder(root: string, identity: string): ChildProcess {
  return launchProcess(childScript(root, identity));
}

function launchProcess(script: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);
  return child;
}

async function waitForOutput(
  child: ChildProcess,
  text: string,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${text}: ${output}`)),
      timeoutMilliseconds,
    );
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Child exited ${String(code)} before ${text}: ${output}`));
    });
  });
}

async function expectCanAcquire(root: string): Promise<void> {
  const lease = await acquireProjectOwnership(
    root,
    {
      trelloBoardId: "board-1",
      githubRepository: "owner/repo",
    },
    "test-host-namespace",
  );
  await lease.release();
}

afterEach(() => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical project ownership coordination", () => {
  it("cancels a blocked registry flock without leaking its descriptor", async () => {
    const root = temporaryRoot();
    const controller = new AbortController();
    configureProcessRuntime({
      runtimeRoot: root,
      signal: controller.signal,
      operationTimeoutMilliseconds: 1_000,
    });
    let releaseRegistry!: () => void;
    let acquiredRegistry!: () => void;
    const registryAcquired = new Promise<void>((resolve) => {
      acquiredRegistry = resolve;
    });
    const held = withProjectRegistryLock(root, async () => {
      acquiredRegistry();
      await new Promise<void>((resolve) => {
        releaseRegistry = resolve;
      });
    });
    await registryAcquired;
    const waiting = withProjectRegistryLock(root, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({
      classification: "interrupted",
    });
    releaseRegistry();
    await held;

    const retryController = new AbortController();
    configureProcessRuntime({
      runtimeRoot: root,
      signal: retryController.signal,
      operationTimeoutMilliseconds: 1_000,
    });
    await expect(withProjectRegistryLock(root, () => "released")).resolves.toBe("released");
    configureProcessRuntime({
      runtimeRoot: os.tmpdir(),
      signal: new AbortController().signal,
    });
  });

  it("captures and redacts split flock stdout and stderr without leaking diagnostics", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flock-safe-error-"));
    temporaryRoots.push(runtimeRoot);
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const marker = "ACTUAL_FLOCK/secret marker_c392";
    const encoded = Buffer.from(marker).toString("base64url");
    const percent = encodeURIComponent(marker);
    const flock = path.join(binaries, "flock");
    fs.writeFileSync(
      flock,
      `#!/usr/bin/env node\nconst out=${JSON.stringify(encoded)}; const err=${JSON.stringify(percent)}; process.stdout.write(out.slice(0,7)); setTimeout(()=>process.stdout.write(out.slice(7)),5); process.stderr.write(err.slice(0,9)); setTimeout(()=>{process.stderr.write(err.slice(9)); process.exit(2)},10);\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    configureProcessRuntime({
      runtimeRoot,
      signal: new AbortController().signal,
      secretValues: [marker],
    });
    const coordinationRoot = path.join(runtimeRoot, "coordination");
    fs.mkdirSync(coordinationRoot);
    provisionCoordinationNamespace(coordinationRoot, "test-host-namespace");
    try {
      let failure: unknown;
      try {
        await acquireProjectOwnership(
          coordinationRoot,
          { trelloBoardId: "board-safe", githubRepository: "owner/repo" },
          "test-host-namespace",
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error;
      expect(error.message).toContain("process-executions/");
      expect(error.message).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      const executions = path.join(runtimeRoot, "process-executions");
      const [executionId] = fs.readdirSync(executions);
      expect(executionId).toBeDefined();
      const stdout = fs.readFileSync(path.join(executions, executionId!, "stdout.txt"), "utf8");
      const stderr = fs.readFileSync(path.join(executions, executionId!, "stderr.txt"), "utf8");
      expect(stdout).toContain("[REDACTED]");
      expect(stderr).toContain("[REDACTED]");
      for (const artifact of [stdout, stderr]) {
        expect(artifact).not.toContain(marker);
        expect(artifact).not.toContain(encoded);
        expect(artifact).not.toContain(percent);
      }
      const metadata = JSON.parse(
        fs.readFileSync(path.join(executions, executionId!, "execution.json"), "utf8"),
      ) as { status: string };
      expect(metadata.status).toBe("nonzero");
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  });

  it("terminates flock on output overflow and records finalized evidence failure", async () => {
    const runtimeRoot = temporaryRoot();
    const binaries = path.join(runtimeRoot, "bin");
    fs.mkdirSync(binaries);
    const canary = "FLOCK_OUTPUT_LIMIT_CANARY";
    fs.writeFileSync(
      path.join(binaries, "flock"),
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(canary)}); process.stdout.write("x".repeat(16 * 1024 * 1024 + 1)); setInterval(()=>{},30000);\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaries}${path.delimiter}${originalPath ?? ""}`;
    configureProcessRuntime({
      runtimeRoot,
      signal: new AbortController().signal,
      operationTimeoutMilliseconds: 5_000,
      secretValues: [canary],
    });
    const coordinationRoot = path.join(runtimeRoot, "coordination");
    fs.mkdirSync(coordinationRoot);
    provisionCoordinationNamespace(coordinationRoot, "flock-output-limit");
    try {
      await expect(
        acquireProjectOwnership(
          coordinationRoot,
          { trelloBoardId: "limit-board", githubRepository: "owner/limit" },
          "flock-output-limit",
        ),
      ).rejects.toThrow(/output limit/u);
      const executions = path.join(runtimeRoot, "process-executions");
      const [executionId] = fs.readdirSync(executions);
      const base = path.join(executions, executionId!);
      expect(fs.readFileSync(path.join(base, "stderr.txt"), "utf8")).toContain("[REDACTED]");
      expect(fs.readFileSync(path.join(base, "stderr.txt"), "utf8")).not.toContain(canary);
      const evidence = JSON.parse(fs.readFileSync(path.join(base, "execution.json"), "utf8")) as {
        status: string;
        evidenceFailure?: string;
      };
      expect(evidence.status).toBe("evidence-failure");
      expect(evidence.evidenceFailure).toContain("output limit");
    } finally {
      process.env.PATH = originalPath;
      configureProcessRuntime({
        runtimeRoot: os.tmpdir(),
        signal: new AbortController().signal,
      });
    }
  });

  it("canonicalizes equivalent GitHub transport spellings", () => {
    expect(canonicalizeGitHubRepository("Owner/Repo.git")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("Owner/Repo.GIT")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("Owner/Repo.Git.GIT/")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("https://github.com/OWNER/REPO/")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("git@github.com:Owner/Repo.git")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("ssh://git@github.com/Owner/Repo.git")).toBe("owner/repo");
    expect(() => canonicalizeGitHubRepository("https://evil.example/owner/repo")).toThrow();
    expect(() => canonicalizeGitHubRepository(" owner/repo")).toThrow();
    expect(() => canonicalizeGitHubRepository("owner/repo#fragment")).toThrow();
    expect(() => canonicalizeGitHubRepository("https://github.com/owner/repo.git/?q=1")).toThrow();
    for (const spelling of [
      "Owner/Repo.GIT",
      "Owner/Repo.git.git/",
      "https://github.com/OWNER/REPO.Git.GIT/",
      "git@github.com:owner/repo.GIT",
    ]) {
      const canonical = canonicalizeGitHubRepository(spelling);
      expect(canonicalizeGitHubRepository(canonical)).toBe(canonical);
    }
  });

  it("serializes same integration from a distinct process despite different aliases", async () => {
    const root = temporaryRoot();
    const holder = launchHolder(
      root,
      JSON.stringify({
        trelloBoardId: "board-1",
        githubRepository: "owner/repo",
      }),
    );
    await waitForOutput(holder, "ACQUIRED");
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "board-1",
          githubRepository: "https://github.com/OWNER/REPO.git",
        },
        "test-host-namespace",
      ),
    ).rejects.toBeInstanceOf(ProjectOwnershipError);
    holder.stdin?.end();
    await waitForExit(holder);
    await expectCanAcquire(root);
  });

  it("blocks GitHub-only overlap across equivalent spellings", async () => {
    const root = temporaryRoot();
    const holder = launchHolder(
      root,
      JSON.stringify({
        trelloBoardId: "board-one",
        githubRepository: "Owner/Repo.git/",
      }),
    );
    await waitForOutput(holder, "ACQUIRED");
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "board-two",
          githubRepository: "https://github.com/OWNER/REPO.git/",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/already held/);
    holder.stdin?.end();
    await waitForExit(holder);
  });

  it("coordinates on either overlapping integration, even when the other differs", async () => {
    const root = temporaryRoot();
    const trelloHolder = launchHolder(
      root,
      JSON.stringify({
        trelloBoardId: "shared-board",
        githubRepository: "one/repo",
      }),
    );
    await waitForOutput(trelloHolder, "ACQUIRED");
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "shared-board",
          githubRepository: "two/repo",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/already held/);
    trelloHolder.stdin?.end();
    await waitForExit(trelloHolder);
    const githubHolder = launchHolder(
      root,
      JSON.stringify({
        trelloBoardId: "other-board",
        githubRepository: "one/repo",
      }),
    );
    await waitForOutput(githubHolder, "ACQUIRED");
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "another-board",
          githubRepository: "ONE/REPO",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/already held/);
    githubHolder.stdin?.end();
    await waitForExit(githubHolder);
  });

  it("recovers kernel ownership after the owning process is killed without PID/age inference", async () => {
    const root = temporaryRoot();
    const holder = launchHolder(
      root,
      JSON.stringify({
        trelloBoardId: "board-1",
        githubRepository: "owner/repo",
      }),
    );
    await waitForOutput(holder, "ACQUIRED");
    holder.kill("SIGKILL");
    await waitForExit(holder);
    await expectCanAcquire(root);
  });

  it("fails closed and preserves malformed metadata", async () => {
    const root = temporaryRoot();
    const key = createHash("sha256").update("github:owner/repo").digest("hex");
    const metadata = path.join(root, `${key}.owner.json`);
    fs.writeFileSync(metadata, "{not-json", { mode: 0o600 });
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "board-1",
          githubRepository: "owner/repo",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/Malformed ownership metadata/);
    expect(fs.readFileSync(metadata, "utf8")).toBe("{not-json");
    fs.unlinkSync(metadata);
    await expectCanAcquire(root);
  });

  it("waits for cleanup after lock-helper failure before ownership acquisition", async () => {
    const root = temporaryRoot();
    const fakeBin = path.join(root, "fake-bin");
    fs.mkdirSync(fakeBin, { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = fakeBin;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await expect(
        Promise.race([
          acquireProjectOwnership(
            root,
            { trelloBoardId: "board-1", githubRepository: "owner/repo" },
            "test-host-namespace",
          ),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("lock acquisition hung")), 1_000);
          }),
        ]),
      ).rejects.toThrow(/flock spawn failure; diagnostics: process-executions\//);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
    await expectCanAcquire(root);
  });

  it("rolls back all locks when metadata validation fails on the second resource", async () => {
    const root = temporaryRoot();
    const identity = {
      trelloBoardId: "second-metadata-board",
      githubRepository: "second/meta",
    };
    const keys = [
      createHash("sha256").update(`trello:${identity.trelloBoardId}`).digest("hex"),
      createHash("sha256").update(`github:${identity.githubRepository}`).digest("hex"),
    ].sort();
    const malformed = path.join(root, `${keys[1]}.owner.json`);
    fs.writeFileSync(malformed, "broken metadata");
    await expect(acquireProjectOwnership(root, identity, "test-host-namespace")).rejects.toThrow(
      /Malformed ownership metadata/,
    );
    expect(fs.readFileSync(malformed, "utf8")).toBe("broken metadata");
    fs.unlinkSync(malformed);
    const retry = await acquireProjectOwnership(root, identity, "test-host-namespace");
    await retry.release();
  });

  it("requires explicit namespace provisioning and rejects namespace mismatches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unprovisioned-coordination-"));
    temporaryRoots.push(root);
    const identity = {
      trelloBoardId: "board-1",
      githubRepository: "owner/repo",
    };
    await expect(acquireProjectOwnership(root, identity, "expected")).rejects.toThrow(
      /marker is missing/,
    );
    const missingRoot = path.join(root, "not-created");
    await expect(acquireProjectOwnership(missingRoot, identity, "expected")).rejects.toThrow(
      /explicitly provisioned/,
    );
    expect(fs.existsSync(missingRoot)).toBe(false);
    provisionCoordinationNamespace(root, "actual");
    await expect(acquireProjectOwnership(root, identity, "expected")).rejects.toThrow(
      /identity mismatch/,
    );
    const lease = await acquireProjectOwnership(root, identity, "actual");
    await lease.release();
  });

  it("preserves and rejects a malformed namespace marker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bad-coordination-marker-"));
    temporaryRoots.push(root);
    const marker = path.join(root, ".agent-orchestrator-coordination.json");
    fs.writeFileSync(marker, "{broken", { mode: 0o600 });
    await expect(
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-1", githubRepository: "owner/repo" },
        "expected",
      ),
    ).rejects.toThrow(/Malformed coordination namespace marker/);
    expect(fs.readFileSync(marker, "utf8")).toBe("{broken");
  });

  it("keeps locks on the opened inode and rejects replacement/symlink races", async () => {
    const root = temporaryRoot();
    const outside = path.join(root, "outside-target");
    fs.writeFileSync(outside, "untouched");
    const lease = await acquireProjectOwnership(
      root,
      { trelloBoardId: "board-1", githubRepository: "owner/repo" },
      "test-host-namespace",
    );
    const key = createHash("sha256").update("github:owner/repo").digest("hex");
    const lockPath = path.join(root, `${key}.lock`);
    const movedPath = `${lockPath}.saved`;
    fs.renameSync(lockPath, movedPath);
    fs.symlinkSync(outside, lockPath);
    expect(() => lease.assertHeld()).toThrow(/no longer held/);
    await expect(
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-2", githubRepository: "owner/repo" },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/safely open ownership lock path/);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, "replacement lock inode", { mode: 0o600 });
    await expect(
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-3", githubRepository: "owner/repo" },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/does not match the current lock inode/);
    fs.unlinkSync(lockPath);
    fs.renameSync(movedPath, lockPath);
    await lease.release();
    await expectCanAcquire(root);
  });

  it("rolls back a partially acquired resource set before rejecting", async () => {
    const root = temporaryRoot();
    const repository = "held/repo";
    const githubKey = createHash("sha256").update(`github:${repository}`).digest("hex");
    let candidateBoard = "candidate-board-0";
    while (createHash("sha256").update(`trello:${candidateBoard}`).digest("hex") > githubKey) {
      candidateBoard = `candidate-board-${Number(candidateBoard.slice("candidate-board-".length)) + 1}`;
    }
    const shared = await acquireProjectOwnership(
      root,
      { trelloBoardId: "held-board", githubRepository: repository },
      "test-host-namespace",
    );
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: candidateBoard,
          githubRepository: repository,
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/already held/);
    await shared.release();
    const retry = await acquireProjectOwnership(
      root,
      { trelloBoardId: candidateBoard, githubRepository: repository },
      "test-host-namespace",
    );
    await retry.release();
  });

  it("permits exactly one simultaneous startup claimant", async () => {
    const root = temporaryRoot();
    const results = await Promise.allSettled([
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-1", githubRepository: "owner/repo" },
        "test-host-namespace",
      ),
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-1", githubRepository: "owner/repo" },
        "test-host-namespace",
      ),
    ]);
    const acquired = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await acquired[0]?.release();
  });

  it("makes release idempotent and immediately marks its lease inactive", async () => {
    const lease = await acquireProjectOwnership(
      temporaryRoot(),
      { trelloBoardId: "board-1", githubRepository: "owner/repo" },
      "test-host-namespace",
    );
    const releaseA = lease.release();
    const releaseB = lease.release();
    expect(releaseB).toBe(releaseA);
    expect(() => lease.assertHeld()).toThrow(/no longer held/);
    await Promise.all([releaseA, releaseB]);
  });

  it("persists termination ambiguity across release and restart without blocking another project", async () => {
    const root = temporaryRoot();
    const identity = {
      trelloBoardId: "ambiguous-board",
      githubRepository: "Owner/Repo.git",
    };
    const lease = await acquireProjectOwnership(root, identity, "test-host-namespace");
    lease.markProcessGroupAmbiguous(48123, ["process-executions/example"]);
    await lease.release();

    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "ambiguous-board",
          githubRepository: "https://github.com/owner/repo",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/unresolved process-group termination ambiguity/);
    const independent = await acquireProjectOwnership(
      root,
      {
        trelloBoardId: "unaffected-board",
        githubRepository: "other/repo",
      },
      "test-host-namespace",
    );
    independent.assertHeld();
    await independent.release();
  });

  it.each([0, 1])(
    "retains all integration locks when ambiguity marker %i cannot be published",
    async (failedMarkerIndex) => {
      const root = temporaryRoot();
      const identity = {
        trelloBoardId: `marker-failure-${failedMarkerIndex}`,
        githubRepository: `marker/repo-${failedMarkerIndex}`,
      };
      const lease = await acquireProjectOwnership(root, identity, "test-host-namespace");
      const keys = [
        createHash("sha256").update(`trello:${identity.trelloBoardId}`).digest("hex"),
        createHash("sha256").update(`github:${identity.githubRepository}`).digest("hex"),
      ].sort();
      const markerToFail = path.join(root, `${keys[failedMarkerIndex]}.ambiguity.json`);
      const originalOpenSync = fs.openSync;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        if (file === markerToFail) {
          const error = new Error("injected marker persistence failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalOpenSync(file, flags, mode);
      });
      try {
        expect(() => lease.markProcessGroupAmbiguous(48123)).toThrow(/injected/);
        await expect(lease.release()).rejects.toThrow(/locks are retained/);
      } finally {
        openSpy.mockRestore();
      }
      await expect(acquireProjectOwnership(root, identity, "test-host-namespace")).rejects.toThrow(
        /already held|unresolved process-group termination ambiguity/,
      );
      const independent = await acquireProjectOwnership(
        root,
        {
          trelloBoardId: `unaffected-${failedMarkerIndex}`,
          githubRepository: `other/repo-${failedMarkerIndex}`,
        },
        "test-host-namespace",
      );
      await independent.release();
      lease.markProcessGroupAmbiguous(48123);
      await lease.release();
    },
  );

  it.each(["file", "directory"] as const)(
    "does not accept an existing ambiguity marker until %s fsync succeeds",
    async (syncTarget) => {
      const root = temporaryRoot();
      const identity = {
        trelloBoardId: `sync-${syncTarget}`,
        githubRepository: "sync/repo",
      };
      const lease = await acquireProjectOwnership(root, identity, "test-host-namespace");
      const key = createHash("sha256").update(`github:${identity.githubRepository}`).digest("hex");
      const marker = path.join(root, `${key}.ambiguity.json`);
      fs.writeFileSync(
        marker,
        `${JSON.stringify({
          version: 1,
          identity: JSON.stringify({
            trelloBoardId: identity.trelloBoardId,
            githubRepository: identity.githubRepository,
          }),
          processGroup: 48123,
          hostname: os.hostname(),
          bootId: null,
          pidNamespace: null,
          artifacts: [],
          recordedAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      const originalFsync = fs.fsyncSync;
      let fail = true;
      const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        const stat = fs.fstatSync(fd);
        const isTarget =
          syncTarget === "file"
            ? stat.ino === fs.statSync(marker).ino && stat.dev === fs.statSync(marker).dev
            : stat.isDirectory() && stat.ino === fs.statSync(root).ino;
        if (fail && isTarget) {
          fail = false;
          const error = new Error(`injected ${syncTarget} fsync failure`);
          (error as NodeJS.ErrnoException).code = "EIO";
          throw error;
        }
        return originalFsync(fd);
      });
      try {
        expect(() => lease.markProcessGroupAmbiguous(48123)).toThrow(/fsync failure/);
        await expect(lease.release()).rejects.toThrow(/locks are retained/);
        await expect(
          acquireProjectOwnership(root, identity, "test-host-namespace"),
        ).rejects.toThrow(/already held|unresolved process-group termination ambiguity/);
        lease.markProcessGroupAmbiguous(48123);
        await lease.release();
      } finally {
        fsyncSpy.mockRestore();
      }
      await expectCanAcquire(root);
    },
  );

  it("keeps a child alive and ownership contended after fence persistence failure until retry succeeds", async () => {
    const root = temporaryRoot();
    const identity = {
      trelloBoardId: "child-fence",
      githubRepository: "child/fence",
    };
    const marker = path.join(
      root,
      `${createHash("sha256").update(`github:${identity.githubRepository}`).digest("hex")}.ambiguity.json`,
    );
    const retrySignal = path.join(root, "allow-fence-retry");
    const script = `import fs from "node:fs";
import { acquireProjectOwnership } from ${JSON.stringify(path.resolve(testDirectory, "../src/coordination/project-ownership.ts"))};
const lease = await acquireProjectOwnership(${JSON.stringify(root)}, ${JSON.stringify(identity)}, "test-host-namespace");
const open = fs.openSync; let blocked = true;
fs.openSync = function(file, flags, mode) { if (blocked && file === ${JSON.stringify(marker)}) { const e = new Error("injected"); e.code = "EACCES"; throw e; } return open.call(this, file, flags, mode); };
try { lease.markProcessGroupAmbiguous(48123); } catch {}
console.log("WAITING");
const control = setInterval(async () => { if (!fs.existsSync(${JSON.stringify(retrySignal)})) return; clearInterval(control); blocked = false; await new Promise(r => setTimeout(r, 1200)); console.log("FENCED"); await lease.release(); }, 25);
control.unref();`;
    const child = launchProcess(script);
    await waitForOutput(child, "WAITING");
    expect(child.exitCode).toBeNull();
    await expect(acquireProjectOwnership(root, identity, "test-host-namespace")).rejects.toThrow(
      /already held|unresolved process-group termination ambiguity/,
    );
    expect(child.exitCode).toBeNull();
    fs.writeFileSync(retrySignal, "retry");
    await waitForOutput(child, "FENCED");
    await waitForExit(child);
    await expect(acquireProjectOwnership(root, identity, "test-host-namespace")).rejects.toThrow(
      /unresolved process-group termination ambiguity/,
    );
  });

  it("retains ownership in the parent descriptor after the one-shot lock utility exits", async () => {
    const root = temporaryRoot();
    const lease = await acquireProjectOwnership(
      root,
      { trelloBoardId: "board-1", githubRepository: "owner/repo" },
      "test-host-namespace",
    );
    lease.assertHeld();
    await expect(
      acquireProjectOwnership(
        root,
        { trelloBoardId: "board-1", githubRepository: "owner/repo" },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/already held/);
    await lease.release();
    await expectCanAcquire(root);
  });

  it("routes startup-scoped static dispatch process ambiguity into the active lease", async () => {
    const root = temporaryRoot();
    const identity = {
      trelloBoardId: "static-dispatch-fence",
      githubRepository: "dispatch/fence",
    };
    const lease = await acquireProjectOwnership(root, identity, "test-host-namespace");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("child has no pid");
    const childPid = child.pid;
    const originalKill = process.kill;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid === -childPid) {
        if (signal === 0) return true;
        return true;
      }
      return originalKill(pid, signal);
    });
    const originalReaddir = fs.readdirSync;
    const procSpy = vi.spyOn(fs, "readdirSync").mockImplementation((directory, options) => {
      if (directory === "/proc") {
        const error = new Error("injected procfs visibility failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalReaddir(directory, options as never) as never;
    });
    try {
      await expect(
        ProjectRunAuthority.withProjectLease(
          "dispatch-project",
          () => lease.assertHeld(),
          (pid) => lease.markProcessGroupAmbiguous(pid),
          () =>
            ProjectRunAuthority.dispatch("dispatch-project", async () =>
              drainProcessGroup(childPid, () => true, 0),
            ),
        ),
      ).rejects.toThrow(/Unable to verify termination/);
      const key = createHash("sha256").update(`github:${identity.githubRepository}`).digest("hex");
      const marker = JSON.parse(
        fs.readFileSync(path.join(root, `${key}.ambiguity.json`), "utf8"),
      ) as { processGroup: number; identity: string };
      expect(marker.processGroup).toBe(childPid);
      expect(marker.identity).toContain(identity.githubRepository);
    } finally {
      procSpy.mockRestore();
      killSpy.mockRestore();
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", () => resolve());
      });
      await lease.release();
    }
    await expect(acquireProjectOwnership(root, identity, "test-host-namespace")).rejects.toThrow(
      /unresolved process-group termination ambiguity/,
    );
  });

  it("stops claims on bootstrap SIGTERM and reacquires preserved attempt references", async () => {
    const root = temporaryRoot();
    const identity = {
      trelloBoardId: "shutdown-board",
      githubRepository: "shutdown/repo",
    };
    const worktree = path.join(root, "task-worktree");
    fs.mkdirSync(worktree);
    const dirtyEdit = path.join(worktree, "uncommitted-change.txt");
    const references = path.join(root, "attempt-references.json");
    const claimLedger = path.join(root, "claim-ledger.jsonl");
    fs.writeFileSync(dirtyEdit, "preserve me\n");
    fs.writeFileSync(
      references,
      `${JSON.stringify({ attemptId: "attempt-shutdown-1", worktree, branch: "agent/shutdown-1", openCodeSessionId: "session-1" })}\n`,
    );
    const script = `import fs from "node:fs";
import { acquireProjectOwnership } from ${JSON.stringify(path.resolve(testDirectory, "../src/coordination/project-ownership.ts"))};
const root = ${JSON.stringify(root)};
const lease = await acquireProjectOwnership(root, ${JSON.stringify(identity)}, "test-host-namespace");
const ledger = ${JSON.stringify(claimLedger)};
let stopping = false;
fs.appendFileSync(ledger, "claim\\n");
console.log("CLAIMED");
const polling = setInterval(() => { if (!stopping) fs.appendFileSync(ledger, "claim\\n"); }, 100);
process.once("SIGTERM", async () => { stopping = true; clearInterval(polling); fs.appendFileSync(ledger, "shutdown\\n"); await lease.release(); console.log("RELEASED"); process.exit(0); });`;
    const bootstrap = launchProcess(script);
    await waitForOutput(bootstrap, "CLAIMED");
    await new Promise((resolve) => setTimeout(resolve, 150));
    bootstrap.kill("SIGTERM");
    await waitForOutput(bootstrap, "RELEASED");
    await waitForExit(bootstrap);

    const events = fs.readFileSync(claimLedger, "utf8").trim().split("\n");
    expect(events.at(-1)).toBe("shutdown");
    const claimsBeforeShutdown = events.filter((event) => event === "claim");
    expect(claimsBeforeShutdown.length).toBeGreaterThan(0);
    const retainedEdit = fs.readFileSync(dirtyEdit, "utf8");
    const retainedReferences = JSON.parse(fs.readFileSync(references, "utf8")) as {
      attemptId: string;
      worktree: string;
      branch: string;
      openCodeSessionId: string;
    };
    expect(retainedEdit).toBe("preserve me\n");
    expect(retainedReferences).toEqual({
      attemptId: "attempt-shutdown-1",
      worktree,
      branch: "agent/shutdown-1",
      openCodeSessionId: "session-1",
    });

    const restartedLease = await acquireProjectOwnership(root, identity, "test-host-namespace");
    restartedLease.assertHeld();
    expect(fs.readFileSync(dirtyEdit, "utf8")).toBe(retainedEdit);
    expect(JSON.parse(fs.readFileSync(references, "utf8"))).toEqual(retainedReferences);
    await restartedLease.release();
    expect(fs.readFileSync(claimLedger, "utf8").trim().split("\n")).toEqual(events);
  }, 10_000);

  it("rejects FIFO marker and owner evidence without blocking", async () => {
    const markerRoot = temporaryRoot();
    const markerPath = path.join(markerRoot, ".agent-orchestrator-coordination.json");
    fs.unlinkSync(markerPath);
    execFileSync("mkfifo", [markerPath]);
    const identity = JSON.stringify({
      trelloBoardId: "board-1",
      githubRepository: "owner/repo",
    });
    const markerReader = launchProcess(acquisitionOnlyScript(markerRoot, identity));
    await waitForOutput(markerReader, "ERROR:", 2_000);
    await waitForExit(markerReader);

    const ownerRoot = temporaryRoot();
    const ownerKey = createHash("sha256").update("github:owner/repo").digest("hex");
    execFileSync("mkfifo", [path.join(ownerRoot, `${ownerKey}.owner.json`)]);
    const ownerReader = launchProcess(acquisitionOnlyScript(ownerRoot, identity));
    await waitForOutput(ownerReader, "ERROR:", 2_000);
    await waitForExit(ownerReader);
  });

  it("rejects symlinked coordination roots and metadata", async () => {
    const parent = temporaryRoot();
    const target = path.join(parent, "target");
    fs.mkdirSync(target);
    const linkedRoot = path.join(parent, "linked");
    fs.symlinkSync(target, linkedRoot);
    await expect(
      acquireProjectOwnership(
        linkedRoot,
        {
          trelloBoardId: "board-1",
          githubRepository: "owner/repo",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/symbolic link/);

    const root = path.join(parent, "locks");
    fs.mkdirSync(root);
    provisionCoordinationNamespace(root, "test-host-namespace");
    const key = createHash("sha256").update("github:owner/repo").digest("hex");
    const metadata = path.join(root, `${key}.owner.json`);
    fs.symlinkSync(path.join(parent, "missing"), metadata);
    await expect(
      acquireProjectOwnership(
        root,
        {
          trelloBoardId: "board-1",
          githubRepository: "owner/repo",
        },
        "test-host-namespace",
      ),
    ).rejects.toThrow(/symbolic link/);
  });
});

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
