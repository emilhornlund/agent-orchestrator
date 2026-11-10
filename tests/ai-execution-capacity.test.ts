import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AiExecutionCapacity } from "../src/orchestrator/ai-execution-capacity.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { runWithPrimaryTaskSession } from "../src/task-session/primary-task-session.js";
import {
  runOrchestrator,
  persistEssentialDependencyWait,
} from "../src/orchestrator/run-orchestrator.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
vi.mock("../src/orchestrator/poll-project.js", () => ({
  pollProject: vi.fn(),
}));
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";

type Fixture = Awaited<ReturnType<typeof notificationAuthorityFixture>>;
const fixtures: Fixture[] = [];
let root: string;
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.lease.release();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  id: string,
  taskKind: "implementation" | "refinement" = "refinement",
): Promise<Fixture> {
  if (fixtures.length === 0)
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capacity-"));
  const f = await notificationAuthorityFixture(
    root,
    id,
    undefined,
    false,
    taskKind,
  );
  fixtures.push(f);
  return f;
}
function dispatch(
  f: Fixture,
  client: OpenCodeClient,
  signal: AbortSignal,
  prompt: string,
) {
  return f.authority.run(() =>
    client.run({
      cwd: f.project.repository.path,
      readOnly: true,
      prompt,
      signal,
      timeoutMilliseconds: 1000,
    }),
  );
}

it("allocates slots FCFS across projects and sends a busy project behind an existing waiter", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  const capacity = new AiExecutionCapacity(1, [a.authority, b.authority]);
  const shutdown = new AbortController();
  const startedA = barrier();
  const releaseA = barrier();
  const startedB = barrier();
  const releaseB = barrier();
  const order: string[] = [];
  const client = new OpenCodeClient(async ({ prompt }) => {
    order.push(prompt);
    if (prompt === "a1") {
      startedA.resolve();
      await releaseA.promise;
    }
    if (prompt === "b") {
      startedB.resolve();
      await releaseB.promise;
    }
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await capacity.runInScope(shutdown.signal, async () => {
    const first = dispatch(a, client, shutdown.signal, "a1");
    await startedA.promise;
    await expect(
      dispatch(a, client, shutdown.signal, "competing-a"),
    ).rejects.toThrow("live AI execution slot");
    const waiting = dispatch(b, client, shutdown.signal, "b");
    const again = first.then(() => dispatch(a, client, shutdown.signal, "a2"));
    releaseA.resolve();
    await startedB.promise;
    expect(order).toEqual(["a1", "b"]);
    releaseB.resolve();
    await Promise.all([again, waiting]);
  });
  expect(order).toEqual(["a1", "b", "a2"]);
  expect(
    a.authority.read("ai-execution-capacity", (value) => value),
  ).toMatchObject({ state: "idle" });
});

it("preserves an unserved shutdown ticket ahead of later requests after restart", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  const c = await fixture("c");
  const shutdown = new AbortController();
  const started = barrier();
  const release = barrier();
  const client = new OpenCodeClient(async ({ prompt }) => {
    if (prompt === "hold") {
      started.resolve();
      await release.promise;
    }
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1).runInScope(shutdown.signal, async () => {
    const active = dispatch(a, client, shutdown.signal, "hold");
    await started.promise;
    const waiting = dispatch(b, client, shutdown.signal, "b").catch(
      (error: unknown) => error,
    );
    shutdown.abort();
    release.resolve();
    await Promise.all([active, waiting]);
  });
  const ticket = b.authority.read("ai-execution-capacity", (value) => value);
  expect(ticket).toMatchObject({ state: "queued", sequence: 2 });
  const next = new AbortController();
  const order: string[] = [];
  const resumedClient = new OpenCodeClient(async ({ prompt }) => {
    order.push(prompt);
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1, [
    a.authority,
    b.authority,
    c.authority,
  ]).runInScope(next.signal, async () => {
    const later = dispatch(c, resumedClient, next.signal, "c");
    const earlier = dispatch(b, resumedClient, next.signal, "b");
    await Promise.all([later, earlier]);
  });
  expect(order).toEqual(["b", "c"]);
});

it("does not double-acquire a slot for nested AI activity", async () => {
  const a = await fixture("a");
  const shutdown = new AbortController();
  const order: string[] = [];
  const client = new OpenCodeClient(async ({ prompt }) => {
    order.push(prompt);
    if (prompt === "outer") await dispatch(a, client, shutdown.signal, "inner");
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1).runInScope(shutdown.signal, () =>
    dispatch(a, client, shutdown.signal, "outer"),
  );
  expect(order).toEqual(["outer", "inner"]);
});

it("cancels a queued operation without dispatching it or retaining an execution slot", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  const shutdown = new AbortController();
  const local = new AbortController();
  const started = barrier();
  const release = barrier();
  const order: string[] = [];
  const client = new OpenCodeClient(async ({ prompt }) => {
    order.push(prompt);
    if (prompt === "hold") {
      started.resolve();
      await release.promise;
    }
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1).runInScope(shutdown.signal, async () => {
    const active = dispatch(a, client, shutdown.signal, "hold");
    await started.promise;
    const waiting = dispatch(b, client, local.signal, "cancelled");
    local.abort();
    await expect(waiting).rejects.toThrow("cancelled before execution");
    expect(
      b.authority.read("ai-execution-capacity", (value) => value),
    ).toMatchObject({ state: "idle" });
    release.resolve();
    await active;
  });
  expect(order).toEqual(["hold"]);
});

it("retains unknown process capacity across restart until stopped evidence is established", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  const shutdown = new AbortController();
  const executionId = randomUUID();
  const directory = path.join(
    a.authority.store.storageRoot,
    "process-executions",
    executionId,
  );
  fs.mkdirSync(directory, { recursive: true });
  const metadataPath = path.join(directory, "metadata.json");
  const metadata = {
    executionId,
    cwd: a.project.repository.path,
    command: "opencode run",
    status: "interrupted",
    treeStopped: false,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const failing = new OpenCodeClient(async (options) => {
    await options.onExecutionPrepared?.({
      executionId,
      metadataPath,
      artifactRoot: directory,
    });
    throw new Error("unknown writer");
  });
  await new AiExecutionCapacity(1).runInScope(shutdown.signal, async () => {
    await expect(
      dispatch(a, failing, shutdown.signal, "write"),
    ).rejects.toThrow("unknown writer");
  });
  expect(
    a.authority.read("ai-execution-capacity", (value) => value),
  ).toMatchObject({ state: "active" });
  const restarted = new AiExecutionCapacity(1, [a.authority, b.authority]);
  const cancel = new AbortController();
  let dispatched = false;
  const client = new OpenCodeClient(async () => {
    dispatched = true;
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await restarted.runInScope(shutdown.signal, async () => {
    const waiting = dispatch(b, client, cancel.signal, "b");
    cancel.abort();
    await expect(waiting).rejects.toThrow("cancelled");
  });
  expect(dispatched).toBe(false);
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({ ...metadata, treeStopped: true }),
  );
  await new AiExecutionCapacity(1, [a.authority, b.authority]).runInScope(
    shutdown.signal,
    () => dispatch(b, client, shutdown.signal, "b"),
  );
  expect(dispatched).toBe(true);
});

it("does not reserve a primary execution or mark session creation ambiguous while waiting for capacity", async () => {
  const a = await fixture("a");
  const b = await fixture("b", "implementation");
  const tasks = new TaskExecutionStore(
    b.project.contextRoot,
    b.project,
    b.authority,
  );
  tasks.create({
    version: 1,
    projectId: b.project.id,
    cardId: b.card.id,
    phase: "planning",
    operationKey: "task",
    revision: 1,
    expectedBranch: `agent/${b.card.id}`,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const before = tasks.read(b.card.id);
  const started = barrier();
  const release = barrier();
  const shutdown = new AbortController();
  const local = new AbortController();
  const client = new OpenCodeClient(async () => {
    started.resolve();
    await release.promise;
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1).runInScope(shutdown.signal, async () => {
    const active = dispatch(a, client, shutdown.signal, "hold");
    await started.promise;
    const primary = b.authority.run(() =>
      runWithPrimaryTaskSession(
        tasks,
        client,
        b.project.id,
        b.card.id,
        {
          cwd: b.project.repository.path,
          prompt: "plan",
          signal: local.signal,
          timeoutMilliseconds: 1000,
        },
        {},
        {
          role: "primary",
          activity: "planning",
          operationId: "plan",
          inspectPending: async () => ({ status: "unknown" }),
        },
      ),
    );
    expect(tasks.read(b.card.id)).toEqual(before);
    local.abort();
    await expect(primary).rejects.toThrow("cancelled before execution");
    expect(tasks.read(b.card.id)).toEqual(before);
    release.resolve();
    await active;
  });
});

it("retains a dormant dependency ticket without consuming capacity or blocking ready projects", async () => {
  const a = await fixture("a", "implementation");
  const b = await fixture("b");
  const ticket = {
    version: 1,
    state: "queued",
    sequence: 1,
    requestedAt: new Date().toISOString(),
  };
  a.authority.mutate(
    "ai-execution-capacity",
    ticket,
    () => ({ value: ticket, result: undefined }),
    (value) => value,
  );
  const tasks = new TaskExecutionStore(
    a.project.contextRoot,
    a.project,
    a.authority,
  );
  tasks.create({
    version: 1,
    projectId: a.project.id,
    cardId: a.card.id,
    phase: "planning",
    operationKey: "task",
    revision: 1,
    expectedBranch: `agent/${a.card.id}`,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  persistEssentialDependencyWait(a.authority, a.card.id, 15_000, "opencode");
  const shutdown = new AbortController();
  let executed = false;
  const client = new OpenCodeClient(async () => {
    executed = true;
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  await new AiExecutionCapacity(1, [a.authority, b.authority]).runInScope(
    shutdown.signal,
    () => dispatch(b, client, shutdown.signal, "b"),
  );
  expect(executed).toBe(true);
  expect(a.authority.read("ai-execution-capacity", (value) => value)).toEqual(
    ticket,
  );
});

it("applies configured capacity through the production project workers and OpenCode entry point", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  const shutdown = new AbortController();
  const started = barrier();
  const release = barrier();
  const order: string[] = [];
  const client = new OpenCodeClient(async ({ prompt }) => {
    order.push(prompt);
    if (order.length === 1) {
      started.resolve();
      await release.promise;
    } else shutdown.abort();
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  vi.mocked(pollProject).mockImplementation(
    async (_trello, _git, _github, openCode, _commands, project, signal) => {
      await openCode.run({
        cwd: project.repository.path,
        prompt: project.id,
        readOnly: true,
        timeoutMilliseconds: 1000,
        signal,
      });
    },
  );
  const running = runOrchestrator(
    a.trello,
    a.git,
    a.github,
    client,
    a.commands,
    {
      ...a.config,
      projects: [a.project, b.project],
      workflow: { ...a.config.workflow, maxConcurrentAiProjects: 1 },
    },
    shutdown.signal,
    undefined,
    undefined,
    new Map([
      [a.project.id, a.context],
      [b.project.id, b.context],
    ]),
  );
  await started.promise;
  expect(order).toEqual(["a"]);
  release.resolve();
  await running;
  expect(order).toEqual(["a", "b"]);
  vi.mocked(pollProject).mockReset();
});
