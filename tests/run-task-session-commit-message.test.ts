import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../src/config/config.js";
import type { GitClient } from "../src/git/git-client.js";
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { getCommitResultRelativePath } from "../src/opencode/commit-result.js";
import {
  CommitMessageAdviceUnavailableError,
  runTaskSessionCommitMessage,
} from "../src/task-session/run-task-session-commit-message.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const card: TrelloCard = {
  id: "card-one",
  name: "Persist settings",
  desc: "Save settings across restarts.",
  idList: "review",
  idLabels: [],
  url: "https://trello.example/card-one",
};
const message =
  "feat(settings): persist preferences\n\n- Save user settings.\n- Verify reload behavior.\n\nKeep settings available after restart.";

function createFixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-commit-message-"));
  const repositoryPath = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, card.id);
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src.ts"), "settings = {}\n");
  const project = {
    id: "project-one",
    repository: { path: repositoryPath, worktreeRoot },
  } as ProjectConfig;
  const store = new TaskExecutionStore(path.join(root, "state"), project);
  store.create({
    version: 1,
    projectId: project.id,
    cardId: card.id,
    phase: "publication",
    primarySessionId: "primary-session",
    sessionCreationStatus: "bound",
    expectedBranch: `agent/${card.id}`,
    operationKey: "task-operation-one",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
  });
  const untrackedCommitResults = () => {
    const directory = path.join(worktreePath, ".agent-orchestrator");
    return fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .filter((name) => /^commit-result-[a-f0-9]{64}\.json$/u.test(name))
          .map((name) => path.posix.join(".agent-orchestrator", name))
      : [];
  };
  const git = {
    getStatus: vi.fn(async () =>
      [
        " M src.ts",
        ...untrackedCommitResults().map((filePath) => `?? ${filePath}`),
      ].join("\n"),
    ),
    getDiff: vi.fn(async (_cwd: string, staged = false) =>
      staged ? "" : fs.readFileSync(path.join(worktreePath, "src.ts"), "utf8"),
    ),
    getUntrackedFiles: vi.fn(async () => untrackedCommitResults()),
  } as unknown as GitClient;
  const runner = vi.fn<RunOpenCode>(async (options: OpenCodeRunOptions) => {
    const resultPath = options.prompt.match(
      /Write exactly one JSON object to ([^\n]+)\./u,
    )?.[1];
    if (resultPath === undefined)
      throw new Error("Commit prompt omitted its result path");
    const absolutePath = path.join(options.cwd, resultPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify({ message }), "utf8");
    return { exitCode: 0, output: "result written", errorOutput: "" };
  });
  const options = {
    project,
    card,
    operationKey: "task-operation-one",
    commitIntentId: "initial-publication",
    operationId: "task-operation-one:commit-message",
    worktreePath,
    taskRecordStore: store,
    git,
    openCode: new OpenCodeClient(runner),
    runOptions: {
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
  };
  return { project, worktreePath, store, runner, options };
}

describe("task-session commit-message recovery", () => {
  it("persists a source-bound result and replays the same intent without redispatch", async () => {
    const fixture = createFixture();
    const first = await runTaskSessionCommitMessage(fixture.options);

    expect(first).toBe(message);
    expect(
      fixture.store.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ],
    ).toMatchObject({
      role: "advisory",
      status: "completed",
      commitMessageResult: {
        message,
        intentIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(
      fs.readdirSync(path.join(fixture.worktreePath, ".agent-orchestrator")),
    ).toEqual([]);

    const restartedStore = new TaskExecutionStore(
      path.join(root!, "state"),
      fixture.project,
    );
    const second = await runTaskSessionCommitMessage({
      ...fixture.options,
      taskRecordStore: restartedStore,
      openCode: new OpenCodeClient(
        vi.fn<RunOpenCode>(async () => {
          throw new Error("same commit intent must not be redispatched");
        }),
      ),
    });

    expect(second).toBe(message);
    expect(fixture.runner).toHaveBeenCalledOnce();

    fs.writeFileSync(
      path.join(fixture.worktreePath, "src.ts"),
      "CI correction\n",
    );
    const ciIntent = {
      ...fixture.options,
      commitIntentId: "ci-repair-pass-one",
      operationId: "ci-repair-pass-one:commit-message",
      taskRecordStore: restartedStore,
      openCode: new OpenCodeClient(fixture.runner),
    };
    await runTaskSessionCommitMessage(ciIntent);
    expect(fixture.runner).toHaveBeenCalledTimes(2);
    expect(
      restartedStore.read(card.id)?.primaryOperations?.[ciIntent.operationId],
    ).toMatchObject({
      status: "completed",
      commitMessageResult: { message },
    });
    await runTaskSessionCommitMessage({
      ...ciIntent,
      openCode: new OpenCodeClient(
        vi.fn<RunOpenCode>(async () => {
          throw new Error("same CI commit intent must reuse its message");
        }),
      ),
    });
    expect(fixture.runner).toHaveBeenCalledTimes(2);
  });

  it("recovers a completed intent after restart before durable message association", async () => {
    const fixture = createFixture();
    const compareAndSwap = fixture.store.compareAndSwap.bind(fixture.store);
    const interruption = new Error("restart before commit message association");
    const saveAssociation = vi
      .spyOn(fixture.store, "compareAndSwap")
      .mockImplementation((cardId, revision, nextRecord) => {
        if (
          nextRecord.primaryOperations?.[fixture.options.operationId]
            ?.commitMessageResult !== undefined
        )
          throw interruption;
        return compareAndSwap(cardId, revision, nextRecord);
      });

    await expect(runTaskSessionCommitMessage(fixture.options)).rejects.toBe(
      interruption,
    );
    saveAssociation.mockRestore();
    expect(fixture.store.read(card.id)?.primaryOperations).toMatchObject({
      [fixture.options.operationId]: {
        status: "completed",
        executions: 1,
      },
    });
    expect(
      fixture.store.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ]?.commitMessageResult,
    ).toBeUndefined();

    const restartedStore = new TaskExecutionStore(
      path.join(root!, "state"),
      fixture.project,
    );
    const recovered = await runTaskSessionCommitMessage({
      ...fixture.options,
      taskRecordStore: restartedStore,
      openCode: new OpenCodeClient(
        vi.fn<RunOpenCode>(async () => {
          throw new Error("completed intent must replay without dispatch");
        }),
      ),
    });

    expect(recovered).toBe(message);
    expect(fixture.runner).toHaveBeenCalledOnce();
    expect(
      restartedStore.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ]?.commitMessageResult,
    ).toMatchObject({ message });
    expect(
      fs.readdirSync(path.join(fixture.worktreePath, ".agent-orchestrator")),
    ).toEqual([]);
  });

  it("removes only its malformed result before reporting safe advisory unavailability", async () => {
    const fixture = createFixture();
    fixture.runner.mockImplementation(async (options) => {
      const resultPath = options.prompt.match(
        /Write exactly one JSON object to ([^\n]+)\./u,
      )?.[1];
      if (resultPath === undefined)
        throw new Error("Commit prompt omitted its result path");
      const absolutePath = path.join(options.cwd, resultPath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "{ malformed", "utf8");
      return { exitCode: 0, output: "result written", errorOutput: "" };
    });

    await expect(
      runTaskSessionCommitMessage(fixture.options),
    ).rejects.toBeInstanceOf(CommitMessageAdviceUnavailableError);

    expect(
      fs.readdirSync(path.join(fixture.worktreePath, ".agent-orchestrator")),
    ).toEqual([]);
    expect(
      fixture.store.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ]?.commitMessageResult,
    ).toBeUndefined();
  });

  it("preserves its result and propagates filesystem read failures without fallback", async () => {
    const fixture = createFixture();
    let resultPath: string | undefined;
    fixture.runner.mockImplementation(async (options) => {
      const relativePath = options.prompt.match(
        /Write exactly one JSON object to ([^\n]+)\./u,
      )?.[1];
      if (relativePath === undefined)
        throw new Error("Commit prompt omitted its result path");
      resultPath = path.join(options.cwd, relativePath);
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify({ message }), "utf8");
      return { exitCode: 0, output: "result written", errorOutput: "" };
    });
    const readFailure = Object.assign(new Error("temporary read failure"), {
      code: "EIO",
    });
    const readFileSync = fs.readFileSync.bind(fs);
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((filePath, options) => {
        if (filePath === resultPath) throw readFailure;
        return readFileSync(filePath, options);
      });

    try {
      await expect(runTaskSessionCommitMessage(fixture.options)).rejects.toBe(
        readFailure,
      );
    } finally {
      read.mockRestore();
    }

    expect(resultPath).toBeDefined();
    expect(fs.existsSync(resultPath!)).toBe(true);
    expect(fixture.runner).toHaveBeenCalledOnce();
    expect(
      fixture.store.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ]?.commitMessageResult,
    ).toBeUndefined();
  });

  it("includes unrelated existing hashed artifacts in its source snapshot", async () => {
    const fixture = createFixture();
    const unrelatedRelativePath = getCommitResultRelativePath("c".repeat(64));
    const unrelatedPath = path.join(
      fixture.worktreePath,
      unrelatedRelativePath,
    );
    fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
    fs.writeFileSync(unrelatedPath, "unrelated pre-existing artifact");

    const result = await runTaskSessionCommitMessage(fixture.options);

    expect(result).toBe(message);
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe(
      "unrelated pre-existing artifact",
    );
    expect(fixture.runner).toHaveBeenCalledOnce();
  });

  it("preserves an unauthorized sibling result artifact and refuses the commit-message result", async () => {
    const fixture = createFixture();
    const foreignRelativePath = getCommitResultRelativePath("d".repeat(64));
    fixture.runner.mockImplementation(async (options) => {
      const resultRelativePath = options.prompt.match(
        /Write exactly one JSON object to ([^\n]+)\./u,
      )?.[1];
      if (resultRelativePath === undefined)
        throw new Error("Commit prompt omitted its result path");
      const artifacts: Array<[string, string]> = [
        [resultRelativePath, JSON.stringify({ message })],
        [foreignRelativePath, "unauthorized sibling artifact"],
      ];
      for (const [relativePath, content] of artifacts) {
        const filePath = path.join(options.cwd, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
      }
      return { exitCode: 0, output: "result written", errorOutput: "" };
    });

    await expect(runTaskSessionCommitMessage(fixture.options)).rejects.toThrow(
      "Commit-message generation changed source files",
    );

    const foreignPath = path.join(fixture.worktreePath, foreignRelativePath);
    expect(fs.readFileSync(foreignPath, "utf8")).toBe(
      "unauthorized sibling artifact",
    );
    expect(fs.existsSync(foreignPath)).toBe(true);
    expect(
      fixture.store.read(card.id)?.primaryOperations?.[
        fixture.options.operationId
      ]?.commitMessageResult,
    ).toBeUndefined();
    expect(fixture.runner).toHaveBeenCalledOnce();
  });
});
