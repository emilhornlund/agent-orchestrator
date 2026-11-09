import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(mode: "outage" | "crash", published = false) {
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
