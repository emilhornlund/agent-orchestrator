import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provisionCoordinationNamespace } from "../src/coordination/project-ownership.js";
import {
  spawnOwnedProcess,
  waitForOwnedProcess,
  type OwnedProcess,
} from "./bounded-process.js";
import {
  closeP2EffectReceiver,
  createP2EffectReceiver,
  waitForP2Effect,
} from "./p2-effect-receiver.js";
import {
  disposeP2Participants,
  removeP2EvidenceIfClean,
} from "./p2-participant-cleanup.js";

type Actor = "host" | "container";
const image =
  process.env.P2_CONTENTION_IMAGE ??
  "localhost/agent-orchestrator-p2-test:latest";
const namespaceId = `p2-contention-${process.pid}-${Date.now()}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p2-startup-contention-"));
const dataRoot = path.join(temp, "data");
const coordinationRoot = path.join(dataRoot, "shared-coordination");
const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const logsRoot = path.join(dataRoot, "logs");
fs.mkdirSync(coordinationRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
provisionCoordinationNamespace(coordinationRoot, namespaceId);
const participants = new Set<ChildProcess>();
const ownedProcesses = new Map<ChildProcess, OwnedProcess>();
const contentionEvidence: Array<Record<string, unknown>> = [];
const podmanNames = new Map<ChildProcess, string>();
const ownedContainerNames = new Set<string>();
const runContainerNames = new Set<string>();
const boundedExec = (
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2] = {},
) =>
  execFileSync(command, args, {
    ...options,
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
const parentReceived: Array<Record<string, unknown>> = [];
const receivedEmitter = new EventEmitter();
const receiverToken = randomUUID();
const receiver = createP2EffectReceiver({
  token: receiverToken,
  accept: (event) => {
    const action = String(event.action ?? "");
    if (!action || typeof event.actor !== "string")
      throw new Error("Missing action/actor identity");
    if (
      [
        "runstore-created",
        "runstore-resumed",
        "task-claim",
        "implementation-dispatch",
        "heartbeat",
      ].includes(action)
    ) {
      const storageRoot = String(event.storageRoot ?? "");
      const attemptId = String(event.attemptId ?? "");
      if (
        !storageRoot.startsWith(`${dataRoot}${path.sep}`) ||
        !attemptId ||
        attemptId.includes("/")
      )
        throw new Error("Task-facing request has unsafe attempt identity");
      const record = JSON.parse(
        fs.readFileSync(
          path.join(storageRoot, "attempts", `${attemptId}.json`),
          "utf8",
        ),
      ) as {
        attemptId: string;
        owner: { instanceId: string; token: string; generation: number };
        pinned: { integrationId: string };
      };
      if (
        record.attemptId !== attemptId ||
        record.owner.instanceId !== event.ownerInstanceId ||
        record.owner.token !== event.ownerToken ||
        record.owner.generation !== event.ownerGeneration ||
        event.leaseInstanceId !== event.ownerInstanceId ||
        event.leaseToken !== event.ownerToken ||
        record.pinned.integrationId !== event.integrationId
      )
        throw new Error(
          "Task-facing request does not match parent-observed durable owner state",
        );
    }
    const accepted = {
      accepted: true,
      sequence: parentReceived.length + 1,
      receivedAt: new Date().toISOString(),
      ...event,
    };
    parentReceived.push(accepted);
    receivedEmitter.emit("received", accepted);
    return accepted;
  },
});
await new Promise<void>((resolve, reject) => {
  receiver.once("error", reject);
  receiver.listen(0, process.env.P2_RECEIVER_BIND ?? "0.0.0.0", resolve);
});
const receiverAddress = receiver.address();
if (!receiverAddress || typeof receiverAddress === "string")
  throw new Error("Parent effect receiver did not bind a TCP port");
const receiverPort = receiverAddress.port;

function waitForParentRequest(
  action: string,
  actor: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  return waitForP2Effect(receivedEmitter, action, actor, options);
}

function waitForParticipant(
  child: ChildProcess,
  options: Parameters<typeof waitForOwnedProcess>[1],
) {
  const owned = ownedProcesses.get(child);
  if (!owned) throw new Error("Participant is missing owned process tracking");
  return waitForOwnedProcess(owned, options);
}

function configFor(
  role: string,
  board = "shared-board",
  repo = "owner/repo",
  hostCoordinationRoot = coordinationRoot,
  containerCoordinationRoot = "/coordination-shared",
  expectedNamespaceId = namespaceId,
  integrationSpellingVariant = role.startsWith("challenger-"),
  alternateRuntime = role.startsWith("challenger-"),
  configuredProjectId = role.startsWith("challenger-")
    ? `project-challenger-${role.slice("challenger-".length)}`
    : undefined,
) {
  const projectKey = role.replace(/^(owner|challenger|retry)-/, "");
  const base = (container: boolean) => {
    const root = alternateRuntime
      ? path.join(dataRoot, "alternate-runtime")
      : dataRoot;
    return {
      projects: [
        {
          id: configuredProjectId ?? `project-${projectKey}`,
          autoMerge: false,
          repository: {
            path: `${root}/repos/${projectKey}`,
            github: integrationSpellingVariant
              ? `https://github.com/${repo.toUpperCase()}.git/`
              : repo,
            defaultBranch: "main",
            worktreeRoot: `${root}/worktrees/${projectKey}`,
            gitIdentity: { name: "Fixture", email: "fixture@example.test" },
          },
          trello: {
            boardId: integrationSpellingVariant ? ` ${board} ` : board,
            backlogListId: "backlog",
            readyListId: "ready",
            workingListId: "working",
            reviewListId: "review",
            failedListId: "failed",
            doneListId: "done",
            refinementLabelId: "refinement",
            featureLabelId: "feature",
            improvementLabelId: "improvement",
            bugLabelId: "bug",
          },
          opencode: {
            refinement: { model: "model", variant: "high" },
            implementation: { model: "model", variant: "high" },
            review: { model: "model", variant: "high" },
            remediation: { model: "model", variant: "high", maxPasses: 1 },
            commit: { model: "model", variant: "low" },
            timeoutMinutes: 1,
          },
        },
      ],
      workflow: {
        pollIntervalSeconds: 1,
        logRetentionDays: 30,
        contextRetentionDays: 30,
        contextRoot: `${root}/context-${projectKey}`,
        coordinationRoot: container
          ? containerCoordinationRoot
          : hostCoordinationRoot,
        coordinationNamespaceId: expectedNamespaceId,
      },
    };
  };
  return { host: base(false), container: base(true) };
}

function launch(
  actor: Actor,
  role: string,
  holder: boolean,
  board = "shared-board",
  repo = "owner/repo",
  coordination = {
    hostRoot: coordinationRoot,
    containerRoot: "/coordination-shared",
    containerMountRoot: "/coordination-shared",
    mountHost: coordinationRoot,
    expectedNamespaceId: namespaceId,
  },
  variants = {
    integrationSpellingVariant: role.startsWith("challenger-"),
    alternateRuntime: role.startsWith("challenger-"),
    configuredProjectId: role.startsWith("challenger-")
      ? `project-challenger-${role.slice("challenger-".length)}`
      : undefined,
  },
): ChildProcess {
  const configs = configFor(
    role,
    board,
    repo,
    coordination.hostRoot,
    coordination.containerRoot,
    coordination.expectedNamespaceId,
    variants.integrationSpellingVariant,
    variants.alternateRuntime,
    variants.configuredProjectId,
  );
  const configPath = path.join(dataRoot, `${role}-${actor}.json`);
  fs.writeFileSync(configPath, JSON.stringify(configs[actor]));
  const environment = {
    P2_CONFIG:
      actor === "container"
        ? `/p2data/${path.basename(configPath)}`
        : configPath,
    P2_ROLE: role,
    P2_RECEIVER_URL:
      actor === "container"
        ? `http://host.containers.internal:${receiverPort}`
        : `http://127.0.0.1:${receiverPort}`,
    P2_RECEIVER_TOKEN: receiverToken,
  };
  const fixture =
    actor === "host"
      ? path.join(sourceRoot, "scripts/p2-contention-participant.ts")
      : "scripts/p2-contention-participant.ts";
  const name = `p2-owner-${role.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`;
  const owned =
    actor === "host"
      ? spawnOwnedProcess(
          path.join(sourceRoot, "node_modules/.bin/tsx"),
          [fixture],
          {
            env: { ...process.env, ...environment },
            cwd: dataRoot,
            stdio: ["pipe", "pipe", "pipe"],
          },
        )
      : spawnOwnedProcess(
          "podman",
          [
            "run",
            "-i",
            "--name",
            name,
            "--userns=keep-id",
            "--security-opt",
            "label=disable",
            "-v",
            `${sourceRoot}:/workspace:ro`,
            "-v",
            `${dataRoot}:/p2data`,
            "-v",
            `${dataRoot}:${dataRoot}`,
            "-v",
            `${logsRoot}:/workspace/logs`,
            "-v",
            `${coordination.mountHost}:${coordination.containerMountRoot}`,
            "-w",
            "/workspace",
            "-e",
            `P2_CONFIG=${environment.P2_CONFIG}`,
            "-e",
            `P2_ROLE=${role}`,
            "-e",
            `P2_RECEIVER_URL=${environment.P2_RECEIVER_URL}`,
            "-e",
            "P2_RECEIVER_TOKEN",
            image,
            "/workspace/node_modules/.bin/tsx",
            fixture,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, P2_RECEIVER_TOKEN: receiverToken },
          },
        );
  const child = owned.child;
  ownedProcesses.set(child, owned);
  if (actor === "container") podmanNames.set(child, name);
  if (actor === "container") {
    ownedContainerNames.add(name);
    runContainerNames.add(name);
  }
  participants.add(child);
  void holder;
  return child;
}

async function readPrefix(
  child: ChildProcess,
  prefix: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${prefix}: ${output}`)),
      30_000,
    );
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const found = output
        .split(/\r?\n/)
        .find((line) => line.startsWith(prefix));
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Participant exited ${String(code)} before ${prefix}: ${output}`,
        ),
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  child.stdin?.end("RELEASE\n");
  const result = await waitForParticipant(child, { timeoutMs: 5_000 });
  if (result.code !== 0)
    throw new Error(`participant exit ${String(result.code)}`);
  participants.delete(child);
  ownedProcesses.delete(child);
  const name = podmanNames.get(child);
  if (name) {
    try {
      boundedExec("podman", ["rm", "--force", name], { stdio: "ignore" });
    } catch {
      // Already removed after a runtime exit.
    }
    podmanNames.delete(child);
    ownedContainerNames.delete(name);
  }
}

function persistedAttempt(role: string, projectKey: string): string {
  return path.join(
    dataRoot,
    `context-${projectKey}`,
    "attempts",
    `attempt-${role}-project-${projectKey}.json`,
  );
}

function sourceDigest(): string {
  const files = [
    "scripts/p2-contention.ts",
    "scripts/p2-contention-participant.ts",
    "scripts/p2-effect-receiver.ts",
    "scripts/p2-participant-cleanup.ts",
    "src/coordination/project-ownership.ts",
    "src/startup/run-startup.ts",
    "src/task-session/project-run-authority.ts",
    "src/task-session/run-store.ts",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(sourceRoot, file)));
  }
  return hash.digest("hex");
}

async function crashTakeover(): Promise<Record<string, unknown>> {
  const role = "owner-crash";
  const projectKey = "crash";
  const board = "crash-board";
  const repository = "owner/crash-repo";
  const sourceBefore = sourceDigest();
  const owner = launch("container", role, true, board, repository);
  const started = await readPrefix(owner, "STARTED:");
  if (!/"createdAttempts":1/.test(started))
    throw new Error(
      `Crash fixture did not create its first RunStore: ${started}`,
    );
  const recordPath = persistedAttempt(role, projectKey);
  const beforeBytes = fs.readFileSync(recordPath);
  const before = JSON.parse(beforeBytes.toString("utf8")) as {
    attemptId: string;
    owner: { generation: number };
    sessions: Record<string, string>;
    resources: Array<Record<string, unknown>>;
  };
  if (
    before.owner.generation !== 1 ||
    !before.sessions.primary ||
    !before.resources.some((resource) => resource.kind === "primary-session")
  )
    throw new Error(
      `Initial durable attempt lacks expected owner/session/resource state: ${beforeBytes.toString("utf8")}`,
    );
  const stableSnapshot = (record: typeof before) =>
    JSON.stringify({
      attemptId: record.attemptId,
      sessions: record.sessions,
      resources: record.resources,
    });
  const stableBefore = stableSnapshot(before);
  const stateHashBefore = createHash("sha256")
    .update(beforeBytes)
    .digest("hex");
  const name = podmanNames.get(owner);
  if (!name)
    throw new Error("Crash fixture did not retain its Podman container name");
  boundedExec("podman", ["kill", "--signal", "KILL", name], {
    stdio: "inherit",
  });
  await waitForParticipant(owner, { timeoutMs: 10_000 });
  participants.delete(owner);
  boundedExec("podman", ["rm", "--force", name], { stdio: "inherit" });
  podmanNames.delete(owner);
  ownedContainerNames.delete(name);

  const restarted = launch("container", role, true, board, repository);
  const restartedLine = await readPrefix(restarted, "STARTED:");
  const afterBytes = fs.readFileSync(recordPath);
  const after = JSON.parse(afterBytes.toString("utf8")) as typeof before;
  const stateHashAfter = createHash("sha256").update(afterBytes).digest("hex");
  if (
    after.attemptId !== before.attemptId ||
    after.owner.generation !== before.owner.generation + 1
  )
    throw new Error(
      `Startup did not take over the same attempt at next generation: ${afterBytes.toString("utf8")}`,
    );
  if (stableSnapshot(after) !== stableBefore)
    throw new Error(
      "Crash recovery changed durable session/resource/attempt references",
    );
  const events = parentReceived.filter((event) => event.actor === role);
  if (
    events.filter((event) => event.action === "runstore-created").length !==
      1 ||
    events.filter((event) => event.action === "task-claim").length !== 1 ||
    events.filter((event) => event.action === "implementation-dispatch")
      .length !== 1 ||
    events.filter((event) => event.action === "runstore-resumed").length !== 1
  )
    throw new Error(
      `Crash recovery replayed task effects or failed to resume exactly once: ${JSON.stringify(events)}`,
    );
  await stop(restarted);
  const sourceAfter = sourceDigest();
  if (sourceBefore !== sourceAfter)
    throw new Error(
      "Source checkout changed during container crash/recreate test",
    );
  return {
    attemptId: after.attemptId,
    generationBefore: before.owner.generation,
    generationAfter: after.owner.generation,
    sessionReferences: after.sessions,
    resources: after.resources,
    stateHashBefore,
    stateHashAfter,
    stableStateHash: createHash("sha256").update(stableBefore).digest("hex"),
    sourceHash: sourceAfter,
    startup: restartedLine,
    containerName: name,
  };
}

async function namespaceFailure(
  variant:
    "missing-marker" | "missing-root" | "wrong-namespace" | "malformed-owner",
): Promise<Record<string, unknown>> {
  const role = `negative-${variant}`;
  const board = `negative-board-${variant}`;
  const repository = `owner/negative-${variant}`;
  const parent = path.join(dataRoot, `negative-${variant}`);
  const provisionedRoot = path.join(parent, "coordination");
  let hostRoot = provisionedRoot;
  let containerRoot = "/coordination-shared";
  let containerMountRoot = "/coordination-shared";
  let mountHost = provisionedRoot;
  const expectedNamespaceId =
    variant === "wrong-namespace" ? `${namespaceId}-wrong` : namespaceId;
  if (variant === "missing-root") {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    hostRoot = path.join(parent, "absent");
    mountHost = parent;
    containerRoot = "/coordination-parent/absent";
    containerMountRoot = "/coordination-parent";
  } else {
    fs.mkdirSync(provisionedRoot, { recursive: true, mode: 0o700 });
    if (variant !== "missing-marker")
      provisionCoordinationNamespace(provisionedRoot, namespaceId);
  }
  let malformedPath: string | undefined;
  let malformedBytes: Buffer | undefined;
  if (variant === "malformed-owner") {
    const ownerKey = createHash("sha256")
      .update(`github:${repository}`)
      .digest("hex");
    malformedPath = path.join(provisionedRoot, `${ownerKey}.owner.json`);
    malformedBytes = Buffer.from('{"preservedMalformed":"evidence"\n');
    fs.writeFileSync(malformedPath, malformedBytes, { mode: 0o600 });
  }
  const coordination = {
    hostRoot,
    containerRoot,
    containerMountRoot,
    mountHost,
    expectedNamespaceId,
  };
  const challenger = launch(
    "container",
    role,
    false,
    board,
    repository,
    coordination,
  );
  const rejected = await readPrefix(challenger, "REJECTED:");
  const result = JSON.parse(rejected.slice("REJECTED:".length)) as {
    name: string;
    message: string;
    createdAttempts: number;
    callbacksCompleted: number;
  };
  const expectedMessage = {
    "missing-marker": /marker is missing/,
    "missing-root": /explicitly provisioned before use/,
    "wrong-namespace": /identity mismatch/,
    "malformed-owner": /Malformed ownership metadata/,
  }[variant];
  if (
    result.name !== "ProjectOwnershipError" ||
    !expectedMessage.test(result.message) ||
    result.createdAttempts !== 0 ||
    result.callbacksCompleted !== 0
  )
    throw new Error(
      `Production startup did not report expected ${variant} failure: ${rejected}`,
    );
  const exit = await waitForParticipant(challenger, { timeoutMs: 5_000 });
  if (exit.code !== 0)
    throw new Error(`negative participant exit ${String(exit.code)}`);
  const projectKey = role;
  const attemptsPath = path.join(dataRoot, `context-${projectKey}`, "attempts");
  if (fs.existsSync(attemptsPath))
    throw new Error(
      `${variant} startup unexpectedly created RunStore attempt state`,
    );
  const taskEffects = parentReceived.filter(
    (event) =>
      event.actor === role &&
      [
        "orchestrator-started",
        "runstore-created",
        "task-claim",
        "implementation-dispatch",
      ].includes(String(event.action)),
  );
  if (taskEffects.length !== 0)
    throw new Error(
      `${variant} startup emitted task effects: ${JSON.stringify(taskEffects)}`,
    );
  if (
    malformedPath &&
    malformedBytes &&
    !fs.readFileSync(malformedPath).equals(malformedBytes)
  )
    throw new Error(
      "Malformed owner metadata bytes were modified or discarded",
    );
  await stop(challenger);
  const evidence = {
    variant,
    result,
    coordinationPath: hostRoot,
    mountHost,
    containerRoot,
    attemptsPath,
    malformedEvidencePath: malformedPath,
    malformedBytesPreserved: malformedPath !== undefined,
  };
  console.log(`PASS startup fail-closed ${variant}: ${rejected}`);
  return evidence;
}

async function scenario(
  ownerActor: Actor,
  challengerActor: Actor,
  index: number,
  control: ChildProcess,
): Promise<void> {
  const board = `shared-board-${index}`;
  const repository = `owner/repo-${index}`;
  const owner = launch(ownerActor, `owner-${index}`, true, board, repository);
  const started = await readPrefix(owner, "STARTED:");
  const startedData = JSON.parse(started.slice("STARTED:".length)) as {
    createdAttempts: number;
  };
  if (startedData.createdAttempts !== 1)
    throw new Error(
      `Owner startup did not create one real attempt: ${started}`,
    );
  const ownerEffects = parentReceived.filter(
    (event) =>
      event.actor === `owner-${index}` &&
      ["runstore-created", "task-claim", "implementation-dispatch"].includes(
        String(event.action),
      ),
  );
  if (
    ownerEffects.filter((event) => event.action === "runstore-created")
      .length !== 1 ||
    ownerEffects.filter((event) => event.action === "task-claim").length !==
      1 ||
    ownerEffects.filter((event) => event.action === "implementation-dispatch")
      .length !== 1
  )
    throw new Error(
      `Parent receiver did not independently capture one owner claim/dispatch: ${JSON.stringify(ownerEffects)}`,
    );
  const taskActions = [
    "orchestrator-started",
    "runstore-created",
    "runstore-resumed",
    "task-claim",
    "implementation-dispatch",
  ];
  const before = parentReceived.filter(
    (event) =>
      event.actor === `challenger-${index}` &&
      taskActions.includes(String(event.action)),
  );
  const challenger = launch(
    challengerActor,
    `challenger-${index}`,
    false,
    board,
    repository,
  );
  const rejected = await readPrefix(challenger, "REJECTED:");
  const result = JSON.parse(rejected.slice("REJECTED:".length)) as {
    name: string;
    message: string;
    createdAttempts: number;
    callbacksCompleted: number;
  };
  if (
    result.name !== "ProjectOwnershipError" ||
    !/already held/.test(result.message) ||
    result.createdAttempts !== 0 ||
    result.callbacksCompleted !== 0
  )
    throw new Error(
      `Losing production startup did not fail closed: ${rejected}`,
    );
  await stop(challenger);
  const after = parentReceived.filter(
    (event) =>
      event.actor === `challenger-${index}` &&
      taskActions.includes(String(event.action)),
  );
  if (JSON.stringify(after) !== JSON.stringify(before) || after.length !== 0)
    throw new Error(
      `Losing startup emitted task effects: ${JSON.stringify(after)}`,
    );

  const heartbeatEventPromise = waitForParentRequest(
    "heartbeat",
    "independent-control",
    { timeoutMs: 10_000 },
  );
  control.stdin?.write("HEARTBEAT\n");
  const [heartbeatEvent, heartbeatOutput] = await Promise.all([
    heartbeatEventPromise,
    readPrefix(control, "HEARTBEAT_RESPONSE:"),
  ]);
  const heartbeatResponse = JSON.parse(
    heartbeatOutput.slice("HEARTBEAT_RESPONSE:".length),
  ) as Record<string, unknown>;
  for (const key of [
    "accepted",
    "sequence",
    "attemptId",
    "ownerGeneration",
    "ownerToken",
    "nonce",
  ])
    if (heartbeatResponse[key] !== heartbeatEvent[key])
      throw new Error(
        `Parent receiver/owner heartbeat authority mismatch for ${key}`,
      );

  await stop(owner);
  const redirected = launch(
    challengerActor,
    `challenger-${index}`,
    true,
    board,
    repository,
  );
  const blockedLine = await readPrefix(redirected, "BLOCKED:");
  const blocked = JSON.parse(blockedLine.slice("BLOCKED:".length)) as {
    reason: string;
  };
  if (
    !/redirects a pinned integration|Configured resources changed while attempt .* remains active/.test(
      blocked.reason,
    )
  )
    throw new Error(
      `Changed alias/runtime retry did not report expected active-pin blockage: ${blockedLine}`,
    );
  const redirectedTaskRequests = parentReceived.filter(
    (event) =>
      event.actor === `challenger-${index}` &&
      ["runstore-created", "task-claim", "implementation-dispatch"].includes(
        String(event.action),
      ),
  );
  if (redirectedTaskRequests.length)
    throw new Error(
      `Redirected active project emitted task effects: ${JSON.stringify(redirectedTaskRequests)}`,
    );
  await stop(redirected);
  const retry = launch(
    challengerActor,
    `retry-${index}`,
    true,
    board,
    repository,
  );
  const retryStarted = await readPrefix(retry, "STARTED:");
  if (!/"createdAttempts":1/.test(retryStarted))
    throw new Error(`Retry startup did not create a RunStore: ${retryStarted}`);
  if (
    parentReceived.filter(
      (event) =>
        event.actor === `retry-${index}` && event.action === "runstore-resumed",
    ).length !== 1
  )
    throw new Error(
      "Same-alias retry did not resume through the parent-observed authority",
    );
  await stop(retry);
  const lockEvidence = [`trello:${board}`, `github:${repository}`].map(
    (resource) => {
      const key = createHash("sha256").update(resource).digest("hex");
      const lockPath = path.join(coordinationRoot, `${key}.lock`);
      const lockStat = fs.statSync(lockPath);
      return {
        lockPath,
        device: lockStat.dev,
        inode: lockStat.ino,
        owner: JSON.parse(
          fs.readFileSync(
            path.join(coordinationRoot, `${key}.owner.json`),
            "utf8",
          ),
        ) as Record<string, unknown>,
      };
    },
  );
  const runRecord = JSON.parse(
    fs.readFileSync(
      path.join(
        dataRoot,
        `context-${index}`,
        "attempts",
        `attempt-owner-${index}-project-${index}.json`,
      ),
      "utf8",
    ),
  ) as {
    owner?: { generation?: number };
    resources?: Array<{ kind: string; id: string }>;
  };
  const claims = parentReceived.filter(
    (event) =>
      event.projectId === `project-${index}` && event.action === "task-claim",
  );
  if (claims.length !== 1)
    throw new Error(
      `Restart/lease recovery duplicated a task claim: ${JSON.stringify(claims)}`,
    );
  if (!runRecord.resources?.some((item) => item.kind === "worktree"))
    throw new Error(
      `Persisted worktree resource reference was lost: ${JSON.stringify(runRecord)}`,
    );
  contentionEvidence.push({
    pair: `${ownerActor.toUpperCase()}/${challengerActor.toUpperCase()}`,
    ownerProjectId: `project-${index}`,
    challengerProjectId: `project-challenger-${index}`,
    namespaceId,
    locks: lockEvidence,
    runGeneration: runRecord.owner?.generation,
    parentHeartbeat: heartbeatEvent,
    changedAliasRuntimeBlockage: blocked.reason,
  });
  console.log(
    `PASS startup contention ${ownerActor}/${challengerActor}: ${rejected}`,
  );
}

let executionError: unknown;
let cleanupError: unknown;
const recordCleanupError = (error: Error) => {
  cleanupError =
    cleanupError === undefined
      ? error
      : new AggregateError(
          [cleanupError, error],
          "Multiple harness cleanup failures",
        );
};
try {
  // A distinct integration remains live while all three shared-resource pairs contend.
  const control = launch(
    "host",
    "independent-control",
    true,
    "independent-board",
    "independent/repo",
  );
  const controlStarted = await readPrefix(control, "STARTED:");
  if (!/"createdAttempts":1/.test(controlStarted))
    throw new Error(`Independent control failed to start: ${controlStarted}`);
  await scenario("host", "host", 1, control);
  await scenario("host", "container", 2, control);
  await scenario("container", "container", 3, control);
  const crashEvidence = await crashTakeover();
  const negativeEvidence = await Promise.all([
    namespaceFailure("missing-marker"),
    namespaceFailure("missing-root"),
    namespaceFailure("wrong-namespace"),
    namespaceFailure("malformed-owner"),
  ]);
  const controlEffects = parentReceived.filter(
    (event) =>
      event.actor === "independent-control" &&
      event.action === "runstore-created",
  );
  if (controlEffects.length !== 1)
    throw new Error(
      `Independent active project was disturbed: ${JSON.stringify(controlEffects)}`,
    );
  const heartbeatEvents = parentReceived.filter(
    (event) =>
      event.actor === "independent-control" && event.action === "heartbeat",
  );
  if (
    heartbeatEvents.length !== 3 ||
    heartbeatEvents.some(
      (event) =>
        event.attemptId !== controlEffects[0]?.attemptId ||
        event.ownerGeneration !== controlEffects[0]?.ownerGeneration ||
        event.ownerToken !== controlEffects[0]?.ownerToken,
    )
  )
    throw new Error(
      `Independent heartbeat/authority oracle failed: ${JSON.stringify(heartbeatEvents)}`,
    );
  await stop(control);
  console.log(
    JSON.stringify({
      result: "PASS",
      pairs: ["HOST/HOST", "HOST/CONTAINER", "CONTAINER/CONTAINER"],
      namespaceId,
      coordinationRoot,
      namespaceMarker: fs.statSync(
        path.join(coordinationRoot, ".agent-orchestrator-coordination.json"),
      ).ino,
      contentionEvidence,
      crashEvidence,
      negativeEvidence,
      independentControlAttempt: controlEffects[0],
    }),
  );
} catch (error) {
  executionError = error;
} finally {
  try {
    await disposeP2Participants(participants, ownedProcesses, {
      timeoutMs: 1_000,
    });
  } catch (error) {
    recordCleanupError(
      new Error(
        `Participant process-group cleanup failed; temp evidence retained at ${temp}`,
        { cause: error },
      ),
    );
  }
  for (const name of ownedContainerNames) {
    try {
      boundedExec("podman", ["rm", "--force", name], { stdio: "ignore" });
      ownedContainerNames.delete(name);
    } catch {
      /* retain temp evidence if removal cannot be confirmed */
    }
  }
  if (participants.size > 0)
    cleanupError ??= new Error(
      `Participant processes could not be confirmed dead; temp evidence retained at ${temp}`,
    );
  try {
    const podmanInventory = boundedExec(
      "podman",
      ["ps", "-a", "--format", "{{.Names}}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as string;
    const remainingOwned = podmanInventory
      .split(/\r?\n/)
      .filter((name) => runContainerNames.has(name));
    if (remainingOwned.length > 0)
      recordCleanupError(
        new Error(
          `Harness-owned Podman containers remain after disposal: ${[...new Set([...remainingOwned, ...ownedContainerNames])].join(", ")}; temp evidence retained at ${temp}`,
        ),
      );
  } catch (error) {
    recordCleanupError(
      new Error(
        `Unable to verify harness-owned Podman inventory; temp evidence retained at ${temp}`,
        { cause: error },
      ),
    );
  }
  try {
    await closeP2EffectReceiver(receiver, 1_000);
    removeP2EvidenceIfClean(participants, cleanupError !== undefined, () =>
      fs.rmSync(temp, { recursive: true, force: true }),
    );
  } catch (error) {
    cleanupError ??= new Error(
      `Harness cleanup failed; temp evidence retained at ${temp}`,
      { cause: error },
    );
  }
}

if (executionError !== undefined && cleanupError !== undefined)
  throw new AggregateError(
    [executionError, cleanupError],
    "Contention scenario failed and cleanup reported additional failures",
  );
if (executionError !== undefined) throw executionError;
if (cleanupError !== undefined) throw cleanupError;
