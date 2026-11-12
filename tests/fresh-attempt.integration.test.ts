import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Config, ProjectConfig } from "../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import {
  verifyAndPinProjects,
  readProjectPinCandidates,
} from "../src/coordination/project-registry.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { runTaskResources } from "../src/task-session/task-resources.js";
import { GitClient } from "../src/git/git-client.js";
import { prepareWorktree } from "../src/git/prepare-worktree.js";
import { createIsolatedGitFixture } from "./support/isolated-git-fixture.js";
import { reconcilePinnedProjectAttempt } from "../src/startup/run-startup.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { RunRegistry, RunStore } from "../src/task-session/run-store.js";
import { runTaskSessionWorkflow } from "../src/orchestrator/run-task-session-workflow.js";
import type { TrelloClient } from "../src/trello/trello-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { returnClosedTaskSessionPullRequestToBacklog } from "../src/orchestrator/reconcile-terminal-task-session-pr.js";
import type { PullRequestState } from "../src/github/github-client.js";
import { assertTerminalArtifactIsolation } from "../src/git/terminal-artifact-isolation.js";

let root: string;
let lease: ProjectOwnershipLease;
afterEach(async () => {
  vi.restoreAllMocks();
  await lease?.release();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-attempt-"));
  const f = createIsolatedGitFixture(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(source);
  f.git(source, "init", "-b", "main");
  fs.writeFileSync(path.join(source, "accepted"), "first");
  f.git(source, "add", ".");
  f.git(source, "commit", "-m", "initial");
  f.git(root, "init", "--bare", remote);
  f.git(source, "remote", "add", "origin", remote);
  f.git(source, "push", "origin", "main");
  const coordinationRoot = path.join(root, "coordination");
  fs.mkdirSync(coordinationRoot);
  provisionCoordinationNamespace(coordinationRoot, "test");
  const project = {
    id: "project",
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      backlogListId: "backlog",
      failedListId: "failed",
      doneListId: "done",
    },
    repository: {
      github: "owner/repo",
      path: source,
      defaultBranch: "main",
      worktreeRoot: path.join(root, "worktrees"),
    },
  } as ProjectConfig;
  const config = {
    projects: [project],
    workflow: {
      coordinationRoot,
      coordinationNamespaceId: "test",
      contextRoot: path.join(root, "state"),
    },
  } as Config;
  lease = await acquireProjectOwnership(
    coordinationRoot,
    { trelloBoardId: "board", githubRepository: "owner/repo" },
    "test",
  );
  const pin = (await verifyAndPinProjects(config, [lease]))[0]!;
  const pinned: RunRecord["pinned"] = {
    integrationId: pin.integrationId,
    projectId: project.id,
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      backlog: "backlog",
      failed: "failed",
      done: "done",
    },
    repository: "owner/repo",
    repositoryPath: source,
    worktreeRoot: project.repository.worktreeRoot,
    storageRoot: pin.storageRoot,
  };
  const create = (taskKind: "refinement" | "implementation" = "refinement") =>
    ProjectRunAuthority.createPreparingAttempt({
      projectId: project.id,
      cardId: "card",
      taskKind,
      pinned,
      projectLease: lease,
      coordinationRoot,
    });
  const git = new GitClient(async (cwd, args) => f.git(cwd, ...args));
  return { f, git, config, project, pin, create, source };
}

it("preserves a failed attempt and starts a distinct clean attempt from current default", async () => {
  const f = await fixture();
  const previous = await f.create();
  previous.claim();
  const old = await previous.run(() => prepareWorktree(f.git, f.project, "card"));
  fs.writeFileSync(path.join(old.path, "unfinished"), "preserved");
  const now = new Date().toISOString();
  await previous.failRefinement({
    observationId: "failure",
    observedAt: now,
    trelloObservationId: "failed-readback",
    trelloVerifiedAt: now,
  });
  await previous.releaseVerifiedTerminal();
  fs.writeFileSync(path.join(f.source, "accepted"), "latest");
  f.f.git(f.source, "add", ".");
  f.f.git(f.source, "commit", "-m", "accepted update");
  f.f.git(f.source, "push", "origin", "main");
  const next = await f.create("implementation");
  expect(next.store.attemptId).not.toBe(previous.store.attemptId);
  expect(next.store.read()!.sessions).toEqual({});
  expect(
    next.run(() => new TaskExecutionStore(next.store.storageRoot, f.project).read("card")),
  ).toBeNull();
  const fresh = await next.run(() => prepareWorktree(f.git, f.project, "card"));
  expect(fresh).toMatchObject({
    ...runTaskResources(next.store.read()!),
    reused: false,
  });
  expect(fresh.path).not.toBe(old.path);
  expect(fresh.branch).not.toBe(old.branch);
  expect(fs.readFileSync(path.join(fresh.path, "accepted"), "utf8")).toBe("latest");
  expect(fs.existsSync(path.join(fresh.path, "unfinished"))).toBe(false);
  expect(fs.readFileSync(path.join(old.path, "unfinished"), "utf8")).toBe("preserved");
  expect(previous.store.read()!.lifecycle).toBe("failed");
  // Exercise the actual Ready dispatch on the new authority, not just a helper
  // constructing a desired worktree. Current card/attachments must be requested
  // before primary dispatch, with no old session/projection inherited.
  next.claim();
  Object.assign(f.project, { contextRoot: next.store.storageRoot });
  const card = {
    id: "card",
    name: "Clarified task",
    desc: "Current task",
    idList: "ready",
    idLabels: ["feature"],
    url: "https://trello.test/card",
  };
  let list = "ready";
  f.project.trello.featureLabelId = "feature";
  f.project.opencode = {
    refinement: {},
    implementation: {},
    review: {},
    remediation: { maxPasses: 1 },
    commit: {},
    timeoutMinutes: 1,
  };
  const boundary = new Error("current attachments requested");
  const attachments = vi.fn(async (current) => {
    expect(current.name).toBe("Clarified task");
    throw boundary;
  });
  await expect(
    next.run(() =>
      runTaskSessionWorkflow({
        project: f.project,
        trello: {
          getCards: async (id: string) => (id === list ? [{ ...card, idList: list }] : []),
          getCard: async () => ({ ...card, idList: list }),
          moveCard: async (_id: string, destination: string) => {
            list = destination;
            return { ...card, idList: list };
          },
        } as unknown as TrelloClient,
        git: f.git,
        github: {} as GitHubClient,
        openCode: new OpenCodeClient(vi.fn()),
        commands: new CommandRunner(),
        signal: new AbortController().signal,
        prepareAttachmentContext: attachments,
      }),
    ),
  ).rejects.toBe(boundary);
  expect(attachments).toHaveBeenCalledOnce();
  expect(
    next.run(() => new TaskExecutionStore(next.store.storageRoot, f.project).read("card"))
      ?.expectedBranch,
  ).toBe(fresh.branch);
});

it.each(["candidate", "pointer", "preparing"])(
  "recovers interruption at %s handoff without another writer",
  async (boundary) => {
    const f = await fixture();
    const previous = await f.create();
    previous.claim();
    const now = new Date().toISOString();
    await previous.failRefinement({
      observationId: "failure",
      observedAt: now,
      trelloObservationId: "failed-readback",
      trelloVerifiedAt: now,
    });
    await previous.releaseVerifiedTerminal();
    if (boundary === "preparing")
      vi.spyOn(RunStore.prototype, "create").mockImplementationOnce(() => {
        throw new Error("interrupted");
      });
    else {
      const handoff = RunRegistry.prototype.handoff;
      vi.spyOn(RunRegistry.prototype, "handoff").mockImplementationOnce(function (
        this: RunRegistry,
        ...args
      ) {
        if (boundary === "pointer") handoff.apply(this, args);
        throw new Error("interrupted");
      });
    }
    await expect(f.create()).rejects.toThrow("interrupted");
    vi.restoreAllMocks();
    const pin = (
      await readProjectPinCandidates(f.config.workflow.coordinationRoot!, f.project.id)
    )[0]!;
    const recovered = await reconcilePinnedProjectAttempt({ ...f, pin, lease });
    if (boundary === "preparing") expect(recovered!.attemptId).toBe(previous.store.attemptId);
    else {
      expect(recovered!.lifecycle).toBe("preparing");
      await expect(f.create()).rejects.toThrow(/occupying/);
    }
  },
);

it("keeps unknown repository ownership fenced rather than declaring isolation", async () => {
  const f = await fixture();
  const authority = await f.create("implementation");
  authority.claim();
  const worktree = await authority.run(() => prepareWorktree(f.git, f.project, "card"));
  vi.spyOn(f.git, "getCommonGitDirectory").mockImplementation(async (cwd) =>
    cwd === worktree.path ? "/unknown/common" : "/owned/common",
  );
  await expect(
    authority.run(() => assertTerminalArtifactIsolation(f.project, f.git)),
  ).rejects.toThrow("ambiguous repository identity");
  await expect(f.create()).rejects.toThrow("occupying");
  expect(fs.existsSync(worktree.path)).toBe(true);
});

it("does not adopt a pre-existing matching worktree merely because its name was planned", async () => {
  const f = await fixture();
  const authority = await f.create("implementation");
  authority.claim();
  const resource = runTaskResources(authority.store.read()!);
  f.f.git(f.source, "worktree", "add", "-b", resource.branch, resource.path);
  await expect(authority.run(() => prepareWorktree(f.git, f.project, "card"))).rejects.toThrow(
    "creation provenance",
  );
  await expect(
    authority.run(() => assertTerminalArtifactIsolation(f.project, f.git)),
  ).rejects.toThrow("creation provenance");
  expect(fs.existsSync(resource.path)).toBe(true);
});

it.each(["ignored", "history-unavailable"])(
  "preserves isolated terminal resources when cleanup is unsafe: %s",
  async (reason) => {
    const f = await fixture();
    const authority = await f.create("implementation");
    authority.claim();
    const worktree = await authority.run(() => prepareWorktree(f.git, f.project, "card"));
    if (reason === "ignored") {
      fs.writeFileSync(path.join(worktree.path, ".gitignore"), "setup-output\n");
      f.f.git(worktree.path, "add", ".gitignore");
      f.f.git(worktree.path, "commit", "-m", "ignore output");
      fs.writeFileSync(path.join(worktree.path, "setup-output"), "preserve me");
    }
    const head = f.f.git(worktree.path, "rev-parse", "HEAD");
    const remove = vi.spyOn(f.git, "removeWorktree");
    await authority.run(() =>
      returnClosedTaskSessionPullRequestToBacklog({
        project: f.project,
        git: f.git,
        trello: {
          moveCard: async () => undefined,
          addComment: async () => undefined,
        } as unknown as TrelloClient,
        github: {
          getPullRequestCommitShas: async () => {
            if (reason === "history-unavailable") throw new Error("outage");
            return [head];
          },
        } as unknown as GitHubClient,
        card: {
          id: "card",
          idList: "review",
          name: "Task",
          desc: "",
          idLabels: [],
          url: "https://trello.test/card",
        },
        pullRequest: {
          state: "CLOSED",
          mergedAt: null,
          headRefOid: head,
          url: "https://github.com/owner/repo/pull/1",
        } as PullRequestState,
        signal: new AbortController().signal,
      }),
    );
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(worktree.path)).toBe(true);
    if (reason === "ignored")
      expect(fs.readFileSync(path.join(worktree.path, "setup-output"), "utf8")).toBe("preserve me");
  },
);
