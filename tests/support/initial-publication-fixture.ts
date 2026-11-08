import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { ProjectConfig } from "../../src/config/config.js";
import { GitClient } from "../../src/git/git-client.js";
import type {
  GitHubClient,
  PullRequestState,
  CreatePullRequestOptions,
} from "../../src/github/github-client.js";
import {
  TrelloRequestError,
  type TrelloCard,
  type TrelloClient,
} from "../../src/trello/trello-client.js";
import {
  RunStore,
  type RunStoreLease,
} from "../../src/task-session/run-store.js";
import { ProjectRunAuthority } from "../../src/task-session/project-run-authority.js";
import type { RunRecord } from "../../src/task-session/run-record.js";
import { TaskExecutionStore } from "../../src/task-session/task-execution-store.js";
import { TaskMutationQueue } from "../../src/task-session/task-mutation-queue.js";
import { createIsolatedGitFixture } from "./isolated-git-fixture.js";

interface ServiceState {
  githubOutage: boolean;
  trelloOutage: boolean;
  delayCreation: boolean;
  loseCreationResponse: boolean;
  loseMoveResponse: boolean;
  wrongMove: boolean;
  rejectMove: boolean;
  secondReady?: boolean;
  loseCommentResponse?: boolean;
  requests: {
    url: string;
    title: string;
    body: string;
    draft: boolean;
    head: string;
  }[];
  prs: {
    url: string;
    title: string;
    body: string;
    draft: boolean;
    head: string;
  }[];
  list: string;
  comments: { id: string; text: string }[];
}

/** Resource state and append-only request/read/acceptance ledger are wholly
 * independent of RunStore. The observer reads them directly, including in a
 * different OS process. No service infers acceptance from application state. */
export class PublicationServices {
  constructor(
    readonly root: string,
    readonly git: GitClient,
    readonly project: ProjectConfig,
  ) {}
  read(): ServiceState {
    return JSON.parse(
      fs.readFileSync(path.join(this.root, "services.json"), "utf8"),
    ) as ServiceState;
  }
  save(state: ServiceState) {
    fs.writeFileSync(
      path.join(this.root, "services.json"),
      JSON.stringify(state),
    );
  }
  change(update: Partial<ServiceState>) {
    this.save({ ...this.read(), ...update });
  }
  ledger(type: string) {
    fs.appendFileSync(
      path.join(this.root, "service-ledger.jsonl"),
      `${JSON.stringify({ type, at: Date.now() })}\n`,
    );
  }
  entries(): { type: string; at: number }[] {
    return fs
      .readFileSync(path.join(this.root, "service-ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; at: number });
  }
  acceptLate() {
    const state = this.read();
    state.prs = [...state.requests];
    this.save(state);
    this.ledger("pr-accept-late");
  }
  card(list = this.read().list): TrelloCard {
    return {
      id: "card",
      name: "Implement task",
      desc: "task",
      url: "https://trello.com/c/card",
      idList: list,
      idLabels: ["feature"],
    };
  }
  github = {
    getCiObservations: async ({ headSha }: { headSha: string }) => ({
      headSha,
      checks: [],
      expectationSources: [
        {
          kind: "repository-rules",
          sourceId: "fixture",
          complete: true,
          checkNames: ["Build"],
        },
      ],
    }),
    findChangesRequestedPullRequest: async () => null,
    getPullRequestConversationComments: async () => [],
    findPullRequestState: async (): Promise<PullRequestState | null> => {
      this.ledger("pr-read");
      const state = this.read();
      if (state.githubOutage) throw new Error("GitHub unavailable");
      const pr = state.prs[0];
      return pr
        ? {
            url: pr.url,
            state: "OPEN",
            mergedAt: null,
            headRefOid: pr.head,
            headRefName: "agent/card",
            baseRefName: "main",
            headRepository: { name: "repo" },
            headRepositoryOwner: { login: "owner" },
          }
        : null;
    },
    getPullRequestPublicationFields: async () => {
      this.ledger("pr-fields-read");
      const state = this.read();
      if (state.githubOutage || !state.prs[0])
        throw new Error("PR unavailable");
      const pr = state.prs[0];
      return { title: pr.title, body: pr.body, isDraft: pr.draft };
    },
    createPullRequest: async (options: CreatePullRequestOptions) => {
      this.ledger("pr-request");
      const state = this.read();
      if (state.githubOutage) throw new Error("GitHub unavailable");
      const pr = {
        url: `https://github.com/owner/repo/pull/${state.requests.length + 1}`,
        title: options.title,
        body: options.body,
        draft: options.draft ?? false,
        head:
          (await this.git.getRemoteBranchSha(
            this.project.repository.path,
            path.join(this.root, "remote.git"),
            "agent/card",
          )) ?? "",
      };
      state.requests.push(pr);
      if (!state.delayCreation) state.prs.push(pr);
      this.save(state);
      if (!state.delayCreation) this.ledger("pr-accept");
      if (state.loseCreationResponse || state.delayCreation)
        throw new Error("Response lost after possible acceptance");
      return { url: pr.url };
    },
  } as unknown as GitHubClient;
  trello = {
    getCards: async (list: string) => {
      this.ledger(`trello-read:${list}`);
      const state = this.read();
      if (state.trelloOutage) throw new Error("Trello unavailable");
      return state.list === list
        ? [this.card()]
        : list === "ready" && state.secondReady
          ? [
              {
                ...this.card("ready"),
                id: "second",
                name: "Second eligible task",
                url: "https://trello.com/c/second",
              },
            ]
          : [];
    },
    moveCard: async (_card: string, list: string) => {
      this.ledger(`move-card:${_card}`);
      if (_card !== "card") throw new Error("Second task must remain excluded");
      this.ledger("move-request");
      const state = this.read();
      if (state.trelloOutage) throw new Error("Trello unavailable");
      if (state.rejectMove)
        throw new TrelloRequestError(
          "card move",
          "fixture authorization rejection",
          { status: 401 },
        );
      if (!state.wrongMove) {
        state.list = list;
        this.save(state);
        this.ledger("move-accept");
      }
      if (state.loseMoveResponse) throw new Error("Move response lost");
      return this.card(list); // Can deliberately lie; readback must catch it.
    },
    getCardComments: async () => {
      this.ledger("comment-read");
      if (this.read().trelloOutage) throw new Error("Trello unavailable");
      return this.read().comments;
    },
    addComment: async (_card: string, text: string) => {
      this.ledger("comment-request");
      const state = this.read();
      if (state.trelloOutage) throw new Error("Trello unavailable");
      state.comments.push({ id: `comment-${state.comments.length + 1}`, text });
      this.save(state);
      this.ledger("comment-accept");
      if (state.loseCommentResponse)
        throw new Error("Comment response lost after acceptance");
      return {
        id: state.comments.at(-1)!.id,
        type: "commentCard",
        date: new Date().toISOString(),
      };
    },
  } as unknown as TrelloClient;
}

export function reopenPublicationFixture(
  root: string,
  token = "lease",
  heldLease?: RunStoreLease,
) {
  const project = JSON.parse(
    fs.readFileSync(path.join(root, "project.json"), "utf8"),
  ) as ProjectConfig & { contextRoot: string };
  const env = JSON.parse(
    fs.readFileSync(path.join(root, "git-env.json"), "utf8"),
  ) as NodeJS.ProcessEnv;
  const git = new GitClient(async (cwd, args, environment) =>
    // Simulate transport only, not configuration discovery: real `get-url`
    // sees the pinned GitHub identity and any test-injected URL rewrites.
    (
      await promisify(execFile)(
        "git",
        [
          ...(["fetch", "push", "ls-remote"].includes(args[0] ?? "")
            ? [
                "-c",
                `url.${pathToFileURL(path.join(root, "remote.git")).href}.insteadOf=https://github.com/owner/repo.git`,
              ]
            : []),
          ...args,
        ],
        {
          cwd,
          env: { ...env, ...environment },
          encoding: "utf8",
        },
      )
    ).stdout.trim(),
  );
  const lease = heldLease ?? {
    integrationId: "integration",
    instanceId: "owner",
    token,
    assertHeld() {},
  };
  const store = RunStore.openWithPersistedIdentity(
    project.contextRoot,
    "attempt",
    lease,
  )!;
  let record = store.read()!;
  if (record.owner.token !== lease.token)
    record = store.takeOwnership(
      record.revision,
      record.owner.generation,
      lease.token,
    );
  const authority = new ProjectRunAuthority(
    project.id,
    store,
    record.owner.generation,
  );
  const services = new PublicationServices(root, git, project);
  return {
    project,
    git,
    store,
    authority,
    services,
    worktreePath: path.join(project.repository.worktreeRoot, "card"),
  };
}

export function createPublicationFixture(
  root: string,
  heldLease?: RunStoreLease,
) {
  const isolated = createIsolatedGitFixture(root);
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git"),
    worktrees = path.join(root, "worktrees"),
    state = path.join(root, "state");
  fs.mkdirSync(source);
  fs.mkdirSync(worktrees);
  isolated.git(root, "init", "--bare", remote);
  isolated.git(source, "init", "-b", "main");
  fs.writeFileSync(path.join(source, "source.txt"), "original\n");
  isolated.git(source, "add", ".");
  isolated.git(source, "commit", "-m", "baseline");
  isolated.git(source, "remote", "add", "origin", remote);
  isolated.git(source, "push", "origin", "main");
  isolated.git(source, "fetch", "origin", "main");
  isolated.git(
    source,
    "remote",
    "set-url",
    "origin",
    "https://github.com/owner/repo.git",
  );
  isolated.git(
    source,
    "worktree",
    "add",
    "-b",
    "agent/card",
    path.join(worktrees, "card"),
  );
  fs.writeFileSync(
    path.join(worktrees, "card", "source.txt"),
    "meaningful task implementation\n",
  );
  const project = {
    id: "p",
    contextRoot: state,
    autoMerge: false,
    repository: {
      path: source,
      worktreeRoot: worktrees,
      github: "owner/repo",
      defaultBranch: "main",
      validationCommand: "true",
      gitIdentity: { name: "Fixture Agent", email: "agent@example.test" },
    },
    trello: {
      boardId: "board",
      readyListId: "ready",
      workingListId: "working",
      reviewListId: "review",
      backlogListId: "backlog",
      doneListId: "done",
      failedListId: "failed",
      featureLabelId: "feature",
      refinementLabelId: "refinement",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    opencode: { timeoutMinutes: 1 },
  } as ProjectConfig & { contextRoot: string };
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(project));
  fs.writeFileSync(
    path.join(root, "git-env.json"),
    JSON.stringify(isolated.env),
  );
  const pinned: RunRecord["pinned"] = {
    integrationId: heldLease?.integrationId ?? "integration",
    projectId: "p",
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      backlog: "backlog",
      done: "done",
      failed: "failed",
    },
    repository: "owner/repo",
    repositoryPath: source,
    worktreeRoot: worktrees,
    storageRoot: state,
  };
  const lease = heldLease ?? {
    integrationId: "integration",
    instanceId: "owner",
    token: "lease",
    assertHeld() {},
  };
  const store = new RunStore(state, "attempt", pinned, lease);
  store.create({
    version: 1,
    revision: 1,
    projectId: "p",
    cardId: "card",
    attemptId: "attempt",
    taskKind: "implementation",
    pinned,
    lifecycle: "publication",
    checkpoint: "publication",
    publicationState: "none",
    operation: { id: "operation", kind: "publication", generation: 1 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: lease.instanceId, token: lease.token, generation: 1 },
    resources: [],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: [],
    expectedTrelloListId: "working",
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {},
    compatibility: {},
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(
    path.join(root, "services.json"),
    JSON.stringify({
      githubOutage: false,
      trelloOutage: false,
      delayCreation: false,
      loseCreationResponse: false,
      loseMoveResponse: false,
      wrongMove: false,
      rejectMove: false,
      requests: [],
      prs: [],
      list: "working",
      comments: [],
    } satisfies ServiceState),
  );
  fs.writeFileSync(path.join(root, "service-ledger.jsonl"), "");
  const fixture = reopenPublicationFixture(root, lease.token, heldLease);
  fixture.authority.run(() => {
    const taskStore = new TaskExecutionStore(state, project);
    taskStore.create({
      version: 1,
      projectId: "p",
      cardId: "card",
      phase: "publication",
      primarySessionId: "primary",
      sessionCreationStatus: "bound",
      expectedBranch: "agent/card",
      setup: { command: null, status: "not-required" },
      operationKey: "operation",
      revision: 1,
      retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const queue = new TaskMutationQueue(state, project);
    queue.enqueue({
      projectId: "p",
      cardId: "card",
      operationKey: "operation",
      eventId: "implementation:card",
      kind: "implementation",
      enqueuedAt: new Date().toISOString(),
    });
    queue.claimForRecovery("implementation:card");
    queue.fail("implementation:card");
  });
  return { ...fixture, isolated };
}
