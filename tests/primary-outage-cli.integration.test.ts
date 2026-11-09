import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "outage" | "outage-once" | "crash", published = false) {
  const temp = process.env.TMPDIR;
  if (!temp) throw new Error("TMPDIR must be set");
  const root = fs.mkdtempSync(path.join(temp, "primary-outage-cli-"));
  roots.push(root);
  const cwd = path.join(root, "worktrees", "card");
  const bin = path.join(root, "bin");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cwd, "primary-mode"), mode);
  fs.copyFileSync(
    path.join(
      process.cwd(),
      "tests/fixtures/scripted-opencode-primary-outage.mjs",
    ),
    path.join(bin, "opencode"),
  );
  fs.chmodSync(path.join(bin, "opencode"), 0o755);
  fs.mkdirSync(path.join(root, "state"));
  fs.mkdirSync(path.join(root, "process-evidence"));
  const project = {
    id: "project",
    autoMerge: false,
    trello: {
      workingListId: "working",
      reviewListId: "review",
      backlogListId: "backlog",
      doneListId: "done",
    },
    repository: {
      path: path.join(root, "repo"),
      worktreeRoot: path.join(root, "worktrees"),
    },
  };
  fs.mkdirSync(project.repository.path);
  fs.writeFileSync(
    path.join(root, "parent-input.json"),
    JSON.stringify({
      root,
      cwd,
      project,
      published,
    }),
  );
  const parentEnvironment = {
    ...process.env,
    TMPDIR: temp,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    PRIMARY_OUTAGE_WINDOWS: "5",
    PRIMARY_RUNTIME_ROOT: path.join(root, "process-evidence"),
  };
  return { root, cwd, project, parentEnvironment };
}

function readRecord(root: string, project: object) {
  return new TaskExecutionStore(
    path.join(root, "state"),
    project as ProjectConfig,
  ).read("card")!;
}

function launchParent(root: string, env: NodeJS.ProcessEnv, now?: number) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "tests/fixtures/primary-outage-parent.ts"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        PRIMARY_PARENT_INPUT: path.join(root, "parent-input.json"),
        ...(now === undefined ? {} : { PRIMARY_PARENT_NOW: String(now) }),
      },
      timeout: 20_000,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(`Fresh parent failed (${child.status}): ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
    status: string;
    retryAt?: string;
    disposition?: string;
    executions?: number;
  };
}

describe("scripted OpenCode primary outage recovery", () => {
  it("preserves a finalized adapter outage across an actual parent SIGKILL gap", async () => {
    const f = fixture("outage-once");
    const inputPath = path.join(f.root, "parent-input.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        root: f.root,
        cwd: f.cwd,
        project: f.project,
        phase: "crash",
      }),
    );
    const parent = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(
          process.cwd(),
          "tests/fixtures/primary-outage-crash-gap-parent.ts",
        ),
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...f.parentEnvironment,
          PRIMARY_PARENT_INPUT: inputPath,
          PRIMARY_OUTAGE_WINDOWS: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    parent.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    parent.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const ready = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error(`adapter did not persist outage result: ${stderr}`)),
        15_000,
      );
      parent.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      parent.stdout.on("data", () => {
        if (stdout.includes("RESULT_PERSISTED")) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    }).catch(async (error: unknown) => {
      parent.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (parent.exitCode !== null || parent.signalCode !== null) resolve();
        else parent.once("close", () => resolve());
      });
      throw error;
    });
    expect(ready).toBe(true);
    parent.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (parent.exitCode !== null || parent.signalCode !== null) resolve();
      else parent.once("close", () => resolve());
    });

    const operation = readRecord(f.root, f.project).primaryOperations?.primary;
    expect(operation).toMatchObject({
      executions: 3,
      failureExecutions: 2,
      dependencyOutages: 0,
      status: "dispatched",
    });
    const processMetadata = JSON.parse(
      fs.readFileSync(operation!.processMetadataPath!, "utf8"),
    ) as Record<string, unknown>;
    expect(processMetadata.failureClassification).toBe("dependency-outage");
    const processResult = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(operation!.processMetadataPath!), "result.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(processResult.failureClassification).toBe("dependency-outage");

    const runFresh = (phase: "recover" | "resume") => {
      fs.writeFileSync(
        inputPath,
        JSON.stringify({ root: f.root, cwd: f.cwd, project: f.project, phase }),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(
            process.cwd(),
            "tests/fixtures/primary-outage-crash-gap-parent.ts",
          ),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...f.parentEnvironment,
            PRIMARY_PARENT_INPUT: inputPath,
            PRIMARY_OUTAGE_WINDOWS: "1",
          },
        },
      );
      if (result.status !== 0)
        throw new Error(`Fresh parent failed: ${result.stderr}`);
      return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
        status: string;
        entry: Record<string, unknown>;
      };
    };
    const recovered = runFresh("recover");
    expect(recovered.status).toBe("waiting");
    expect(recovered.entry).toMatchObject({
      id: "primary",
      executions: 3,
      failureExecutions: 2,
      dependencyOutages: 1,
      accountedExecution: 3,
      lastExecutionClassification: "dependency-outage",
      status: "failed",
    });
    const reopened = readRecord(f.root, f.project).primaryOperations?.primary;
    expect(reopened?.dependencyOutages).toBe(1);
    expect(reopened?.failureExecutions).toBe(2);
    const resumed = runFresh("resume");
    expect(resumed.status, JSON.stringify(resumed)).toBe("completed");
    expect(resumed.entry).toMatchObject({
      executions: 4,
      failureExecutions: 2,
      dependencyOutages: 1,
    });
    expect(
      fs
        .readFileSync(path.join(f.cwd, "primary-cli-calls.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  }, 30_000);

  it("uses persisted retryAt gates across fresh parents, then continues the bound session and operation", () => {
    const f = fixture("outage");
    let outcome = launchParent(f.root, f.parentEnvironment);
    expect(outcome.status).toBe("waiting");
    expect(readRecord(f.root, f.project)).toMatchObject({
      phase: "implementation",
      operationKey: "attempt-1",
      primarySessionId: "ses_primary",
      recoveryWait: { kind: "dependency" },
      primaryOperations: { primary: { status: "failed" } },
    });
    const calls = () =>
      fs.existsSync(path.join(f.cwd, "primary-cli-calls.jsonl"))
        ? fs
            .readFileSync(path.join(f.cwd, "primary-cli-calls.jsonl"), "utf8")
            .trim()
            .split("\n").length
        : 0;
    expect(calls()).toBe(1);

    for (let window = 1; window < 5; window += 1) {
      const retryAt = Date.parse(outcome.retryAt!);
      const blocked = launchParent(f.root, f.parentEnvironment, retryAt - 1);
      expect(blocked.status).toBe("waiting");
      expect(calls()).toBe(window);
      expect(
        readRecord(f.root, f.project).primaryOperations?.primary?.executions,
      ).toBe(window);
      outcome = launchParent(f.root, f.parentEnvironment, retryAt);
      expect(outcome.status).toBe("waiting");
      expect(calls()).toBe(window + 1);
      expect(readRecord(f.root, f.project)).toMatchObject({
        phase: "implementation",
        recoveryWait: { kind: "dependency" },
        primaryOperations: {
          primary: { status: "failed", failureExecutions: 0 },
        },
      });
    }

    const lastRetryAt = Date.parse(outcome.retryAt!);
    outcome = launchParent(f.root, f.parentEnvironment, lastRetryAt - 1);
    expect(outcome.status).toBe("waiting");
    expect(calls()).toBe(5);
    expect(
      readRecord(f.root, f.project).primaryOperations?.primary?.executions,
    ).toBe(5);
    outcome = launchParent(f.root, f.parentEnvironment, lastRetryAt);
    expect(outcome.status).toBe("completed");
    expect(calls()).toBe(6);
    const callArgs = fs
      .readFileSync(path.join(f.cwd, "primary-cli-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(callArgs).toHaveLength(6);
    expect(callArgs.every((args) => args.includes("ses_primary"))).toBe(true);
    expect(
      fs.readFileSync(path.join(f.cwd, "primary-cli-result.txt"), "utf8"),
    ).toContain("continued from same session");
  }, 30_000);

  it.each([false, true])(
    "uses three SIGKILLed CLI executions for verified crash disposition (published=%s)",
    (published) => {
      const f = fixture("crash", published);
      const outcome = launchParent(f.root, f.parentEnvironment);
      expect(outcome).toMatchObject({
        status: "exhausted",
        disposition: published
          ? "published-blockage"
          : "prepublication-failure",
        executions: 3,
      });
      expect(
        fs
          .readFileSync(path.join(f.cwd, "primary-cli-calls.jsonl"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(3);
      const operation = readRecord(f.root, f.project).primaryOperations
        ?.primary;
      expect(operation).toMatchObject({
        failureExecutions: 3,
        accountedExecution: 3,
      });
      const metadata = JSON.parse(
        fs.readFileSync(operation!.processMetadataPath!, "utf8"),
      ) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        status: "nonzero",
        treeStopped: true,
        signal: "SIGKILL",
      });
    },
    30_000,
  );
});
