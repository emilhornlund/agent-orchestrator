import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../src/coordination/project-registry.js";
import { GitClient } from "../src/git/git-client.js";
import { logger } from "../src/logging/logger.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { runRefinementCardWorkflow } from "../src/refinement/run-refinement-card.js";
import { getRefinementResultPath } from "../src/refinement/refinement-result.js";
import { refinementResultRelativePath } from "../src/refinement/refinement-result.js";
import { runRefinementSetup } from "../src/refinement/run-refinement-setup.js";
import { runRefinement } from "../src/refinement/run-refinement.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

let root: string;
let lease: ProjectOwnershipLease | undefined;

afterEach(async () => {
  await lease?.release();
  lease = undefined;
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(setupCommand: string) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-setup-recovery-"));
  const repositoryPath = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  const worktreePath = path.join(worktreeRoot, "card-setup");
  const storageRoot = path.join(root, "runtime");
  const coordinationRoot = path.join(root, "coordination");
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(coordinationRoot, { recursive: true });
  provisionCoordinationNamespace(coordinationRoot, "setup-test");
  const project = {
    id: "project-setup",
    autoMerge: false,
    trello: {
      boardId: "board-setup",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      failedListId: "failed",
      doneListId: "done",
      backlogListId: "backlog",
      refinementLabelId: "refinement",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    repository: {
      path: repositoryPath,
      github: "owner/setup",
      defaultBranch: "main",
      worktreeRoot,
      setupCommand,
      gitIdentity: { name: "Setup test", email: "setup@example.invalid" },
    },
    opencode: {
      refinement: { model: "test/refine", variant: "low" },
      implementation: { model: "test/implement", variant: "low" },
      review: { model: "test/review", variant: "low" },
      remediation: { model: "test/repair", variant: "low", maxPasses: 1 },
      commit: { model: "test/commit", variant: "low" },
      timeoutMinutes: 1,
    },
  } as ProjectConfig;
  const card: TrelloCard = {
    id: "card-setup",
    name: "Refine setup task",
    desc: "Use setup before refinement.",
    idList: project.trello.workingListId,
    idLabels: [project.trello.refinementLabelId],
    url: "https://trello.example/card-setup",
  };
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["config", "user.name", "Setup test"], {
    cwd: repositoryPath,
  });
  execFileSync("git", ["config", "user.email", "setup@example.invalid"], {
    cwd: repositoryPath,
  });
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "initial\n");
  fs.writeFileSync(
    path.join(repositoryPath, ".gitignore"),
    "ignored-generated/\n",
  );
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repositoryPath });
  execFileSync(
    "git",
    ["worktree", "add", "-qb", `agent/${card.id}`, worktreePath, "HEAD"],
    { cwd: repositoryPath },
  );
  const integrationId = JSON.stringify({
    trelloBoardId: project.trello.boardId,
    githubRepository: project.repository.github,
  });
  const pinned: RunRecord["pinned"] = {
    integrationId,
    projectId: project.id,
    boardId: project.trello.boardId,
    lists: {
      ready: project.trello.readyListId,
      working: project.trello.workingListId,
      review: project.trello.reviewListId,
      failed: project.trello.failedListId,
      done: project.trello.doneListId,
      backlog: project.trello.backlogListId,
    },
    repository: project.repository.github,
    repositoryPath,
    worktreeRoot,
    storageRoot,
  };
  lease = await acquireProjectOwnership(
    coordinationRoot,
    {
      trelloBoardId: project.trello.boardId,
      githubRepository: project.repository.github,
    },
    "setup-test",
  );
  const config = {
    projects: [project],
    workflow: {
      contextRoot: storageRoot,
      coordinationRoot,
      coordinationNamespaceId: "setup-test",
      pollIntervalSeconds: 1,
      logRetentionDays: 30,
      contextRetentionDays: 30,
    },
  } as Config;
  await verifyAndPinProjects(config, [lease]);
  const authority = await ProjectRunAuthority.createPreparingAttempt({
    projectId: project.id,
    cardId: card.id,
    taskKind: "refinement",
    pinned,
    projectLease: lease,
    coordinationRoot,
  });
  authority.claim();
  return {
    project,
    card,
    authority,
    coordinationRoot,
    pinned,
    worktreePath,
    git: new GitClient(),
  };
}

function makeTrello(card: TrelloCard) {
  return {
    moveCard: vi.fn(async (_cardId: string, listId: string) => ({
      ...card,
      idList: listId,
    })),
    addComment: vi.fn(async () => undefined),
    updateCardContent: vi.fn(async () => undefined),
  } as unknown as TrelloClient;
}

function stateFor(authority: ProjectRunAuthority, cardId: string) {
  return authority.read(`refinement-setup-${cardId}`, (value) => value) as {
    status: string;
    attempts: { outcome: string; after?: string; executionId?: string }[];
  };
}

describe("refinement setup recovery (canonical authority, real Git and processes)", () => {
  it("retains bounded corrections and validated output across reconstructed authority", async () => {
    const f = await fixture("true");
    const baseline = await f.authority.run(() =>
      runRefinementSetup({
        commands: new CommandRunner(),
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger,
      }),
    );
    const run = vi.fn(async () => {
      fs.writeFileSync(
        getRefinementResultPath(f.worktreePath),
        run.mock.calls.length === 1
          ? "{}"
          : JSON.stringify({
              title: "Grounded",
              description: "Scoped work",
              type: "bug",
            }),
      );
      return { exitCode: 0, output: "", errorOutput: "" };
    });
    const execute = (authority: ProjectRunAuthority) =>
      authority.run(() =>
        runRefinement(
          f.git,
          new OpenCodeClient(run),
          f.project,
          f.card,
          f.worktreePath,
          new AbortController().signal,
          undefined,
          baseline,
        ),
      );
    await expect(execute(f.authority)).resolves.toMatchObject({ type: "bug" });
    const resumed = new ProjectRunAuthority(
      f.project.id,
      f.authority.store,
      f.authority.ownerGeneration,
    );
    await expect(execute(resumed)).resolves.toMatchObject({ type: "bug" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      f.authority.read("refinement-analysis-v1", (value) => value),
    ).toMatchObject({ attempts: 2, status: "complete" });
  });
  it("confines refinement and descendants to external results while preserving setup files, index and refs", async () => {
    const f = await fixture("printf generated > setup-file");
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    await f.authority.run(async () => {
      await runRefinementSetup({
        commands: new CommandRunner(),
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger,
      });
      const resultPath = getRefinementResultPath(f.worktreePath);
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      const metadata = path.resolve(
        f.worktreePath,
        fs
          .readFileSync(path.join(f.worktreePath, ".git"), "utf8")
          .trim()
          .slice(8),
      );
      const protectedPaths = [
        "README.md",
        "setup-file",
        "new-file",
        ".git",
        path.join(metadata, "index"),
        path.join(metadata, "HEAD"),
        path.join(f.project.repository.path, ".git/refs/heads/intrusion"),
      ];
      fs.writeFileSync(
        path.join(bin, "opencode"),
        `#!${process.execPath}
const fs = require('node:fs'); const {spawnSync} = require('node:child_process');
for (const p of ${JSON.stringify(protectedPaths)}) { try { fs.writeFileSync(p, 'unsafe'); process.exit(31); } catch {} }
const child = spawnSync(${JSON.stringify(process.execPath)}, ['-e', "try {require('node:fs').writeFileSync('README.md', 'unsafe'); process.exit(32)} catch {}"]);
if (child.status !== 0) process.exit(33);
fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({title:'Grounded task', description:'Refined objective', type:'feature'}));
`,
        { mode: 0o700 },
      );
      const result = await new OpenCodeClient().run({
        cwd: f.worktreePath,
        model: "openai/test",
        prompt: "refine",
        refinementResultDirectory: path.dirname(resultPath),
        environment: {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
        },
        timeoutMilliseconds: 10000,
        signal: new AbortController().signal,
      });
      expect(result.exitCode, result.errorOutput).toBe(0);
      expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({
        type: "feature",
      });
      expect(
        fs.readFileSync(path.join(f.worktreePath, "setup-file"), "utf8"),
      ).toBe("generated");
      expect(
        fs.readFileSync(path.join(f.worktreePath, "README.md"), "utf8"),
      ).toBe("initial\n");
    });
  });
  it.each([
    ["nonzero", "printf preserved > setup-effect; exit 9", undefined],
    ["timeout", "printf preserved > setup-effect; sleep 5", 40],
  ] as const)(
    "blocks refinement on %s setup and preserves bounded effects",
    async (_label, command, timeout) => {
      const f = await fixture(command);
      const trello = makeTrello(f.card);
      const runOpenCode = vi.fn(async () => ({
        exitCode: 0,
        output: "",
        errorOutput: "",
      }));
      const realRunner = new CommandRunner();
      let dispatched = 0;
      const commands = new CommandRunner((options) => {
        dispatched += 1;
        return realRunner.run({
          ...options,
          ...(timeout === undefined ? {} : { timeoutMilliseconds: timeout }),
        });
      });
      await expect(
        f.authority.run(() =>
          runRefinementCardWorkflow({
            trello,
            git: f.git,
            commands,
            openCode: new OpenCodeClient(runOpenCode),
            project: f.project,
            card: f.card,
            signal: new AbortController().signal,
            preparedWorktree: {
              path: f.worktreePath,
              branch: `agent/${f.card.id}`,
            },
            prepareAttachmentContext: async () => undefined,
          }),
        ),
      ).rejects.toThrow();
      expect(runOpenCode).not.toHaveBeenCalled();
      expect(dispatched).toBe(3);
      expect(
        fs.readFileSync(path.join(f.worktreePath, "setup-effect"), "utf8"),
      ).toBe("preserved");
      const persisted = stateFor(f.authority, f.card.id);
      expect(persisted).toMatchObject({
        status: "failed",
        attempts: [
          { outcome: "failed" },
          { outcome: "failed" },
          { outcome: "failed" },
        ],
      });
      expect(
        persisted.attempts.every((attempt) => attempt.after !== undefined),
      ).toBe(true);
      const processStore = new TaskExecutionStore(
        f.authority.store.read()!.pinned.storageRoot,
        f.project,
        f.authority,
      );
      for (const attempt of persisted.attempts) {
        expect(attempt.executionId).toBeDefined();
        expect(
          processStore.readProcessExecution(f.card.id, attempt.executionId!),
        ).toMatchObject({
          treeStopped: true,
          status: _label === "timeout" ? "timeout" : "nonzero",
        });
      }
    },
  );

  it("reopens the canonical store and skips verified completion; changed setup identity blocks", async () => {
    const f = await fixture("printf setup-ready > generated-lockfile");
    const firstRunner = new CommandRunner();
    await f.authority.run(() =>
      runRefinementSetup({
        commands: firstRunner,
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
      }),
    );
    expect(
      fs.readFileSync(path.join(f.worktreePath, "generated-lockfile"), "utf8"),
    ).toBe("setup-ready");
    const attemptId = f.authority.store.read()!.attemptId;
    await lease!.release();
    lease = await acquireProjectOwnership(
      path.join(root, "coordination"),
      {
        trelloBoardId: f.project.trello.boardId,
        githubRepository: f.project.repository.github,
      },
      "setup-test",
    );
    const resumed = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: path.join(root, "coordination"),
    });
    const noDispatch = vi.fn(async () => {
      throw new Error("Verified setup must not execute again");
    });
    await resumed.run(() =>
      runRefinementSetup({
        commands: new CommandRunner(noDispatch),
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
      }),
    );
    expect(noDispatch).not.toHaveBeenCalled();
    const changedCommand = {
      ...f.project,
      repository: { ...f.project.repository, setupCommand: "true" },
    } as ProjectConfig;
    await expect(
      resumed.run(() =>
        runRefinementSetup({
          commands: new CommandRunner(noDispatch),
          git: f.git,
          project: changedCommand,
          cardId: f.card.id,
          worktreePath: f.worktreePath,
          signal: new AbortController().signal,
          cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
        }),
      ),
    ).rejects.toThrow("Persisted refinement setup identity changed");
    await expect(
      resumed.run(() =>
        runRefinementSetup({
          commands: new CommandRunner(noDispatch),
          git: f.git,
          project: f.project,
          cardId: f.card.id,
          worktreePath: path.join(root, "different-worktree"),
          signal: new AbortController().signal,
          cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
        }),
      ),
    ).rejects.toThrow("Persisted refinement setup identity changed");
  });

  it.each(["untracked", "ignored"] as const)(
    "allows a result-only restart when the refinement result is %s",
    async (classification) => {
      const f = await fixture("printf setup-ready > generated-lockfile");
      let setupExecutions = 0;
      const realRunner = new CommandRunner();
      const commands = new CommandRunner((options) => {
        setupExecutions += 1;
        return realRunner.run(options);
      });
      await f.authority.run(() =>
        runRefinementSetup({
          commands,
          git: f.git,
          project: f.project,
          cardId: f.card.id,
          worktreePath: f.worktreePath,
          signal: new AbortController().signal,
          cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
        }),
      );
      const resultPath = getRefinementResultPath(f.worktreePath);
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          title: "Interrupted result",
          description: "Valid",
          type: "feature",
        }),
      );
      if (classification === "ignored") {
        const excludePath = execFileSync(
          "git",
          ["rev-parse", "--git-path", "info/exclude"],
          { cwd: f.worktreePath, encoding: "utf8" },
        ).trim();
        fs.appendFileSync(
          path.resolve(f.worktreePath, excludePath),
          `${refinementResultRelativePath}\n`,
        );
        expect(await f.git.getIgnoredFiles(f.worktreePath)).toContain(
          refinementResultRelativePath,
        );
      } else {
        expect(await f.git.getUntrackedFiles(f.worktreePath)).toContain(
          refinementResultRelativePath,
        );
      }
      const attemptId = f.authority.store.read()!.attemptId;
      await lease!.release();
      lease = await acquireProjectOwnership(
        path.join(root, "coordination"),
        {
          trelloBoardId: f.project.trello.boardId,
          githubRepository: f.project.repository.github,
        },
        "setup-test",
      );
      const resumed = await ProjectRunAuthority.resumeAttempt({
        projectId: f.project.id,
        attemptId,
        pinned: f.pinned,
        projectLease: lease,
        coordinationRoot: path.join(root, "coordination"),
      });
      const openCode = vi.fn(async () => {
        expect(fs.existsSync(resultPath)).toBe(true);
        expect(getRefinementResultPath(f.worktreePath)).not.toBe(resultPath);
        return {
          exitCode: 7,
          output: "expected nonzero after setup skip",
          errorOutput: "",
        };
      });
      await expect(
        resumed.run(() =>
          runRefinementCardWorkflow({
            trello: makeTrello(f.card),
            git: f.git,
            commands,
            openCode: new OpenCodeClient(openCode),
            project: f.project,
            card: f.card,
            signal: new AbortController().signal,
            preparedWorktree: {
              path: f.worktreePath,
              branch: `agent/${f.card.id}`,
            },
            prepareAttachmentContext: async () => undefined,
          }),
        ),
      ).rejects.toThrow(
        "Refinement execution did not establish a stopped child",
      );
      expect(openCode).toHaveBeenCalledOnce();
      expect(setupExecutions).toBe(1);
    },
  );

  it("retains a transient baseline-read failure and retries the verified setup without rerunning it", async () => {
    const f = await fixture("printf setup-ready > generated-lockfile");
    let setupExecutions = 0;
    const realRunner = new CommandRunner();
    const commands = new CommandRunner((options) => {
      setupExecutions += 1;
      return realRunner.run(options);
    });
    await f.authority.run(() =>
      runRefinementSetup({
        commands,
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
      }),
    );
    const attemptId = f.authority.store.read()!.attemptId;
    await lease!.release();
    lease = await acquireProjectOwnership(
      path.join(root, "coordination"),
      {
        trelloBoardId: f.project.trello.boardId,
        githubRepository: f.project.repository.github,
      },
      "setup-test",
    );
    const resumed = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: path.join(root, "coordination"),
    });
    const transientGit = Object.create(f.git) as GitClient;
    let failedRead = false;
    Object.defineProperty(transientGit, "getHeadSha", {
      value: async (cwd: string, signal?: AbortSignal) => {
        if (!failedRead) {
          failedRead = true;
          throw new Error("transient baseline inspection failure");
        }
        return f.git.getHeadSha(cwd, signal);
      },
    });
    const firstAgent = vi.fn(async () => ({
      exitCode: 0,
      output: "",
      errorOutput: "",
    }));
    const trello = makeTrello(f.card);
    await expect(
      resumed.run(() =>
        runRefinementCardWorkflow({
          trello,
          git: transientGit,
          commands,
          openCode: new OpenCodeClient(firstAgent),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/could not inspect the worktree/i);
    expect(firstAgent).not.toHaveBeenCalled();
    expect(trello.moveCard).not.toHaveBeenCalled();

    const secondAgent = vi.fn(async () => ({
      exitCode: 7,
      output: "agent was allowed only after read recovered",
      errorOutput: "",
    }));
    await expect(
      resumed.run(() =>
        runRefinementCardWorkflow({
          trello,
          git: f.git,
          commands,
          openCode: new OpenCodeClient(secondAgent),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow("Refinement execution did not establish a stopped child");
    expect(secondAgent).toHaveBeenCalledOnce();
    expect(setupExecutions).toBe(1);
  });

  it("does not launder interrupted tracked, untracked, or ignored edits into a new setup baseline", async () => {
    const f = await fixture("printf setup-ready > generated-lockfile");
    await f.authority.run(() =>
      runRefinementSetup({
        commands: new CommandRunner(),
        git: f.git,
        project: f.project,
        cardId: f.card.id,
        worktreePath: f.worktreePath,
        signal: new AbortController().signal,
        cardLog: logger.child({ projectId: f.project.id, cardId: f.card.id }),
      }),
    );
    fs.writeFileSync(
      path.join(f.worktreePath, "README.md"),
      "interrupted tracked edit\n",
    );
    fs.writeFileSync(
      path.join(f.worktreePath, "untracked-agent-file"),
      "preserve me",
    );
    fs.mkdirSync(path.join(f.worktreePath, "ignored-generated"));
    fs.writeFileSync(
      path.join(f.worktreePath, "ignored-generated", "cache"),
      "keep",
    );
    const attemptId = f.authority.store.read()!.attemptId;
    await lease!.release();
    lease = await acquireProjectOwnership(
      path.join(root, "coordination"),
      {
        trelloBoardId: f.project.trello.boardId,
        githubRepository: f.project.repository.github,
      },
      "setup-test",
    );
    const resumed = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: path.join(root, "coordination"),
    });
    const runOpenCode = vi.fn(async () => ({
      exitCode: 0,
      output: "",
      errorOutput: "",
    }));
    await expect(
      resumed.run(() =>
        runRefinementCardWorkflow({
          trello: makeTrello(f.card),
          git: f.git,
          commands: new CommandRunner(),
          openCode: new OpenCodeClient(runOpenCode),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/post-setup baseline/i);
    expect(runOpenCode).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(path.join(f.worktreePath, "README.md"), "utf8"),
    ).toBe("interrupted tracked edit\n");
    expect(
      fs.readFileSync(
        path.join(f.worktreePath, "untracked-agent-file"),
        "utf8",
      ),
    ).toBe("preserve me");
    expect(
      fs.readFileSync(
        path.join(f.worktreePath, "ignored-generated", "cache"),
        "utf8",
      ),
    ).toBe("keep");
  });

  it("keeps an unbound dispatch outcome ambiguous and preserves work without agent dispatch", async () => {
    const f = await fixture("true");
    const preservedPath = path.join(f.worktreePath, "existing-setup-output");
    fs.writeFileSync(preservedPath, "keep for operator recovery");
    const runOpenCode = vi.fn(async () => ({
      exitCode: 0,
      output: "",
      errorOutput: "",
    }));
    const commands = new CommandRunner(
      vi.fn(async () => {
        throw new Error("cannot establish whether the command was dispatched");
      }),
    );
    await expect(
      f.authority.run(() =>
        runRefinementCardWorkflow({
          trello: makeTrello(f.card),
          git: f.git,
          commands,
          openCode: new OpenCodeClient(runOpenCode),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/ambiguous/i);
    expect(runOpenCode).not.toHaveBeenCalled();
    expect(fs.readFileSync(preservedPath, "utf8")).toBe(
      "keep for operator recovery",
    );
    expect(stateFor(f.authority, f.card.id)).toMatchObject({
      status: "ambiguous",
      attempts: [
        { outcome: "ambiguous", after: expect.stringMatching(/^sha256:/u) },
      ],
    });
  });

  it("recovers a process that finished before the effects completion record was written", async () => {
    const f = await fixture("printf once > recovery-marker");
    const realGit = f.git;
    let branchRead = 0;
    const interruptedGit = Object.create(realGit) as GitClient;
    vi.spyOn(realGit, "getCurrentBranch");
    Object.defineProperty(interruptedGit, "getCurrentBranch", {
      value: async (cwd: string, signal?: AbortSignal) => {
        branchRead += 1;
        if (branchRead === 2) throw new Error("simulated parent interruption");
        return realGit.getCurrentBranch(cwd, signal);
      },
    });
    const trello = makeTrello(f.card);
    const initialOpenCode = vi.fn(async () => ({
      exitCode: 0,
      output: "",
      errorOutput: "",
    }));
    await expect(
      f.authority.run(() =>
        runRefinementCardWorkflow({
          trello,
          git: interruptedGit,
          commands: new CommandRunner(),
          openCode: new OpenCodeClient(initialOpenCode),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow(/after-effects\/result evidence/i);
    expect(initialOpenCode).not.toHaveBeenCalled();
    expect(stateFor(f.authority, f.card.id).status).toBe("active");
    expect(
      fs.readFileSync(path.join(f.worktreePath, "recovery-marker"), "utf8"),
    ).toBe("once");
    const attemptId = f.authority.store.read()!.attemptId;
    await lease!.release();
    lease = await acquireProjectOwnership(
      path.join(root, "coordination"),
      {
        trelloBoardId: f.project.trello.boardId,
        githubRepository: f.project.repository.github,
      },
      "setup-test",
    );
    const resumed = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: path.join(root, "coordination"),
    });
    const noDispatch = vi.fn(async () => {
      throw new Error("Finished setup must not be repeated");
    });
    const resumedOpenCode = vi.fn(async () => ({
      exitCode: 7,
      output: "",
      errorOutput: "expected regression sentinel",
    }));
    await expect(
      resumed.run(() =>
        runRefinementCardWorkflow({
          trello,
          git: realGit,
          commands: new CommandRunner(noDispatch),
          openCode: new OpenCodeClient(resumedOpenCode),
          project: f.project,
          card: f.card,
          signal: new AbortController().signal,
          preparedWorktree: {
            path: f.worktreePath,
            branch: `agent/${f.card.id}`,
          },
          prepareAttachmentContext: async () => undefined,
        }),
      ),
    ).rejects.toThrow("Refinement execution did not establish a stopped child");
    expect(noDispatch).not.toHaveBeenCalled();
    expect(resumedOpenCode).toHaveBeenCalledOnce();
    expect(stateFor(resumed, f.card.id)).toMatchObject({ status: "passed" });
  });
});
