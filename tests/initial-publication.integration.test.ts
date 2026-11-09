import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { runOrchestrator } from "../src/orchestrator/run-orchestrator.js";
import type { Config } from "../src/config/config.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import { ProcessExecutionError } from "../src/process/process-runtime.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { publishCard } from "../src/orchestrator/publish-card.js";
import {
  writePendingCommitState,
  readPendingCommitState,
} from "../src/orchestrator/trusted-commit-state.js";
import {
  beginInitialPublication,
  PUBLICATION_RECHECK_MS,
  PublicationWaitingError,
} from "../src/orchestrator/initial-publication.js";
import { publishTaskSessionCard } from "../src/orchestrator/publish-task-session-card.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import {
  getSetupTrackedDelta,
  resolveSetupCommitScope,
  setupFileIdentity,
  type PersistedSetupDisposition,
} from "../src/process/setup-commit-scope.js";
import { captureSetupEffects } from "../src/process/run-setup.js";
import type { VerifiedPublicationDecisionInput } from "../src/task-session/verified-publication-decision.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "initial-publication-"));
  roots.push(root);
  const f = createPublicationFixture(root);
  vi.useFakeTimers({ toFake: ["Date"] });
  return { ...f, root };
}
async function begin(
  f: ReturnType<typeof fixture>,
  message = "feat: implement task",
  setupDisposition?: PersistedSetupDisposition,
) {
  const identity = await getTaskSessionSourceSnapshotIdentity(
    f.git,
    f.worktreePath,
  );
  f.authority.run(() =>
    beginInitialPublication(
      {
        project: f.project,
        card: f.services.card(),
        git: f.git,
        trello: f.services.trello,
        github: f.services.github,
        worktreePath: f.worktreePath,
        branch: "agent/card",
        commitMessage: message,
        reviewResult: "Passed",
        remediationResult: "Not required",
        ...(setupDisposition === undefined ? {} : { setupDisposition }),
      },
      "Trello: https://trello.com/c/card",
      identity,
    ),
  );
}

async function createSetupDisposition(
  f: ReturnType<typeof fixture>,
  unrelatedPath: string,
): Promise<PersistedSetupDisposition> {
  const taskStore = f.authority.run(
    () => new TaskExecutionStore(f.project.contextRoot, f.project),
  );
  const existing = task(f)!;
  const before = JSON.parse(
    (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
  ) as Parameters<typeof getSetupTrackedDelta>[0];
  fs.writeFileSync(path.join(f.worktreePath, "yarn.lock"), "task dependency\n");
  fs.writeFileSync(path.join(f.worktreePath, unrelatedPath), "preserve me\n");
  f.isolated.git(f.worktreePath, "add", unrelatedPath);
  const failedAttemptAfter = JSON.parse(
    (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
  ) as Parameters<typeof getSetupTrackedDelta>[1];
  // The successful retry is a no-op: the committable effect from the failed
  // attempt remains in the worktree and must still be judged.
  const after = JSON.parse(
    (await captureSetupEffects(f.git, f.worktreePath)).toString("utf8"),
  ) as Parameters<typeof getSetupTrackedDelta>[1];
  const { candidates, contextDigest } = getSetupTrackedDelta(
    before,
    after,
    after,
  );
  const verdict = {
    version: 1 as const,
    contextDigest,
    changes: candidates.map((file) => ({
      path: file.path,
      identity: setupFileIdentity(file),
      relevant: file.path === "yarn.lock",
    })),
  };
  const scope = resolveSetupCommitScope(before, after, after, verdict);
  const beforeArtifact = taskStore.writePrimaryResultArtifact(
    "setup-before-integration",
    before,
  );
  const afterArtifact = taskStore.writePrimaryResultArtifact(
    "setup-after-integration",
    after,
  );
  const failedAttemptAfterArtifact = taskStore.writePrimaryResultArtifact(
    "setup-failed-attempt-after-integration",
    failedAttemptAfter,
  );
  const scopeArtifact = taskStore.writePrimaryResultArtifact(
    "setup-scope-integration",
    {
      version: 1,
      before: beforeArtifact.reference,
      after: afterArtifact.reference,
      current: after,
      verdict,
      scope,
    },
  );
  f.authority.run(() =>
    taskStore.compareAndSwap(f.services.card().id, existing.revision, {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
      setup: {
        command: "yarn install",
        status: "passed",
        worktreePath: f.worktreePath,
        before: beforeArtifact.reference,
        attemptBefore: failedAttemptAfterArtifact.reference,
        after: afterArtifact.reference,
        relevance: scopeArtifact.reference,
        attempts: 2,
        history: [
          {
            command: "yarn install",
            worktreePath: f.worktreePath,
            before: beforeArtifact.reference,
            after: failedAttemptAfterArtifact.reference,
            exitCode: 9,
            outcome: "failed",
          },
          {
            command: "yarn install",
            worktreePath: f.worktreePath,
            before: failedAttemptAfterArtifact.reference,
            after: afterArtifact.reference,
            exitCode: 0,
            outcome: "passed",
          },
        ],
      },
    }),
  );
  return {
    version: 1,
    artifactReference: scopeArtifact.reference,
    contextDigest,
    exclude: scope.exclude,
  };
}
async function poll(
  f: ReturnType<typeof reopenPublicationFixture>,
  tick = true,
) {
  if (tick) vi.setSystemTime(Date.now() + PUBLICATION_RECHECK_MS + 1);
  await pollProject(
    f.services.trello,
    f.git,
    f.services.github,
    {
      run: () => {
        throw new Error("Publication recovery must not invoke AI");
      },
    } as never,
    {} as never,
    f.project,
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    f.authority,
  );
}
function operation(
  f: ReturnType<typeof reopenPublicationFixture>,
  name: string,
) {
  return f.store
    .read()!
    .pendingOperations.find((entry) => entry.id === `initial:${name}`);
}
async function through(
  f: ReturnType<typeof reopenPublicationFixture>,
  name: string,
) {
  for (let count = 0; count < 12; count++) {
    if (operation(f, name)?.status === "completed") return;
    await poll(f);
  }
  throw new Error(
    `Did not complete ${name}: ${JSON.stringify(f.store.read()?.compatibility)}`,
  );
}
function task(f: ReturnType<typeof reopenPublicationFixture>) {
  return f.authority.run(() =>
    new TaskExecutionStore(f.project.contextRoot, f.project).read("card"),
  );
}

describe("setup-aware initial publication commit scope", () => {
  it("judges failed-attempt output across a successful no-op retry and preserves excluded bytes", async () => {
    const f = fixture();
    const disposition = await createSetupDisposition(f, "unrelated.setup");
    await begin(f, "feat: setup aware task", disposition);
    await through(f, "pr");
    expect(f.isolated.git(f.worktreePath, "show", "HEAD:yarn.lock")).toBe(
      "task dependency",
    );
    expect(() =>
      f.isolated.git(f.worktreePath, "show", "HEAD:unrelated.setup"),
    ).toThrow();
    expect(
      fs.readFileSync(path.join(f.worktreePath, "unrelated.setup"), "utf8"),
    ).toBe("preserve me\n");
    expect(f.isolated.git(f.worktreePath, "status", "--porcelain")).toContain(
      "?? unrelated.setup",
    );
    expect(
      f.isolated.git(
        path.join(f.root, "remote.git"),
        "show",
        "refs/heads/agent/card:yarn.lock",
      ),
    ).toBe("task dependency");
    expect(f.services.read().requests.length).toBeGreaterThan(0);
  });

  it("blocks publication when the immutable original setup baseline is missing", async () => {
    const f = fixture();
    const disposition = await createSetupDisposition(f, "unrelated.setup");
    const store = f.authority.run(
      () => new TaskExecutionStore(f.project.contextRoot, f.project),
    );
    const existing = task(f)!;
    f.authority.run(() =>
      store.compareAndSwap(f.services.card().id, existing.revision, {
        ...existing,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
        setup: { ...existing.setup!, before: `sha256:${"0".repeat(64)}` },
      }),
    );
    await begin(f, "feat: missing setup baseline", disposition);
    await expect(poll(f, false)).rejects.toThrow(/baseline|artifact|evidence/u);
    expect(f.services.read().requests).toHaveLength(0);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("0");
    expect(
      fs.readFileSync(path.join(f.worktreePath, "unrelated.setup"), "utf8"),
    ).toBe("preserve me\n");
  });

  it("blocks a final-attempt-only proof that overwrote the original baseline", async () => {
    const f = fixture();
    const disposition = await createSetupDisposition(f, "unrelated.setup");
    const store = f.authority.run(
      () => new TaskExecutionStore(f.project.contextRoot, f.project),
    );
    const existing = task(f)!;
    const retryBaseline = existing.setup!.attemptBefore!;
    f.authority.run(() =>
      store.compareAndSwap(f.services.card().id, existing.revision, {
        ...existing,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
        setup: { ...existing.setup!, before: retryBaseline },
      }),
    );
    await begin(f, "feat: overwritten setup baseline", disposition);
    await expect(poll(f, false)).rejects.toThrow(/durable setup evidence/u);
    expect(f.services.read().requests).toHaveLength(0);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("0");
  });

  it("blocks an old configured-setup publication checkpoint without a scope artifact", async () => {
    const f = fixture();
    await begin(f);
    f.project.repository.setupCommand = "yarn install";
    const parent = await f.git.getHeadSha(f.worktreePath);
    await expect(poll(f, false)).rejects.toThrow(/scope proof/u);
    expect(await f.git.getHeadSha(f.worktreePath)).toBe(parent);
    expect(f.services.read().requests).toHaveLength(0);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("0");
  });

  it("does not begin a configured-setup publication without durable disposition", async () => {
    const f = fixture();
    f.project.repository.setupCommand = "yarn install";
    const parent = await f.git.getHeadSha(f.worktreePath);
    await expect(begin(f)).rejects.toThrow(/commit-scope disposition/u);
    expect(await f.git.getHeadSha(f.worktreePath)).toBe(parent);
    expect(f.services.read().requests).toHaveLength(0);
  });

  it("blocks malformed or stale setup judgments before real Git commit or push", async () => {
    const f = fixture();
    const before = {
      files: [
        {
          path: "package.json",
          kind: "file",
          mode: 0o644,
          sha256: "before",
          bytes: 6,
        },
      ],
      tracked: ["package.json"],
      committable: ["package.json"],
      untracked: [],
    };
    const after = {
      files: [
        {
          path: "package.json",
          kind: "file",
          mode: 0o644,
          sha256: "after",
          bytes: 5,
        },
      ],
      tracked: ["package.json"],
      committable: ["package.json"],
      untracked: [],
    };
    const digest = getSetupTrackedDelta(before, after, after).contextDigest;
    const beforeHead = await f.git.getHeadSha(f.worktreePath);
    const stale = {
      version: 1,
      contextDigest: digest,
      changes: [
        {
          path: "package.json",
          identity: setupFileIdentity(after.files[0]!),
          relevant: true,
        },
      ],
    };
    expect(() => resolveSetupCommitScope(before, after, after, null)).toThrow();
    expect(() =>
      resolveSetupCommitScope(
        before,
        after,
        { ...after, files: [{ ...after.files[0]!, sha256: "later" }] },
        stale,
      ),
    ).toThrow(/context-stale/u);
    expect(await f.git.getHeadSha(f.worktreePath)).toBe(beforeHead);
    expect(f.services.read().requests).toHaveLength(0);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("0");
  });

  it("blocks a setup-included file changed after the verdict when resuming a checkpoint", async () => {
    const f = fixture();
    const disposition = await createSetupDisposition(f, "unrelated.setup");
    await begin(f, "feat: setup scope resume", disposition);
    const parent = await f.git.getHeadSha(f.worktreePath);
    fs.writeFileSync(
      path.join(f.worktreePath, "yarn.lock"),
      "tampered after review\n",
    );
    const reopened = reopenPublicationFixture(f.root);
    await expect(poll(reopened, false)).rejects.toThrow(/stale/u);
    expect(await reopened.git.getHeadSha(reopened.worktreePath)).toBe(parent);
    expect(reopened.services.read().requests).toHaveLength(0);
    expect(
      fs.readFileSync(path.join(reopened.worktreePath, "yarn.lock"), "utf8"),
    ).toBe("tampered after review\n");
  });
});

async function killPublicationAt(
  f: ReturnType<typeof fixture>,
  effect: string,
  barrier: string,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "tests/fixtures/p4-publication-crash.ts",
      f.root,
      barrier,
      String(Date.now()),
      effect,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  try {
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Child exited before publication regression barrier");
      }),
    ]);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    vi.setSystemTime(Date.parse(f.store.read()!.updatedAt) + 15_001);
    return reopenPublicationFixture(f.root, `resumed-${effect}-${barrier}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

function payload(
  f: ReturnType<typeof reopenPublicationFixture>,
  effect: string,
): unknown {
  const id = operation(f, effect)!.mutation!.intent.payloadId;
  return JSON.parse(
    fs.readFileSync(
      f.store.read()!.artifacts.find((artifact) => artifact.id === id)!.path,
      "utf8",
    ),
  ) as unknown;
}

describe("initial publication production checkpoint with independent simulated services", () => {
  it("rechecks the destination at the transport boundary and proves non-dispatch if config changes after the dispatch checkpoint", async () => {
    const f = fixture();
    await begin(f);
    const wrong = path.join(f.root, "unintended.git");
    f.isolated.git(f.root, "init", "--bare", "--initial-branch=main", wrong);
    const record = f.store.recordMutationEvent.bind(f.store);
    let change = true;
    f.store.recordMutationEvent = (...args) => {
      const result = record(...args);
      if (
        change &&
        args[2] === "initial:push" &&
        (args[4] as { type: string }).type === "dispatch"
      ) {
        change = false;
        f.isolated.git(
          f.project.repository.path,
          "config",
          "remote.origin.pushurl",
          wrong,
        );
      }
      return result;
    };
    await through(f, "commit");
    expect(operation(f, "push")?.status).toBe("failed");
    expect(
      operation(f, "push")?.mutation?.dispatches[0]?.response?.evidence
        .nonDeliveryProof,
    ).toBe("transport-proven-not-sent");
    expect(
      f.isolated.git(wrong, "for-each-ref", "--format=%(objectname)"),
    ).toBe("");
    expect(
      f.isolated.git(
        path.join(f.root, "remote.git"),
        "for-each-ref",
        "--format=%(objectname)",
        "refs/heads/agent/card",
      ),
    ).toBe("");
    f.isolated.git(
      f.project.repository.path,
      "config",
      "--unset-all",
      "remote.origin.pushurl",
    );
    await through(f, "comment");
    expect(operation(f, "push")?.mutation?.dispatches).toHaveLength(2);
    expect(task(f)?.phase).toBe("ci");
    expect(f.services.read().requests).toHaveLength(1);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("1");
  });
  it.each(["cleanup-proof", "destination-proof"] as const)(
    "preserves pre-fix publication state missing %s without inventing historical proof",
    async (missing) => {
      const f = fixture();
      await begin(f);
      if (missing === "cleanup-proof")
        f.authority.run(() =>
          f.authority.mutate(
            "initial-publication-v1",
            null,
            (value) => {
              const old = { ...(value as Record<string, unknown>) };
              delete old.commitCleanup;
              return { value: old, result: undefined };
            },
            (value) => value,
          ),
        );
      else {
        const store = f.store;
        const artifact = store.writeArtifact(
          Buffer.from(
            JSON.stringify({
              sha: "a".repeat(40),
              remote: "origin",
              branch: "agent/card",
            }),
          ),
          "application/json",
        );
        store.referenceMutationArtifact(store.read()!.revision, 1, artifact);
        store.persistMutationIntent(
          store.read()!.revision,
          1,
          "initial:push",
          {
            kind: "git-push",
            target: "refs/heads/agent/card",
            correlationId: "attempt:push",
            payloadId: artifact.id,
          },
          new Date().toISOString(),
        );
        store.recordMutationEvent(
          store.read()!.revision,
          1,
          "initial:push",
          1,
          {
            type: "dispatch",
            nextRecheckAt: new Date(Date.now() + 15_000).toISOString(),
          },
          new Date().toISOString(),
        );
      }
      const original = operation(f, "push");
      await poll(f);
      expect(operation(f, "push")).toEqual(original);
      expect(
        f.store.read()!.compatibility["initial-publication-v1"],
      ).not.toHaveProperty("gitDestinations");
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe("0");
      expect(f.services.read().requests).toHaveLength(0);
      expect(task(f)?.phase).toBe("publication");
    },
  );
  it.each([
    "pushurl",
    "multiple-pushurls",
    "duplicate-pushurls",
    "empty-pushurl",
    "multiple-fetchurls",
    "fetch-rewrite",
    "push-rewrite",
    "global-push-rewrite",
    "second-rewrite",
    "explicit-pushurl-rewrite",
  ] as const)(
    "rejects %s against the pinned repository before any publication write",
    async (mode) => {
      const f = fixture();
      const source = f.project.repository.path;
      const wrong = path.join(f.root, "unintended.git");
      f.isolated.git(f.root, "init", "--bare", "--initial-branch=main", wrong);
      const correct = "https://github.com/owner/repo.git";
      if (mode === "pushurl")
        f.isolated.git(source, "config", "remote.origin.pushurl", wrong);
      if (
        ["multiple-pushurls", "duplicate-pushurls", "empty-pushurl"].includes(
          mode,
        )
      ) {
        f.isolated.git(
          source,
          "config",
          "--add",
          "remote.origin.pushurl",
          correct,
        );
        f.isolated.git(
          source,
          "config",
          "--add",
          "remote.origin.pushurl",
          mode === "multiple-pushurls"
            ? wrong
            : mode === "empty-pushurl"
              ? ""
              : correct,
        );
      }
      if (mode === "multiple-fetchurls")
        f.isolated.git(source, "config", "--add", "remote.origin.url", correct);
      if (mode === "fetch-rewrite" || mode === "second-rewrite")
        f.isolated.git(source, "config", `url.${wrong}.insteadOf`, correct);
      if (mode === "second-rewrite") {
        f.isolated.git(
          source,
          "remote",
          "set-url",
          "origin",
          "publication-alias:",
        );
        f.isolated.git(
          source,
          "config",
          `url.${correct}.insteadOf`,
          "publication-alias:",
        );
      }
      if (mode === "push-rewrite" || mode === "explicit-pushurl-rewrite")
        f.isolated.git(source, "config", `url.${wrong}.pushInsteadOf`, correct);
      if (mode === "global-push-rewrite")
        f.isolated.git(
          source,
          "config",
          "--global",
          `url.${wrong}.pushInsteadOf`,
          correct,
        );
      if (mode === "explicit-pushurl-rewrite")
        f.isolated.git(source, "config", "remote.origin.pushurl", correct);
      if (mode === "pushurl") {
        expect(
          f.isolated.git(source, "remote", "get-url", "--all", "origin"),
        ).toBe(correct);
        expect(
          await f.git.getRemoteBranchSha(source, "origin", "main"),
        ).toMatch(/^[0-9a-f]{40}$/u);
      }
      const beforeWrong = f.isolated.git(
        wrong,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      );
      await expect(
        f.git.resolvePublicationDestinations(f.worktreePath, "owner/repo"),
      ).rejects.toThrow();
      await begin(f);
      await poll(f);
      await poll(f);
      expect(
        f.isolated.git(
          wrong,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ),
      ).toBe(beforeWrong);
      expect(
        f.isolated.git(
          path.join(f.root, "remote.git"),
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/agent/card",
        ),
      ).toBe("");
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe("0");
      expect(
        fs.readFileSync(path.join(f.worktreePath, "source.txt"), "utf8"),
      ).toBe("meaningful task implementation\n");
      expect(task(f)?.phase).toBe("publication");
      expect(
        f.authority.run(() =>
          new TaskMutationQueue(f.project.contextRoot, f.project).getActive(),
        ),
      ).not.toBeNull();
      expect(f.services.read().requests).toHaveLength(0);
    },
  );

  it("accepts a terminal Git URL alias rewrite and binds the concrete destination, not origin, into push intent", async () => {
    const f = fixture();
    const correct = "https://github.com/owner/repo.git";
    f.isolated.git(
      f.project.repository.path,
      "remote",
      "set-url",
      "origin",
      "publication-alias:",
    );
    f.isolated.git(
      f.project.repository.path,
      "config",
      `url.${correct}.insteadOf`,
      "publication-alias:",
    );
    await begin(f);
    await through(f, "comment");
    expect(payload(f, "push")).toMatchObject({
      destinations: { fetch: correct, push: correct },
      branch: "agent/card",
    });
    expect(operation(f, "push")?.mutation?.intent.target).toBe(
      `${correct}#refs/heads/agent/card`,
    );
    expect(task(f)?.phase).toBe("ci");
    expect(f.services.read().requests).toHaveLength(1);
  }, 30_000);

  it.each(["intent", "acceptance"] as const)(
    "rejects a push destination changed after %s and across restart without touching the unintended remote",
    async (barrier) => {
      const f = fixture();
      await begin(f);
      const restarted = await killPublicationAt(f, "push", barrier);
      const originalPayload = payload(restarted, "push");
      expect(originalPayload).toMatchObject({
        destinations: {
          fetch: "https://github.com/owner/repo.git",
          push: "https://github.com/owner/repo.git",
        },
      });
      const sha = f.isolated.git(f.worktreePath, "rev-parse", "HEAD");
      const wrong = path.join(f.root, "unintended.git");
      f.isolated.git(f.root, "init", "--bare", "--initial-branch=main", wrong);
      f.isolated.git(
        f.project.repository.path,
        "config",
        "remote.origin.pushurl",
        wrong,
      );
      for (let count = 0; count < 3; count++) await poll(restarted);
      expect(
        f.isolated.git(
          wrong,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ),
      ).toBe("");
      expect(operation(restarted, "push")?.status).toBe(
        barrier === "intent" ? "pending" : "ambiguous",
      );
      expect(payload(restarted, "push")).toEqual(originalPayload);
      expect(f.isolated.git(f.worktreePath, "rev-parse", "HEAD")).toBe(sha);
      expect(
        fs.readFileSync(path.join(f.worktreePath, "source.txt"), "utf8"),
      ).toBe("meaningful task implementation\n");
      expect(task(restarted)?.phase).toBe("publication");
      expect(
        restarted.authority.run(() =>
          new TaskMutationQueue(
            restarted.project.contextRoot,
            restarted.project,
          ).getActive(),
        ),
      ).not.toBeNull();
      expect(restarted.services.read().requests).toHaveLength(0);
      f.isolated.git(
        f.project.repository.path,
        "config",
        "--unset-all",
        "remote.origin.pushurl",
      );
      await through(restarted, "comment");
      expect(task(restarted)?.phase).toBe("ci");
      expect(operation(restarted, "push")?.mutation?.dispatches).toHaveLength(
        1,
      );
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe("1");
    },
  );

  it("fences even a changed concrete push URL spelling that still identifies the pinned repository", async () => {
    const f = fixture();
    await begin(f);
    await poll(f);
    f.isolated.git(
      f.project.repository.path,
      "config",
      "remote.origin.pushurl",
      "git@github.com:owner/repo.git",
    );
    await expect(
      f.git.resolvePublicationDestinations(f.worktreePath, "owner/repo"),
    ).resolves.toMatchObject({ push: "git@github.com:owner/repo.git" });
    await poll(f);
    expect(operation(f, "push")).toBeUndefined();
    expect(f.services.read().requests).toHaveLength(0);
    expect(task(f)?.phase).toBe("publication");
    f.isolated.git(
      f.project.repository.path,
      "config",
      "--unset-all",
      "remote.origin.pushurl",
    );
    await through(f, "comment");
    expect(task(f)?.phase).toBe("ci");
  });

  it.each([
    {
      cleanup: "strip",
      message: "\n\nfeat: leading blanks\n\n# retained comment\n",
    },
    { cleanup: "whitespace", message: "feat: trailing spaces  \n\nbody \t \n" },
    { cleanup: "strip", message: "feat: repeated blank lines\n\n\nbody\n\n\n" },
    {
      cleanup: "scissors",
      message:
        "feat: scissors\n\n# ------------------------ >8 ------------------------\nretained body\n",
    },
    { cleanup: "whitespace", message: "feat: no final newline" },
  ])(
    "recovers one verbatim commit after acceptance/restart with commit.cleanup=$cleanup and message $message",
    async ({ cleanup, message }) => {
      const f = fixture();
      f.isolated.git(
        f.project.repository.path,
        "config",
        "commit.cleanup",
        cleanup,
      );
      await begin(f, message);
      const restarted = await killPublicationAt(f, "commit", "acceptance");
      const expected = message.endsWith("\n") ? message : `${message}\n`;
      const raw = execFileSync("git", ["cat-file", "commit", "HEAD"], {
        cwd: f.worktreePath,
        env: f.isolated.env,
        encoding: "utf8",
      });
      expect(raw.slice(raw.indexOf("\n\n") + 2)).toBe(expected);
      expect(payload(restarted, "commit")).toMatchObject({
        message: expected,
        cleanup: "verbatim",
      });
      expect(operation(restarted, "commit")?.status).toBe("ambiguous");
      f.isolated.git(
        f.project.repository.path,
        "config",
        "commit.cleanup",
        "strip",
      );
      await through(restarted, "comment");
      expect(task(restarted)?.phase).toBe("ci");
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe("1");
      expect(operation(restarted, "commit")?.mutation?.dispatches).toHaveLength(
        1,
      );
      expect(restarted.services.read().prs).toHaveLength(1);
    },
    30_000,
  );
  it("resolves the actual canonical fixture Git destinations", async () => {
    const f = fixture();
    await expect(
      f.git.resolvePublicationDestinations(f.worktreePath, "owner/repo"),
    ).resolves.toEqual({
      fetch: "https://github.com/owner/repo.git",
      push: "https://github.com/owner/repo.git",
    });
  });
  it("cannot bypass an unresolved initial journal by supplying an expected-existing-PR option", async () => {
    const f = fixture();
    await begin(f);
    await expect(
      f.authority.run(() =>
        publishCard({
          project: f.project,
          card: f.services.card(),
          git: f.git,
          trello: f.services.trello,
          github: f.services.github,
          worktreePath: f.worktreePath,
          branch: "agent/card",
          commitSha: "a".repeat(40),
          reviewResult: "Passed",
          remediationResult: "Not required",
          expectedExistingPullRequestUrl:
            "https://github.com/owner/repo/pull/1",
        }),
      ),
    ).rejects.toBeInstanceOf(PublicationWaitingError);
    expect(operation(f, "commit")?.mutation?.dispatches).toHaveLength(1);
    expect(operation(f, "push")).toBeUndefined();
    await through(f, "comment");
    expect(task(f)?.phase).toBe("ci");
    expect(f.services.read().requests).toHaveLength(1);
  }, 30_000);
  it("preserves the content fence across publication waiting instead of staging newly changed source", async () => {
    const f = fixture();
    await begin(f);
    fs.writeFileSync(
      path.join(f.worktreePath, "source.txt"),
      "unverified later change\n",
    );
    await poll(f);
    expect(operation(f, "commit")).toBeUndefined();
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("0");
    expect(f.services.read().requests).toHaveLength(0);
    fs.writeFileSync(
      path.join(f.worktreePath, "source.txt"),
      "meaningful task implementation\n",
    );
    await through(f, "comment");
    expect(task(f)?.phase).toBe("ci");
  });

  it("rejects stale owners and redirected pins before they can dispatch a publication effect", async () => {
    const f = fixture();
    await begin(f);
    const restarted = reopenPublicationFixture(f.root, "new-owner");
    await expect(poll(f)).rejects.toThrow();
    expect(f.services.entries()).toEqual([]);
    const redirected = {
      ...restarted,
      project: {
        ...restarted.project,
        trello: { ...restarted.project.trello, reviewListId: "unowned-list" },
      },
    };
    await expect(poll(redirected)).rejects.toThrow("differs from attempt pins");
    expect(f.services.entries()).toEqual([]);
    await through(restarted, "comment");
    expect(task(restarted)?.phase).toBe("ci");
  });

  it("retries PR creation only after transport-proven non-dispatch, preserving both dispatch generations", async () => {
    const f = fixture();
    await begin(f);
    const create = f.services.github.createPullRequest.bind(f.services.github);
    f.services.github.createPullRequest = async () => {
      throw new ProcessExecutionError("gh", "not-spawned", "spawn-failure");
    };
    await through(f, "push");
    expect(operation(f, "pr")?.status).toBe("failed");
    expect(
      operation(f, "pr")?.mutation?.dispatches[0]?.response?.evidence
        .nonDeliveryProof,
    ).toBe("transport-proven-not-sent");
    f.services.github.createPullRequest = create;
    await through(f, "comment");
    expect(f.services.read().requests).toHaveLength(1);
    expect(operation(f, "pr")?.mutation?.dispatches).toHaveLength(2);
    expect(task(f)?.phase).toBe("ci");
  });
  it.each(["commit", "push", "move", "comment", "projection"] as const)(
    "discovers the original effect after SIGKILL following %s acceptance/durable handoff",
    async (effect) => {
      const f = fixture();
      await begin(f);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/p4-publication-crash.ts",
          f.root,
          effect === "projection" ? "projection" : "acceptance",
          String(Date.now()),
          effect,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("Child exited before effect barrier");
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        vi.setSystemTime(Date.parse(f.store.read()!.updatedAt) + 15_001);
        const restarted = reopenPublicationFixture(f.root, `after-${effect}`);
        if (effect !== "projection")
          expect(operation(restarted, effect)?.status).toBe("ambiguous");
        await through(restarted, "comment");
        if (effect === "projection") {
          // The killed writer had committed the workflow projection but never
          // reached notifyHumanReview. Its durable event must already exist.
          const outbox = new NotificationOutbox(
            restarted.store.storageRoot,
            restarted.project.id,
            () => restarted.authority.assertHeld(),
          );
          expect(outbox.records()).toHaveLength(1);
          expect(outbox.records()[0]?.dispatches).toEqual([]);
          const sink: string[] = [];
          await outbox.drain(
            {
              send: async (message) => {
                sink.push(message.text);
              },
            },
            () => {},
          );
          await outbox.drain(
            {
              send: async (message) => {
                sink.push(message.text);
              },
            },
            () => {},
          );
          expect(sink).toHaveLength(1);
          expect(sink[0]).toContain("Actual draft status:");
          await poll(restarted);
        }
        expect(task(restarted)?.phase).toBe("ci");
        expect(
          restarted.authority.run(() =>
            new TaskMutationQueue(
              restarted.project.contextRoot,
              restarted.project,
            ).getActive(),
          ),
        ).toBeNull();
        expect(
          f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
        ).toBe("1");
        expect(restarted.services.read().requests).toHaveLength(1);
        expect(restarted.services.read().prs).toHaveLength(1);
        expect(restarted.services.read().comments).toHaveLength(1);
        expect(
          restarted.services
            .entries()
            .filter((entry) => entry.type === "move-request"),
        ).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    },
  );
  it("rejects a lease-scoped publication without attempt authority instead of falling back to unjournaled production writes", async () => {
    const f = fixture();
    await expect(
      ProjectRunAuthority.withProjectLease(
        f.project.id,
        () => {},
        () => {},
        () =>
          publishCard({
            project: f.project,
            card: f.services.card(),
            git: f.git,
            trello: f.services.trello,
            github: f.services.github,
            worktreePath: f.worktreePath,
            branch: "agent/card",
            commitSha: "a".repeat(40),
            reviewResult: "Passed",
            remediationResult: "Not required",
          }),
      ),
    ).rejects.toThrow("requires durable attempt authority");
    expect(f.services.entries()).toEqual([]);
    expect(f.store.read()!.pendingOperations).toEqual([]);
  });

  it("preserves original legacy uncertainty and does not manufacture a journal intent or commit", async () => {
    const f = fixture();
    f.authority.run(() =>
      writePendingCommitState(f.project, "card", {
        version: 1,
        kind: "pending-commit",
        projectId: "p",
        cardId: "card",
        taskBranch: "agent/card",
        defaultBranch: "main",
        parentSha: "a".repeat(40),
      }),
    );
    const before = f.store.read()!;
    await expect(begin(f)).rejects.toThrow("Legacy uncertain publication");
    expect(f.store.read()).toEqual(before);
    expect(
      f.authority.run(() => readPendingCommitState(f.project, "card"))
        ?.parentSha,
    ).toBe("a".repeat(40));
    expect(f.services.entries()).toEqual([]);
    expect(f.isolated.git(f.worktreePath, "status", "--porcelain")).toContain(
      "source.txt",
    );
  });

  it("does not upgrade a legacy trusted commit into proof that PR creation was never dispatched", () => {
    const f = fixture();
    const before = f.store.read();
    expect(() =>
      f.authority.run(() =>
        beginInitialPublication(
          {
            project: f.project,
            card: f.services.card(),
            git: f.git,
            trello: f.services.trello,
            github: f.services.github,
            worktreePath: f.worktreePath,
            branch: "agent/card",
            commitSha: "a".repeat(40),
            reviewResult: "Passed",
            remediationResult: "Not required",
          },
          "body",
          `sha256:${"a".repeat(64)}`,
        ),
      ),
    ).toThrow("no durable dispatch provenance");
    expect(f.store.read()).toEqual(before);
    expect(f.services.entries()).toEqual([]);
  });

  it("sanitizes checkpoint, journal payloads, commit message, PR and Trello comment before hashing or dispatch", async () => {
    const f = fixture();
    const canary = "p4-publication-canary-93bb";
    registerProcessSecrets([canary]);
    const encoded = Buffer.from(canary).toString("base64");
    const sourceIdentity = await getTaskSessionSourceSnapshotIdentity(
      f.git,
      f.worktreePath,
    );
    f.authority.run(() =>
      beginInitialPublication(
        {
          project: f.project,
          card: { ...f.services.card(), name: `Task ${canary}` },
          git: f.git,
          trello: f.services.trello,
          github: f.services.github,
          worktreePath: f.worktreePath,
          branch: "agent/card",
          commitMessage: `feat: task ${encoded}`,
          reviewResult: `Passed ${canary}`,
          remediationResult: `Not required ${encoded}`,
        },
        `Task ${canary} ${encoded}`,
        sourceIdentity,
      ),
    );
    await through(f, "comment");
    for (const text of [
      JSON.stringify(f.store.read()),
      JSON.stringify(f.services.read()),
      f.isolated.git(f.worktreePath, "log", "-1", "--format=%B"),
      ...f.store
        .read()!
        .artifacts.map((artifact) => fs.readFileSync(artifact.path, "utf8")),
    ]) {
      expect(text).not.toContain(canary);
      expect(text).not.toContain(encoded);
    }
    expect(f.services.read().prs[0]!.body).toContain("[REDACTED]");
  });

  it("retries only a conclusive Trello rejection, keeping the verified PR and original dispatch history", async () => {
    const f = fixture();
    await begin(f);
    f.services.change({ rejectMove: true });
    await through(f, "pr");
    expect(task(f)?.pullRequest?.number).toBe(1);
    expect(operation(f, "move")?.status).toBe("failed");
    expect(
      operation(f, "move")?.mutation?.dispatches[0]?.response?.evidence
        .nonDeliveryProof,
    ).toBe("provider-rejected-before-acceptance");
    f.services.change({ rejectMove: false });
    const restarted = reopenPublicationFixture(f.root, "trello-restored");
    await through(restarted, "comment");
    expect(task(restarted)?.phase).toBe("ci");
    expect(operation(restarted, "move")?.mutation?.dispatches).toHaveLength(2);
    expect(
      restarted.services
        .entries()
        .filter((entry) => entry.type === "move-accept"),
    ).toHaveLength(1);
    expect(restarted.services.read().requests).toHaveLength(1);
  });

  it("runs automatic paced recovery in runOrchestrator even when startup Trello validation was deferred, with deduplicated attention", async () => {
    const f = fixture();
    await begin(f);
    f.services.change({ trelloOutage: true });
    const controller = new AbortController();
    const messages: string[] = [];
    const deferredValidation = vi.fn(async () => {
      throw new Error(
        "Must not reroute active publication to startup exhaustion",
      );
    });
    let ticks = 0;
    const timer = setInterval(() => {
      vi.setSystemTime(Date.now() + 15_001);
      ticks++;
      if (ticks === 25) f.services.change({ trelloOutage: false });
      if (ticks > 300) controller.abort();
    }, 5);
    try {
      await runOrchestrator(
        f.services.trello,
        f.git,
        f.services.github,
        {} as never,
        {} as never,
        {
          projects: [f.project],
          workflow: {
            contextRoot: f.project.contextRoot,
            pollIntervalSeconds: 0.002,
            logRetentionDays: 30,
            contextRetentionDays: 30,
          },
        } as Config,
        controller.signal,
        {
          send: async (message) => {
            messages.push(message.text);
            if (message.text.includes("Event: Human Review"))
              controller.abort();
          },
        },
        deferredValidation,
        new Map([
          [
            f.project.id,
            { authority: f.authority, pinned: f.store.read()!.pinned },
          ],
        ]),
      );
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeLessThan(300);
    expect(deferredValidation).not.toHaveBeenCalled();
    expect(
      messages.filter((text) => text.includes("Event: Attention Required")),
    ).toHaveLength(1);
    expect(
      messages.filter((text) => text.includes("Event: Human Review")),
    ).toHaveLength(1);
    expect(task(f)?.phase).toBe("ci");
    expect(f.services.read().requests).toHaveLength(1);
    expect(
      f.services.entries().some((entry) => entry.type === "trello-read:ready"),
    ).toBe(false);
  });

  it("routes the production commit entrypoint through journal, persists verified PR BEFORE Trello, and resumes lost move acknowledgment", async () => {
    let f = fixture();
    const identity = await getTaskSessionSourceSnapshotIdentity(
      f.git,
      f.worktreePath,
    );
    const evidence: VerifiedPublicationDecisionInput = {
      currentContentIdentity: identity,
      validationCommand: "true",
      validation: {
        command: "true",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 0,
        status: "passed",
        timedOut: false,
        aborted: false,
        diagnostic: "fixture quality evidence",
        contentIdentity: identity,
      },
      coverage: null,
      review: {
        version: 1,
        projectId: "p",
        cardId: "card",
        verdict: "pass",
        reviewedContentIdentity: identity,
        requirementAssessments: [
          {
            requirementId: "REQ-1",
            status: "satisfied",
            details: "fixture",
            evidence: ["source.txt"],
          },
        ],
        blockingFindings: [],
      },
    };
    await expect(
      f.authority.run(() =>
        publishTaskSessionCard({
          project: f.project,
          card: f.services.card(),
          git: f.git,
          trello: f.services.trello,
          github: f.services.github,
          worktreePath: f.worktreePath,
          branch: "agent/card",
          commitMessage: "feat: implement task",
          reviewResult: "Passed",
          remediationResult: "Not required",
          initialEvidence: evidence,
          verifyPreparedContent: async () => evidence,
        }),
      ),
    ).rejects.toBeInstanceOf(PublicationWaitingError);
    expect(operation(f, "commit")?.mutation?.dispatches).toHaveLength(1);
    f.services.change({ loseMoveResponse: true });
    await through(f, "pr");
    expect(task(f)?.pullRequest?.url).toBe(
      "https://github.com/owner/repo/pull/1",
    );
    expect(
      f.services.entries().filter((entry) => entry.type === "move-request"),
    ).toHaveLength(1);
    expect(
      operation(f, "move")?.mutation?.dispatches[0]?.response?.outcome,
    ).toBe("unknown");
    // The first move is already dispatched in the PR verification pass. Make
    // readback unavailable, then restart from durable state and restore reads.
    f.services.change({ trelloOutage: true });
    await poll(f);
    expect(task(f)?.phase).toBe("publication");
    expect(f.store.read()!.lifecycle).toBe("publication");
    const restarted = reopenPublicationFixture(f.root, "resumed-owner");
    f = { ...f, ...restarted };
    f.services.change({ trelloOutage: false });
    await through(f, "comment");
    expect(task(f)?.phase).toBe("ci");
    expect(f.services.read().prs).toHaveLength(1);
    expect(f.services.read().comments).toHaveLength(1);
    expect(
      f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
    ).toBe("1");
    expect(
      f.isolated.git(f.project.repository.path, "status", "--porcelain"),
    ).toBe("");
    expect(
      f.isolated.git(f.project.repository.path, "show", "HEAD:source.txt"),
    ).toBe("original");
    expect(
      f.authority.run(() =>
        new TaskMutationQueue(f.project.contextRoot, f.project).getActive(),
      ),
    ).toBeNull();
    expect(f.store.read()!.publicationState).toBe("open");
  });

  it("keeps a negative lookup ambiguous, handles late acceptance after restart, and never dispatches a second PR", async () => {
    const f = fixture();
    await begin(f);
    f.services.change({ delayCreation: true });
    await through(f, "push");
    expect(f.services.read().requests).toHaveLength(1);
    expect(f.services.read().prs).toHaveLength(0);
    const before = f.services.entries().length;
    await poll(f, false);
    await poll(f, false);
    expect(f.services.entries()).toHaveLength(before); // Controlled pacing includes reads.
    await poll(f);
    expect(operation(f, "pr")?.mutation?.observations.at(-1)?.outcome).toBe(
      "absent",
    );
    expect(task(f)?.pullRequest).toBeUndefined();
    expect(
      f.authority.run(() =>
        new TaskMutationQueue(f.project.contextRoot, f.project).getActive(),
      ),
    ).not.toBeNull();
    const restarted = reopenPublicationFixture(f.root, "resumed");
    restarted.services.acceptLate();
    await through(restarted, "comment");
    expect(task(restarted)?.phase).toBe("ci");
    expect(restarted.services.read().requests).toHaveLength(1);
    expect(restarted.services.read().prs).toHaveLength(1);
    const ledger = restarted.services.entries().map((entry) => entry.type);
    expect(ledger.indexOf("pr-request")).toBeLessThan(
      ledger.indexOf("pr-accept-late"),
    );
    expect(
      ledger.slice(
        ledger.indexOf("pr-request") + 1,
        ledger.indexOf("pr-accept-late"),
      ),
    ).toContain("pr-read");
  });

  it.each(["before-create", "accepted-response-lost"] as const)(
    "automatically resumes a prolonged GitHub outage (%s), without an absorbing attention state",
    async (fault) => {
      const f = fixture();
      await begin(f);
      const attentionAt = Date.now() + 5 * 60_000;
      if (fault === "before-create") f.services.change({ githubOutage: true });
      else {
        f.services.change({ loseCreationResponse: true });
        await through(f, "push");
        f.services.change({ githubOutage: true });
      }
      await poll(f);
      const beforePacedPolls = f.services.entries();
      await poll(f, false);
      await poll(f, false);
      expect(f.services.entries()).toEqual(beforePacedPolls);

      // Exercise repeated due checks without paying for 25 real Git/fsync cycles
      // just to advance Date. Leave a full recheck interval before the threshold.
      vi.setSystemTime(attentionAt - PUBLICATION_RECHECK_MS - 1);
      await poll(f, false);
      expect(
        f.store.read()!.compatibility["initial-publication-v1"],
      ).toMatchObject({ attention: false, attentionNotified: false });
      vi.setSystemTime(attentionAt);
      await poll(f, false);
      expect(
        f.store.read()!.compatibility["initial-publication-v1"],
      ).toMatchObject({ attention: true, attentionNotified: true });
      expect(task(f)?.phase).toBe("publication");
      expect(f.store.read()!.lifecycle).toBe("publication");
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe(fault === "before-create" ? "0" : "1");
      expect(
        f.services.entries().filter((entry) => entry.type === "pr-request"),
      ).toHaveLength(fault === "before-create" ? 0 : 1);
      const restarted = reopenPublicationFixture(f.root, "recovered");
      restarted.services.change({ githubOutage: false });
      await through(restarted, "comment");
      expect(task(restarted)?.phase).toBe("ci");
      expect(restarted.services.read().requests).toHaveLength(1);
      expect(restarted.services.read().prs).toHaveLength(1);
    },
  );

  it("does not mistake a successful move response for the intended destination or repeat the uncertain move", async () => {
    const f = fixture();
    await begin(f);
    f.services.change({ wrongMove: true });
    await through(f, "pr");
    for (let count = 0; count < 4; count++) await poll(f);
    expect(operation(f, "move")?.status).toBe("ambiguous");
    expect(task(f)?.phase).toBe("publication");
    expect(task(f)?.pullRequest?.number).toBe(1);
    expect(
      f.services.entries().filter((entry) => entry.type === "move-request"),
    ).toHaveLength(1);
    expect(f.services.read().comments).toHaveLength(0);
    f.services.change({ list: "review" }); // Later independent authoritative acceptance.
    await through(f, "comment");
    expect(task(f)?.phase).toBe("ci");
  });

  it.each([
    "intent",
    "dispatch",
    "acceptance",
    "response",
    "completion",
  ] as const)(
    "survives SIGKILL at PR %s through the production polling entrypoint",
    async (barrier) => {
      const f = fixture();
      await begin(f);
      // Finish commit, but do not advance push verification (which would create PR).
      await poll(f);
      await poll(f);
      expect(operation(f, "push")?.status).toBe("ambiguous");
      vi.setSystemTime(Date.now() + PUBLICATION_RECHECK_MS + 1);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/p4-publication-crash.ts",
          f.root,
          barrier,
          String(Date.now()),
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        const result = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("Child exited before publication barrier");
          }),
        ]);
        expect(result[0]).toBe("barrier");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        let restarted = reopenPublicationFixture(f.root, `after-${barrier}`);
        if (barrier === "completion")
          expect(operation(restarted, "pr")?.status).toBe("completed");
        if (barrier === "dispatch") {
          for (let count = 0; count < 3; count++) await poll(restarted);
          expect(restarted.services.read().requests).toHaveLength(0);
          expect(operation(restarted, "pr")?.status).toBe("ambiguous");
          expect(task(restarted)?.phase).toBe("publication");
          return; // A dispatch checkpoint alone cannot prove a request was not sent.
        }
        // Completion requires an additional due read: the first child pass either
        // dispatches creation or verifies it at the next due boundary.
        await through(restarted, "comment");
        expect(task(restarted)?.phase).toBe("ci");
        expect(restarted.services.read().requests).toHaveLength(1);
        expect(restarted.services.read().prs).toHaveLength(1);
        expect(
          f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
        ).toBe("1");
        restarted = reopenPublicationFixture(f.root, `final-${barrier}`);
        expect(
          restarted.store
            .read()!
            .pendingOperations.filter(
              (entry) => entry.kind === "github-pr-create",
            ),
        ).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    },
  );
});
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
