import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LedgerEvent = {
  sequence: number;
  at: number;
  kind:
    "request" | "acceptance" | "read" | "response" | "dispatch" | "checkpoint";
  service: "trello" | "github" | "opencode" | "git" | "process";
  action: string;
  resourceId?: string;
  detail?: string;
  actor?: "orchestrator" | "human" | "test";
  projectId?: string;
  attemptId?: string;
  correlationId?: string;
  argv?: readonly string[];
};

export type Fault =
  | "success"
  | "reject"
  | "timeout-before-acceptance"
  | "accept-without-response"
  | "delay"
  | "missing";

export class ServiceFault extends Error {
  constructor(readonly kind: "rejected" | "timeout" | "missing") {
    super(`Service operation ${kind}`);
  }
}

export class ControlledClock {
  private value = 0;
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Clock advance must be non-negative");
    this.value += milliseconds;
  }
}

export class Barriers {
  private readonly barriers = new Map<
    string,
    {
      generation: number;
      reached: boolean;
      stopping: boolean;
      waiters: Set<() => void>;
      release?: () => void;
    }
  >();

  arm(name: string): void {
    const current = this.barriers.get(name);
    if (current && (!current.reached || current.stopping))
      throw new Error(`Barrier ${name} is already armed`);
    this.barriers.set(name, {
      generation: (current?.generation ?? 0) + 1,
      reached: false,
      stopping: false,
      waiters: new Set(),
    });
  }

  async stop(name: string): Promise<void> {
    const barrier = this.barriers.get(name);
    if (barrier === undefined || barrier.reached) return;
    barrier.reached = true;
    for (const resolve of [...barrier.waiters]) resolve();
    barrier.stopping = true;
    await new Promise<void>((resolve) => {
      barrier.release = resolve;
    });
    barrier.stopping = false;
    delete barrier.release;
  }

  async waitUntil(
    name: string,
    timeoutMs = 1000,
    signal?: AbortSignal,
  ): Promise<void> {
    const barrier = this.barriers.get(name);
    if (barrier === undefined) throw new Error(`Barrier ${name} is not armed`);
    if (barrier.reached) return;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error("Barrier timeout must be non-negative");
    if (signal?.aborted)
      throw signal.reason ?? new Error("Barrier wait cancelled");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const reached = () => finish();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        barrier.waiters.delete(reached);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new Error(`Barrier ${name} timed out`)),
        timeoutMs,
      );
      const abort = () =>
        finish(signal?.reason ?? new Error("Barrier wait cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      barrier.waiters.add(reached);
    });
  }

  release(name: string): void {
    const barrier = this.barriers.get(name);
    barrier?.release?.();
    if (barrier !== undefined) delete barrier.release;
  }
}

export type HarnessResource = {
  cards: Map<string, { list: string; comments: string[] }>;
  pullRequests: Map<
    string,
    {
      head: string;
      state: "open" | "closed" | "merged";
      draft: boolean;
      approvals: number;
      repository?: string;
      base?: string;
      attemptId?: string;
      correlationId?: string;
    }
  >;
};

/** Stateful offline substitutes. Events record intent and effect separately; reads come from resource maps. */
export class P1ServiceHarness {
  readonly clock = new ControlledClock();
  readonly barriers = new Barriers();
  private readonly events: LedgerEvent[] = [];
  private readonly state: HarnessResource = {
    cards: new Map(),
    pullRequests: new Map(),
  };
  private nextId = 1;

  get ledger(): readonly LedgerEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.argv ? { argv: [...event.argv] } : {}),
    }));
  }
  get resources(): HarnessResource {
    return {
      cards: new Map(
        [...this.state.cards].map(([id, card]) => [
          id,
          { list: card.list, comments: [...card.comments] },
        ]),
      ),
      pullRequests: new Map(
        [...this.state.pullRequests].map(([id, pr]) => [id, { ...pr }]),
      ),
    };
  }
  seedCard(
    id: string,
    card: { list: string; comments?: readonly string[] },
  ): void {
    this.state.cards.set(id, {
      list: card.list,
      comments: [...(card.comments ?? [])],
    });
  }
  setCardList(id: string, list: string): void {
    const card = this.state.cards.get(id);
    if (!card) throw new Error(`Unknown card ${id}`);
    card.list = list;
  }

  exportState(): string {
    return JSON.stringify({
      now: this.clock.now(),
      nextId: this.nextId,
      cards: [...this.state.cards],
      pullRequests: [...this.state.pullRequests],
      ledger: this.events,
    });
  }

  restoreState(serialized: string): void {
    const state = JSON.parse(serialized) as {
      now: number;
      nextId: number;
      cards: Array<[string, { list: string; comments: string[] }]>;
      pullRequests: Array<
        [
          string,
          {
            head: string;
            state: "open" | "closed" | "merged";
            draft: boolean;
            approvals: number;
          },
        ]
      >;
      ledger: LedgerEvent[];
    };
    if (
      this.events.length !== 0 ||
      this.state.cards.size !== 0 ||
      this.state.pullRequests.size !== 0 ||
      this.clock.now() !== 0
    ) {
      throw new Error("restoreState requires a fresh service harness");
    }
    if (!Number.isFinite(state.now) || state.now < 0)
      throw new Error("Invalid snapshot clock");
    this.clock.advance(state.now);
    this.nextId = state.nextId;
    for (const [id, card] of state.cards)
      this.state.cards.set(id, {
        list: card.list,
        comments: [...card.comments],
      });
    for (const [id, pr] of state.pullRequests)
      this.state.pullRequests.set(id, { ...pr });
    this.events.push(
      ...state.ledger.map((event) => ({
        ...event,
        ...(event.argv ? { argv: [...event.argv] } : {}),
      })),
    );
  }

  private record(event: Omit<LedgerEvent, "sequence" | "at">): void {
    this.events.push({
      ...event,
      sequence: this.ledger.length + 1,
      at: this.clock.now(),
    });
  }

  async createPullRequest(
    head: string,
    fault: Fault = "success",
    identity: {
      repository?: string;
      base?: string;
      attemptId?: string;
      correlationId?: string;
    } = {},
  ): Promise<string | undefined> {
    const proposed = `pr-${this.nextId++}`;
    this.record({
      kind: "request",
      service: "github",
      action: "create-pr",
      resourceId: proposed,
      detail: fault,
      ...identity,
    });
    if (fault === "delay") this.clock.advance(500);
    await this.barriers.stop("before-acceptance");
    if (
      fault === "reject" ||
      fault === "timeout-before-acceptance" ||
      fault === "missing"
    ) {
      this.record({
        kind: "response",
        service: "github",
        action: "create-pr",
        resourceId: proposed,
        detail: fault,
      });
      throw new ServiceFault(
        fault === "reject"
          ? "rejected"
          : fault === "timeout-before-acceptance"
            ? "timeout"
            : "missing",
      );
    }
    const id = proposed;
    this.state.pullRequests.set(id, {
      head,
      state: "open",
      draft: false,
      approvals: 0,
      ...identity,
    });
    this.record({
      kind: "acceptance",
      service: "github",
      action: "create-pr",
      resourceId: id,
    });
    await this.barriers.stop("after-acceptance");
    await this.barriers.stop("before-response");
    if (fault !== "accept-without-response")
      this.record({
        kind: "response",
        service: "github",
        action: "create-pr",
        resourceId: id,
      });
    return fault === "accept-without-response" ? undefined : id;
  }

  readPullRequests(
    fault: Fault = "success",
  ): Array<
    [
      string,
      HarnessResource["pullRequests"] extends Map<string, infer T> ? T : never,
    ]
  > {
    this.record({
      kind: "read",
      service: "github",
      action: "list-prs",
      detail: fault,
    });
    if (
      fault === "reject" ||
      fault === "timeout-before-acceptance" ||
      fault === "missing"
    )
      throw new ServiceFault(
        fault === "reject"
          ? "rejected"
          : fault === "missing"
            ? "missing"
            : "timeout",
      );
    return [...this.state.pullRequests.entries()].map(([id, pr]) => [
      id,
      { ...pr },
    ]);
  }

  addComment(cardId: string, body: string, fault: Fault = "success"): void {
    this.record({
      kind: "request",
      service: "trello",
      action: "add-comment",
      resourceId: cardId,
      detail: fault,
    });
    if (fault === "success" || fault === "accept-without-response") {
      const card = this.state.cards.get(cardId);
      if (!card) throw new Error(`Unknown card ${cardId}`);
      card.comments.push(body);
      this.record({
        kind: "acceptance",
        service: "trello",
        action: "add-comment",
        resourceId: cardId,
        detail: body,
      });
    }
    if (fault !== "accept-without-response")
      this.record({
        kind: "response",
        service: "trello",
        action: "add-comment",
        resourceId: cardId,
        detail: fault,
      });
  }

  dispatch(
    action: string,
    service: LedgerEvent["service"],
    detail?: string,
    actor: "orchestrator" | "human" | "test" = "test",
  ): void {
    this.record({
      kind: "dispatch",
      service,
      action,
      ...(detail === undefined ? {} : { detail }),
      actor,
    });
  }

  recordGitArgv(argv: readonly string[]): void {
    this.record({
      kind: "dispatch",
      service: "git",
      action: argv[0] ?? "git",
      argv: [...argv],
      actor: "test",
    });
  }

  checkpoint(name: string): void {
    this.record({ kind: "checkpoint", service: "process", action: name });
  }
}

/** Independent read-only oracle: reads actual fixture resources and scans the complete append-only trace. */
export class P1Observer {
  constructor(private readonly harness: P1ServiceHarness) {}
  snapshot() {
    return {
      cards: [...this.harness.resources.cards].map(([id, card]) => ({
        id,
        list: card.list,
        comments: [...card.comments],
      })),
      pullRequests: [...this.harness.resources.pullRequests].map(
        ([id, pr]) => ({ id, ...pr }),
      ),
    };
  }
  history(): readonly LedgerEvent[] {
    return this.harness.ledger.map((event) => ({
      ...event,
      ...(event.argv === undefined ? {} : { argv: [...event.argv] }),
    }));
  }
  assertNoForbiddenOrDuplicateEffects(): void {
    const events = this.harness.ledger;
    const unsafe = events.filter((event) => {
      if (
        event.service === "github" &&
        /merge-pr|merge-pull-request/i.test(event.action) &&
        event.actor === "orchestrator"
      )
        return true;
      if (
        /force-push|rebase|restore-worktree|reset|restore/i.test(event.action)
      )
        return true;
      return (
        event.service === "git" &&
        (event.argv ?? []).some(
          (arg) =>
            /^--force(?:-with-lease)?(?:=|$)/.test(arg) ||
            /^\+/.test(arg) ||
            /^(?:rebase|reset|restore)$/.test(arg),
        )
      );
    });
    if (unsafe.length)
      throw new Error(
        `Forbidden ledger actions: ${unsafe.map((event) => event.action).join(", ")}`,
      );
    const acceptedPrs = events.filter(
      (event) => event.kind === "acceptance" && event.action === "create-pr",
    );
    const ids = acceptedPrs.map((event) => event.resourceId);
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate accepted PR identity in ledger");
    const prKeys = [...this.harness.resources.pullRequests.values()].map((pr) =>
      [
        pr.repository ?? "",
        pr.base ?? "",
        pr.head,
        pr.attemptId ?? "",
        pr.correlationId ?? "",
      ].join("\0"),
    );
    if (new Set(prKeys).size !== prKeys.length)
      throw new Error(
        "Duplicate PR resources for repository/base/head/attempt/correlation",
      );
    const comments = events.filter(
      (event) => event.kind === "acceptance" && event.action === "add-comment",
    );
    const commentKeys = comments.map(
      (event) => `${event.resourceId}\0${event.detail}`,
    );
    if (new Set(commentKeys).size !== commentKeys.length)
      throw new Error("Duplicate accepted comment effect in ledger");
  }
}

export function createRealGitFixture(): {
  root: string;
  source: string;
  worktree: string;
  remote: string;
  gitArgv: string[][];
  git: (...args: string[]) => string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-harness-git-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: path.join(root, "empty-template"),
  };
  fs.mkdirSync(env.GIT_TEMPLATE_DIR!);
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const gitArgv: string[][] = [];
  const git = (...args: string[]) => {
    gitArgv.push([...args]);
    const result = spawnSync("git", args, {
      cwd: args[0] === "-C" ? undefined : root,
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0 || result.signal !== null)
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message}`,
      );
    return result.stdout.trim();
  };
  try {
    git("init", "--bare", "--initial-branch=main", remote);
    git("clone", remote, source);
    git("-C", source, "config", "user.name", "P1 fixture");
    git("-C", source, "config", "user.email", "p1@example.test");
    git("-C", source, "config", "core.hooksPath", "/dev/null");
    git("-C", source, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(source, "fixture.txt"), "base\n");
    git("-C", source, "add", ".");
    git(
      "-C",
      source,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture base",
    );
    git("-C", source, "push", "-u", "origin", "main");
    const worktree = path.join(root, "task-worktree");
    git("-C", source, "worktree", "add", "-b", "agent/p1-task", worktree);
    return {
      root,
      source,
      worktree,
      remote,
      gitArgv,
      git: (...args) => git("-C", source, ...args),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function runActualProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeout = 10_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "p1-empty-gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
