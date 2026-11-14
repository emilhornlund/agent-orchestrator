import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPublicationFixture } from "./support/initial-publication-fixture.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { recordStartupStopAttestation } from "../src/task-session/startup-stop-attestation.js";
import { prepareTerminalTaskSession } from "../src/orchestrator/prepare-terminal-task-session.js";
import { readTerminalPrFence } from "../src/task-session/terminal-pr-fence.js";
import type { PullRequestState } from "../src/github/github-client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-terminal-proof-"));
  roots.push(root);
  const f = createPublicationFixture(root);
  const tasks = new TaskExecutionStore(f.project.contextRoot, f.project, f.authority);
  const task = f.authority.run(() => tasks.read("card")!);
  const directory = path.join(
    f.project.contextRoot,
    "artifacts",
    f.project.id,
    "card",
    "attempt",
    "process-executions",
  );
  const file = path.join(directory, "initial-startup", "execution.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = {
    executionId: "initial-startup",
    command: "opencode run",
    cwd: f.worktreePath,
    startedAt: task.createdAt,
    status: "running",
    dispatchState: "dispatch-pending",
  };
  fs.writeFileSync(file, JSON.stringify(value));
  const observedAt = new Date(Date.now() + 2000).toISOString();
  const legacy = (patch: Record<string, unknown> = {}) => {
    const artifact = f.store.writeArtifact(
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "operator-confirmed-stopped-startup",
          attemptId: "attempt",
          taskRevision: task.revision,
          worktreePath: f.worktreePath,
          confirmedStopped: true,
          sessionInventory: "absent",
          observedAt,
          ...patch,
        }),
      ),
      "application/json",
    );
    return artifact;
  };
  const publish = async () =>
    f.authority.run(async () => {
      const head = await f.git.getHeadSha(f.worktreePath);
      const current = tasks.read("card")!;
      tasks.compareAndSwap("card", current.revision, {
        ...current,
        pullRequest: { number: 1, url: "https://github.com/owner/repo/pull/1", headSha: head },
        revision: current.revision + 1,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
      });
      return {
        state: "MERGED",
        mergedAt: new Date().toISOString(),
        headRefOid: head,
        url: "https://github.com/owner/repo/pull/1",
        headRefName: "agent/card",
        baseRefName: "main",
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "owner" },
      } as PullRequestState;
    });
  const prepare = (pr: PullRequestState) =>
    f.authority.run(() =>
      prepareTerminalTaskSession({
        project: f.project,
        taskStore: tasks,
        queue: new TaskMutationQueue(f.project.contextRoot, f.project),
        git: f.git,
        cardId: "card",
        pullRequest: pr,
      }),
    );
  return { ...f, tasks, task, file, value, legacy, publish, prepare, directory, observedAt };
}

it("honors retained legacy operator startup proof during merged-PR reconciliation without rewriting process metadata", async () => {
  const f = fixture();
  const proof = f.legacy();
  const pr = await f.publish();
  expect(f.store.read()!.artifacts.some((artifact) => artifact.id === proof.id)).toBe(false);
  await expect(f.prepare(pr)).resolves.toMatchObject({ ready: true });
  expect(f.authority.run(() => readTerminalPrFence(f.authority)?.stoppedAt)).toBeDefined();
  expect(f.store.read()!.artifacts.some((artifact) => artifact.id === proof.id)).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.file, "utf8"))).toEqual(f.value);
  await expect(f.prepare(pr)).resolves.toMatchObject({ ready: true });
});

it.each(["missing", "wrong-attempt", "wrong-worktree", "later-execution", "changed-metadata"])(
  "retains ownership when startup operator proof cannot authorize the execution (%s)",
  async (condition) => {
    const f = fixture();
    if (condition !== "missing")
      f.legacy(
        condition === "wrong-attempt"
          ? { attemptId: "other" }
          : condition === "wrong-worktree"
            ? { worktreePath: "/other" }
            : {},
      );
    if (condition === "later-execution")
      fs.writeFileSync(
        f.file,
        JSON.stringify({
          ...f.value,
          startedAt: new Date(Date.parse(f.observedAt) + 1).toISOString(),
        }),
      );
    if (condition === "changed-metadata")
      fs.utimesSync(f.file, new Date(), new Date(Date.parse(f.observedAt) + 10_000));
    const pr = await f.publish();
    await expect(f.prepare(pr)).resolves.toMatchObject({ ready: false });
    expect(f.authority.run(() => readTerminalPrFence(f.authority)?.stoppedAt)).toBeUndefined();
  },
);

it("binds new operator proof to exact execution metadata and does not authorize later unknown work", async () => {
  const f = fixture();
  f.authority.run(() => recordStartupStopAttestation({ authority: f.authority, task: f.task }));
  const later = path.join(f.directory, "later-execution", "execution.json");
  fs.mkdirSync(path.dirname(later));
  fs.writeFileSync(later, JSON.stringify({ ...f.value, executionId: "later-execution" }));
  const pr = await f.publish();
  await expect(f.prepare(pr)).resolves.toMatchObject({ ready: false });
});

it("accepts the exact execution covered by the new operator stop assertion", async () => {
  const f = fixture();
  f.authority.run(() => recordStartupStopAttestation({ authority: f.authority, task: f.task }));
  await expect(f.prepare(await f.publish())).resolves.toMatchObject({ ready: true });
  expect(JSON.parse(fs.readFileSync(f.file, "utf8"))).toEqual(f.value);
});

it("rejects a changed execution after the new scoped operator assertion", async () => {
  const f = fixture();
  f.authority.run(() => recordStartupStopAttestation({ authority: f.authority, task: f.task }));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.value, pid: 12345 }));
  await expect(f.prepare(await f.publish())).resolves.toMatchObject({ ready: false });
});
