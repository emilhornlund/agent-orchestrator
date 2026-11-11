import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createIsolatedGitFixture } from "./isolated-git-fixture.js";
import { vi } from "vitest";
import type { Config, ProjectConfig } from "../../src/config/config.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../../src/coordination/project-registry.js";
import { ProjectRunAuthority } from "../../src/task-session/project-run-authority.js";
import type { RunRecord } from "../../src/task-session/run-record.js";
import { TrelloClient } from "../../src/trello/trello-client.js";
import { GitClient } from "../../src/git/git-client.js";
import { GitHubClient } from "../../src/github/github-client.js";
import { OpenCodeClient } from "../../src/opencode/opencode-client.js";
import { CommandRunner } from "../../src/process/command-runner.js";
import { getRefinementResultPath } from "../../src/refinement/refinement-result.js";
import { pollProject } from "../../src/orchestrator/poll-project.js";
import {
  NotificationOutbox,
  notificationTriggerObserver,
} from "../../src/notifications/notification-outbox.js";

export async function notificationAuthorityFixture(
  root: string,
  id: string,
  shared?: {
    storageRoot: string;
    coordinationRoot: string;
    otherProjects: { project: ProjectConfig; lease: ProjectOwnershipLease }[];
  },
  actualGit = false,
  taskKind: "refinement" | "implementation" = "refinement",
  attemptId?: string,
) {
  const base = path.join(root, id);
  fs.mkdirSync(base, { recursive: true });
  const repositoryPath = path.join(base, "repo");
  fs.mkdirSync(repositoryPath);
  const project = {
    id,
    autoMerge: false,
    contextRoot: shared?.storageRoot ?? path.join(base, "state"),
    trello: Object.fromEntries(
      [
        "board",
        "backlog",
        "ready",
        "working",
        "review",
        "failed",
        "done",
        "refinement",
        "feature",
        "improvement",
        "bug",
      ].map((value) => [
        value === "board"
          ? "boardId"
          : ["refinement", "feature", "improvement", "bug"].includes(value)
            ? `${value}LabelId`
            : `${value}ListId`,
        `${id}-${value}`,
      ]),
    ),
    repository: {
      path: repositoryPath,
      worktreeRoot: path.join(base, "work"),
      github: `owner/${id}`,
      defaultBranch: "main",
      validationCommand: "validate",
      gitIdentity: { name: "Agent", email: "agent@example.test" },
    },
    opencode: {
      refinement: { model: "refinement" },
      implementation: {},
      review: {},
      remediation: { maxPasses: 1 },
      commit: {},
      timeoutMinutes: 1,
    },
  } as ProjectConfig & { contextRoot: string };
  const coordinationRoot =
    shared?.coordinationRoot ?? path.join(base, "coordination");
  if (!fs.existsSync(coordinationRoot)) {
    fs.mkdirSync(coordinationRoot);
    provisionCoordinationNamespace(
      coordinationRoot,
      "notification-authority-test",
    );
  }
  const config = {
    projects: [
      ...(shared?.otherProjects.map((other) => other.project) ?? []),
      project,
    ],
    workflow: {
      contextRoot: project.contextRoot,
      coordinationRoot,
      coordinationNamespaceId: "notification-authority-test",
      pollIntervalSeconds: 0.01,
      logRetentionDays: 30,
      contextRetentionDays: 30,
    },
  } as Config;
  const lease = await acquireProjectOwnership(
    coordinationRoot,
    {
      trelloBoardId: project.trello.boardId,
      githubRepository: project.repository.github,
    },
    "notification-authority-test",
  );
  const pin = (
    await verifyAndPinProjects(config, [
      ...(shared?.otherProjects.map((other) => other.lease) ?? []),
      lease,
    ])
  ).find((candidate) => candidate.projectId === id)!;
  const pinned: RunRecord["pinned"] = {
    integrationId: pin.integrationId,
    projectId: id,
    boardId: project.trello.boardId,
    lists: {
      ready: project.trello.readyListId,
      working: project.trello.workingListId,
      review: project.trello.reviewListId,
      failed: project.trello.failedListId,
      done: project.trello.doneListId,
      backlog: project.trello.backlogListId,
    },
    repository: pin.repository.github,
    repositoryPath: pin.repository.path,
    worktreeRoot: pin.repository.worktreeRoot,
    storageRoot: pin.storageRoot,
  };
  const card = {
    id: `${id}-card`,
    idBoard: project.trello.boardId,
    name: "Task",
    desc: "Original",
    idList: project.trello.readyListId,
    idLabels: [project.trello.refinementLabelId],
    url: `https://trello.com/c/${id}-card`,
    dueComplete: false,
  };
  const cardPath = path.join(base, "external-card.json");
  const saveCard = () => fs.writeFileSync(cardPath, JSON.stringify(card));
  saveCard();
  const comments: { id: string; text: string }[] = [];
  const requests: string[] = [];
  const fetch = async (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const parts = url.pathname.split("/");
    requests.push(`${method}:${url.pathname}`);
    if (method === "GET" && parts[2] === "lists")
      return Response.json(card.idList === parts[3] ? [card] : []);
    if (method === "GET" && parts[2] === "boards")
      return Response.json(
        ["feature", "improvement", "bug", "refinement"].map((label) => ({
          id: `${id}-${label}`,
          name: label,
          color: null,
        })),
      );
    if (method === "GET" && parts[2] === "cards" && parts[4] === "attachments")
      return Response.json([]);
    if (method === "GET" && parts[2] === "cards" && parts[4] === "actions")
      return Response.json(
        url.searchParams.get("filter") === "commentCard"
          ? comments.map((comment) => ({
              id: comment.id,
              type: "commentCard",
              data: { text: comment.text },
            }))
          : [],
      );
    if (method === "GET" && parts[2] === "cards") return Response.json(card);
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (typeof body.name === "string") card.name = body.name;
      if (typeof body.desc === "string") card.desc = body.desc;
      if (typeof body.idList === "string") card.idList = body.idList;
      saveCard();
      return Response.json(card);
    }
    if (method === "DELETE" && parts[4] === "idLabels") {
      card.idLabels = card.idLabels.filter((label) => label !== parts[5]);
      saveCard();
      return Response.json({});
    }
    if (method === "POST" && parts[4] === "idLabels") {
      card.idLabels.push(url.searchParams.get("value")!);
      saveCard();
      return Response.json({});
    }
    if (method === "POST" && parts[4] === "actions") {
      comments.push({
        id: `comment-${comments.length}`,
        text: url.searchParams.get("text")!,
      });
      return Response.json({
        id: comments.at(-1)!.id,
        type: "commentCard",
        date: new Date().toISOString(),
      });
    }
    throw new Error(`Unexpected fixture request ${method}:${url.pathname}`);
  };
  const trello = new TrelloClient({ apiKey: "key", token: "token" });
  let git = {
    fetch: vi.fn(async () => {}),
    branchExists: vi.fn(async () => false),
    addWorktreeWithNewBranch: vi.fn(
      async (_repo: string, directory: string) => {
        fs.mkdirSync(directory, { recursive: true });
      },
    ),
    getStatus: vi.fn(async (directory: string) =>
      fs.existsSync(getRefinementResultPath(directory))
        ? "?? .agent-orchestrator/refinement-result.json"
        : "",
    ),
    getCurrentBranch: vi.fn(
      async (directory: string) => `agent/${path.basename(directory)}`,
    ),
    getRebaseState: vi.fn(async () => null),
    getConflictedPaths: vi.fn(async () => []),
    removeWorktree: vi.fn(async (_repo: string, directory: string) => {
      fs.rmSync(directory, { recursive: true, force: true });
    }),
    pruneWorktrees: vi.fn(async () => {}),
  } as unknown as GitClient;
  if (actualGit) {
    const isolated = createIsolatedGitFixture(base);
    const run = isolated.git;
    const remote = path.join(base, "remote.git");
    run(repositoryPath, "init", "-b", "main");
    fs.writeFileSync(
      path.join(repositoryPath, "source.txt"),
      "Repository evidence\n",
    );
    run(repositoryPath, "add", ".");
    run(repositoryPath, "commit", "-m", "baseline");
    run(base, "init", "--bare", remote);
    run(repositoryPath, "remote", "add", "origin", remote);
    run(repositoryPath, "push", "origin", "main");
    run(repositoryPath, "fetch", "origin", "main");
    run(
      repositoryPath,
      "remote",
      "set-url",
      "origin",
      `https://github.com/owner/${id}.git`,
    );
    git = new GitClient(async (cwd, args, override) =>
      execFileSync(
        "git",
        [
          ...(["fetch", "push", "ls-remote"].includes(args[0]!)
            ? [
                "-c",
                `url.${pathToFileURL(remote).href}.insteadOf=https://github.com/owner/${id}.git`,
              ]
            : []),
          ...args,
        ],
        { cwd, env: { ...isolated.env, ...override }, encoding: "utf8" },
      ).trim(),
    );
  }
  const github = new GitHubClient(vi.fn());
  const engineer = vi.fn(async ({ cwd }: { cwd: string }) => {
    const file = getRefinementResultPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (actualGit) {
      execFileSync(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ title: 'Refined task', description: 'Complete intended fields', type: 'feature' }))",
          file,
        ],
        { cwd },
      );
    } else
      fs.writeFileSync(
        file,
        JSON.stringify({
          title: "Refined task",
          description: "Complete intended fields",
          type: "feature",
        }),
      );
    return { exitCode: 0, output: "done", errorOutput: "" };
  });
  const openCode = new OpenCodeClient(engineer);
  const commands = new CommandRunner(vi.fn());
  const authority = await ProjectRunAuthority.createPreparingAttempt({
    ...(attemptId === undefined ? {} : { attemptId }),
    projectId: id,
    cardId: card.id,
    taskKind,
    pinned,
    projectLease: lease,
    coordinationRoot,
  });
  authority.claim();
  const sink: string[] = [];
  const notifier = {
    send: vi.fn(async (message: { text: string }) => {
      sink.push(message.text);
    }),
  };
  const outbox = () =>
    new NotificationOutbox(
      pinned.storageRoot,
      id,
      () => lease.assertHeld(),
      Date.now,
      notificationTriggerObserver(pinned.storageRoot, id, () =>
        lease.assertHeld(),
      ),
    );
  const poll = () =>
    pollProject(
      trello,
      git,
      github,
      openCode,
      commands,
      project,
      new AbortController().signal,
      notifier,
      undefined,
      undefined,
      authority,
    );
  const context = { authority, projectLease: lease, coordinationRoot, pinned };
  return {
    project,
    config,
    lease,
    pinned,
    authority,
    card,
    cardPath,
    saveCard,
    fetch,
    trello,
    git,
    github,
    openCode,
    commands,
    engineer,
    notifier,
    sink,
    outbox,
    poll,
    context,
    requests,
  };
}
