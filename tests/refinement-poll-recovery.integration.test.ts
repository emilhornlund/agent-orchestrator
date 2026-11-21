import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { runTaskResources } from "../src/task-session/task-resources.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { CommandRunner, type CommandRunOptions } from "../src/process/command-runner.js";
import {
  beginProcessEvidence,
  ProcessExecutionError,
  registerProcessSecrets,
} from "../src/process/process-runtime.js";
import {
  refinementRecoveryKey,
  refinementRecoverySchema,
  refinementRecoveryReason,
  withRefinementRecovery,
} from "../src/refinement/refinement-recovery.js";
import {
  RefinementSetupAmbiguousError,
  RefinementInternalRecoveryError,
} from "../src/refinement/run-refinement-setup.js";
import { TrelloRequestError } from "../src/trello/trello-client.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-poll-recovery-"));
  roots.push(root);
  const f = await notificationAuthorityFixture(root, "recovery", undefined, true);
  leases.push(f.lease);
  vi.stubGlobal("fetch", f.fetch);
  let authority = f.authority;
  let lease = f.lease;
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const state = () => authority.read(refinementRecoveryKey, refinementRecoverySchema.parse);
  const due = () => {
    now = Date.parse(state()!.nextCheckAt) + 1;
  };
  const reopen = async () => {
    const priorGeneration = authority.ownerGeneration;
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
    authority = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId: authority.store.attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: f.context.coordinationRoot,
    });
    expect(authority.ownerGeneration).toBe(priorGeneration + 1);
  };
  const poll = (commands = f.commands) =>
    pollProject(
      f.trello,
      f.git,
      f.github,
      f.openCode,
      commands,
      f.project,
      new AbortController().signal,
      f.notifier,
      undefined,
      undefined,
      authority,
    );
  return { ...f, state, due, reopen, poll, currentAuthority: () => authority };
}

it.each([false, true])(
  "completes large setup inventories without repeating setup (legacy restart: %s)",
  async (legacy) => {
    const f = await fixture();
    f.project.repository.setupCommand = "install dependencies";
    // A realistic monorepo-sized ignored-path inventory, without thousands of fixture files.
    const ignored = Array.from(
      { length: 110_000 },
      (_, i) => `node_modules/dependency-${i}/${"nested-package/".repeat(10)}index.js`,
    );
    vi.spyOn(f.git, "getIgnoredFiles").mockResolvedValue(ignored);
    const setup = vi.fn(async (options: CommandRunOptions) => {
      const run = ProjectRunAuthority.current(f.project.id)!.store.read()!;
      const directory = path.join(
        run.pinned.storageRoot,
        "artifacts",
        encodeURIComponent(run.projectId),
        encodeURIComponent(run.cardId),
        encodeURIComponent(run.attemptId),
      );
      const evidence = beginProcessEvidence(options.command, options.cwd, [], directory);
      options.onExecutionStarted?.(evidence.executionId);
      fs.writeFileSync(path.join(options.cwd, "setup-generated.txt"), "preserve setup effects");
      evidence.finish("success", { exitCode: 0, treeStopped: true });
      return { exitCode: 0, executionId: evidence.executionId };
    });
    const commands = new CommandRunner(setup);
    const attemptId = f.authority.store.attemptId;
    if (legacy) {
      const read = f.authority.store.readArtifact.bind(f.authority.store);
      const oldReader = vi.spyOn(f.authority.store, "readArtifact").mockImplementation((ref) => {
        const bytes = read(ref);
        if (bytes.length > 16 * 1024 * 1024) throw new Error("Unsafe artifact file");
        return bytes;
      });
      await f.poll(commands);
      expect(f.card.idList).toBe(f.project.trello.workingListId);
      expect(f.engineer).not.toHaveBeenCalled();
      const checkpoint = f.authority.read(`refinement-setup-${f.card.id}`, (value) => value) as {
        status: string;
        baseline: string;
      };
      expect(checkpoint.status).toBe("passed");
      expect(read(checkpoint.baseline).length).toBeGreaterThan(16 * 1024 * 1024);
      expect(f.state()?.reason).toContain("Unsafe artifact file");
      oldReader.mockRestore();
      // Pre-fix deployments have the completed setup, but no recovery pacing record.
      f.authority.remove(refinementRecoveryKey);
      await f.reopen();
    }
    await f.poll(commands);
    expect(f.currentAuthority().store.attemptId).toBe(attemptId);
    expect(f.currentAuthority().store.read()).toMatchObject({
      lifecycle: "refined",
      terminalSync: "verified",
    });
    expect(f.card).toMatchObject({
      idList: f.project.trello.backlogListId,
      name: "Refined task",
      desc: "Complete intended fields",
      idLabels: [f.project.trello.featureLabelId],
    });
    expect(setup).toHaveBeenCalledOnce();
    expect(f.engineer).toHaveBeenCalledOnce();
    const resources = runTaskResources(f.currentAuthority().store.read()!);
    expect(fs.readFileSync(path.join(resources.path, "setup-generated.txt"), "utf8")).toBe(
      "preserve setup effects",
    );
    for (let i = 0; i < 5; i++) await f.poll(commands);
    expect(setup).toHaveBeenCalledOnce();
    expect(f.engineer).toHaveBeenCalledOnce();
  },
);

it("paces internal recovery across reopened stores and confirms Failed after three attempts", async () => {
  const f = await fixture();
  const attachments = vi
    .spyOn(f.trello, "getCardAttachments")
    .mockRejectedValue(new Error("injected attachment preparation defect"));
  await f.poll();
  expect(f.state()).toMatchObject({ internalFailures: 1, kind: "internal" });
  const firstDeadline = f.state()!.nextCheckAt;
  await f.reopen();
  for (let i = 0; i < 10; i++) await f.poll();
  expect(f.state()!.nextCheckAt).toBe(firstDeadline);
  expect(attachments).toHaveBeenCalledOnce();
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  f.due();
  await f.poll();
  expect(f.state()!.internalFailures).toBe(2);
  await f.reopen();
  f.due();
  await f.poll();
  expect(attachments).toHaveBeenCalledTimes(3);
  expect(f.engineer).not.toHaveBeenCalled();
  expect(f.card).toMatchObject({
    idList: f.project.trello.failedListId,
    name: "Task",
    desc: "Original",
    idLabels: [f.project.trello.refinementLabelId],
  });
  const authority = f.currentAuthority();
  expect(authority.store.read()).toMatchObject({
    lifecycle: "failed",
    terminalSync: "verified",
    terminalEvidence: { prOutcome: "no-pr-failure", trelloListId: f.project.trello.failedListId },
  });
  expect(fs.existsSync(runTaskResources(authority.store.read()!).path)).toBe(true);
  expect(new TaskMutationQueue(f.pinned.storageRoot, f.project, authority).getActive()).toBeNull();
  await vi.waitFor(() =>
    expect(f.sink.some((message) => message.includes("three bounded attempts"))).toBe(true),
  );
  expect(f.sink.filter((message) => message.includes("Event: Attention Required"))).toHaveLength(1);
});

it.each(["paced", "legacy", "unknown-child"] as const)(
  "only resumes a stopped pre-claim source fetch after safe restart reconciliation (%s)",
  async (mode) => {
    const f = await fixture();
    const attempt = f.authority.store.attemptId;
    const directory = path.join(
      f.pinned.storageRoot,
      "artifacts",
      f.project.id,
      f.card.id,
      attempt,
      "process-executions",
    );
    const fetch = vi.spyOn(f.git, "fetch").mockImplementation(async () => {
      const evidence = beginProcessEvidence(
        `git -c credential.helper= fetch origin ${f.project.repository.defaultBranch}`,
        f.project.repository.path,
        [],
        directory,
      );
      evidence.finish("nonzero", { exitCode: 128, treeStopped: true });
      throw new ProcessExecutionError("Git", evidence.executionId, "nonzero", 128);
    });
    const moves: string[] = [];
    vi.stubGlobal("fetch", (url: URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { idList?: string };
        if (body.idList) moves.push(body.idList);
      }
      return f.fetch(url, init);
    });
    await f.poll();
    expect(f.card.idList).toBe(f.project.trello.readyListId);
    expect(f.state()).toMatchObject({ kind: "reconciliation", internalFailures: 0, rechecks: 1 });
    expect(moves).toEqual([]);
    if (mode === "legacy") {
      // A pre-fix service leaves the queue failed and records only the process evidence.
      f.currentAuthority().remove(refinementRecoveryKey);
      f.currentAuthority().run(() => {
        const queue = new TaskMutationQueue(f.pinned.storageRoot, f.project);
        const event = queue.claimForRecovery(queue.getActive()!.eventId)!;
        queue.fail(event.eventId);
      });
    }
    await f.reopen();
    if (mode === "unknown-child") {
      beginProcessEvidence("git worktree add", f.project.repository.path, [], directory);
      f.due();
      await expect(f.poll()).rejects.toThrow("preserve state and pause writes");
      expect(fetch).toHaveBeenCalledOnce();
      expect(moves).toEqual([]);
      expect(f.engineer).not.toHaveBeenCalled();
      return;
    }
    await f.poll();
    if (mode === "paced") {
      expect(fetch).toHaveBeenCalledOnce();
      f.due();
      await f.poll();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.state()).toMatchObject({ internalFailures: 0, rechecks: mode === "paced" ? 2 : 1 });
    expect(f.engineer).not.toHaveBeenCalled();
    fetch.mockRestore();
    f.due();
    await f.poll();
    expect(f.currentAuthority().store.attemptId).toBe(attempt);
    expect(f.card.idList).toBe(f.project.trello.backlogListId);
    expect(f.engineer).toHaveBeenCalledOnce();
    expect(moves).toEqual([f.project.trello.workingListId, f.project.trello.backlogListId]);
  },
);

it.each(["safety", "trello-outage"] as const)(
  "retains %s as a controlled wait, then resumes without charging internal failures",
  async (kind) => {
    const f = await fixture();
    const error =
      kind === "safety"
        ? new RefinementSetupAmbiguousError("setup evidence temporarily unavailable")
        : new TrelloRequestError("attachment metadata", "Trello unavailable", {
            retryable: true,
            status: 503,
          });
    const read =
      kind === "safety"
        ? vi.spyOn(f.git, "getIgnoredFiles").mockRejectedValue(error)
        : vi.spyOn(f.trello, "getCardAttachments").mockRejectedValue(error);
    await f.poll();
    expect(f.state()).toMatchObject({ internalFailures: 0, kind: "reconciliation" });
    for (let round = 0; round < 4; round++) {
      const count = read.mock.calls.length;
      await f.reopen();
      for (let poll = 0; poll < 5; poll++) await f.poll();
      expect(read).toHaveBeenCalledTimes(count);
      f.due();
      await f.poll();
      expect(f.state()!.internalFailures).toBe(0);
    }
    expect(f.engineer).not.toHaveBeenCalled();
    read.mockRestore();
    f.due();
    await f.poll();
    expect(f.card.idList).toBe(f.project.trello.backlogListId);
    expect(f.engineer).toHaveBeenCalledOnce();
  },
);

it("never redispatches exhausted internal recovery while stopped-process evidence is missing", async () => {
  const f = await fixture();
  const original = vi
    .spyOn(f.trello, "getCardAttachments")
    .mockRejectedValue(new Error("local defect"));
  await f.poll();
  original.mockRestore();
  const authority = f.authority;
  const resources = runTaskResources(authority.store.read()!);
  const active = {
    command: "setup",
    worktreePath: resources.path,
    status: "active",
    attempts: [
      {
        command: "setup",
        worktreePath: resources.path,
        before: `sha256:${"a".repeat(64)}`,
        outcome: "active",
      },
    ],
  };
  authority.mutate(
    `refinement-setup-${f.card.id}`,
    active,
    () => ({ value: active, result: undefined }),
    (value) => value,
  );
  const execute = vi.fn(async () => {
    throw new RefinementInternalRecoveryError("local defect");
  });
  const attempt = () =>
    authority.run(() =>
      withRefinementRecovery({
        project: f.project,
        card: f.card,
        worktreePath: resources.path,
        signal: new AbortController().signal,
        execute,
      }),
    );
  await expect(attempt()).rejects.toThrow();
  await expect(attempt()).rejects.toThrow();
  for (let i = 0; i < 5; i++) await expect(attempt()).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(f.state()!.internalFailures).toBe(3);
  expect(authority.store.read()!.lifecycle).toBe("refinement");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
});

it("preserves a bounded, sanitized causal diagnostic even for cyclic causes", () => {
  const secret = "refinement-recovery-test-secret";
  registerProcessSecrets([secret]);
  const cause = new Error(`Artifact read failed: ${secret}`);
  const outer = new RefinementInternalRecoveryError("Preserve refinement", { cause });
  cause.cause = outer;
  const diagnostic = refinementRecoveryReason(outer);
  expect(diagnostic).toContain("Cause: Artifact read failed:");
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic.length).toBeLessThanOrEqual(2000);
});
