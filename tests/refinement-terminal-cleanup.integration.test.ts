import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { runTaskResources } from "../src/task-session/task-resources.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { readTerminalCleanup } from "../src/task-session/terminal-cleanup-state.js";
import { refinementCleanupProofKey } from "../src/task-session/refinement-cleanup-proof.js";
import { reconcileTerminalCleanup } from "../src/orchestrator/reconcile-terminal-cleanup.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { CommandRunner, type CommandRunOptions } from "../src/process/command-runner.js";
import { beginProcessEvidence } from "../src/process/process-runtime.js";
import { createIsolatedGitFixture } from "./support/isolated-git-fixture.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(complete = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-cleanup-"));
  roots.push(root);
  const f = await notificationAuthorityFixture(root, "cleanup", undefined, true);
  leases.push(f.lease);
  vi.stubGlobal("fetch", f.fetch);
  const local = createIsolatedGitFixture(root);
  fs.mkdirSync(path.join(f.project.repository.path, ".git/info"), { recursive: true });
  fs.appendFileSync(
    path.join(f.project.repository.path, ".git/info/exclude"),
    "\nnode_modules/\ndist/\n",
  );
  f.project.repository.setupCommand = "fixture setup";
  const setup = vi.fn(async (options: CommandRunOptions) => {
    const directory = new TaskExecutionStore(
      f.pinned.storageRoot,
      f.project,
      f.authority,
    ).processExecutionDirectory(f.card.id)!;
    const evidence = beginProcessEvidence(options.command, options.cwd, [], directory);
    options.onExecutionStarted?.(evidence.executionId);
    execFileSync(
      process.execPath,
      [
        "-e",
        `
      const fs = require("node:fs");
      fs.mkdirSync("node_modules", {recursive: true});
      fs.mkdirSync("dist", {recursive: true});
      fs.writeFileSync("node_modules/sentinel", "dependency content");
      fs.writeFileSync("dist/private.txt", "preserve unknown output");
    `,
      ],
      { cwd: options.cwd },
    );
    evidence.finish("success", { exitCode: 0, treeStopped: true });
    return { exitCode: 0, executionId: evidence.executionId };
  });
  const commands = new CommandRunner(setup);
  const engineer = f.engineer.getMockImplementation()!;
  f.engineer.mockImplementation(async (options) => {
    const directory = new TaskExecutionStore(
      f.pinned.storageRoot,
      f.project,
      f.authority,
    ).processExecutionDirectory(f.card.id)!;
    const evidence = beginProcessEvidence(
      "opencode run --model refinement",
      options.cwd,
      [],
      path.join(directory, "process-executions"),
    );
    await options.onExecutionPrepared?.({
      executionId: evidence.executionId,
      metadataPath: evidence.metadataPath,
      artifactRoot: evidence.artifactRoot,
    });
    const result = await engineer(options);
    evidence.finish("success", { exitCode: 0, treeStopped: true });
    return result;
  });
  const signal = new AbortController().signal;
  if (!complete) {
    const read = f.trello.getCards.bind(f.trello);
    vi.spyOn(f.trello, "getCards").mockImplementation(async (list) => {
      if (list === f.project.trello.backlogListId) throw new Error("final readback unavailable");
      return read(list);
    });
  }
  const poll = () =>
    pollProject(
      f.trello,
      f.git,
      f.github,
      f.openCode,
      commands,
      f.project,
      signal,
      f.notifier,
      undefined,
      undefined,
      f.authority,
    );
  if (complete) await poll();
  else await expect(poll()).rejects.toThrow("final readback unavailable");
  expect(f.authority.store.read()!.lifecycle).toBe(complete ? "refined" : "refinement");
  const resource = runTaskResources(f.authority.store.read()!);
  let lease = f.lease;
  let authority = f.authority;
  let now = new Date();
  const state = () => authority.run(() => readTerminalCleanup(authority));
  const reopen = async () => {
    await lease.release();
    lease = await acquireProjectOwnership(
      f.context.coordinationRoot,
      {
        trelloBoardId: f.project.trello.boardId,
        githubRepository: f.project.repository.github,
      },
      "notification-authority-test",
    );
    leases.push(lease);
    const priorGeneration = authority.ownerGeneration;
    authority = ProjectRunAuthority.resumeTerminalCleanup({
      projectId: f.project.id,
      attemptId: f.authority.store.attemptId,
      pinned: f.pinned,
      projectLease: lease,
    });
    expect(authority.ownerGeneration).toBe(priorGeneration + 1);
  };
  const sweep = () =>
    reconcileTerminalCleanup({
      project: f.project,
      pinned: f.pinned,
      projectLease: lease,
      git: f.git,
      github: f.github,
      trello: f.trello,
      signal,
      now,
    });
  const due = () => {
    now = new Date(Date.parse(state()!.retryAt!) + 1);
  };
  return {
    ...f,
    root,
    resource,
    local,
    setup,
    commands,
    signal,
    state,
    sweep,
    due,
    reopen,
    currentAuthority: () => authority,
    currentLease: () => lease,
  };
}

it("archives a pre-upgrade refined attempt on idle restart without replaying refinement", async () => {
  const f = await fixture();
  expect(f.state()).toBeNull();
  expect(fs.existsSync(f.resource.path)).toBe(true);
  const inode = fs.statSync(path.join(f.resource.path, "dist/private.txt")).ino;
  const beforeSource = f.local.git(f.project.repository.path, "status", "--porcelain");
  const beforeRequests = [...f.requests];
  const beforeEmails = [...f.sink];
  await f.reopen();
  await f.sweep();
  await f.sweep();
  expect(f.state()).toMatchObject({ status: "removed", attempts: 1, retryAt: null });
  expect(fs.existsSync(f.resource.path)).toBe(false);
  expect(await f.git.branchExists(f.project.repository.path, f.resource.branch)).toBe(false);
  const archive = f.state()!.archiveRoot!;
  expect(archive).toBe(
    path.join(path.dirname(f.resource.path), ".cleanup-archives", f.authority.store.attemptId),
  );
  expect(fs.readFileSync(path.join(archive, "node_modules/sentinel"), "utf8")).toBe(
    "dependency content",
  );
  expect(fs.readFileSync(path.join(archive, "dist/private.txt"), "utf8")).toBe(
    "preserve unknown output",
  );
  expect(fs.statSync(path.join(archive, "dist/private.txt")).ino).toBe(inode);
  expect(f.local.git(f.project.repository.path, "status", "--porcelain")).toBe(beforeSource);
  expect(f.requests).toEqual(beforeRequests);
  expect(f.sink).toEqual(beforeEmails);
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  expect(f.currentAuthority().store.read()).toMatchObject({
    lifecycle: "refined",
    terminalSync: "verified",
  });
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.engineer).toHaveBeenCalledOnce();
});

it("resumes an interrupted archival rename with durable pacing after lease takeover", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    if (String(to).includes(".cleanup-archives")) throw new Error("crash after archive rename");
  });
  await f.sweep();
  failure.mockRestore();
  expect(f.state()).toMatchObject({ status: "retryable-failure", attempts: 1 });
  const archive = f.state()!.archiveRoot;
  await f.reopen();
  await f.sweep();
  expect(f.state()!.attempts).toBe(1);
  f.due();
  await f.sweep();
  expect(f.state()).toMatchObject({ status: "removed", attempts: 2, archiveRoot: archive });
  expect(fs.existsSync(f.resource.path)).toBe(false);
  expect(f.engineer).toHaveBeenCalledOnce();
});

it.each(["tracked", "untracked", "local-commit"])(
  "preserves %s work and stops cleanup after three attempts without changing the outcome",
  async (kind) => {
    const f = await fixture();
    const file = kind === "tracked" ? "source.txt" : "unexpected.txt";
    fs.writeFileSync(path.join(f.resource.path, file), "human work");
    if (kind === "local-commit") {
      f.local.git(f.resource.path, "add", file);
      f.local.git(f.resource.path, "commit", "-m", "unpublished setup history");
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.sweep();
      expect(f.state()!.attempts).toBe(attempt);
      await f.reopen();
      if (attempt < 3) f.due();
    }
    await f.sweep();
    expect(f.state()).toMatchObject({
      status: "preserved",
      reason: "retry-limit",
      attempts: 3,
      retryAt: null,
    });
    expect(fs.readFileSync(path.join(f.resource.path, file), "utf8")).toBe("human work");
    expect(fs.readFileSync(path.join(f.resource.path, "dist/private.txt"), "utf8")).toBe(
      "preserve unknown output",
    );
    expect(f.currentAuthority().store.read()!.lifecycle).toBe("refined");
    // Failed housekeeping is not active task ownership and does not block new work.
    const next = await ProjectRunAuthority.createPreparingAttempt({
      projectId: f.project.id,
      cardId: "next-card",
      taskKind: "implementation",
      pinned: f.pinned,
      projectLease: f.currentLease(),
      coordinationRoot: f.context.coordinationRoot,
    });
    expect(next.store.attemptId).not.toBe(f.authority.store.attemptId);
  },
);

it.each(["setup", "analysis"])(
  "does not archive without authoritative stopped %s evidence",
  async (kind) => {
    const f = await fixture();
    const read = TaskExecutionStore.prototype.readProcessExecution;
    vi.spyOn(TaskExecutionStore.prototype, "readProcessExecution").mockImplementation(function (
      this: TaskExecutionStore,
      card,
      execution,
      layout,
    ) {
      if ((kind === "analysis") === (layout === "process-executions")) return null;
      return read.call(this, card, execution, layout);
    });
    await f.sweep();
    expect(f.state()).toMatchObject({ status: "retryable-failure", attempts: 1 });
    expect(f.currentAuthority().read(refinementCleanupProofKey, (value) => value)).toBeNull();
    expect(fs.existsSync(f.resource.path)).toBe(true);
    vi.restoreAllMocks();
    f.due();
    await f.sweep();
    expect(f.state()!.status).toBe("removed");
  },
);

it("does not take cleanup authority beside a new active attempt", async () => {
  const f = await fixture();
  await ProjectRunAuthority.createPreparingAttempt({
    projectId: f.project.id,
    cardId: "next-card",
    taskKind: "implementation",
    pinned: f.pinned,
    projectLease: f.currentLease(),
    coordinationRoot: f.context.coordinationRoot,
  });
  await expect(f.sweep()).rejects.toThrow("beside an active attempt");
  expect(fs.existsSync(f.resource.path)).toBe(true);
});

it("does not clean a card in Backlog until the canonical refinement outcome is verified", async () => {
  const f = await fixture(false);
  const before = [...f.requests];
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  await f.sweep();
  expect(f.state()).toBeNull();
  expect(fs.existsSync(f.resource.path)).toBe(true);
  expect(f.requests).toEqual(before);
});

it("preserves both locations on an archive collision instead of overwriting ignored output", async () => {
  const f = await fixture();
  const target = path.join(
    path.dirname(f.resource.path),
    ".cleanup-archives",
    f.authority.store.attemptId,
    "dist",
  );
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "private.txt"), "unowned destination");
  await f.sweep();
  expect(f.state()!.status).toBe("retryable-failure");
  expect(fs.readFileSync(path.join(target, "private.txt"), "utf8")).toBe("unowned destination");
  expect(fs.readFileSync(path.join(f.resource.path, "dist/private.txt"), "utf8")).toBe(
    "preserve unknown output",
  );
  expect(f.currentAuthority().store.read()!.lifecycle).toBe("refined");
});

it("requires accepted default history and recovers without re-entering refinement", async () => {
  const f = await fixture();
  const read = f.git.getRefSha.bind(f.git);
  const missing = vi
    .spyOn(f.git, "getRefSha")
    .mockImplementation((cwd, ref) =>
      ref.startsWith("refs/remotes/") ? Promise.resolve(null) : read(cwd, ref),
    );
  await f.sweep();
  expect(f.state()).toMatchObject({ status: "retryable-failure", attempts: 1 });
  expect(f.currentAuthority().read(refinementCleanupProofKey, (value) => value)).toBeNull();
  expect(fs.existsSync(f.resource.path)).toBe(true);
  missing.mockRestore();
  f.due();
  await f.sweep();
  expect(f.state()!.status).toBe("removed");
  expect(f.engineer).toHaveBeenCalledOnce();
});

it("limits terminal refinement authority to owned local cleanup, not remote branch deletion or ordinary effects", async () => {
  const f = await fixture();
  await f.sweep();
  const authority = f.currentAuthority();
  await authority.run(async () => {
    for (const kind of ["remote-branch", "branch"] as const) {
      const resource = kind === "branch" ? "unowned-branch" : f.resource.branch;
      const payload = authority.store.writeArtifact(
        Buffer.from(
          JSON.stringify({
            route: "git-cleanup",
            args: {
              cwd: f.project.repository.path,
              resource,
              kind,
              sha: null,
            },
          }),
        ),
      );
      authority.store.referenceMutationArtifact(
        authority.store.read()!.revision,
        authority.ownerGeneration,
        payload,
      );
      expect(() =>
        authority.store.persistMutationIntent(
          authority.store.read()!.revision,
          authority.ownerGeneration,
          `forbidden-${kind}`,
          {
            kind: "git-cleanup",
            target: `git:${kind}:${encodeURIComponent(resource)}`,
            payloadId: payload.id,
            correlationId: `forbidden-${kind}`,
          },
          new Date().toISOString(),
        ),
      ).toThrow("resource ownership proof");
    }
    const payload = authority.store.writeArtifact(Buffer.from("{}"));
    authority.store.referenceMutationArtifact(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      payload,
    );
    expect(() =>
      authority.store.persistMutationIntent(
        authority.store.read()!.revision,
        authority.ownerGeneration,
        "forbidden-push",
        {
          kind: "git-push",
          target: "forbidden",
          payloadId: payload.id,
          correlationId: "forbidden-push",
        },
        new Date().toISOString(),
      ),
    ).toThrow("Cannot add workflow mutations to terminal attempt");
  });
});
