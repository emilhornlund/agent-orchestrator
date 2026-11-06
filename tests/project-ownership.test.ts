import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  ProjectOwnershipError,
} from "../src/coordination/project-ownership.js";
import { canonicalizeGitHubRepository } from "../src/config/config.js";

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
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
      reject(
        new Error(`Child exited ${String(code)} before ${text}: ${output}`),
      );
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
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical project ownership coordination", () => {
  it("canonicalizes equivalent GitHub transport spellings", () => {
    expect(canonicalizeGitHubRepository("Owner/Repo.git")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("Owner/Repo.GIT")).toBe("owner/repo");
    expect(canonicalizeGitHubRepository("Owner/Repo.Git.GIT/")).toBe(
      "owner/repo",
    );
    expect(canonicalizeGitHubRepository("https://github.com/OWNER/REPO/")).toBe(
      "owner/repo",
    );
    expect(canonicalizeGitHubRepository("git@github.com:Owner/Repo.git")).toBe(
      "owner/repo",
    );
    expect(
      canonicalizeGitHubRepository("ssh://git@github.com/Owner/Repo.git"),
    ).toBe("owner/repo");
    expect(() =>
      canonicalizeGitHubRepository("https://evil.example/owner/repo"),
    ).toThrow();
    expect(() => canonicalizeGitHubRepository(" owner/repo")).toThrow();
    expect(() => canonicalizeGitHubRepository("owner/repo#fragment")).toThrow();
    expect(() =>
      canonicalizeGitHubRepository("https://github.com/owner/repo.git/?q=1"),
    ).toThrow();
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
            timeout = setTimeout(
              () => reject(new Error("lock acquisition hung")),
              1_000,
            );
          }),
        ]),
      ).rejects.toThrow(/Could not start host kernel locking utility/);
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
      createHash("sha256")
        .update(`trello:${identity.trelloBoardId}`)
        .digest("hex"),
      createHash("sha256")
        .update(`github:${identity.githubRepository}`)
        .digest("hex"),
    ].sort();
    const malformed = path.join(root, `${keys[1]}.owner.json`);
    fs.writeFileSync(malformed, "broken metadata");
    await expect(
      acquireProjectOwnership(root, identity, "test-host-namespace"),
    ).rejects.toThrow(/Malformed ownership metadata/);
    expect(fs.readFileSync(malformed, "utf8")).toBe("broken metadata");
    fs.unlinkSync(malformed);
    const retry = await acquireProjectOwnership(
      root,
      identity,
      "test-host-namespace",
    );
    await retry.release();
  });

  it("requires explicit namespace provisioning and rejects namespace mismatches", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "unprovisioned-coordination-"),
    );
    temporaryRoots.push(root);
    const identity = {
      trelloBoardId: "board-1",
      githubRepository: "owner/repo",
    };
    await expect(
      acquireProjectOwnership(root, identity, "expected"),
    ).rejects.toThrow(/marker is missing/);
    const missingRoot = path.join(root, "not-created");
    await expect(
      acquireProjectOwnership(missingRoot, identity, "expected"),
    ).rejects.toThrow(/explicitly provisioned/);
    expect(fs.existsSync(missingRoot)).toBe(false);
    provisionCoordinationNamespace(root, "actual");
    await expect(
      acquireProjectOwnership(root, identity, "expected"),
    ).rejects.toThrow(/identity mismatch/);
    const lease = await acquireProjectOwnership(root, identity, "actual");
    await lease.release();
  });

  it("preserves and rejects a malformed namespace marker", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "bad-coordination-marker-"),
    );
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
    const githubKey = createHash("sha256")
      .update(`github:${repository}`)
      .digest("hex");
    let candidateBoard = "candidate-board-0";
    while (
      createHash("sha256").update(`trello:${candidateBoard}`).digest("hex") >
      githubKey
    ) {
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
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
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

  it("rejects FIFO marker and owner evidence without blocking", async () => {
    const markerRoot = temporaryRoot();
    const markerPath = path.join(
      markerRoot,
      ".agent-orchestrator-coordination.json",
    );
    fs.unlinkSync(markerPath);
    execFileSync("mkfifo", [markerPath]);
    const identity = JSON.stringify({
      trelloBoardId: "board-1",
      githubRepository: "owner/repo",
    });
    const markerReader = launchProcess(
      acquisitionOnlyScript(markerRoot, identity),
    );
    await waitForOutput(markerReader, "ERROR:", 2_000);
    await waitForExit(markerReader);

    const ownerRoot = temporaryRoot();
    const ownerKey = createHash("sha256")
      .update("github:owner/repo")
      .digest("hex");
    execFileSync("mkfifo", [path.join(ownerRoot, `${ownerKey}.owner.json`)]);
    const ownerReader = launchProcess(
      acquisitionOnlyScript(ownerRoot, identity),
    );
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
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
