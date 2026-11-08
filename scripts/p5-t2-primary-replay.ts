import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectConfig } from "../src/config/config.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";
import { runWithPrimaryTaskSession } from "../src/task-session/primary-task-session.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

type ReplayFixture = { root: string; model: string; variant: string };
const replayArg = process.argv.indexOf("--replay");
const gapArg = process.argv.indexOf("--gap-dispatch");

async function dispatchThenCrash(fixture: ReplayFixture): Promise<never> {
  const { root, model, variant } = fixture;
  const worktree = join(root, "worktree");
  const runtime = join(root, "runtime");
  const data = JSON.parse(
    await readFile(join(runtime, "fixture.json"), "utf8"),
  ) as {
    sessionId: string;
    constellation: string;
    projectId: string;
    cardId: string;
    operationId: string;
    project: ProjectConfig;
  };
  configureProcessRuntime({
    runtimeRoot: join(runtime, "process-artifacts"),
    signal: new AbortController().signal,
  });
  const store = new TaskExecutionStore(join(runtime, "ledger"), data.project);
  const client = new OpenCodeClient();
  const runActual = client.run.bind(client);
  Object.defineProperty(client, "run", {
    value: async (options: Parameters<OpenCodeClient["run"]>[0]) => {
      const result = await runActual(options);
      // OpenCode has atomically finalized its process artifacts, but control
      // never returns to runPrimaryOperation to CAS the ledger completion.
      process.kill(process.pid, "SIGKILL");
      return result;
    },
  });
  await runWithPrimaryTaskSession(
    store,
    client,
    data.projectId,
    data.cardId,
    {
      cwd: worktree,
      model,
      variant,
      timeoutMilliseconds: 120_000,
      signal: new AbortController().signal,
      readOnly: true,
      prompt: `Recall the harmless constellation ${data.constellation} and reply READY.`,
      environment: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: join(root, "empty-xdg"),
        TMPDIR: process.env.TMPDIR ?? "",
      },
    },
    {},
    {
      role: "primary",
      operationId: data.operationId,
      activity: "implementation",
      inspectPending: () =>
        inspectPrimaryOperationEvidence(store, data.cardId, data.operationId, {
          trustedRoot: join(runtime, "process-artifacts"),
          cwd: worktree,
        }),
    },
  );
  throw new Error("SIGKILL crash barrier failed to terminate parent");
}

async function replay(fixture: ReplayFixture): Promise<void> {
  const { root, model, variant } = fixture;
  const worktree = join(root, "worktree");
  const runtime = join(root, "runtime");
  const data = JSON.parse(
    await readFile(join(runtime, "fixture.json"), "utf8"),
  ) as {
    sessionId: string;
    constellation: string;
    projectId: string;
    cardId: string;
    operationId: string;
    project: ProjectConfig;
  };
  configureProcessRuntime({
    runtimeRoot: join(runtime, "process-artifacts"),
    signal: new AbortController().signal,
  });
  const store = new TaskExecutionStore(join(runtime, "ledger"), data.project);
  let prepared = 0;
  const openCode = new OpenCodeClient();
  const result = await runWithPrimaryTaskSession(
    store,
    openCode,
    data.projectId,
    data.cardId,
    {
      cwd: worktree,
      model,
      variant,
      timeoutMilliseconds: 120_000,
      signal: new AbortController().signal,
      readOnly: true,
      prompt: `Recall the harmless constellation ${data.constellation} and reply READY.`,
      environment: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: join(root, "empty-xdg"),
      },
      onExecutionPrepared: () => {
        prepared++;
      },
    },
    {},
    {
      role: "primary",
      operationId: data.operationId,
      activity: "implementation",
      inspectPending: () =>
        inspectPrimaryOperationEvidence(store, data.cardId, data.operationId, {
          trustedRoot: join(runtime, "process-artifacts"),
          cwd: worktree,
        }),
    },
  );
  const entry = store.read(data.cardId)?.primaryOperations?.[data.operationId];
  if (
    prepared !== 0 ||
    result.exitCode !== 0 ||
    !entry ||
    entry.executions !== 1 ||
    entry.status !== "completed"
  )
    throw new Error(
      `Ledger replay mismatch: prepared=${prepared}, executions=${entry?.executions}, status=${entry?.status}`,
    );
  await writeFile(
    join(runtime, "replay-result.json"),
    `${JSON.stringify({ executions: entry.executions, status: entry.status, prepared, sessionId: result.sessionId }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ replay: true, executions: entry.executions, status: entry.status, prepared })}\n`,
  );
}

if (replayArg >= 0) {
  const fixture = JSON.parse(
    process.argv[replayArg + 1] ?? "null",
  ) as ReplayFixture;
  await replay(fixture);
} else if (gapArg >= 0) {
  const fixture = JSON.parse(
    process.argv[gapArg + 1] ?? "null",
  ) as ReplayFixture;
  await dispatchThenCrash(fixture);
} else {
  const model = process.env.P5_T2_MODEL;
  const variant = process.env.P5_T2_VARIANT;
  if (!model || !variant)
    throw new Error("Set P5_T2_MODEL and P5_T2_VARIANT explicitly");
  if (!process.env.TMPDIR)
    throw new Error("Set TMPDIR to a workspace-local temporary directory");
  const root = await mkdtemp(join(process.env.TMPDIR, "p5-t2-primary-replay-"));
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  const runtime = join(root, "runtime");
  const emptyXdg = join(root, "empty-xdg");
  await Promise.all([mkdir(source), mkdir(runtime), mkdir(emptyXdg)]);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git([
    "-c",
    "user.name=verification",
    "-c",
    "user.email=verification.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  git(["worktree", "add", "-q", "-b", "agent/p5-t2-primary-replay", worktree]);
  const projectId = "p5-t2-primary-replay";
  const cardId = "fixture-card";
  const operationKey = "fixture-operation";
  const operationId = `${operationKey}:implementation`;
  const project = {
    id: projectId,
    autoMerge: false,
    trello: {
      boardId: "fixture",
      backlogListId: "fixture",
      readyListId: "fixture",
      workingListId: "fixture",
      reviewListId: "fixture",
      failedListId: "fixture",
      doneListId: "fixture",
      refinementLabelId: "fixture",
      featureLabelId: "fixture",
      improvementLabelId: "fixture",
      bugLabelId: "fixture",
    },
    opencode: { model, variant },
    repository: {
      path: source,
      worktreeRoot: join(root, "worktrees"),
      defaultBranch: "main",
    },
  } as ProjectConfig;
  const constellation = `silver otter ${Math.floor(Math.random() * 900 + 100)}`;
  const client = new OpenCodeClient();
  const initial = await client.run({
    cwd: worktree,
    model,
    variant,
    timeoutMilliseconds: 120_000,
    signal: new AbortController().signal,
    readOnly: true,
    prompt: `Remember this harmless constellation ${constellation}. Reply only READY.`,
    captureSessionId: true,
    environment: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: emptyXdg,
    },
  });
  if (initial.exitCode !== 0 || !initial.sessionId)
    throw new Error("Advisory session creation failed; evidence retained");
  const store = new TaskExecutionStore(join(runtime, "ledger"), project);
  const timestamp = new Date().toISOString();
  store.create({
    version: 1,
    projectId,
    cardId,
    phase: "implementation",
    primarySessionId: initial.sessionId,
    sessionCreationStatus: "bound",
    expectedBranch: "agent/p5-t2-primary-replay",
    operationKey,
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const fixture = { root, model, variant };
  await writeFile(
    join(runtime, "fixture.json"),
    `${JSON.stringify({ ...fixture, sessionId: initial.sessionId, constellation, projectId, cardId, operationId, project }, null, 2)}\n`,
  );
  configureProcessRuntime({
    runtimeRoot: join(runtime, "process-artifacts"),
    signal: new AbortController().signal,
  });
  const gapChild = spawnSync(
    join(process.cwd(), "node_modules/.bin/tsx"),
    [process.argv[1]!, "--gap-dispatch", JSON.stringify(fixture)],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 150_000,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
      },
    },
  );
  if (gapChild.signal !== "SIGKILL" && gapChild.status !== 137)
    throw new Error(
      `Expected process-finish/ledger-CAS SIGKILL barrier; status=${gapChild.status}; stderr=${gapChild.stderr}`,
    );
  const afterGap = store.read(cardId)?.primaryOperations?.[operationId];
  if (afterGap?.executions !== 1 || afterGap.status !== "dispatched")
    throw new Error(
      "Crash barrier did not preserve dispatched, uncompleted ledger state",
    );
  await writeFile(
    join(runtime, "finish-before-ledger.json"),
    `${JSON.stringify({ executions: afterGap.executions, status: afterGap.status, processExecutionId: afterGap.processExecutionId }, null, 2)}\n`,
  );
  const child = spawnSync(
    join(process.cwd(), "node_modules/.bin/tsx"),
    [process.argv[1]!, "--replay", JSON.stringify(fixture)],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 150_000,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
      },
    },
  );
  if (child.status !== 0)
    throw new Error(`Fresh-process replay failed: ${child.stderr}`);
  const replayResult = JSON.parse(
    await readFile(join(runtime, "replay-result.json"), "utf8"),
  ) as { executions: number; status: string; prepared: number };
  if (
    replayResult.executions !== 1 ||
    replayResult.status !== "completed" ||
    replayResult.prepared !== 0
  )
    throw new Error(`Fresh-process replay assertion failed: ${child.stdout}`);
  const evidence = {
    root,
    source,
    worktree,
    runtime,
    model,
    variant,
    sessionId: initial.sessionId,
    operationId,
    processExecutionId: afterGap.processExecutionId,
    executions: replayResult.executions,
    finishBeforeLedger: JSON.parse(
      await readFile(join(runtime, "finish-before-ledger.json"), "utf8"),
    ) as unknown,
    replay: replayResult,
  };
  await writeFile(
    join(runtime, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
