import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import { createIsolatedGitFixture } from "./support/isolated-git-fixture.js";
import { runTaskResources } from "../src/task-session/task-resources.js";
import {
  recordTerminalPrFence,
  markTerminalWritersStopped,
} from "../src/task-session/terminal-pr-fence.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import {
  readTerminalCleanup,
  writeTerminalCleanup,
} from "../src/task-session/terminal-cleanup-state.js";
import { completeMergedTaskSessionPullRequest } from "../src/orchestrator/reconcile-terminal-task-session-pr.js";
import { cleanupTerminalResources } from "../src/orchestrator/cleanup-terminal-resources.js";
import { reconcileTerminalCleanup } from "../src/orchestrator/reconcile-terminal-cleanup.js";
import { preserveIgnoredOutput } from "../src/git/preserve-ignored-output.js";
import { runRepositorySetup } from "../src/process/run-setup.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { acquireProjectOwnership } from "../src/coordination/project-ownership.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

let root: string;
const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) await release();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-cleanup-"));
  const f = await notificationAuthorityFixture(root, "cleanup", undefined, true, "implementation");
  releases.push(() => f.lease.release());
  const isolated = path.join(root, "operator");
  fs.mkdirSync(isolated);
  const local = createIsolatedGitFixture(isolated);
  const resource = runTaskResources(f.authority.store.read()!);
  fs.mkdirSync(path.join(f.project.repository.path, ".git/info"), { recursive: true });
  fs.appendFileSync(
    path.join(f.project.repository.path, ".git/info/exclude"),
    "\nnode_modules/\ndist/\nvaluable/\n",
  );
  await f.authority.run(() =>
    f.git.addWorktreeWithNewBranch(
      f.project.repository.path,
      resource.path,
      resource.branch,
      "HEAD",
    ),
  );
  // Execute setup and build processes, rather than merely mocking Git status.
  for (const [stage, outputs] of [
    ["setup", ["node_modules/dependency", "valuable/private.txt"]],
    ["build", ["dist/app.js"]],
  ] as const) {
    const script = `const fs=require('node:fs'); for(const p of ${JSON.stringify(outputs)}) { fs.mkdirSync(require('node:path').dirname(p),{recursive:true}); fs.writeFileSync(p,p); }`;
    await f.authority.run(() =>
      runRepositorySetup(new CommandRunner(), {
        cwd: resource.path,
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        timeoutMilliseconds: 10_000,
        sessionLogPath: path.join(root, `${stage}.log`),
        sessionLabel: stage,
      }),
    );
  }
  fs.writeFileSync(path.join(resource.path, "feature.txt"), "implemented\n");
  local.git(resource.path, "add", "feature.txt");
  local.git(resource.path, "commit", "-m", "implementation");
  const head = local.git(resource.path, "rev-parse", "HEAD");
  local.git(f.project.repository.path, "merge", "--no-ff", resource.branch, "-m", "human merge");
  const pr = {
    state: "MERGED" as const,
    mergedAt: "2026-11-14T00:00:00Z",
    url: "https://github.com/owner/cleanup/pull/1",
    headRefOid: head,
    headRefName: resource.branch,
    baseRefName: "main",
    headRepositoryOwner: { login: "owner" },
    headRepository: { name: "cleanup" },
  };
  f.authority.run(() => {
    recordTerminalPrFence(
      f.authority,
      {
        cardId: f.card.id,
        expectedBranch: resource.branch,
        pullRequest: { url: pr.url, headSha: head },
      } as TaskExecutionRecord,
      pr,
      false,
      "main",
    );
    const proof = f.authority.store.writeArtifact(
      Buffer.from(JSON.stringify({ kind: "task-processes-stopped", cardId: f.card.id })),
    );
    f.authority.store.referenceMutationArtifact(
      f.authority.store.read()!.revision,
      f.authority.ownerGeneration,
      proof,
    );
    const run = f.authority.store.read()!;
    f.authority.store.transition(
      run.revision,
      f.authority.ownerGeneration,
      null,
      "merged",
      run.lifecycle,
      "done",
      (snapshot) => snapshot,
      {
        prOutcome: "merged",
        prObservationId: "merged",
        prVerifiedAt: pr.mergedAt,
        trelloListId: f.project.trello.doneListId,
        trelloObservationId: "done",
        trelloVerifiedAt: pr.mergedAt,
      },
    );
    markTerminalWritersStopped(f.authority, proof.id);
  });
  return { ...f, resource, head, pr, local, signal: new AbortController().signal };
}

describe("terminal resource cleanup", () => {
  it("archives on the worktree mount when context is a separate filesystem", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-mounts-"));
    const worktree = path.join(root, "worktrees", "card");
    const context = path.join(root, "context");
    const moduleURL = new URL("../src/git/preserve-ignored-output.ts", import.meta.url).href;
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(context);
    const script = `
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { preserveIgnoredOutput } from ${JSON.stringify(moduleURL)};
const worktree = ${JSON.stringify(worktree)}, context = ${JSON.stringify(context)};
fs.mkdirSync(path.join(worktree, "dist"));
const sentinel = path.join(worktree, "dist", "sentinel");
fs.writeFileSync(sentinel, "preserve ignored output");
assert.throws(() => fs.renameSync(sentinel, path.join(context, "old-destination")), {code: "EXDEV"});
let state = {version: 1, status: "pending", attempts: 1, updatedAt: new Date().toISOString(), retryAt: null, reason: "inspection", archive: []};
const authority = {
  store: {storageRoot: context, attemptId: "mount-test"},
  read(_key, validate) { return validate(state); },
  mutate(_key, _initial, operation, validate) { const next = operation(state); state = validate(next.value); return next.result; },
  assertHeld() {},
};
const archive = await preserveIgnoredOutput({getIgnoredCleanupPaths: async () => ["dist"]}, worktree, authority);
assert.equal(archive, path.join(path.dirname(worktree), ".cleanup-archives", "mount-test"));
assert.equal(state.archiveRoot, archive);
assert.equal(fs.readFileSync(path.join(archive, "dist", "sentinel"), "utf8"), "preserve ignored output");
assert.equal(fs.existsSync(sentinel), false);
assert.deepEqual(fs.readdirSync(context), []);
`;
    execFileSync(
      "bwrap",
      [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--bind",
        "/",
        "/",
        "--tmpfs",
        context,
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        process.execPath,
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        script,
      ],
      { timeout: 12_000, stdio: "pipe" },
    );
  });

  it("archives setup/build and unknown ignored output, removes actual Git resources, and repeats safely", async () => {
    const f = await fixture();
    const beforeSource = f.local.git(f.project.repository.path, "status", "--porcelain");
    const complete = () =>
      f.authority.run(() =>
        completeMergedTaskSessionPullRequest({
          project: f.project,
          git: f.git,
          trello: f.trello,
          card: { ...f.card, idList: f.project.trello.doneListId },
          pullRequest: f.pr,
          signal: f.signal,
        }),
      );
    await complete();
    await complete();
    expect(fs.existsSync(f.resource.path)).toBe(false);
    expect(await f.git.branchExists(f.project.repository.path, f.resource.branch)).toBe(false);
    expect(f.local.git(f.project.repository.path, "worktree", "list", "--porcelain")).not.toContain(
      f.resource.path,
    );
    expect(f.local.git(f.project.repository.path, "status", "--porcelain")).toBe(beforeSource);
    const state = f.authority.run(() => readTerminalCleanup(f.authority))!;
    expect(state).toMatchObject({ status: "removed", attempts: 1, retryAt: null });
    for (const relative of ["node_modules/dependency", "dist/app.js", "valuable/private.txt"])
      expect(
        fs.readFileSync(
          path.join(
            path.dirname(f.resource.path),
            ".cleanup-archives",
            f.authority.store.attemptId,
            relative,
          ),
          "utf8",
        ),
      ).toBe(relative);
    expect(
      f.authority.store
        .read()!
        .pendingOperations.every((operation) => operation.status === "completed"),
    ).toBe(true);
  });

  it("recovers a rename interrupted before its caller records completion", async () => {
    const f = await fixture();
    f.authority.run(() =>
      writeTerminalCleanup(f.authority, {
        version: 1,
        status: "pending",
        attempts: 0,
        updatedAt: new Date().toISOString(),
        retryAt: null,
        reason: "inspection",
        archive: [],
      }),
    );
    const rename = fs.renameSync;
    const crash = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).includes("cleanup-archives")) throw new Error("simulated crash after rename");
    });
    await expect(
      f.authority.run(() => preserveIgnoredOutput(f.git, f.resource.path, f.authority)),
    ).rejects.toThrow("archival requires recovery");
    crash.mockRestore();
    await f.lease.release();
    const nextLease = await acquireProjectOwnership(
      f.context.coordinationRoot,
      f.lease.identity,
      "notification-authority-test",
    );
    releases.push(() => nextLease.release());
    await reconcileTerminalCleanup({
      project: f.project,
      pinned: f.pinned,
      projectLease: nextLease,
      git: f.git,
      github: f.github,
      trello: f.trello,
      signal: f.signal,
    });
    expect(fs.existsSync(f.resource.path)).toBe(false);
    const resumed = ProjectRunAuthority.resumeTerminalCleanup({
      projectId: f.project.id,
      attemptId: f.authority.store.attemptId,
      pinned: f.pinned,
      projectLease: nextLease,
    });
    expect(resumed.run(() => readTerminalCleanup(resumed))?.status).toBe("removed");
  });

  it("resumes an existing archive plan at its original context location", async () => {
    const f = await fixture();
    const original = path.join(f.resource.path, "dist");
    const stat = fs.lstatSync(original, { bigint: true });
    const legacy = path.join(
      f.pinned.storageRoot,
      "cleanup-archives",
      f.authority.store.attemptId,
    );
    f.authority.run(() =>
      writeTerminalCleanup(f.authority, {
        version: 1,
        status: "pending",
        attempts: 0,
        updatedAt: new Date().toISOString(),
        retryAt: null,
        reason: "inspection",
        archive: [{ relativePath: "dist", device: String(stat.dev), inode: String(stat.ino) }],
      }),
    );
    fs.mkdirSync(legacy, { recursive: true });
    fs.renameSync(original, path.join(legacy, "dist"));
    const destination = await f.authority.run(() =>
      preserveIgnoredOutput(f.git, f.resource.path, f.authority),
    );
    expect(destination).toBe(legacy);
    expect(f.authority.run(() => readTerminalCleanup(f.authority))?.archiveRoot).toBe(legacy);
    expect(fs.readFileSync(path.join(legacy, "dist/app.js"), "utf8")).toBe("dist/app.js");
  });

  it("paces preserved dirty resources across restarts and stops after three attempts", async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.resource.path, "feature.txt"), "unpublished edits");
    const reconcile = (now: number) =>
      reconcileTerminalCleanup({
        project: f.project,
        pinned: f.pinned,
        projectLease: f.lease,
        git: f.git,
        github: f.github,
        trello: f.trello,
        signal: f.signal,
        now: new Date(now),
      });
    const now = Date.now();
    await reconcile(now);
    await reconcile(now + 1);
    expect(f.authority.run(() => readTerminalCleanup(f.authority))?.attempts).toBe(1);
    await reconcile(now + 60_000);
    await reconcile(now + 120_000);
    await reconcile(now + 600_000);
    expect(f.authority.run(() => readTerminalCleanup(f.authority))).toMatchObject({
      status: "preserved",
      attempts: 3,
      reason: "retry-limit",
      retryAt: null,
    });
    expect(fs.readFileSync(path.join(f.resource.path, "feature.txt"), "utf8")).toBe(
      "unpublished edits",
    );
    expect(fs.existsSync(path.join(path.dirname(f.resource.path), ".cleanup-archives"))).toBe(false);
  });

  it("preserves an archive collision rather than overwrite or remove either copy", async () => {
    const f = await fixture();
    const destination = path.join(
      path.dirname(f.resource.path),
      ".cleanup-archives",
      f.authority.store.attemptId,
      "dist",
    );
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "canary"), "unowned archive");
    await expect(
      f.authority.run(() =>
        cleanupTerminalResources({
          project: f.project,
          git: f.git,
          cardId: f.card.id,
          headSha: f.head,
          signal: f.signal,
        }),
      ),
    ).rejects.toThrow("archive collision");
    expect(fs.readFileSync(path.join(destination, "canary"), "utf8")).toBe("unowned archive");
    expect(fs.existsSync(f.resource.path)).toBe(true);
  });

  it("refuses symlinked archive ancestors without touching their target", async () => {
    const f = await fixture();
    const target = path.join(root, "unowned");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(path.dirname(f.resource.path), ".cleanup-archives"), "dir");
    await expect(
      f.authority.run(() =>
        cleanupTerminalResources({
          project: f.project,
          git: f.git,
          cardId: f.card.id,
          headSha: f.head,
          signal: f.signal,
        }),
      ),
    ).rejects.toThrow("Unsafe cleanup archive ancestor");
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.readFileSync(path.join(f.resource.path, "valuable/private.txt"), "utf8")).toBe(
      "valuable/private.txt",
    );
  });

  it("never dispatches ordinary workflow effects from a completed attempt", async () => {
    const f = await fixture();
    const before = f.authority.store.read()!;
    const artifact = f.authority.store.writeArtifact(Buffer.from("{}"));
    f.authority.store.referenceMutationArtifact(
      before.revision,
      f.authority.ownerGeneration,
      artifact,
    );
    const current = f.authority.store.read()!;
    expect(() =>
      f.authority.store.persistMutationIntent(
        current.revision,
        f.authority.ownerGeneration,
        "forbidden",
        {
          kind: "git-push",
          target: "git:forbidden",
          payloadId: artifact.id,
          correlationId: "forbidden",
        },
        new Date().toISOString(),
      ),
    ).toThrow("Cannot add workflow mutations to terminal attempt");
  });

  it("does not take housekeeping authority beside an active attempt", async () => {
    const f = await fixture();
    await f.authority.releaseVerifiedTerminal();
    await ProjectRunAuthority.createPreparingAttempt({
      projectId: f.project.id,
      cardId: "next-card",
      taskKind: "implementation",
      pinned: f.pinned,
      projectLease: f.lease,
      coordinationRoot: f.context.coordinationRoot,
    });
    expect(() =>
      ProjectRunAuthority.resumeTerminalCleanup({
        projectId: f.project.id,
        attemptId: f.authority.store.attemptId,
        pinned: f.pinned,
        projectLease: f.lease,
      }),
    ).toThrow("beside an active attempt");
    expect(fs.existsSync(f.resource.path)).toBe(true);
  });
});
