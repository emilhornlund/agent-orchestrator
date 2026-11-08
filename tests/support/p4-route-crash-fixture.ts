import fs from "node:fs";
import path from "node:path";
import { RunStore } from "../../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../../src/task-session/project-run-authority.js";
import { TrelloClient } from "../../src/trello/trello-client.js";
import { GitHubClient } from "../../src/github/github-client.js";
import { execFileSync } from "node:child_process";
import { WorkflowMutationWaitingError } from "../../src/task-session/workflow-mutation.js";
import { reconcileWorkflowMutations } from "../../src/orchestrator/reconcile-workflow-mutations.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
} from "../../src/refinement/refinement-mutation-snapshot.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./initial-publication-fixture.js";

export const crashRoutes = [
  "move",
  "content",
  "label-add",
  "label-remove",
  "comment",
  "body",
  "draft",
  "thread",
  "conversation",
  "commit",
  "push",
  "worktree-new",
  "worktree-existing",
  "worktree-remove",
  "branch-delete",
  "remote-delete",
] as const;
export type CrashRoute = (typeof crashRoutes)[number];
type ExternalState = {
  card: {
    id: string;
    idBoard: string;
    name: string;
    desc: string;
    idList: string;
    idLabels: string[];
    url: string;
    dueComplete: boolean;
  };
  body: string;
  draft: boolean;
  comments: { id: string; text: string }[];
  replies: { id: number; body: string; thread: boolean }[];
};
export function setupRoute(root: string, route: CrashRoute) {
  const f = createPublicationFixture(root);
  // Matrix preparation is outside the application writer; each route starts from
  // a fresh, independently observed resource, never from another matrix case.
  f.isolated.git(f.worktreePath, "restore", "source.txt");
  if (route === "commit" || route === "push") {
    fs.writeFileSync(
      path.join(f.worktreePath, "source.txt"),
      "Meaningful correction\n",
    );
    f.isolated.git(f.worktreePath, "add", "source.txt");
    fs.writeFileSync(path.join(root, "message"), "fix: correction\n");
    if (route === "push")
      f.isolated.git(
        f.worktreePath,
        "commit",
        "-F",
        path.join(root, "message"),
      );
  }
  if (
    (route.startsWith("worktree-") && route !== "worktree-remove") ||
    route === "branch-delete"
  ) {
    f.isolated.git(
      f.project.repository.path,
      "worktree",
      "remove",
      f.worktreePath,
    );
    if (route === "worktree-new")
      f.isolated.git(f.project.repository.path, "branch", "-D", "agent/card");
  }
  if (route === "remote-delete")
    f.isolated.git(
      f.project.repository.path,
      "push",
      path.join(root, "remote.git"),
      "agent/card",
    );
  fs.writeFileSync(
    path.join(root, "route.json"),
    JSON.stringify({
      card: {
        id: "card",
        idBoard: "board",
        name: "Original",
        desc: "Original description",
        idList: "working",
        idLabels: ["refinement"],
        url: "https://trello.com/c/card",
        dueComplete: false,
      },
      body: "Original body",
      draft: false,
      comments: [],
      replies: [],
    } satisfies ExternalState),
  );
  fs.writeFileSync(path.join(root, "route-ledger.jsonl"), "");
  const refinement = ["content", "label-add", "label-remove"].includes(route);
  const lease = {
    integrationId: "integration",
    instanceId: "route-owner",
    token: "route-lease",
    assertHeld() {},
  };
  const store = new RunStore(
    f.project.contextRoot,
    "route",
    f.store.read()!.pinned,
    lease,
  );
  store.create({
    ...f.store.read()!,
    attemptId: "route",
    revision: 1,
    taskKind: refinement ? "refinement" : "implementation",
    lifecycle: refinement ? "refinement" : "human-review",
    checkpoint: refinement ? "refinement" : "human-review",
    publicationState: refinement ? "none" : "open",
    operation: { id: "route-operation", kind: "mutation", generation: 1 },
    owner: { instanceId: lease.instanceId, token: lease.token, generation: 1 },
    pendingOperations: [],
    queue: [],
    compatibility: {},
    resources: [
      {
        kind: "pull-request",
        id: "1",
        path: "https://github.com/owner/repo/pull/1",
        provenance: "independent-fixture",
      },
      {
        kind: "branch",
        id: "card",
        path: "refs/heads/agent/card",
        provenance: "independent-fixture",
      },
      {
        kind: "worktree",
        id: "card",
        path: f.worktreePath,
        provenance: "independent-fixture",
      },
    ],
  });
  const a = new ProjectRunAuthority("p", store, 1);
  if (refinement)
    a.mutate(
      refinementMutationSnapshotKey,
      {
        cardId: "card",
        original: {
          title: "Original",
          description: "Original description",
          labels: ["refinement"],
        },
        intended: {
          title: "Refined",
          description: "Refined description",
          type: "feature",
          labels: ["feature"],
        },
      },
      (value) => ({ value, result: undefined }),
      refinementMutationSnapshotSchema.parse,
    );
  return openRoute(root);
}

export function openRoute(
  root: string,
  stop?: (boundary: string) => void,
  token = "route-lease",
) {
  const f = reopenPublicationFixture(root);
  const lease = {
    integrationId: "integration",
    instanceId: "route-owner",
    token,
    assertHeld() {},
  };
  const store = RunStore.openWithPersistedIdentity(
    f.project.contextRoot,
    "route",
    lease,
  )!;
  let record = store.read()!;
  if (record.owner.token !== token)
    record = store.takeOwnership(
      record.revision,
      record.owner.generation,
      token,
    );
  const authority = new ProjectRunAuthority(
    "p",
    store,
    record.owner.generation,
  );
  const read = () =>
    JSON.parse(
      fs.readFileSync(path.join(root, "route.json"), "utf8"),
    ) as ExternalState;
  const observeGit = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: JSON.parse(
        fs.readFileSync(path.join(root, "git-env.json"), "utf8"),
      ) as NodeJS.ProcessEnv,
      encoding: "utf8",
    }).trim();
  const ledger = (type: string, id: string) =>
    fs.appendFileSync(
      path.join(root, "route-ledger.jsonl"),
      `${JSON.stringify({ type, id, at: Date.now() })}\n`,
    );
  const accept = (state: ExternalState, id: string) => {
    fs.writeFileSync(path.join(root, "route.json"), JSON.stringify(state));
    ledger("accepted", id);
    stop?.("acceptance");
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const s = read();
    if (method === "GET") {
      ledger("read", url.pathname);
      if (url.pathname.includes("/boards/"))
        return Response.json(
          ["feature", "refinement"].map((id) => ({
            id,
            name: id,
            color: null,
          })),
        );
      if (url.pathname.endsWith("/actions"))
        return Response.json(
          s.comments.map((comment) => ({
            id: comment.id,
            type: "commentCard",
            data: { text: comment.text },
          })),
        );
      return Response.json(s.card);
    }
    ledger("request", `${method}:${url.pathname}`);
    if (method === "PUT")
      Object.assign(s.card, JSON.parse(String(init?.body)) as object);
    else if (url.pathname.endsWith("/comments"))
      s.comments.push({
        id: "trello-action-1",
        text: url.searchParams.get("text")!,
      });
    else if (method === "POST")
      s.card.idLabels.push(url.searchParams.get("value")!);
    else
      s.card.idLabels = s.card.idLabels.filter(
        (label) => !url.pathname.endsWith(`/${label}`),
      );
    accept(s, url.pathname.endsWith("/comments") ? "trello-action-1" : "card");
    return Response.json(
      url.pathname.endsWith("/comments")
        ? {
            id: "trello-action-1",
            type: "commentCard",
            date: new Date().toISOString(),
          }
        : s.card,
    );
  };
  const trello = new TrelloClient({
    apiKey: "fixture-key",
    token: "fixture-token",
  });
  const github = new GitHubClient(async (_cwd, args) => {
    const s = read();
    if (args[0] === "pr" && args[1] === "view" && args.includes("isDraft"))
      return String(s.draft);
    if (
      args.some((arg) => arg.includes("mutation($threadId")) ||
      args.includes("POST")
    ) {
      const thread = args.some((arg) => arg.includes("mutation($threadId"));
      ledger("request", thread ? "thread" : "conversation");
      s.replies.push({
        id: 101,
        body: args.find((arg) => arg.startsWith("body="))!.slice(5),
        thread,
      });
      accept(s, "101");
      return JSON.stringify(
        thread
          ? {
              data: {
                addPullRequestReviewThreadReply: {
                  comment: { databaseId: 101 },
                },
              },
            }
          : { id: 101, body: s.replies.at(-1)!.body },
      );
    }
    if (args[0] === "pr" && ["edit", "ready"].includes(args[1]!)) {
      ledger("request", args[1]!);
      if (args[1] === "edit") s.body = args[args.indexOf("--body") + 1]!;
      else s.draft = true;
      accept(s, "pull/1");
      return "";
    }
    ledger("read", "threads");
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: s.replies
                      .filter((reply) => reply.thread)
                      .map((reply) => ({
                        databaseId: reply.id,
                        body: reply.body,
                        author: { login: "bot" },
                        path: null,
                        line: null,
                        originalLine: null,
                        diffHunk: null,
                        pullRequestReview: { databaseId: 9 },
                      })),
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });
  });
  github.getPullRequestStateByNumber = async () => {
    ledger("read", "pr-state");
    return { state: "OPEN" } as Awaited<
      ReturnType<GitHubClient["getPullRequestStateByNumber"]>
    >;
  };
  github.getPullRequestDescription = async () => {
    ledger("read", "body");
    return read().body;
  };
  github.getPullRequestPublicationFields = async () => {
    ledger("read", "draft");
    const s = read();
    return { title: "Task", body: s.body, isDraft: s.draft };
  };
  github.getPullRequestConversationComments = async () => {
    ledger("read", "conversation");
    return read()
      .replies.filter((reply) => !reply.thread)
      .map((reply) => ({
        id: reply.id,
        body: reply.body,
        author: "bot",
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: null,
      }));
  };
  // Use the actual publication Git executor, including real get-url fences and
  // bare-remote transport mapping. Observe acceptance outside RunStore.
  const git = f.git;
  for (const name of [
    "commit",
    "push",
    "addWorktree",
    "addWorktreeWithNewBranch",
    "removeWorktree",
    "deleteBranch",
    "deleteRemoteBranch",
  ] as const) {
    const original = git[name].bind(git) as (...args: never[]) => Promise<void>;
    Object.assign(git, {
      [name]: async (...args: never[]) => {
        const before = store
          .read()!
          .pendingOperations.at(-1)
          ?.mutation?.dispatches.at(-1);
        const inside = before && !before.response;
        if (inside) ledger("request", name);
        await original(...args);
        if (inside) {
          const resource =
            name === "commit"
              ? observeGit(f.worktreePath, "rev-parse", "HEAD")
              : name === "push"
                ? observeGit(
                    path.join(root, "remote.git"),
                    "rev-parse",
                    "refs/heads/agent/card",
                  )
                : name.startsWith("addWorktree")
                  ? `${f.worktreePath}:${observeGit(f.worktreePath, "rev-parse", "HEAD")}`
                  : `verified-absence:${name}`;
          ledger("accepted", resource);
          stop?.("acceptance");
        }
      },
    });
  }
  const common = {
    cwd: f.project.repository.path,
    repository: "owner/repo",
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
    project: f.project,
  };
  const invoke = (route: CrashRoute) =>
    authority.run(async () => {
      switch (route) {
        case "move":
          return trello.moveCard("card", "review");
        case "content":
          return trello.updateCardContent(
            "card",
            "Refined",
            "Refined description",
          );
        case "label-add":
          return trello.addLabel("card", "feature");
        case "label-remove":
          return trello.removeLabel("card", "refinement");
        case "comment":
          return trello.addComment("card", "Verified outcome");
        case "body":
          return github.editPullRequestDescription({
            ...common,
            body: "Current body",
          });
        case "draft":
          return github.ensurePullRequestDraft(common);
        case "thread":
          return github.replyToReviewThread({
            ...common,
            threadId: "thread-1",
            body: "Verified correction",
          });
        case "conversation":
          return github.replyToConversationComment({
            ...common,
            body: "Verified correction",
          });
        case "commit":
          return git.commit(
            f.worktreePath,
            path.join(root, "message"),
            f.project.repository.gitIdentity,
            "verbatim",
          );
        case "push":
          return git.push(f.worktreePath, "origin", "agent/card", f.project);
        case "worktree-new":
          return git.addWorktreeWithNewBranch(
            common.cwd,
            f.worktreePath,
            "agent/card",
            "main",
          );
        case "worktree-existing":
          return git.addWorktree(common.cwd, f.worktreePath, "agent/card");
        case "worktree-remove":
          return git.removeWorktree(common.cwd, f.worktreePath);
        case "branch-delete":
          return git.deleteBranch(common.cwd, "agent/card");
        case "remote-delete":
          return git.deleteRemoteBranch(
            common.cwd,
            "origin",
            "agent/card",
            f.project,
          );
      }
    });
  const persist = store.persistMutationIntent.bind(store);
  store.persistMutationIntent = (...args) => {
    const result = persist(...args);
    stop?.("intent");
    return result;
  };
  const event = store.recordMutationEvent.bind(store);
  store.recordMutationEvent = (...args) => {
    const e = args[4] as { type: string; outcome?: string };
    // A response has returned to the adapter, but its checkpoint has not yet
    // reached storage. Recovery must work without that in-memory knowledge.
    if (e.type === "response") stop?.("response");
    const result = event(...args);
    if (e.type === "dispatch") stop?.("dispatch");
    if (e.type === "observe" && e.outcome === "verified") stop?.("completion");
    return result;
  };
  const reconcile = () =>
    authority.run(() =>
      reconcileWorkflowMutations({ project: f.project, trello, github, git }),
    );
  return {
    ...f,
    store,
    authority,
    read,
    invoke,
    reconcile,
    ledger,
    observeGit,
  };
}
export async function runRoute(
  root: string,
  route: CrashRoute,
  stop: (boundary: string) => void,
) {
  const f = openRoute(root, stop);
  try {
    await f.invoke(route);
  } catch (error) {
    if (!(error instanceof WorkflowMutationWaitingError)) throw error;
  }
}
