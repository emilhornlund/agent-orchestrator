import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  RunRegistry,
  RunStore,
  RunStoreConflictError,
  RunStoreUnsupportedVersionError,
  type RunStoreLease,
} from "../src/task-session/run-store.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import {
  runEventTypes,
  runLifecycleStates,
  runTransitionMatrix,
} from "../src/task-session/run-record.js";
import { provisionCoordinationNamespace } from "../src/coordination/project-ownership.js";
import { acquireProjectOwnership } from "../src/coordination/project-ownership.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-store-"));
  const lease: RunStoreLease = {
    integrationId: "integration-hash",
    instanceId: "instance-1",
    token: "lease-token-1",
    assertHeld() {},
  };
  const identity = {
    integrationId: lease.integrationId,
    projectId: "p",
    boardId: "board",
    lists: {
      ready: "ready",
      working: "working",
      review: "review",
      failed: "failed",
      done: "done",
      backlog: "backlog",
    },
    repository: "owner/repo",
    repositoryPath: path.join(root, "repo"),
    worktreeRoot: path.join(root, "work"),
    storageRoot: path.join(root, "state"),
  };
  fs.mkdirSync(identity.repositoryPath);
  fs.mkdirSync(identity.worktreeRoot);
  const store = new RunStore(
    identity.storageRoot,
    "attempt-1",
    identity,
    lease,
  );
  return { root, lease, identity, store };
}
function fixture(identity: ReturnType<typeof setup>["identity"]): RunRecord {
  return {
    version: 1,
    revision: 1,
    projectId: "p",
    cardId: "card",
    attemptId: "attempt-1",
    taskKind: "implementation",
    pinned: identity,
    lifecycle: "ready",
    checkpoint: "ready",
    publicationState: "none",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: "instance-1", token: "lease-token-1", generation: 1 },
    resources: [],
    pendingOperations: [],
    queue: [],
    budgets: {},
    sessions: {},
    artifacts: [],
    expectedTrelloListId: null,
    terminalSync: "not-applicable",
    terminalEvidence: null,
    legacy: {},
    compatibility: {},
    updatedAt: new Date(0).toISOString(),
  };
}
function terminalProof(
  identity: ReturnType<typeof setup>["identity"],
  event: string,
) {
  return {
    prOutcome:
      event === "merged"
        ? ("merged" as const)
        : event === "failed"
          ? ("no-pr-failure" as const)
          : ("closed-unmerged" as const),
    prObservationId: "pr-readback-1",
    prVerifiedAt: new Date(0).toISOString(),
    trelloListId:
      event === "merged"
        ? identity.lists.done
        : event === "failed"
          ? identity.lists.failed
          : identity.lists.backlog,
    trelloObservationId: "card-readback-1",
    trelloVerifiedAt: new Date(0).toISOString(),
  };
}
const start = (store: RunStore) =>
  store.transition(1, 1, null, "claim", "ready", "planning", (run) => run);

// One cell per allowed tuple, retaining the original forbidden-destination
// checks for EACH allowed target (including their deliberate repetition when an
// event/source has several allowed targets). Each cell uses real RunStore/fsync
// storage and retains its own directory; no single test owns the entire I/O sum.
const transitionCells = runEventTypes.flatMap((event) =>
  runLifecycleStates.flatMap((source) => {
    const declared = runTransitionMatrix[event]?.[source];
    if (declared === undefined) return [];
    const allowed = Array.isArray(declared) ? declared : [declared];
    return allowed.map((target) => ({ event, source, target, allowed }));
  }),
);

describe("RunStore authoritative foundation", () => {
  it.each(transitionCells)(
    "executes $event: $source -> $target and rejects every unlisted destination",
    ({ event, source, target, allowed }) => {
      const base = setup();
      let sequence = 0;
      const attemptId = `matrix-${sequence++}`;
      const store = new RunStore(
        base.identity.storageRoot,
        attemptId,
        base.identity,
        base.lease,
      );
      const initial = {
        ...fixture(base.identity),
        attemptId,
        cardId: `card-${sequence}`,
        taskKind:
          source === "refinement" ||
          event === "refinement-claimed" ||
          event === "refinement-completed"
            ? ("refinement" as const)
            : ("implementation" as const),
        lifecycle: source,
        checkpoint:
          source === "waiting"
            ? event === "wait-resumed"
              ? target
              : "planning"
            : source,
        publicationState: ["merged", "closed-unmerged", "cancelled"].includes(
          event,
        )
          ? ("open" as const)
          : ("none" as const),
        wait:
          source === "waiting"
            ? {
                reason: "test-wait",
                dependency: "test",
                since: new Date(0).toISOString(),
                retryAt: null,
              }
            : fixture(base.identity).wait,
        operation: { id: "matrix-op", kind: "matrix-test", generation: 1 },
        pendingOperations: [
          {
            id: "matrix-op",
            kind: "matrix-test",
            status:
              source === "waiting" && event === "wait-resumed"
                ? ("completed" as const)
                : ("running" as const),
            generation: 1,
            expectedRevision: 1,
            prerequisites: [],
            intent: {},
            ...(source === "waiting" && event === "wait-resumed"
              ? {
                  completionEvidence: "discovered-effect",
                  resolutionEvidence: {
                    disposition: "accepted" as const,
                    source: "process" as const,
                    observationId: "observed-op",
                    observedAt: new Date(0).toISOString(),
                  },
                }
              : {}),
          },
        ],
      };
      store.create(initial);
      const observation = [
        "refinement-completed",
        "merged",
        "closed-unmerged",
        "failed",
        "cancelled",
      ].includes(event);
      const claim = [
        "claim",
        "implementation-claimed",
        "refinement-claimed",
      ].includes(event);
      const result = store.transition(
        1,
        1,
        observation || claim ? null : { id: "matrix-op", generation: 1 },
        event,
        source,
        target,
        (run) => {
          if (event === "wait-entered")
            return {
              ...run,
              wait: {
                reason: "test-wait",
                dependency: "test",
                since: new Date(0).toISOString(),
                retryAt: null,
              },
            };
          if (event === "wait-resumed" || observation || claim) return run;
          return {
            ...run,
            pendingOperations: [
              {
                ...run.pendingOperations[0]!,
                status: "completed",
                completionEvidence: "matrix-evidence",
              },
            ],
          };
        },
        observation
          ? event === "refinement-completed"
            ? {
                prOutcome: "refinement-completed" as const,
                prObservationId: "refinement-observed",
                prVerifiedAt: new Date(0).toISOString(),
                trelloListId: base.identity.lists.backlog,
                trelloObservationId: "backlog-observed",
                trelloVerifiedAt: new Date(0).toISOString(),
              }
            : terminalProof(base.identity, event)
          : event === "wait-entered" || event === "wait-resumed" || claim
            ? undefined
            : "matrix-evidence",
      );
      expect(result.lifecycle).toBe(target);
      if (observation)
        expect(result.pendingOperations[0]?.status).toBe("ambiguous");
      for (const forbidden of runLifecycleStates.filter(
        (candidate) => !allowed.includes(candidate),
      )) {
        const rejectedId = `reject-${sequence++}`;
        const rejectedStore = new RunStore(
          base.identity.storageRoot,
          rejectedId,
          base.identity,
          base.lease,
        );
        rejectedStore.create({
          ...initial,
          attemptId: rejectedId,
          cardId: `card-${sequence}`,
        });
        expect(() =>
          rejectedStore.transition(
            1,
            1,
            observation || event === "claim"
              ? null
              : { id: "matrix-op", generation: 1 },
            event,
            source,
            forbidden,
            (run) => run,
            "matrix-evidence",
          ),
        ).toThrow();
      }
    },
  );
  it("allows only matrix transitions and rejects stale revisions, owner and operation completions", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "done", (run) => run),
    ).toThrow("Forbidden transition");
    const claimed = start(store);
    expect(claimed.lifecycle).toBe("planning");
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "planning", (run) => run),
    ).toThrow(RunStoreConflictError);
    expect(() =>
      store.transition(
        2,
        1,
        { id: "old-op", generation: 1 },
        "plan-approved",
        "planning",
        "implementation",
        (run) => run,
      ),
    ).toThrow(RunStoreConflictError);
    expect(() =>
      store.transition(
        2,
        9,
        null,
        "plan-approved",
        "planning",
        "implementation",
        (run) => run,
      ),
    ).toThrow(RunStoreConflictError);
  });
  it("rejects wait-resumed from every lifecycle other than waiting through the source matrix", () => {
    const base = setup();
    for (const state of runLifecycleStates.filter(
      (candidate) => candidate !== "waiting" && candidate !== "refined",
    )) {
      const attemptId = `not-waiting-${state}`;
      const store = new RunStore(
        base.identity.storageRoot,
        attemptId,
        base.identity,
        base.lease,
      );
      const terminal = ["done", "failed", "cancelled"].includes(state);
      const terminalEvent =
        state === "done"
          ? "merged"
          : state === "failed"
            ? "failed"
            : "cancelled";
      const initial = {
        ...fixture(base.identity),
        attemptId,
        cardId: `card-${state}`,
        lifecycle: state,
        checkpoint: terminal ? "planning" : state,
        publicationState:
          state === "done"
            ? "merged"
            : state === "cancelled"
              ? "closed-unmerged"
              : "none",
        terminalSync: terminal ? "verified" : "not-applicable",
        terminalEvidence: terminal
          ? terminalProof(base.identity, terminalEvent)
          : null,
        expectedTrelloListId: terminal
          ? terminalProof(base.identity, terminalEvent).trelloListId
          : null,
      } as RunRecord;
      store.create(initial);
      expect(() =>
        store.transition(
          1,
          1,
          null,
          "wait-resumed",
          state,
          state,
          (run) => run,
        ),
      ).toThrow("event/source pair");
    }
  });
  it("accepts a correctly fenced completion and resumes only its saved nonterminal checkpoint", () => {
    const { store, identity } = setup();
    const initial = fixture(identity);
    store.create(initial);
    const claim = store.transition(
      1,
      1,
      null,
      "claim",
      "ready",
      "planning",
      (run) => ({
        ...run,
        operation: { id: "op-1", kind: "planning", generation: 1 },
        pendingOperations: [
          {
            id: "op-1",
            kind: "planning",
            status: "running",
            generation: 1,
            expectedRevision: 1,
            prerequisites: [],
            intent: {},
          },
        ],
      }),
    );
    const completed = store.transition(
      claim.revision,
      1,
      { id: "op-1", generation: 1 },
      "plan-approved",
      "planning",
      "implementation",
      (run) => ({
        ...run,
        operation: { id: "op-2", kind: "implementation", generation: 1 },
        pendingOperations: [
          {
            ...run.pendingOperations[0]!,
            status: "completed",
            completionEvidence: "plan-persisted",
          },
          {
            id: "op-2",
            kind: "implementation",
            status: "running",
            generation: 1,
            expectedRevision: 2,
            prerequisites: [],
            intent: {},
          },
        ],
      }),
      "plan-persisted",
    );
    expect(completed.lifecycle).toBe("implementation");
    const waiting = store.transition(
      completed.revision,
      1,
      { id: "op-2", generation: 1 },
      "wait-entered",
      "implementation",
      "waiting",
      (run) => ({
        ...run,
        wait: {
          reason: "dependency-outage",
          dependency: "trello",
          since: new Date(0).toISOString(),
          retryAt: null,
        },
      }),
    );
    expect(waiting.checkpoint).toBe("implementation");
    expect(() =>
      store.transition(
        waiting.revision,
        1,
        { id: "op-2", generation: 1 },
        "wait-resumed",
        "waiting",
        "done",
        (run) => run,
      ),
    ).toThrow("unresolved");
    expect(() =>
      store.transition(
        waiting.revision,
        1,
        { id: "op-2", generation: 1 },
        "wait-resumed",
        "waiting",
        "implementation",
        (run) => run,
      ),
    ).toThrow("unresolved");
    const notFound = store.recordDiscoveredOperationOutcome(
      waiting.revision,
      1,
      "op-2",
      1,
      {
        disposition: "not-found",
        source: "trello",
        observationId: "trello-negative-lookup",
        observedAt: new Date(0).toISOString(),
      },
    );
    expect(notFound.lifecycle).toBe("waiting");
    expect(
      notFound.pendingOperations[1]?.status ??
        notFound.pendingOperations[0]?.status,
    ).toBe("ambiguous");
    expect(() =>
      store.transition(
        notFound.revision,
        1,
        { id: "op-2", generation: 1 },
        "wait-resumed",
        "waiting",
        "implementation",
        (run) => run,
      ),
    ).toThrow("unresolved");
    const reconciled = store.recordDiscoveredOperationOutcome(
      notFound.revision,
      1,
      "op-2",
      1,
      {
        disposition: "accepted",
        source: "trello",
        observationId: "late-accepted-effect",
        observedAt: new Date(1).toISOString(),
      },
    );
    expect(() =>
      store.transition(
        reconciled.revision,
        1,
        { id: "op-2", generation: 1 },
        "wait-resumed",
        "waiting",
        "done",
        (run) => run,
      ),
    ).toThrow("Forbidden transition");
    const resumed = store.transition(
      reconciled.revision,
      1,
      { id: "op-2", generation: 1 },
      "wait-resumed",
      "waiting",
      "implementation",
      (run) => run,
    );
    expect(resumed.lifecycle).toBe("implementation");
    expect(resumed.checkpoint).toBe("implementation");
  });
  it("terminal observation supersedes but preserves in-flight operations and blocks failure for open PRs", () => {
    const { store, identity, lease } = setup();
    store.create({ ...fixture(identity), publicationState: "open" });
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    registry.handoff(store, null, 1);
    const claimed = store.transition(
      1,
      1,
      null,
      "claim",
      "ready",
      "planning",
      (run) => ({
        ...run,
        operation: { id: "push", kind: "publish", generation: 1 },
        pendingOperations: [
          {
            id: "push",
            kind: "publish",
            status: "running",
            generation: 1,
            expectedRevision: 1,
            prerequisites: [],
            intent: { sha: "abc" },
          },
        ],
      }),
    );
    const active = store.transition(
      claimed.revision,
      1,
      { id: "push", generation: 1 },
      "wait-entered",
      "planning",
      "waiting",
      (run) => ({
        ...run,
        wait: {
          reason: "outage",
          dependency: "github",
          since: new Date(0).toISOString(),
          retryAt: null,
        },
        pendingOperations: [
          { ...run.pendingOperations[0]!, status: "ambiguous" },
        ],
      }),
    );
    expect(() =>
      store.transition(
        active.revision,
        1,
        null,
        "failed",
        "waiting",
        "failed",
        (run) => run,
        terminalProof(identity, "failed"),
      ),
    ).toThrow("cannot be terminally failed");
    const finished = store.transition(
      active.revision,
      1,
      null,
      "merged",
      "waiting",
      "done",
      (run) => run,
      terminalProof(identity, "merged"),
    );
    expect(finished.lifecycle).toBe("done");
    expect(finished.pendingOperations).toEqual(active.pendingOperations);
    expect(finished.publicationState).toBe("merged");
    const previousPointer = registry.read()!;
    const candidateId = "after-terminal";
    const candidateLease: RunStoreLease = {
      integrationId: identity.integrationId,
      instanceId: "restarted",
      token: "restart-token",
      assertHeld() {},
    };
    const candidate = new RunStore(
      identity.storageRoot,
      candidateId,
      identity,
      lease,
    );
    candidate.create({
      ...fixture(identity),
      attemptId: candidateId,
      cardId: "next-card",
    });
    expect(() => registry.handoff(candidate, previousPointer, 2)).toThrow(
      "verified terminal release",
    );
    const restarted = new RunStore(
      identity.storageRoot,
      "attempt-1",
      identity,
      candidateLease,
    );
    const takeover = restarted.takeOwnership(
      finished.revision,
      1,
      "restart-token",
    );
    const reconciled = restarted.recordDiscoveredOperationOutcome(
      takeover.revision,
      2,
      "push",
      1,
      {
        disposition: "conclusively-not-accepted",
        source: "github",
        observationId: "push-discovery-readback",
        observedAt: new Date(0).toISOString(),
        reason: "provider-rejected",
      },
    );
    expect(reconciled.lifecycle).toBe("done");
    expect(reconciled.pendingOperations[0]?.status).toBe("failed");
    const restartedCandidate = new RunStore(
      identity.storageRoot,
      candidateId,
      identity,
      candidateLease,
    );
    restartedCandidate.takeOwnership(1, 1, "restart-token");
    const restartedRegistry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      candidateLease,
    );
    restartedRegistry.handoff(restartedCandidate, previousPointer, 2);
    expect(restartedRegistry.reconcile()?.attemptId).toBe(candidateId);
  });
  it("rejects mutation of all pinned identity and owner provenance fields", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "planning", (run) => ({
        ...run,
        pinned: { ...run.pinned, boardId: "other" },
      })),
    ).toThrow("cannot modify pinned identity");
    expect(
      () =>
        new RunStore(identity.storageRoot, "different", identity, {
          ...setup().lease,
          integrationId: "other",
        }),
    ).toThrow("mismatched canonical lease");
    const mutations: ((run: RunRecord) => void)[] = [
      (run) => {
        run.pinned.boardId = "tampered";
      },
      (run) => {
        run.cardId = "other-card";
      },
      (run) => {
        run.revision = 100;
      },
      (run) => {
        run.owner.instanceId = "other-instance";
      },
      (run) => {
        run.owner.token = "other-token";
      },
    ];
    for (const mutate of mutations) {
      const isolated = setup();
      isolated.store.create(fixture(isolated.identity));
      expect(() =>
        isolated.store.transition(
          1,
          1,
          null,
          "claim",
          "ready",
          "planning",
          (run) => {
            mutate(run);
            return run;
          },
        ),
      ).toThrow();
      expect(isolated.store.read()?.revision).toBe(1);
    }
  });
  it("preserves unsupported and malformed records and validates storage location", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    const record = path.join(
      identity.storageRoot,
      "attempts",
      "attempt-1.json",
    );
    const original = '{"version":99}\n';
    fs.writeFileSync(record, original);
    expect(() => store.read()).toThrow(RunStoreUnsupportedVersionError);
    expect(fs.readFileSync(record, "utf8")).toBe(original);
    fs.writeFileSync(
      record,
      JSON.stringify({
        ...fixture(identity),
        pinned: { ...identity, boardId: "tampered" },
      }),
    );
    expect(() => store.read()).toThrow("identity/pins");
  });
  it("uses content addressed immutable artifacts and rejects missing or changed references", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    const ref = store.writeArtifact(Buffer.from("plan"));
    expect(ref.id).toBe(
      `sha256:${createHash("sha256").update("plan").digest("hex")}`,
    );
    const next = store.transition(
      1,
      1,
      null,
      "claim",
      "ready",
      "planning",
      (run) => ({ ...run, artifacts: [ref] }),
    );
    expect(next.artifacts).toHaveLength(1);
    fs.writeFileSync(ref.path, "tampered");
    expect(() => store.read()).toThrow("Missing or modified artifact");
  });
  it("rejects missing, duplicate, and interrupted artifact references without losing the prior record", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    const recordPath = path.join(
      identity.storageRoot,
      "attempts",
      "attempt-1.json",
    );
    const debrisPath = `${recordPath}.dead-process.tmp`;
    fs.writeFileSync(debrisPath, "partial");
    expect(store.read()?.revision).toBe(1);
    expect(fs.existsSync(debrisPath)).toBe(true);
    const ref = store.writeArtifact(Buffer.from("data"));
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "planning", (run) => ({
        ...run,
        artifacts: [ref, ref],
      })),
    ).toThrow();
    expect(store.read()?.revision).toBe(1);
    fs.unlinkSync(ref.path);
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "planning", (run) => ({
        ...run,
        artifacts: [ref],
      })),
    ).toThrow();
    expect(store.read()?.revision).toBe(1);
  });
  it("durably creates attempt before registry pointer handoff and rejects absent candidates", () => {
    const { store, identity, lease } = setup();
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    expect(() => registry.handoff(store, null, 1)).toThrow("durable candidate");
    store.create(fixture(identity));
    registry.handoff(store, null, 1);
    expect(registry.read()?.attemptId).toBe("attempt-1");
    expect(registry.reconcile()?.attemptId).toBe("attempt-1");
  });

  it("scopes unpointed-attempt reconciliation to its canonical integration", () => {
    const { root, lease, identity, store } = setup();
    const firstRegistry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    store.create(fixture(identity));
    firstRegistry.handoff(store, null, 1);

    const otherIdentity = {
      ...identity,
      integrationId: "another-integration",
      projectId: "other-project",
      boardId: "other-board",
    };
    const otherLease: RunStoreLease = {
      integrationId: otherIdentity.integrationId,
      instanceId: "other-instance",
      token: "other-token",
      assertHeld() {},
    };
    const otherStore = new RunStore(
      otherIdentity.storageRoot,
      "other-attempt",
      otherIdentity,
      otherLease,
    );
    otherStore.create({
      ...fixture(otherIdentity),
      projectId: otherIdentity.projectId,
      attemptId: "other-attempt",
      owner: {
        instanceId: otherLease.instanceId,
        token: otherLease.token,
        generation: 1,
      },
    });
    const otherRegistry = new RunRegistry(
      otherIdentity.storageRoot,
      otherIdentity.integrationId,
      otherLease,
    );
    otherRegistry.handoff(otherStore, null, 1);
    expect(firstRegistry.reconcile()?.attemptId).toBe("attempt-1");
    expect(otherRegistry.reconcile()?.attemptId).toBe("other-attempt");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opens a terminal predecessor with its persisted pins before a new-pin handoff", () => {
    const { root, lease, identity, store } = setup();
    const terminal = {
      ...fixture(identity),
      lifecycle: "failed" as const,
      checkpoint: "failed" as const,
      expectedTrelloListId: identity.lists.failed,
      terminalSync: "verified" as const,
      terminalEvidence: {
        prOutcome: "no-pr-failure" as const,
        prObservationId: "failure-readback",
        prVerifiedAt: new Date().toISOString(),
        trelloListId: identity.lists.failed,
        trelloObservationId: "failed-list-readback",
        trelloVerifiedAt: new Date().toISOString(),
      },
    };
    store.create(terminal);
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    registry.handoff(store, null, 1);

    const predecessor = RunStore.openWithPersistedIdentity(
      identity.storageRoot,
      terminal.attemptId,
      lease,
    );
    expect(predecessor?.read()?.pinned.repositoryPath).toBe(
      identity.repositoryPath,
    );
    const nextRepository = path.join(root, "new-repo");
    const nextWorktrees = path.join(root, "new-worktrees");
    fs.mkdirSync(nextRepository);
    fs.mkdirSync(nextWorktrees);
    const nextIdentity = {
      ...identity,
      repositoryPath: nextRepository,
      worktreeRoot: nextWorktrees,
    };
    const nextStore = new RunStore(
      identity.storageRoot,
      "attempt-next",
      nextIdentity,
      lease,
    );
    nextStore.create({
      ...fixture(nextIdentity),
      attemptId: "attempt-next",
    });
    registry.handoff(nextStore, registry.read(), 2);
    expect(registry.reconcile()?.attemptId).toBe("attempt-next");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("rejects active registry replacement and dangling pointer recovery", () => {
    const { store, identity, lease } = setup();
    store.create(fixture(identity));
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    registry.handoff(store, null, 1);
    const nextIdentity = { ...identity };
    const nextStore = new RunStore(
      identity.storageRoot,
      "attempt-2",
      nextIdentity,
      lease,
    );
    nextStore.create({ ...fixture(identity), attemptId: "attempt-2" });
    const prior = registry.read();
    expect(() => registry.handoff(nextStore, prior, 2)).toThrow(
      "active attempt",
    );
    fs.unlinkSync(
      path.join(identity.storageRoot, "attempts", "attempt-1.json"),
    );
    expect(() => registry.reconcile()).toThrow("missing attempt");
  });
  it("allows pointer replacement only after terminal reconciliation and compares prior pointer", () => {
    const { store, identity, lease } = setup();
    store.create(fixture(identity));
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    registry.handoff(store, null, 1);
    store.transition(1, 1, null, "claim", "ready", "planning", (run) => run);
    store.transition(
      2,
      1,
      null,
      "failed",
      "planning",
      "failed",
      (run) => run,
      terminalProof(identity, "failed"),
    );
    const nextId = "attempt-2";
    const next = new RunStore(identity.storageRoot, nextId, identity, lease);
    next.create({ ...fixture(identity), attemptId: nextId, cardId: "card-2" });
    const pointer = registry.read()!;
    expect(() => registry.reconcile()).toThrow(
      "Conflicting unpointed attempts",
    );
    expect(() =>
      registry.handoff(next, { ...pointer, generation: 0 }, 2),
    ).toThrow("compare-and-swap");
    registry.handoff(next, pointer, 2);
    expect(registry.reconcile()?.attemptId).toBe(nextId);
  });
  it("rejects work after lease loss and advances durable owner generation on takeover", () => {
    const { identity, lease } = setup();
    let held = true;
    const firstLease: RunStoreLease = {
      ...lease,
      assertHeld() {
        if (!held) throw new Error("lease lost");
      },
    };
    const firstStore = new RunStore(
      identity.storageRoot,
      "attempt-1",
      identity,
      firstLease,
    );
    firstStore.create(fixture(identity));
    held = false;
    expect(() => start(firstStore)).toThrow("lease lost");
    const nextLease: RunStoreLease = {
      integrationId: lease.integrationId,
      instanceId: "instance-2",
      token: "lease-token-2",
      assertHeld() {},
    };
    const nextStore = new RunStore(
      identity.storageRoot,
      "attempt-1",
      identity,
      nextLease,
    );
    const taken = nextStore.takeOwnership(1, 1, "lease-token-2");
    expect(taken.owner.generation).toBe(2);
    expect(taken.owner.instanceId).toBe("instance-2");
    expect(() =>
      nextStore.transition(
        2,
        1,
        null,
        "claim",
        "ready",
        "planning",
        (run) => run,
      ),
    ).toThrow(RunStoreConflictError);
  });
  it("recovers ownership after a real owner process dies and fences stale completions", async () => {
    const { identity } = setup();
    const coordinationRoot = path.join(
      identity.storageRoot,
      "restart-coordination",
    );
    fs.mkdirSync(coordinationRoot, { mode: 0o700, recursive: true });
    provisionCoordinationNamespace(coordinationRoot, "restart-namespace");
    const marker = path.join(identity.storageRoot, "owner-ready");
    const runUrl = new URL("../src/task-session/run-store.ts", import.meta.url)
      .href;
    const ownershipUrl = new URL(
      "../src/coordination/project-ownership.ts",
      import.meta.url,
    ).href;
    const script = `import fs from 'node:fs'; import { acquireProjectOwnership } from ${JSON.stringify(ownershipUrl)}; import { RunStore } from ${JSON.stringify(runUrl)}; const [encoded,coord,marker,recordJson]=process.argv.slice(1); const identity=JSON.parse(encoded); const owner=await acquireProjectOwnership(coord,{trelloBoardId:'board',githubRepository:'owner/repo'},'restart-namespace'); const lease={integrationId:identity.integrationId,instanceId:'dead-instance',token:'dead-token',assertHeld(){owner.assertHeld()}}; new RunStore(identity.storageRoot,'attempt-1',identity,lease).create({...JSON.parse(recordJson),owner:{instanceId:'dead-instance',token:'dead-token',generation:1}}); fs.writeFileSync(marker,'ready'); const a=new Int32Array(new SharedArrayBuffer(4));while(true)Atomics.wait(a,0,0,1000);`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(identity),
        coordinationRoot,
        marker,
        JSON.stringify(fixture(identity)),
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const acquired = await acquireProjectOwnership(
      coordinationRoot,
      { trelloBoardId: "board", githubRepository: "owner/repo" },
      "restart-namespace",
    );
    const nextLease: RunStoreLease = {
      integrationId: identity.integrationId,
      instanceId: "restarted",
      token: "new-token",
      assertHeld: () => acquired.assertHeld(),
    };
    const restarted = new RunStore(
      identity.storageRoot,
      "attempt-1",
      identity,
      nextLease,
    );
    const taken = restarted.takeOwnership(1, 1, "new-token");
    expect(taken.owner.generation).toBe(2);
    expect(() =>
      restarted.transition(
        2,
        1,
        null,
        "claim",
        "ready",
        "planning",
        (run) => run,
      ),
    ).toThrow(RunStoreConflictError);
    await acquired.release();
  });
  it("serializes subprocesses using actual canonical project ownership", async () => {
    const { identity, store } = setup();
    const coordinationRoot = path.join(identity.storageRoot, "coordination");
    fs.mkdirSync(coordinationRoot, { mode: 0o700, recursive: true });
    provisionCoordinationNamespace(coordinationRoot, "test-namespace");
    const runUrl = new URL("../src/task-session/run-store.ts", import.meta.url)
      .href;
    const ownershipUrl = new URL(
      "../src/coordination/project-ownership.ts",
      import.meta.url,
    ).href;
    const recordJson = JSON.stringify(fixture(identity));
    const barrier = path.join(identity.storageRoot, "lease-test-barrier");
    fs.mkdirSync(barrier);
    const script = `import fs from 'node:fs'; import { acquireProjectOwnership } from ${JSON.stringify(ownershipUrl)}; import { RunStore } from ${JSON.stringify(runUrl)}; const [encoded, coordination, index, recordJson, barrier] = process.argv.slice(1); setTimeout(()=>{console.error('child-timeout',process.argv,fs.readdirSync(barrier));process.exit(9)},8000); const identity=JSON.parse(encoded); fs.writeFileSync(barrier+'/'+index+'.attempted','1'); let owner; try { owner=await acquireProjectOwnership(coordination,{trelloBoardId:'board',githubRepository:'owner/repo'},'test-namespace'); } catch { fs.writeFileSync(barrier+'/'+index+'.lost','1'); process.exit(3); } const lease={integrationId:identity.integrationId,instanceId:'instance-'+index,token:'token-'+index,assertHeld(){owner.assertHeld()}}; const record=JSON.parse(recordJson); record.owner={instanceId:lease.instanceId,token:lease.token,generation:1}; const run=new RunStore(identity.storageRoot,'attempt-1',identity,lease); run.create(record); run.transition(1,1,null,'claim','ready','planning',r=>r); fs.writeFileSync(barrier+'/'+index+'.winner','1'); const a=new Int32Array(new SharedArrayBuffer(4)); while(!fs.existsSync(barrier+'/release')) Atomics.wait(a,0,0,10); await owner.release(); process.exit(0);`;
    const children = [0, 1].map((index) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          JSON.stringify(identity),
          coordinationRoot,
          String(index),
          recordJson,
          barrier,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const childExits = children.map(
      (child) =>
        new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? -1));
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolve(9);
          }, 8000).unref();
        }),
    );
    const childOutput: string[] = [];
    for (const child of children) {
      child.stdout?.on("data", (chunk: Buffer) =>
        childOutput.push(chunk.toString()),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        childOutput.push(chunk.toString()),
      );
    }
    for (
      let attempt = 0;
      attempt < 200 &&
      [0, 1].some(
        (index) => !fs.existsSync(path.join(barrier, `${index}.attempted`)),
      );
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (
      let attempt = 0;
      attempt < 200 &&
      (!fs.readdirSync(barrier).some((entry) => entry.endsWith(".winner")) ||
        !fs.readdirSync(barrier).some((entry) => entry.endsWith(".lost")));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(path.join(barrier, "release"), "release winner");
    const statuses = await Promise.all(childExits);
    expect(
      fs.readdirSync(barrier).filter((entry) => entry.endsWith(".attempted")),
      childOutput.join("\n"),
    ).toHaveLength(2);
    expect(
      fs.readdirSync(barrier).filter((entry) => entry.endsWith(".winner")),
      childOutput.join("\n"),
    ).toHaveLength(1);
    expect(
      fs.readdirSync(barrier).filter((entry) => entry.endsWith(".lost")),
      childOutput.join("\n"),
    ).toHaveLength(1);
    expect(statuses.filter((status) => status === 0)).toHaveLength(1);
    expect(statuses.sort()).toEqual([0, 3]);
    expect(store.read()?.revision).toBe(2);
    expect(
      fs
        .readdirSync(path.join(identity.storageRoot, "attempts"))
        .some((entry) => entry.endsWith(".lock")),
    ).toBe(false);
    const afterRelease = await Promise.race([
      acquireProjectOwnership(
        coordinationRoot,
        { trelloBoardId: "board", githubRepository: "owner/repo" },
        "test-namespace",
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "post-release canonical ownership acquisition timed out",
              ),
            ),
          3000,
        ),
      ),
    ]);
    await afterRelease.release();
  }, 20000);
  it("rejects symlink and non-regular state files", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    const file = path.join(identity.storageRoot, "attempts", "attempt-1.json");
    const backup = `${file}.backup`;
    fs.renameSync(file, backup);
    fs.symlinkSync(backup, file);
    expect(() => store.read()).toThrow("Unsafe or oversized state file");
  });
  it("rejects symlinked state ancestors and oversized state before replacing the previous revision", () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    expect(() =>
      store.transition(1, 1, null, "claim", "ready", "planning", (run) => ({
        ...run,
        legacy: { huge: "x".repeat(9 * 1024 * 1024) },
      })),
    ).toThrow("byte limit");
    expect(store.read()?.revision).toBe(1);
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "run-store-outside-"),
    );
    const parent = path.join(identity.storageRoot, "attempts");
    const moved = path.join(identity.storageRoot, "attempts-real");
    fs.renameSync(parent, moved);
    fs.symlinkSync(outside, parent, "dir");
    expect(() => store.read()).toThrow("Unsafe run storage path");
  });
  it("survives process death after temporary-file fsync and before atomic replacement", async () => {
    const { store, identity } = setup();
    store.create(fixture(identity));
    const marker = path.join(identity.storageRoot, "rename-barrier");
    const runUrl = new URL("../src/task-session/run-store.ts", import.meta.url)
      .href;
    const script = `import fs from 'node:fs'; import { RunStore } from ${JSON.stringify(runUrl)}; const [encoded, marker] = process.argv.slice(1); const identity=JSON.parse(encoded); const original=fs.renameSync; fs.renameSync=(from,to)=>{fs.writeFileSync(marker,'ready');const a=new Int32Array(new SharedArrayBuffer(4));while(true)Atomics.wait(a,0,0,1000);return original(from,to)}; const lease={integrationId:identity.integrationId,instanceId:'instance-1',token:'lease-token-1',assertHeld(){}}; new RunStore(identity.storageRoot,'attempt-1',identity,lease).transition(1,1,null,'claim','ready','planning',r=>r);`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(identity),
        marker,
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(store.read()?.revision).toBe(1);
  });
  it("recovers an interrupted registry handoff without mistaking the candidate for absent", async () => {
    const { store, identity, lease } = setup();
    store.create(fixture(identity));
    const registry = new RunRegistry(
      identity.storageRoot,
      identity.integrationId,
      lease,
    );
    const marker = path.join(identity.storageRoot, "pointer-barrier");
    const runUrl = new URL("../src/task-session/run-store.ts", import.meta.url)
      .href;
    const script = `import fs from 'node:fs'; import { RunRegistry, RunStore } from ${JSON.stringify(runUrl)}; const [encoded, marker] = process.argv.slice(1); const identity=JSON.parse(encoded); const original=fs.renameSync; fs.renameSync=(from,to)=>{if(String(to).includes('/registry/')){fs.writeFileSync(marker,'ready');const a=new Int32Array(new SharedArrayBuffer(4));while(true)Atomics.wait(a,0,0,1000)}return original(from,to)}; const lease={integrationId:identity.integrationId,instanceId:'instance-1',token:'lease-token-1',assertHeld(){}}; const candidate=new RunStore(identity.storageRoot,'attempt-1',identity,lease); new RunRegistry(identity.storageRoot,identity.integrationId,lease).handoff(candidate,null,1);`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(identity),
        marker,
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(() => registry.reconcile()).toThrow("without registry pointer");
    registry.handoff(store, null, 1);
    expect(registry.reconcile()?.attemptId).toBe("attempt-1");
  });
});
