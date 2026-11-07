import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../src/task-session/run-store.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TrelloClient } from "../src/trello/trello-client.js";
import {
  GitHubClient,
  type RunGitHubCommand,
} from "../src/github/github-client.js";
import { GitClient } from "../src/git/git-client.js";
import {
  WorkflowMutationWaitingError,
  withJournaledDispatch,
} from "../src/task-session/workflow-mutation.js";
import type { MutationIntent } from "../src/task-session/durable-mutation.js";
import { reconcileWorkflowMutations } from "../src/orchestrator/reconcile-workflow-mutations.js";
import type { ProjectConfig } from "../src/config/config.js";
import { finalizeRefinement } from "../src/refinement/finalize-refinement.js";
import { GitHubCredentialProvider } from "../src/github/github-credential-provider.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(refinement = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-mutations-"));
  roots.push(root);
  const pinned: RunRecord["pinned"] = {
    integrationId: "integration",
    projectId: "p",
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      done: "done",
      backlog: "backlog",
      failed: "failed",
    },
    repository: "owner/repo",
    repositoryPath: path.join(root, "repo"),
    worktreeRoot: path.join(root, "work"),
    storageRoot: path.join(root, "state"),
  };
  const lease = {
    integrationId: "integration",
    instanceId: "instance",
    token: "lease",
    assertHeld() {},
  };
  const open = () => new RunStore(pinned.storageRoot, "attempt", pinned, lease);
  const store = open();
  const url = "https://github.com/owner/repo/pull/1";
  store.create({
    version: 1,
    revision: 1,
    projectId: "p",
    cardId: "card",
    attemptId: "attempt",
    taskKind: refinement ? "refinement" : "implementation",
    pinned,
    lifecycle: refinement ? "refinement" : "human-review",
    checkpoint: refinement ? "refinement" : "human-review",
    publicationState: refinement ? "none" : "open",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, since: null, dependency: null, retryAt: null },
    owner: { instanceId: "instance", token: "lease", generation: 1 },
    resources: [
      { kind: "pull-request", id: "1", path: url, provenance: "test-observed" },
      {
        kind: "branch",
        id: "card",
        path: "refs/heads/agent/card",
        provenance: "test-owned",
      },
      {
        kind: "worktree",
        id: "card",
        path: path.join(pinned.worktreeRoot, "card"),
        provenance: "test-owned",
      },
    ],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: [],
    expectedTrelloListId: "review",
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {},
    compatibility: {},
    updatedAt: new Date().toISOString(),
  });
  let authority = new ProjectRunAuthority("p", store, 1);
  const project = {
    id: "p",
    repository: {
      path: pinned.repositoryPath,
      worktreeRoot: pinned.worktreeRoot,
      github: pinned.repository,
      defaultBranch: "main",
    },
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      backlogListId: "backlog",
      failedListId: "failed",
      doneListId: "done",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
      refinementLabelId: "refinement",
    },
  } as ProjectConfig;
  const trello = new TrelloClient({ apiKey: "key", token: "token" });
  const github = new GitHubClient();
  const git = new GitClient();
  const card = {
    id: "card",
    idBoard: "board",
    name: "Task",
    desc: "Description",
    idList: "review",
    idLabels: refinement ? ["refinement"] : ["feature"],
    url: "https://trello.com/c/card",
    dueComplete: false,
  };
  const comments: { id: string; text: string }[] = [];
  const ledger: string[] = [];
  let late: (() => void) | undefined;
  let delay = false;
  let wrongMove = false;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    ledger.push(`${method}:${url.pathname}`);
    if (method === "GET" && url.pathname === "/1/cards/card")
      return Response.json(card);
    if (method === "GET" && url.pathname === "/1/boards/board/labels")
      return Response.json(
        ["feature", "improvement", "bug", "refinement"].map((id) => ({
          id,
          name: id,
          color: null,
        })),
      );
    if (method === "GET" && url.pathname.endsWith("/actions"))
      return Response.json(
        comments.map((comment) => ({
          id: comment.id,
          type: "commentCard",
          data: { text: comment.text },
        })),
      );
    if (method === "PUT") {
      const fields = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!wrongMove) Object.assign(card, fields);
      ledger.push("accepted:fields");
      return Response.json({ ...card, ...fields }); // a success-shaped lie is not readback
    }
    if (method === "POST" && url.pathname.endsWith("/comments")) {
      const text = url.searchParams.get("text")!;
      const accept = () => {
        comments.push({ id: `comment-${comments.length + 1}`, text });
        ledger.push("accepted:comment");
      };
      if (delay) {
        late = accept;
        throw new Error("acknowledgment lost while still in flight");
      }
      accept();
      return Response.json({
        id: "comment-1",
        type: "commentCard",
        date: new Date().toISOString(),
      });
    }
    if (method === "POST" && url.pathname.endsWith("/idLabels")) {
      card.idLabels.push(url.searchParams.get("value")!);
      return Response.json({});
    }
    if (method === "DELETE") {
      card.idLabels = card.idLabels.filter(
        (id) => !url.pathname.endsWith(`/${id}`),
      );
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unhandled fixture request ${method} ${url.pathname}`);
  });
  const run = <T>(fn: () => T) => authority.run(fn);
  const reconcile = () =>
    run(() => reconcileWorkflowMutations({ project, trello, github, git }));
  const tick = () => vi.setSystemTime(Date.now() + 15_001);
  return {
    root,
    store,
    pinned,
    project,
    trello,
    github,
    git,
    card,
    comments,
    ledger,
    url,
    run,
    reconcile,
    tick,
    restart: () => {
      authority = new ProjectRunAuthority("p", open(), 1);
    },
    authority: () => authority,
    delay: () => {
      delay = true;
    },
    acceptLate: () => late!(),
    wrongMove: () => {
      wrongMove = true;
    },
  };
}

function intent(
  f: ReturnType<typeof fixture>,
  id: string,
  kind: MutationIntent["kind"],
  target: string,
  payload: unknown,
  dispatch = false,
) {
  const reference = f.store.writeArtifact(
    Buffer.from(JSON.stringify(payload)),
    "application/json",
  );
  f.store.referenceMutationArtifact(f.store.read()!.revision, 1, reference);
  f.store.persistMutationIntent(
    f.store.read()!.revision,
    1,
    id,
    { kind, target, payloadId: reference.id, correlationId: `attempt:${id}` },
    new Date().toISOString(),
  );
  if (dispatch)
    f.store.recordMutationEvent(
      f.store.read()!.revision,
      1,
      id,
      1,
      {
        type: "dispatch",
        nextRecheckAt: new Date(Date.now() + 15_000).toISOString(),
      },
      new Date().toISOString(),
    );
}

function realGit(f: ReturnType<typeof fixture>) {
  fs.mkdirSync(f.pinned.repositoryPath);
  fs.mkdirSync(f.pinned.worktreeRoot);
  const command = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const source = f.pinned.repositoryPath;
  const cwd = path.join(f.pinned.worktreeRoot, "card");
  const remote = path.join(f.root, "remote.git");
  const destination = "https://github.com/owner/repo.git";
  command(source, "init", "-b", "main");
  command(source, "config", "user.name", "Test");
  command(source, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(source, "app"), "original\n");
  command(source, "add", "app");
  command(source, "commit", "-m", "Initial");
  const parent = command(source, "rev-parse", "HEAD");
  command(source, "init", "--bare", remote);
  command(source, "remote", "add", "origin", remote);
  command(source, "push", "origin", "main");
  command(source, "remote", "set-url", "origin", destination);
  command(source, "worktree", "add", "-b", "agent/card", cwd);
  const execute = (repository: string, args: string[]) =>
    command(
      repository,
      ...args.map((arg) =>
        ["push", "fetch", "ls-remote"].includes(args[0]!) && arg === destination
          ? remote
          : arg,
      ),
    );
  return { command, execute, cwd, source, remote, destination, parent };
}

describe("production workflow client journal", () => {
  it("revokes an already-consumed method before a delayed unawaited transport can send", async () => {
    const f = fixture();
    intent(
      f,
      "initial:pr",
      "github-pr-create",
      "owner/repo",
      {
        base: "main",
        head: "agent/card",
        title: "Task",
        body: "Exact",
        draft: true,
      },
      true,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const credentials = new GitHubCredentialProvider();
    vi.spyOn(credentials, "resolve").mockImplementation(async () => {
      await gate;
      return { mode: "ambient", environment: {}, secretValues: [] };
    });
    const transport = vi.fn<RunGitHubCommand>(
      async () => "https://github.com/owner/repo/pull/2",
    );
    const github = new GitHubClient(transport, credentials);
    let unawaited!: Promise<unknown>;
    await f.run(() =>
      withJournaledDispatch(f.authority(), "initial:pr", async () => {
        unawaited = github.createPullRequest({
          cwd: path.join(f.pinned.worktreeRoot, "card"),
          repository: "owner/repo",
          baseBranch: "main",
          headBranch: "agent/card",
          title: "Task",
          body: "Exact",
          draft: true,
          project: f.project,
        });
      }),
    );
    const rejected = expect(unawaited).rejects.toThrow("transport capability");
    release();
    await rejected;
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires live durable dispatch proof at activation and rechecks it at consumption", async () => {
    const f = fixture();
    const authority = f.authority();
    await expect(
      f.run(() =>
        withJournaledDispatch(authority, "missing", async () =>
          f.trello.addComment("card", "Not authorized"),
        ),
      ),
    ).rejects.toThrow("durable dispatch");
    intent(f, "initial:comment", "trello-comment", "card", {
      text: "Original",
    });
    await expect(
      f.run(() =>
        withJournaledDispatch(authority, "initial:comment", async () =>
          f.trello.addComment("card", "Original"),
        ),
      ),
    ).rejects.toThrow("durable dispatch");
    f.store.recordMutationEvent(
      f.store.read()!.revision,
      1,
      "initial:comment",
      1,
      {
        type: "dispatch",
        nextRecheckAt: new Date(Date.now() + 15_000).toISOString(),
      },
      new Date().toISOString(),
    );
    await f.run(() =>
      withJournaledDispatch(authority, "initial:comment", async () => {
        const reference = f.store.writeArtifact(
          Buffer.from("accepted response"),
          "text/plain",
        );
        f.store.referenceMutationArtifact(
          f.store.read()!.revision,
          1,
          reference,
        );
        f.store.recordMutationEvent(
          f.store.read()!.revision,
          1,
          "initial:comment",
          1,
          {
            type: "response",
            outcome: "accepted",
            evidence: {
              observationId: "response",
              observedAt: new Date().toISOString(),
              artifactId: reference.id,
            },
          },
          new Date().toISOString(),
        );
        await expect(
          Promise.resolve().then(() => f.trello.addComment("card", "Original")),
        ).rejects.toThrow("Stale");
      }),
    );
    expect(f.ledger).toHaveLength(0);
  });

  it("captures authorized T2 commit bytes instead of reopening the caller's mutable message file", async () => {
    const f = fixture();
    const g = realGit(f);
    fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
    g.command(g.cwd, "add", "app");
    const identity = { name: "Test", email: "test@example.com" };
    const message = "Authorized commit\n";
    intent(
      f,
      "initial:commit",
      "git-commit",
      "refs/heads/agent/card",
      {
        parent: g.parent,
        tree: g.command(g.cwd, "write-tree"),
        message,
        identity,
        cleanup: "verbatim",
      },
      true,
    );
    const messagePath = path.join(f.root, "mutable-message");
    fs.writeFileSync(messagePath, message);
    let commits = 0;
    const git = new GitClient(async (cwd, args) => {
      if (args.includes("commit")) {
        commits++;
        expect(args[args.indexOf("-F") + 1]).not.toBe(messagePath);
        fs.writeFileSync(messagePath, "Unauthorized mutation\n");
      }
      return g.execute(cwd, args);
    });
    await f.run(() =>
      withJournaledDispatch(f.authority(), "initial:commit", async () =>
        git.commit(g.cwd, messagePath, identity, "verbatim"),
      ),
    );
    expect(commits).toBe(1);
    expect(g.command(g.cwd, "log", "-1", "--format=%B")).toBe(message.trim());
  });
  it("limits a valid T2 dispatch to its exact authority/card/route/payload and one use", async () => {
    const f = fixture();
    const authority = f.authority();
    intent(
      f,
      "initial:comment",
      "trello-comment",
      "card",
      { text: "Original publication" },
      true,
    );
    const transport = vi.fn<RunGitHubCommand>(
      async () => "https://github.com/owner/repo/pull/2",
    );
    const github = new GitHubClient(transport);
    const pr = {
      cwd: f.pinned.repositoryPath,
      repository: "owner/repo",
      headBranch: "agent/card",
      baseBranch: "main",
      title: "Task",
      body: "Body",
      project: f.project,
    };
    let release!: () => void;
    let escaped!: Promise<unknown>;
    await f.run(() =>
      withJournaledDispatch(authority, "initial:comment", async () => {
        await expect(
          Promise.resolve().then(() =>
            f.trello.addComment("other-card", "Original publication"),
          ),
        ).rejects.toThrow("capability");
        await expect(
          Promise.resolve().then(() =>
            f.trello.addComment("card", "Changed payload"),
          ),
        ).rejects.toThrow("capability");
        await expect(
          Promise.resolve().then(() => f.trello.moveCard("card", "working")),
        ).rejects.toThrow("capability");
        await expect(github.createPullRequest(pr)).rejects.toThrow(
          "capability",
        );
        await expect(
          github.createPullRequest({ ...pr, repository: "elsewhere/repo" }),
        ).rejects.toThrow("capability");
        await expect(
          github.createPullRequest({
            ...pr,
            project: { ...f.project, id: "different-project" },
          }),
        ).rejects.toThrow("authority mismatch");
        await expect(
          withJournaledDispatch(authority, "initial:comment", async () => {}),
        ).rejects.toThrow("Nested");
        await expect(f.git.stageAll("unrelated-repository")).rejects.toThrow(
          "forbidden",
        );
        await expect(f.git.resetHard("unrelated-repository")).rejects.toThrow(
          "forbidden",
        );
        await expect(
          f.git.createRefIfAbsent(
            "unrelated-repository",
            "refs/heads/other",
            "a".repeat(40),
          ),
        ).rejects.toThrow("forbidden");
        await expect(
          f.git.fetch("unrelated-repository", "unrelated-remote", "other"),
        ).rejects.toThrow("forbidden");
        expect(f.ledger).toHaveLength(0);
        expect(transport).not.toHaveBeenCalled();
        await f.trello.addComment("card", "Original publication");
        await expect(
          Promise.resolve().then(() =>
            f.trello.addComment("card", "Original publication"),
          ),
        ).rejects.toThrow("consumed");
        escaped = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => f.trello.addComment("card", "Original publication"));
      }),
    );
    release();
    await expect(escaped).rejects.toThrow("capability");
    await expect(
      f.run(() =>
        withJournaledDispatch(authority, "initial:comment", async () =>
          f.trello.addComment("card", "Original publication"),
        ),
      ),
    ).rejects.toThrow("already issued");
    expect(f.comments).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not broaden a T2 PR-creation capability to another repo/project/head/body or fields", async () => {
    const f = fixture();
    const authority = f.authority();
    const cwd = path.join(f.pinned.worktreeRoot, "card");
    intent(
      f,
      "initial:pr",
      "github-pr-create",
      "owner/repo",
      {
        base: "main",
        head: "agent/card",
        title: "Task",
        body: "Exact body",
        draft: true,
      },
      true,
    );
    const transport = vi.fn<RunGitHubCommand>(
      async () => "https://github.com/owner/repo/pull/2",
    );
    const github = new GitHubClient(transport);
    const input = {
      cwd,
      repository: "owner/repo",
      headBranch: "agent/card",
      baseBranch: "main",
      title: "Task",
      body: "Exact body",
      draft: true,
      project: f.project,
    };
    await f.run(() =>
      withJournaledDispatch(authority, "initial:pr", async () => {
        for (const changed of [
          { repository: "elsewhere/repo" },
          { cwd: "/unrelated" },
          { headBranch: "agent/other" },
          { baseBranch: "other" },
          { title: "Other" },
          { body: "Other" },
          { draft: false },
        ]) {
          await expect(
            github.createPullRequest({ ...input, ...changed }),
          ).rejects.toThrow("capability");
        }
        const otherAuthority = new ProjectRunAuthority("p", f.store, 1);
        await expect(
          otherAuthority.run(() => github.createPullRequest(input)),
        ).rejects.toThrow("capability");
        expect(transport).not.toHaveBeenCalled();
        const authorized = github.createPullRequest(input);
        input.body = "Changed after capability consumption";
        input.repository = "elsewhere/repo";
        await authorized;
        await expect(
          github.ensurePullRequestDraft({
            cwd,
            repository: "owner/repo",
            pullRequestUrl: f.url,
            project: f.project,
          }),
        ).rejects.toThrow("consumed");
      }),
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![1]).toContain("Exact body");
    expect(transport.mock.calls[0]![1]).toContain("owner/repo");
    expect(transport.mock.calls[0]![1]).not.toContain("elsewhere/repo");
  });

  it("discovers accepted noninitial push after restart with original payload and one immutable refspec", async () => {
    const f = fixture();
    const g = realGit(f);
    fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
    g.command(g.cwd, "add", "app");
    g.command(g.cwd, "commit", "-m", "Intended");
    const sha = g.command(g.cwd, "rev-parse", "HEAD");
    let pushes = 0;
    const git = new GitClient(async (cwd, args) => {
      const output = g.execute(cwd, args);
      if (args[0] === "push") {
        pushes++;
        throw new Error("accepted immutable push, response lost");
      }
      return output;
    });
    await expect(
      f.run(() => git.push(g.cwd, "origin", "agent/card", f.project)),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.restart();
    f.tick();
    await f.run(() =>
      reconcileWorkflowMutations({
        project: f.project,
        trello: f.trello,
        github: f.github,
        git,
      }),
    );
    expect(pushes).toBe(1);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    expect(
      g.command(g.source, "ls-remote", g.remote, "refs/heads/agent/card"),
    ).toBe(`${sha}\trefs/heads/agent/card`);
  });

  it.each(["switched", "detached"] as const)(
    "refuses commit transport when task branch is %s between intent and dispatch",
    async (race) => {
      const f = fixture();
      const g = realGit(f);
      fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
      g.command(g.cwd, "add", "app");
      const request = {
        route: "git-commit",
        args: {
          cwd: g.cwd,
          branch: "agent/card",
          parent: g.parent,
          tree: g.command(g.cwd, "write-tree"),
          message: "Intended\n",
          identity: { name: "Test", email: "test@example.com" },
        },
      };
      intent(
        f,
        "workflow:commit-race",
        "git-commit",
        "git:agent/card",
        request,
      );
      if (race === "switched") g.command(g.cwd, "checkout", "-b", "other");
      else g.command(g.cwd, "checkout", "--detach", g.parent);
      let commits = 0;
      const git = new GitClient(async (cwd, args) => {
        if (args.includes("commit")) commits++;
        return g.execute(cwd, args);
      });
      await f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          github: f.github,
          git,
        }),
      );
      expect(commits).toBe(0);
      expect(g.command(g.cwd, "rev-parse", "HEAD")).toBe(g.parent);
      f.restart();
      f.tick();
      await f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          github: f.github,
          git,
        }),
      );
      expect(f.store.read()!.pendingOperations[0]!.status).not.toBe(
        "completed",
      );
      expect(commits).toBe(0);
    },
  );

  it.each(["switched", "detached", "ref-changed"] as const)(
    "refuses noninitial push when task branch is %s between intent and dispatch",
    async (race) => {
      const f = fixture();
      const g = realGit(f);
      fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
      g.command(g.cwd, "add", "app");
      g.command(g.cwd, "commit", "-m", "Intended");
      const sha = g.command(g.cwd, "rev-parse", "HEAD");
      const request = {
        route: "git-push",
        args: {
          cwd: g.cwd,
          branch: "agent/card",
          sha,
          destination: g.destination,
          fetch: g.destination,
        },
      };
      intent(
        f,
        "workflow:push-race",
        "git-push",
        `git:${g.destination}:agent/card`,
        request,
      );
      if (race === "switched") g.command(g.cwd, "checkout", "-b", "other");
      if (race === "detached") g.command(g.cwd, "checkout", "--detach", sha);
      let changeRef = race === "ref-changed";
      const mutations: string[][] = [];
      const git = new GitClient(async (cwd, args) => {
        if (args[0] === "push") mutations.push(args);
        const output = g.execute(cwd, args);
        if (changeRef && args[0] === "branch" && args[1] === "--show-current") {
          changeRef = false;
          g.command(g.cwd, "update-ref", "refs/heads/agent/card", g.parent);
        }
        return output;
      });
      await f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          github: f.github,
          git,
        }),
      );
      expect(mutations).toHaveLength(0);
      expect(
        g.command(g.source, "ls-remote", g.remote, "refs/heads/agent/card"),
      ).toBe("");
      f.restart();
      f.tick();
      await f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          github: f.github,
          git,
        }),
      );
      expect(f.store.read()!.pendingOperations[0]!.status).not.toBe(
        "completed",
      );
      expect(mutations).toHaveLength(0);
    },
  );

  it("pushes the immutable intended SHA even if the task ref moves after the final check", async () => {
    const f = fixture();
    const g = realGit(f);
    fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
    g.command(g.cwd, "add", "app");
    g.command(g.cwd, "commit", "-m", "Intended");
    const sha = g.command(g.cwd, "rev-parse", "HEAD");
    g.command(g.cwd, "config", "push.followTags", "true");
    g.command(
      g.cwd,
      "tag",
      "-a",
      "unintended-tag",
      "-m",
      "Do not publish this tag",
      sha,
    );
    const sent: string[][] = [];
    const git = new GitClient(async (cwd, args) => {
      if (args[0] === "push") {
        sent.push(args);
        expect(args).toEqual([
          "push",
          "--no-follow-tags",
          g.destination,
          `${sha}:refs/heads/agent/card`,
        ]);
        g.command(g.cwd, "update-ref", "refs/heads/agent/card", g.parent);
      }
      return g.execute(cwd, args);
    });
    await f.run(() => git.push(g.cwd, "origin", "agent/card", f.project));
    expect(sent).toHaveLength(1);
    expect(
      g.command(g.source, "ls-remote", g.remote, "refs/heads/agent/card"),
    ).toBe(`${sha}\trefs/heads/agent/card`);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    expect(
      g.command(g.source, "ls-remote", g.remote, "refs/tags/unintended-tag"),
    ).toBe("");
    expect(g.command(g.cwd, "rev-parse", "refs/heads/agent/card")).toBe(
      g.parent,
    );
  });

  it.each(["switched", "detached", "wrong-task-ref"] as const)(
    "does not falsely complete accepted commit discovery from %s HEAD after restart",
    async (race) => {
      const f = fixture();
      const g = realGit(f);
      fs.writeFileSync(path.join(g.cwd, "app"), "intended\n");
      g.command(g.cwd, "add", "app");
      const messagePath = path.join(f.root, "message");
      fs.writeFileSync(messagePath, "Exact commit\n");
      let commits = 0;
      const git = new GitClient(async (cwd, args) => {
        if (!args.includes("commit")) return g.execute(cwd, args);
        commits++;
        g.execute(cwd, args);
        const sha = g.command(g.cwd, "rev-parse", "HEAD");
        if (race === "switched") g.command(g.cwd, "checkout", "-b", "other");
        else g.command(g.cwd, "checkout", "--detach", sha);
        if (race === "wrong-task-ref")
          g.command(g.cwd, "update-ref", "refs/heads/agent/card", g.parent);
        throw new Error("accepted then HEAD changed, acknowledgment lost");
      });
      await expect(
        f.run(() =>
          git.commit(g.cwd, messagePath, {
            name: "Test",
            email: "test@example.com",
          }),
        ),
      ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
      const actual = g.command(g.cwd, "rev-parse", "HEAD");
      f.restart();
      f.tick();
      await f.reconcile();
      expect(f.store.read()!.pendingOperations[0]!.status).not.toBe(
        "completed",
      );
      expect(commits).toBe(1);
      expect(g.command(g.cwd, "rev-parse", "HEAD")).toBe(actual);
      expect(
        g.command(g.source, "ls-remote", g.remote, "refs/heads/agent/card"),
      ).toBe("");
    },
  );
  it("discovers an accepted owned-worktree creation without a second branch creation", async () => {
    const f = fixture();
    fs.mkdirSync(f.pinned.repositoryPath);
    fs.mkdirSync(f.pinned.worktreeRoot);
    const command = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    command(f.pinned.repositoryPath, "init", "-b", "main");
    command(f.pinned.repositoryPath, "config", "user.name", "Test");
    command(
      f.pinned.repositoryPath,
      "config",
      "user.email",
      "test@example.com",
    );
    fs.writeFileSync(path.join(f.pinned.repositoryPath, "app"), "initial\n");
    command(f.pinned.repositoryPath, "add", "app");
    command(f.pinned.repositoryPath, "commit", "-m", "Initial");
    const start = command(f.pinned.repositoryPath, "rev-parse", "HEAD");
    const worktree = path.join(f.pinned.worktreeRoot, "card");
    let creations = 0;
    const git = new GitClient(async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        expect(
          f.store.read()!.pendingOperations[0]!.mutation!.dispatches,
        ).toHaveLength(1);
        creations++;
        command(cwd, ...args);
        throw new Error("creation accepted without acknowledgment");
      }
      return command(cwd, ...args);
    });
    await expect(
      f.run(() =>
        git.addWorktreeWithNewBranch(
          f.pinned.repositoryPath,
          worktree,
          "agent/card",
          "main",
        ),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.restart();
    f.tick();
    await f.reconcile();
    expect(creations).toBe(1);
    expect(command(worktree, "rev-parse", "HEAD")).toBe(start);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
  });

  it("binds an exact review reply in its intended thread, never a marker in another thread", async () => {
    const f = fixture();
    let pending = "";
    let sends = 0;
    const comments = new Map<string, { databaseId: number; body: string }[]>([
      ["target", []],
      ["other", []],
    ]);
    const github = new GitHubClient(async (_cwd, args) => {
      if (args.some((arg) => arg.includes("mutation($threadId"))) {
        sends++;
        pending = args.find((arg) => arg.startsWith("body="))!.slice(5);
        throw new Error("reply still in flight");
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [...comments].map(([id, entries]) => ({
                  id,
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: entries.map((comment) => ({
                      ...comment,
                      author: { login: "bot" },
                      path: null,
                      line: null,
                      originalLine: null,
                      diffHunk: null,
                      pullRequestReview: { databaseId: 9 },
                    })),
                    pageInfo: { hasNextPage: false },
                  },
                })),
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      });
    });
    vi.spyOn(github, "getPullRequestStateByNumber").mockResolvedValue({
      state: "OPEN",
    } as Awaited<ReturnType<GitHubClient["getPullRequestStateByNumber"]>>);
    const reconcile = () =>
      f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          git: f.git,
          github,
        }),
      );
    await expect(
      f.run(() =>
        github.replyToReviewThread({
          cwd: f.pinned.repositoryPath,
          repository: "owner/repo",
          pullRequestUrl: f.url,
          project: f.project,
          threadId: "target",
          body: "Evidence-bound correction",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.tick();
    await reconcile();
    expect(sends).toBe(1);
    comments.get("other")!.push({ databaseId: 99, body: pending });
    f.restart();
    f.tick();
    await reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    comments
      .get("target")!
      .push({ databaseId: 100, body: `Wrong text\n${pending}` });
    f.tick();
    await reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    comments.set("target", [{ databaseId: 100, body: pending }]);
    f.tick();
    await reconcile();
    expect(
      f.store.read()!.pendingOperations[0]!.mutation!.observations.at(-1)!
        .resourceId,
    ).toBe("100");
    expect(sends).toBe(1);
  });
  it("discovers an accepted correction commit after restart without a second commit", async () => {
    const f = fixture();
    fs.mkdirSync(f.pinned.repositoryPath);
    fs.mkdirSync(f.pinned.worktreeRoot);
    const command = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    command(f.pinned.repositoryPath, "init", "-b", "main");
    command(f.pinned.repositoryPath, "config", "user.name", "Test");
    command(
      f.pinned.repositoryPath,
      "config",
      "user.email",
      "test@example.com",
    );
    fs.writeFileSync(path.join(f.pinned.repositoryPath, "app"), "initial\n");
    command(f.pinned.repositoryPath, "add", "app");
    command(f.pinned.repositoryPath, "commit", "-m", "Initial");
    const worktree = path.join(f.pinned.worktreeRoot, "card");
    command(
      f.pinned.repositoryPath,
      "worktree",
      "add",
      "-b",
      "agent/card",
      worktree,
    );
    fs.writeFileSync(path.join(worktree, "app"), "correction\n");
    command(worktree, "add", "app");
    const message = path.join(f.root, "message");
    fs.writeFileSync(message, "Correct task\n\nExact evidence.  \n");
    let commits = 0;
    const git = new GitClient(async (cwd, args) => {
      if (args.includes("commit")) {
        expect(
          f.store.read()!.pendingOperations.at(-1)!.mutation!.dispatches,
        ).toHaveLength(1);
        commits++;
        command(cwd, ...args);
        throw new Error("accepted commit, lost acknowledgment");
      }
      return command(cwd, ...args);
    });
    await expect(
      f.run(() =>
        git.commit(worktree, message, {
          name: "Test",
          email: "test@example.com",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    const sha = command(worktree, "rev-parse", "HEAD");
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    f.restart();
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    expect(command(worktree, "rev-parse", "HEAD")).toBe(sha);
    expect(commits).toBe(1);
    expect(command(worktree, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("journals cleanup before removal and independently discovers accepted removal after restart", async () => {
    const f = fixture();
    fs.mkdirSync(f.pinned.repositoryPath);
    fs.mkdirSync(f.pinned.worktreeRoot);
    const command = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    command(f.pinned.repositoryPath, "init", "-b", "main");
    command(f.pinned.repositoryPath, "config", "user.name", "Test");
    command(
      f.pinned.repositoryPath,
      "config",
      "user.email",
      "test@example.com",
    );
    fs.writeFileSync(path.join(f.pinned.repositoryPath, "app"), "preserved\n");
    command(f.pinned.repositoryPath, "add", "app");
    command(f.pinned.repositoryPath, "commit", "-m", "Initial");
    const worktree = path.join(f.pinned.worktreeRoot, "card");
    command(
      f.pinned.repositoryPath,
      "worktree",
      "add",
      "-b",
      "agent/card",
      worktree,
    );
    let removals = 0;
    const git = new GitClient(async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        expect(
          f.store.read()!.pendingOperations[0]!.mutation!.dispatches,
        ).toHaveLength(1);
        removals++;
        command(cwd, ...args);
        throw new Error("accepted removal, lost acknowledgment");
      }
      return command(cwd, ...args);
    });
    await expect(
      f.run(() => git.removeWorktree(f.pinned.repositoryPath, worktree)),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    expect(fs.existsSync(worktree)).toBe(false);
    await expect(f.authority().releaseVerifiedTerminal()).rejects.toThrow();
    f.restart();
    f.tick();
    await f.reconcile();
    expect(removals).toBe(1);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    expect(command(f.pinned.repositoryPath, "show", "agent/card:app")).toBe(
      "preserved",
    );
    await expect(
      f.run(() =>
        git.removeWorktree(
          f.pinned.repositoryPath,
          path.join(f.root, "unknown"),
        ),
      ),
    ).rejects.toThrow("not owned");
    expect(removals).toBe(1);
  });
  it("retains a late Trello comment through negative reads/restart without another request", async () => {
    const f = fixture();
    f.delay();
    await expect(
      f.run(() => f.trello.addComment("card", "Outcome")),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    const reads = f.ledger.length;
    await f.reconcile();
    expect(f.ledger).toHaveLength(reads);
    f.tick();
    await f.reconcile();
    expect(f.comments).toHaveLength(0);
    f.restart();
    f.acceptLate();
    f.tick();
    await f.reconcile();
    expect(f.comments).toHaveLength(1);
    expect(
      f.ledger.filter((item) => item === "POST:/1/cards/card/actions/comments"),
    ).toHaveLength(1);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    await f.run(() => f.trello.addComment("card", "Outcome"));
    expect(f.comments).toHaveLength(1);
  });

  it("retries only a concretely rejected Trello write at a paced dispatch generation", async () => {
    const f = fixture();
    const service = globalThis.fetch;
    let rejected = false;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST" && !rejected) {
        rejected = true;
        return new Response("rejected", { status: 400 });
      }
      return service(input, init);
    });
    await expect(
      f.run(() => f.trello.addComment("card", "Outcome")),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    expect(
      f.store.read()!.pendingOperations[0]!.mutation!.dispatches[0]!.response!
        .outcome,
    ).toBe("not-delivered");
    await f.reconcile();
    expect(f.comments).toHaveLength(0);
    f.restart();
    f.tick();
    await f.reconcile();
    expect(f.comments).toHaveLength(1);
    expect(
      f.store.read()!.pendingOperations[0]!.mutation!.dispatches,
    ).toHaveLength(2);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
  });

  it("reconciles a dispatched comment after terminal observation but blocks release and all new writes", async () => {
    const f = fixture();
    f.delay();
    await expect(
      f.run(() => f.trello.addComment("card", "Terminal explanation")),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    const current = f.store.read()!;
    const now = new Date().toISOString();
    f.store.transition(
      current.revision,
      1,
      null,
      "merged",
      "human-review",
      "done",
      (run) => run,
      {
        prOutcome: "merged",
        prObservationId: "pr-1",
        prVerifiedAt: now,
        trelloListId: "done",
        trelloObservationId: "card",
        trelloVerifiedAt: now,
      },
    );
    await expect(f.authority().releaseVerifiedTerminal()).rejects.toThrow(
      "synchronization",
    );
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    f.acceptLate();
    f.restart();
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    await f.authority().releaseVerifiedTerminal();
    await expect(
      f.run(() => f.trello.addComment("card", "Unsafe new write")),
    ).rejects.toThrow("terminal");
    expect(f.comments).toHaveLength(1);
    expect(f.ledger.filter((item) => item.startsWith("POST:"))).toHaveLength(1);
  });

  it("verifies exact GitHub body/draft fields and discovers a late conversation reply", async () => {
    const f = fixture();
    let body = "Human content";
    let draft = false;
    let pendingBody = "";
    let pendingReply = "";
    const comments: {
      id: number;
      body: string;
      author: string;
      createdAt: string;
      updatedAt: null;
    }[] = [];
    const requests: string[] = [];
    const github = new GitHubClient(async (_cwd, args) => {
      requests.push(args.slice(0, 2).join(" "));
      expect(
        f.store.read()!.pendingOperations.at(-1)!.mutation!.dispatches,
      ).toHaveLength(1);
      if (args[0] === "pr" && args[1] === "view" && args.includes("isDraft"))
        return String(draft);
      if (args[0] === "pr" && args[1] === "edit") {
        pendingBody = args[args.indexOf("--body") + 1]!;
        return "";
      }
      if (args[0] === "pr" && args[1] === "ready") {
        draft = true;
        return "";
      }
      if (args[0] === "api" && args.includes("POST")) {
        pendingReply = args.find((arg) => arg.startsWith("body="))!.slice(5);
        throw new Error("reply in flight");
      }
      throw new Error("Unexpected GitHub command in fixture");
    });
    vi.spyOn(github, "getPullRequestStateByNumber").mockResolvedValue({
      state: "OPEN",
    } as Awaited<ReturnType<GitHubClient["getPullRequestStateByNumber"]>>);
    vi.spyOn(github, "getPullRequestDescription").mockImplementation(
      async () => body,
    );
    vi.spyOn(github, "getPullRequestPublicationFields").mockImplementation(
      async () => ({ title: "Task", body, isDraft: draft }),
    );
    vi.spyOn(github, "getPullRequestConversationComments").mockImplementation(
      async () => comments,
    );
    const input = {
      cwd: f.pinned.repositoryPath,
      repository: "owner/repo",
      pullRequestUrl: f.url,
      project: f.project,
    };
    const reconcile = () =>
      f.run(() =>
        reconcileWorkflowMutations({
          project: f.project,
          trello: f.trello,
          git: f.git,
          github,
        }),
      );
    await expect(
      f.run(() =>
        github.editPullRequestDescription({
          ...input,
          body: "Human content\nCurrent evidence",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.tick();
    await reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    body = pendingBody;
    f.restart();
    f.tick();
    await reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    // Draft uses its own concrete isDraft readback, not the ready response.
    await f.run(() => github.ensurePullRequestDraft(input));
    expect(draft).toBe(true);
    expect(f.store.read()!.pendingOperations[1]!.status).toBe("completed");
    await expect(
      f.run(() =>
        github.replyToConversationComment({
          ...input,
          body: "Verified correction",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.tick();
    await reconcile();
    expect(comments).toHaveLength(0);
    comments.push({
      id: 88,
      body: pendingReply,
      author: "bot",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });
    f.restart();
    f.tick();
    await reconcile();
    expect(f.store.read()!.pendingOperations[2]!.status).toBe("completed");
    expect(
      requests.filter((request) => request === "api --method"),
    ).toHaveLength(1);
    expect(requests.filter((request) => request === "pr edit")).toHaveLength(1);
  });

  it("checks actual destination and dueComplete instead of a successful-looking response", async () => {
    const f = fixture();
    f.wrongMove();
    await expect(
      f.run(() => f.trello.moveCard("card", "done", { dueComplete: true })),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    f.card.idList = "done";
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    await expect(f.authority().releaseVerifiedTerminal()).rejects.toThrow(
      "verified terminal",
    );
    f.card.dueComplete = true;
    f.restart();
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
    expect(f.ledger.filter((item) => item.startsWith("PUT:"))).toHaveLength(1);
  });

  it("preserves the full refinement snapshot before its first field write and detects wrong fields", async () => {
    const f = fixture(true);
    f.wrongMove();
    await expect(
      f.run(() =>
        finalizeRefinement(f.trello, f.project, f.card, {
          title: "Refined",
          description: "New description",
          type: "feature",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowMutationWaitingError);
    expect(
      f.store.read()!.compatibility["refinement-mutation-foundation-v1"],
    ).toMatchObject({
      original: {
        title: "Task",
        description: "Description",
        labels: ["refinement"],
      },
      intended: {
        title: "Refined",
        description: "New description",
        labels: ["feature"],
      },
    });
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).not.toBe("completed");
    expect(f.card.name).toBe("Task");
    f.card.name = "Refined";
    f.card.desc = "New description";
    f.restart();
    f.tick();
    await f.reconcile();
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
  });

  it("fails closed for missing authority in single and multi-project lease scopes", async () => {
    const f = fixture();
    await expect(
      ProjectRunAuthority.withProjectLease(
        "p",
        () => {},
        () => {},
        async () => f.trello.addComment("card", "No"),
      ),
    ).rejects.toThrow("authority");
    await expect(
      ProjectRunAuthority.withProjectLeases(
        ["p", "q"].map((projectId) => ({
          projectId,
          assertHeld() {},
          markTerminationAmbiguous() {},
        })),
        async () => f.trello.addComment("card", "No"),
      ),
    ).rejects.toThrow("authority");
    expect(f.ledger).toHaveLength(0);
  });
});
