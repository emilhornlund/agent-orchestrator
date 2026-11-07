import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withActiveLogFile } from "../src/logging/active-log-files.js";
import { cleanupLogRetention } from "../src/logging/log-retention.js";
import { runRecordSchema } from "../src/task-session/run-record.js";
import { RunStore, type RunStoreLease } from "../src/task-session/run-store.js";

const originalCwd = process.cwd();
const now = new Date("2026-01-15T00:00:00.000Z");
const cutoff = new Date("2026-01-01T00:00:00.000Z");
let temporaryDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    temporaryDirectory = undefined;
  }
});

function useTemporaryWorkingDirectory(): void {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-retention-test-"),
  );
  process.chdir(temporaryDirectory);
}

function createFile(relativePath: string, modifiedAt: Date): string {
  const filePath = path.join(process.cwd(), "logs", relativePath);

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });
  fs.writeFileSync(filePath, "log content", "utf8");
  fs.utimesSync(filePath, modifiedAt, modifiedAt);

  return filePath;
}

function canonicalAttempt(options: {
  attemptId: string;
  lifecycle?: "human-review" | "done";
  artifacts?: string[];
}) {
  const lifecycle = options.lifecycle ?? "human-review";
  const lists = {
    ready: "ready",
    working: "working",
    review: "review",
    failed: "failed",
    done: "done",
    backlog: "backlog",
  };
  return runRecordSchema.parse({
    version: 1,
    revision: 1,
    projectId: "p",
    cardId: "c",
    attemptId: options.attemptId,
    taskKind: "implementation",
    pinned: {
      integrationId: "i",
      projectId: "p",
      boardId: "b",
      lists,
      repository: "repo",
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
      storageRoot: "/runtime",
    },
    lifecycle,
    checkpoint: lifecycle,
    publicationState: lifecycle === "done" ? "merged" : "none",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: "instance", token: "token", generation: 1 },
    resources: [],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: (options.artifacts ?? []).map((artifactPath) => ({
      id: `sha256:${"a".repeat(64)}`,
      path: artifactPath,
      bytes: 1,
    })),
    expectedTrelloListId: lifecycle === "done" ? lists.done : null,
    terminalSync: lifecycle === "done" ? "verified" : "not-applicable",
    terminalEvidence:
      lifecycle === "done"
        ? {
            prOutcome: "merged",
            prObservationId: "pr-observed",
            prVerifiedAt: now.toISOString(),
            trelloListId: lists.done,
            trelloObservationId: "card-observed",
            trelloVerifiedAt: now.toISOString(),
          }
        : null,
    legacy: {},
    compatibility: {},
    updatedAt: now.toISOString(),
  });
}

function writeAttempt(
  root: string,
  record: ReturnType<typeof canonicalAttempt>,
): void {
  const directory = path.join(root, "attempts");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${record.attemptId}.json`),
    JSON.stringify(record),
  );
}

describe("cleanupLogRetention", () => {
  it("protects cross-root active references regardless of root order and protects legacy sessions", () => {
    useTemporaryWorkingDirectory();
    const activeRoot = path.join(process.cwd(), "active-runtime");
    const legacyRoot = path.join(process.cwd(), "legacy-runtime");
    const old = new Date("2025-12-01T00:00:00.000Z");
    const referenced = path.join(legacyRoot, "history", "referenced.log");
    const legacySession = path.join(
      process.cwd(),
      "logs",
      "sessions",
      "p",
      "c.log",
    );
    for (const file of [referenced, legacySession]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "evidence");
      fs.utimesSync(file, old, old);
    }
    writeAttempt(
      activeRoot,
      canonicalAttempt({
        attemptId: "live",
        artifacts: [referenced, legacySession],
      }),
    );
    fs.mkdirSync(path.join(legacyRoot, "attempts"), { recursive: true });
    for (const roots of [
      [activeRoot, legacyRoot],
      [legacyRoot, activeRoot],
    ]) {
      cleanupLogRetention(14, now, roots);
      expect(fs.existsSync(referenced)).toBe(true);
      expect(fs.existsSync(legacySession)).toBe(true);
    }
  });

  it("expires canonical verified terminal records but quarantines malformed and symlink attempts", () => {
    useTemporaryWorkingDirectory();
    const canonicalRoot = path.join(process.cwd(), "canonical");
    const malformedRoot = path.join(process.cwd(), "malformed");
    const linkRoot = path.join(process.cwd(), "linked");
    const old = new Date("2025-12-01T00:00:00.000Z");
    const terminalFile = path.join(canonicalRoot, "history", "old.log");
    const stateBlob = path.join(
      canonicalRoot,
      "artifacts",
      "content-addressed",
      "blob.bin",
    );
    const malformedFile = path.join(malformedRoot, "artifacts", "old.log");
    const linkedFile = path.join(linkRoot, "artifacts", "old.log");
    for (const file of [terminalFile, stateBlob, malformedFile, linkedFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "evidence");
      fs.utimesSync(file, old, old);
    }
    writeAttempt(
      canonicalRoot,
      canonicalAttempt({
        attemptId: "finished",
        lifecycle: "done",
        artifacts: [stateBlob],
      }),
    );
    fs.mkdirSync(path.join(malformedRoot, "attempts"), { recursive: true });
    fs.writeFileSync(
      path.join(malformedRoot, "attempts", "fake.json"),
      JSON.stringify({
        attemptId: "fake",
        lifecycle: "done",
        terminalSync: "verified",
      }),
    );
    fs.mkdirSync(path.join(linkRoot, "attempts"), { recursive: true });
    const external = path.join(process.cwd(), "outside.json");
    fs.writeFileSync(external, "uncertain");
    fs.symlinkSync(external, path.join(linkRoot, "attempts", "linked.json"));
    cleanupLogRetention(14, now, [canonicalRoot]);
    expect(fs.existsSync(terminalFile)).toBe(false);
    expect(fs.existsSync(stateBlob)).toBe(true);
    cleanupLogRetention(14, now, [malformedRoot, linkRoot]);
    expect(fs.existsSync(malformedFile)).toBe(true);
    expect(fs.existsSync(linkedFile)).toBe(true);
  });

  it("expires configured daily logs, inactive execution metadata and streams at the exact retention cutoff", () => {
    useTemporaryWorkingDirectory();
    const customRoot = path.join(process.cwd(), "custom-context");
    const dailyDirectory = path.join(customRoot, "orchestrator-logs");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1);
    const exact = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const expiredDaily = path.join(
      dailyDirectory,
      "orchestrator-2025-12-01.log",
    );
    const exactDaily = path.join(dailyDirectory, "orchestrator-2025-12-16.log");
    const processDirectory = path.join(
      customRoot,
      "artifacts",
      "process-executions",
      "execution-1",
    );
    const execution = path.join(processDirectory, "execution.json");
    const stream = path.join(processDirectory, "stdout.txt");
    for (const [file, modified] of [
      [expiredDaily, old],
      [exactDaily, exact],
      [execution, old],
      [stream, old],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "old");
      fs.utimesSync(file, modified, modified);
    }
    writeAttempt(
      customRoot,
      canonicalAttempt({ attemptId: "finished", lifecycle: "done" }),
    );
    cleanupLogRetention(30, now, [customRoot]);
    expect(fs.existsSync(expiredDaily)).toBe(false);
    expect(fs.existsSync(exactDaily)).toBe(true);
    expect(fs.existsSync(execution)).toBe(false);
    expect(fs.existsSync(stream)).toBe(false);
  });

  it("keeps an old Human Review attempt and its artifact across a restarted cleanup process", () => {
    useTemporaryWorkingDirectory();
    const root = path.join(process.cwd(), "restarted-runtime");
    const artifact = path.join(root, "artifacts", "review.log");
    const old = new Date("2025-12-01T00:00:00.000Z");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, "review evidence");
    fs.utimesSync(artifact, old, old);
    writeAttempt(
      root,
      canonicalAttempt({
        attemptId: "waiting-for-review",
        artifacts: [artifact],
      }),
    );
    cleanupLogRetention(30, now, [root]);
    expect(fs.existsSync(artifact)).toBe(true);
  });

  it("retains a terminal RunStore content-addressed artifact so the stored record remains readable", () => {
    useTemporaryWorkingDirectory();
    const root = path.join(process.cwd(), "actual-store");
    const lease: RunStoreLease = {
      integrationId: "i",
      instanceId: "instance",
      token: "token",
      assertHeld() {},
    };
    const pinned = {
      integrationId: "i",
      projectId: "p",
      boardId: "b",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        failed: "failed",
        done: "done",
        backlog: "backlog",
      },
      repository: "repo",
      repositoryPath: path.join(process.cwd(), "repo"),
      worktreeRoot: path.join(process.cwd(), "worktrees"),
      storageRoot: root,
    };
    const store = new RunStore(root, "finished", pinned, lease);
    const content = Buffer.from("durable state blob");
    const digest = createHash("sha256").update(content).digest("hex");
    const artifactPath = path.join(
      root,
      "artifacts",
      "finished",
      `sha256-${digest}`,
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);
    const record = runRecordSchema.parse({
      ...canonicalAttempt({ attemptId: "finished", lifecycle: "done" }),
      pinned,
      artifacts: [
        {
          id: `sha256:${digest}`,
          path: artifactPath,
          bytes: content.byteLength,
        },
      ],
    });
    store.create(record);
    store.writeArtifact(content);
    const old = new Date("2025-12-01T00:00:00.000Z");
    fs.utimesSync(artifactPath, old, old);
    cleanupLogRetention(30, now, [root]);
    expect(store.read()?.artifacts[0]?.path).toBe(artifactPath);
  });

  it("fails closed for a symlinked runtime root or symlinked ancestor", () => {
    useTemporaryWorkingDirectory();
    const target = path.join(process.cwd(), "real-runtime");
    const old = new Date("2025-12-01T00:00:00.000Z");
    const evidence = path.join(target, "artifacts", "old.log");
    fs.mkdirSync(path.join(target, "attempts"), { recursive: true });
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.writeFileSync(evidence, "evidence");
    fs.utimesSync(evidence, old, old);
    writeAttempt(
      target,
      canonicalAttempt({ attemptId: "terminal", lifecycle: "done" }),
    );
    const rootLink = path.join(process.cwd(), "runtime-link");
    fs.symlinkSync(target, rootLink, "dir");
    cleanupLogRetention(14, now, [rootLink]);
    expect(fs.existsSync(evidence)).toBe(true);

    const ancestorTarget = path.join(process.cwd(), "ancestor-target");
    const nestedRoot = path.join(ancestorTarget, "nested-runtime");
    fs.mkdirSync(path.join(nestedRoot, "attempts"), { recursive: true });
    const nestedEvidence = path.join(nestedRoot, "artifacts", "old.log");
    fs.mkdirSync(path.dirname(nestedEvidence), { recursive: true });
    fs.writeFileSync(nestedEvidence, "evidence");
    fs.utimesSync(nestedEvidence, old, old);
    writeAttempt(
      nestedRoot,
      canonicalAttempt({ attemptId: "terminal", lifecycle: "done" }),
    );
    const ancestorLink = path.join(process.cwd(), "ancestor-link");
    fs.symlinkSync(ancestorTarget, ancestorLink, "dir");
    cleanupLogRetention(14, now, [path.join(ancestorLink, "nested-runtime")]);
    expect(fs.existsSync(nestedEvidence)).toBe(true);
  });

  it("fails closed when a symlinked attempts directory may hide a legacy-session reference", () => {
    useTemporaryWorkingDirectory();
    const runtimeRoot = path.join(process.cwd(), "runtime");
    const hiddenOwnerRoot = path.join(process.cwd(), "hidden-owner");
    const session = path.join(
      process.cwd(),
      "logs",
      "sessions",
      "legacy",
      "card.log",
    );
    const old = new Date("2025-12-01T00:00:00.000Z");
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, "referenced session");
    fs.utimesSync(session, old, old);
    writeAttempt(
      hiddenOwnerRoot,
      canonicalAttempt({
        attemptId: "active-hidden",
        artifacts: [session],
      }),
    );
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.symlinkSync(
      path.join(hiddenOwnerRoot, "attempts"),
      path.join(runtimeRoot, "attempts"),
      "dir",
    );

    cleanupLogRetention(14, now, [runtimeRoot]);

    expect(fs.existsSync(session)).toBe(true);
  });

  it("preserves idle Human Review evidence, malformed ownership and active external references", () => {
    useTemporaryWorkingDirectory();
    const runtime = path.join(process.cwd(), "pinned-runtime");
    const legacy = path.join(process.cwd(), "legacy-runtime");
    const malformedRoot = path.join(process.cwd(), "malformed-runtime");
    const attemptDirectory = path.join(runtime, "attempts");
    fs.mkdirSync(attemptDirectory, { recursive: true });
    const old = new Date("2025-12-31T23:59:59.999Z");
    const activeLog = path.join(
      runtime,
      "history",
      "p",
      "c",
      "active",
      "events.jsonl",
    );
    const activeArtifact = path.join(legacy, "history", "session.log");
    const terminalLog = path.join(
      runtime,
      "history",
      "p",
      "c",
      "terminal",
      "events.jsonl",
    );
    for (const file of [activeLog, activeArtifact, terminalLog]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "evidence");
      fs.utimesSync(file, old, old);
    }
    fs.mkdirSync(path.join(legacy, "attempts"), { recursive: true });
    fs.mkdirSync(path.join(malformedRoot, "attempts"), { recursive: true });
    writeAttempt(
      runtime,
      canonicalAttempt({
        attemptId: "active",
        artifacts: [activeArtifact],
      }),
    );
    writeAttempt(
      runtime,
      canonicalAttempt({
        attemptId: "terminal",
        lifecycle: "done",
      }),
    );
    fs.writeFileSync(
      path.join(malformedRoot, "attempts", "uncertain.json"),
      JSON.stringify({
        ...canonicalAttempt({
          attemptId: "uncertain",
          artifacts: [activeArtifact],
        }),
        unknownMalformedField: true,
      }),
    );
    const malformedEvidence = path.join(malformedRoot, "artifacts", "old.txt");
    fs.mkdirSync(path.dirname(malformedEvidence), { recursive: true });
    fs.writeFileSync(malformedEvidence, "preserve");
    fs.utimesSync(malformedEvidence, old, old);
    cleanupLogRetention(14, now, [runtime, legacy, malformedRoot]);
    expect(fs.existsSync(activeLog)).toBe(true);
    // The malformed owner may hide a cross-root reference, so all roots are
    // kept intact rather than sweeping an unrecognized legacy artifact.
    expect(fs.existsSync(activeArtifact)).toBe(true);
    expect(fs.existsSync(malformedEvidence)).toBe(true);
    // Partial JSON is not canonical terminal proof and must remain evidence.
    expect(fs.existsSync(terminalLog)).toBe(true);
  });

  it("expires verified terminal evidence strictly older than the configured cutoff", () => {
    useTemporaryWorkingDirectory();
    const runtime = path.join(process.cwd(), "pinned-runtime");
    const attempts = path.join(runtime, "attempts");
    fs.mkdirSync(attempts, { recursive: true });
    const terminal = path.join(
      runtime,
      "history",
      "p",
      "c",
      "done",
      "events.jsonl",
    );
    const cutoffFile = path.join(
      runtime,
      "history",
      "p",
      "c",
      "cutoff",
      "events.jsonl",
    );
    for (const [file, timestamp] of [
      [terminal, new Date(cutoff.getTime() - 1)],
      [cutoffFile, cutoff],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "evidence");
      fs.utimesSync(file, timestamp, timestamp);
    }
    fs.writeFileSync(
      path.join(attempts, "done.json"),
      JSON.stringify({
        attemptId: "done",
        lifecycle: "done",
        terminalSync: "verified",
      }),
    );
    cleanupLogRetention(14, now, [runtime]);
    expect(fs.existsSync(terminal)).toBe(true);
    expect(fs.existsSync(cutoffFile)).toBe(true);
  });

  it("removes expired daily and session logs but retains the cutoff and newer files", () => {
    useTemporaryWorkingDirectory();

    const expiredDaily = createFile(
      "orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const expiredTestDaily = createFile(
      "test-orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const cutoffDaily = createFile("orchestrator-2026-01-01.log", cutoff);
    const newerDaily = createFile(
      "test-orchestrator-2026-01-02.log",
      new Date("2026-01-02T00:00:00.001Z"),
    );
    const expiredSession = createFile(
      "sessions/project-1/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const cutoffSession = createFile("sessions/project-1/card-2.log", cutoff);
    const newerSession = createFile(
      "sessions/project-1/card-3.log",
      new Date("2026-01-02T00:00:00.001Z"),
    );

    cleanupLogRetention(14, now);

    expect(fs.existsSync(expiredDaily)).toBe(false);
    expect(fs.existsSync(expiredTestDaily)).toBe(false);
    expect(fs.existsSync(expiredSession)).toBe(false);
    expect(fs.existsSync(cutoffDaily)).toBe(true);
    expect(fs.existsSync(newerDaily)).toBe(true);
    expect(fs.existsSync(cutoffSession)).toBe(true);
    expect(fs.existsSync(newerSession)).toBe(true);
  });

  it("does not remove active log files or unrelated entries", () => {
    useTemporaryWorkingDirectory();

    const activeLog = createFile(
      "sessions/project-1/active-card.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const unrelatedFile = createFile(
      "notes.txt",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const unrelatedDirectory = path.join(process.cwd(), "logs", "archive");

    fs.mkdirSync(unrelatedDirectory, {
      recursive: true,
    });
    const unrelatedNestedLog = path.join(unrelatedDirectory, "old.log");
    fs.writeFileSync(unrelatedNestedLog, "unrelated", "utf8");
    fs.utimesSync(
      unrelatedNestedLog,
      new Date("2025-12-31T23:59:59.999Z"),
      new Date("2025-12-31T23:59:59.999Z"),
    );

    withActiveLogFile(activeLog, () => {
      cleanupLogRetention(14, now);
    });

    expect(fs.existsSync(activeLog)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(fs.existsSync(unrelatedNestedLog)).toBe(true);
  });

  it("preserves symbolic links and never follows their targets", () => {
    useTemporaryWorkingDirectory();

    const outsideDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "orchestrator-retention-target-"),
    );
    const outsideFile = path.join(outsideDirectory, "outside.log");

    try {
      fs.writeFileSync(outsideFile, "outside", "utf8");
      fs.utimesSync(
        outsideFile,
        new Date("2025-12-31T23:59:59.999Z"),
        new Date("2025-12-31T23:59:59.999Z"),
      );

      const dailyLink = path.join(
        process.cwd(),
        "logs",
        "orchestrator-2025-12-31.log",
      );
      const sessionLink = path.join(
        process.cwd(),
        "logs",
        "sessions",
        "project-1",
        "card-1.log",
      );

      fs.mkdirSync(path.dirname(sessionLink), {
        recursive: true,
      });
      fs.symlinkSync(outsideFile, dailyLink);
      fs.symlinkSync(outsideFile, sessionLink);

      cleanupLogRetention(14, now);

      expect(fs.lstatSync(dailyLink).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(sessionLink).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      fs.rmSync(outsideDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("treats missing log directories as a no-op", () => {
    useTemporaryWorkingDirectory();

    expect(() => cleanupLogRetention(14, now)).not.toThrow();
  });

  it("reports removal failures and continues with other files", () => {
    useTemporaryWorkingDirectory();

    const failedPath = createFile(
      "orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const removablePath = createFile(
      "test-orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const originalUnlink = fs.unlinkSync;

    vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === failedPath) {
        throw new Error("permission denied");
      }

      return originalUnlink(filePath);
    });

    cleanupLogRetention(14, now);

    expect(fs.existsSync(failedPath)).toBe(true);
    expect(fs.existsSync(removablePath)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Log retention could not remove ${failedPath}`,
    );
    expect(diagnostic).toContain("permission denied");
  });

  it("reports scan failures and continues with other project directories", () => {
    useTemporaryWorkingDirectory();

    const failedProjectDirectory = path.join(
      process.cwd(),
      "logs",
      "sessions",
      "unavailable-project",
    );
    const failedProjectLog = createFile(
      "sessions/unavailable-project/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const availableProjectLog = createFile(
      "sessions/available-project/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const originalReadDirectory = fs.readdirSync;

    vi.spyOn(fs, "readdirSync").mockImplementation((directoryPath, options) => {
      if (String(directoryPath) === failedProjectDirectory) {
        throw new Error("directory unavailable");
      }

      return originalReadDirectory(directoryPath, options);
    });

    cleanupLogRetention(14, now);

    expect(fs.existsSync(failedProjectLog)).toBe(true);
    expect(fs.existsSync(availableProjectLog)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Log retention could not scan ${failedProjectDirectory}`,
    );
    expect(diagnostic).toContain("directory unavailable");
  });
});
