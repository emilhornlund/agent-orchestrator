import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore, RunRegistry, type RunStoreLease } from "../src/task-session/run-store.js";
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
import {
  parseRunRecord,
  isConclusiveOperationResolution,
  type RunRecord,
} from "../src/task-session/run-record.js";
import {
  mutationPolicies,
  type MutationEvent,
  type MutationIntent,
} from "../src/task-session/durable-mutation.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const at = (seconds: number) => new Date(seconds * 1000).toISOString();
function fixture(lifecycle: "publication" | "human-review" = "publication") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-"));
  roots.push(root);
  const lease = {
    integrationId: "integration",
    instanceId: "owner",
    token: "lease",
    assertHeld() {},
  } satisfies RunStoreLease;
  const pinned: RunRecord["pinned"] = {
    integrationId: "integration",
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
  const reopen = () => new RunStore(pinned.storageRoot, "attempt", pinned, lease);
  const store = reopen();
  store.create({
    version: 1,
    revision: 1,
    projectId: "p",
    cardId: "card",
    attemptId: "attempt",
    taskKind: "implementation",
    pinned,
    lifecycle,
    checkpoint: lifecycle,
    publicationState: lifecycle === "human-review" ? "open" : "none",
    operation: { id: null, kind: null, generation: 0 },
    wait: { reason: null, dependency: null, since: null, retryAt: null },
    owner: { instanceId: "owner", token: "lease", generation: 1 },
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
    updatedAt: at(0),
  });
  const artifact = store.writeArtifact(
    Buffer.from(JSON.stringify({ sanitized: "outbound body / authoritative fields" })),
  );
  store.referenceMutationArtifact(1, 1, artifact);
  const intent = (kind: MutationIntent["kind"] = "trello-comment"): MutationIntent => ({
    kind,
    target: "card",
    correlationId: "attempt-comment-1",
    payloadId: artifact.id,
  });
  const evidence = (seconds: number) => ({
    observationId: `read-${seconds}`,
    observedAt: at(seconds),
    artifactId: artifact.id,
  });
  const add = (kind?: MutationIntent["kind"], id = "effect") =>
    store.persistMutationIntent(store.read()!.revision, 1, id, intent(kind), at(0));
  const event = (
    event: MutationEvent,
    seconds: number,
    target = store,
    owner = 1,
    generation?: number,
  ) => {
    const current = target.read()!;
    return target.recordMutationEvent(
      current.revision,
      owner,
      "effect",
      generation ?? current.pendingOperations[0]!.generation,
      event,
      at(seconds),
    );
  };
  const dispatch = () => event({ type: "dispatch", nextRecheckAt: at(10) }, 0);
  return {
    root,
    pinned,
    store,
    reopen,
    lease,
    artifact,
    intent,
    evidence,
    add,
    event,
    dispatch,
  };
}

/** External state survives application reopen; observer never reads RunStore to infer acceptance. */
class StatefulService {
  readonly ledger: string[] = [];
  readonly effects = new Map<string, string>();
  private inFlight: string | undefined;
  request(correlation: string) {
    this.ledger.push("request");
    this.inFlight = correlation;
  }
  accept() {
    this.ledger.push("accept");
    this.effects.set(this.inFlight!, "resource-42");
  }
  observe(correlation: string) {
    this.ledger.push("read");
    return this.effects.get(correlation);
  }
}

describe("durable workflow mutation foundation (REQ-WF-001)", () => {
  it.each(["terminal", "cancellation"] as const)(
    "resolves never-dispatched intent across SIGKILL after %s, then releases terminal ownership",
    async (barrier) => {
      const f = fixture("human-review");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/mutation-crash.ts",
          f.root,
          barrier,
          JSON.stringify(f.intent()),
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        const result = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("Fixture exited before cancellation crash barrier");
          }),
        ]);
        expect(result[0]).toBe("barrier");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const store = f.reopen();
        const before = store.read()!;
        expect(before.lifecycle).toBe("done");
        expect(before.pendingOperations[0]!.mutation!.dispatches).toEqual([]);
        f.lease.token = "resumed-owner";
        const resumed = store.takeOwnership(before.revision, 1, f.lease.token);
        let released = false;
        const authority = new ProjectRunAuthority("p", store, 2, async () => {
          released = true;
        });
        if (barrier === "terminal") {
          await expect(authority.releaseVerifiedTerminal()).rejects.toThrow();
          expect(() => f.event({ type: "dispatch", nextRecheckAt: at(10) }, 2, store, 2)).toThrow(
            /Terminal/,
          );
          expect(() =>
            f.event(
              {
                type: "cancel",
                reason: "terminal-observed",
                evidence: f.evidence(2),
              },
              2,
              store,
              1,
            ),
          ).toThrow(/generation/);
          store.recordMutationEvent(
            resumed.revision,
            2,
            "effect",
            1,
            {
              type: "cancel",
              reason: "terminal-observed",
              evidence: f.evidence(2),
            },
            at(2),
          );
        }
        const resolved = f.reopen().read()!.pendingOperations[0]!;
        expect(resolved.status).toBe("cancelled");
        expect(isConclusiveOperationResolution(resolved)).toBe(true);
        expect(resolved.completionEvidence).toBeUndefined();
        expect(resolved.resolutionEvidence).toBeUndefined();
        expect(resolved.mutation!.intent).toEqual(f.intent());
        expect(resolved.mutation!.cancellation!.ownerGeneration).toBe(
          barrier === "terminal" ? 2 : 1,
        );
        expect(resolved.mutation!.cancellation!.evidence).toEqual(f.evidence(2));
        expect(() =>
          f.event(
            {
              type: "cancel",
              reason: "terminal-observed",
              evidence: f.evidence(3),
            },
            3,
            store,
            2,
          ),
        ).toThrow(/immutable/);
        await authority.releaseVerifiedTerminal();
        expect(released).toBe(true);
        expect(fs.existsSync(path.join(f.root, "service.jsonl"))).toBe(false);
        expect(fs.existsSync(path.join(f.root, "service-resource.json"))).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );

  it("cancels a superseded never-dispatched execution, preserving both fences across restart", () => {
    const f = fixture("human-review");
    const original = f.add();
    const cancel = {
      type: "cancel",
      reason: "execution-superseded",
      evidence: f.evidence(1),
    } as const;
    expect(() => f.event(cancel, 1)).toThrow(/superseding execution/);
    expect(() => f.event({ ...cancel, reason: "terminal-observed" }, 1)).toThrow(
      /terminal observation/,
    );
    f.store.mutateCompatibility({
      expectedRevision: original.revision,
      expectedOwnerGeneration: 1,
      key: "supersession",
      current: () => ({ value: {}, result: null }),
      validate: (value) => value,
      runState: { operation: { id: "replacement", kind: "ci", generation: 1 } },
    });
    const store = f.reopen();
    const superseded = store.read()!;
    expect(() =>
      store.persistMutationIntent(superseded.revision, 1, "effect", f.intent(), at(1)),
    ).toThrow(/rebind/);
    expect(() =>
      store.recordMutationEvent(original.revision, 1, "effect", 1, cancel, at(1)),
    ).toThrow(/revision/);
    expect(() =>
      store.recordMutationEvent(superseded.revision, 1, "effect", 2, cancel, at(1)),
    ).toThrow(/generation/);
    f.event(cancel, 1, store);
    const cancelled = f.reopen().read()!.pendingOperations[0]!;
    expect(cancelled.mutation!.executionFence).toEqual(
      original.pendingOperations[0]!.mutation!.executionFence,
    );
    expect(cancelled.mutation!.cancellation!.executionFence).toEqual({
      id: "replacement",
      generation: 1,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(() => f.event({ type: "dispatch", nextRecheckAt: at(10) }, 2, store)).toThrow();
    const current = store.read()!;
    store.transition(
      current.revision,
      1,
      null,
      "feedback-ci-failed",
      "human-review",
      "ci",
      (run) => run,
    );
    expect(store.read()!.lifecycle).toBe("ci");
  });

  it.each(["uncertain", "not-delivered", "verified"] as const)(
    "refuses cancellation and rebinding after dispatch with %s evidence",
    (outcome) => {
      const f = fixture("human-review");
      f.add();
      f.dispatch();
      if (outcome !== "uncertain")
        f.event(
          {
            type: "observe",
            outcome,
            evidence: {
              ...f.evidence(10),
              ...(outcome === "not-delivered"
                ? { nonDeliveryProof: "transport-proven-not-sent" as const }
                : {}),
            },
            resourceId: "resource",
            attentionRequired: false,
          },
          10,
        );
      const current = f.store.read()!;
      f.store.mutateCompatibility({
        expectedRevision: current.revision,
        expectedOwnerGeneration: 1,
        key: "supersession",
        current: () => ({ value: {}, result: null }),
        validate: (value) => value,
        runState: {
          operation: { id: "replacement", kind: "ci", generation: 1 },
        },
      });
      const store = f.reopen();
      const before = store.read()!;
      expect(() =>
        f.event(
          {
            type: "cancel",
            reason: "execution-superseded",
            evidence: f.evidence(11),
          },
          11,
          store,
        ),
      ).toThrow(/dispatch/);
      expect(() =>
        store.persistMutationIntent(before.revision, 1, "effect", f.intent(), at(11)),
      ).toThrow(/rebind/);
      const forged = structuredClone(before);
      forged.pendingOperations[0]!.mutation!.cancellation = {
        reason: "execution-superseded",
        evidence: f.evidence(11),
        recordedAt: at(11),
        ownerGeneration: 1,
        executionFence: { id: "replacement", generation: 1 },
      };
      forged.pendingOperations[0]!.status = "cancelled";
      expect(() => parseRunRecord(forged)).toThrow();
      expect(f.reopen().read()).toEqual(before);
    },
  );
  it("rejects dispatch without intent, outcomes without dispatch, and unsubstantiated non-delivery", () => {
    const f = fixture();
    expect(() => f.event({ type: "dispatch", nextRecheckAt: at(10) }, 0, f.store, 1, 1)).toThrow(
      /operation generation/,
    );
    f.add();
    expect(() =>
      f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1),
    ).toThrow(/durable dispatch/);
    expect(() => f.event({ type: "dispatch", nextRecheckAt: at(0) }, 0)).toThrow(/future/);
    f.dispatch();
    const before = f.store.read();
    expect(() =>
      f.event({ type: "response", outcome: "not-delivered", evidence: f.evidence(1) }, 1),
    ).toThrow(/proof/);
    expect(f.reopen().read()).toEqual(before);
  });
  it.each(["intent", "dispatch", "acceptance", "response", "completion"] as const)(
    "survives SIGKILL at the %s barrier with independently stored service state",
    async (barrier) => {
      const f = fixture();
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/mutation-crash.ts",
          f.root,
          barrier,
          JSON.stringify(f.intent("github-pr-create")),
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        const result = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("Fixture exited before crash barrier");
          }),
        ]);
        expect(result[0]).toBe("barrier");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const restarted = f.reopen();
        const entry = restarted.read()!.pendingOperations[0]!;
        expect(entry.status).toBe(
          barrier === "intent" ? "pending" : barrier === "completion" ? "completed" : "ambiguous",
        );
        const resourceFile = path.join(f.root, "service-resource.json");
        if (["acceptance", "response", "completion"].includes(barrier)) {
          const resource = JSON.parse(fs.readFileSync(resourceFile, "utf8")) as {
            id: string;
            correlationId: string;
          };
          expect(resource.correlationId).toBe(f.intent().correlationId);
          if (barrier !== "completion")
            f.event(
              {
                type: "observe",
                outcome: "verified",
                resourceId: resource.id,
                evidence: f.evidence(10),
                attentionRequired: false,
              },
              10,
              restarted,
            );
          const ledger = fs
            .readFileSync(path.join(f.root, "service.jsonl"), "utf8")
            .trim()
            .split("\n");
          expect(ledger).toHaveLength(2);
          expect(restarted.read()!.pendingOperations[0]!.status).toBe("completed");
        } else expect(fs.existsSync(resourceFile)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );
  it("preserves a verified effect when subsequent intent validation or dispatch fails", () => {
    const f = fixture();
    f.add();
    f.dispatch();
    f.event(
      {
        type: "observe",
        outcome: "verified",
        evidence: f.evidence(10),
        resourceId: "comment-42",
        attentionRequired: false,
      },
      10,
    );
    const completed = f.store.read()!;
    expect(() =>
      f.store.persistMutationIntent(
        completed.revision,
        1,
        "later",
        { ...f.intent("trello-move"), payloadId: `sha256:${"0".repeat(64)}` },
        at(10),
      ),
    ).toThrow(/artifact/);
    expect(f.reopen().read()).toEqual(completed);
    expect(() =>
      f.store.persistMutationIntent(completed.revision, 1, "duplicate", f.intent(), at(10)),
    ).toThrow(/correlation/);
    expect(f.reopen().read()).toEqual(completed);
  });

  it("rejects a superseded worker but lets the coordinator discover its already-dispatched effect", () => {
    const f = fixture("human-review");
    f.add();
    f.dispatch();
    const current = f.store.read()!;
    expect(() =>
      f.store.transition(
        current.revision,
        1,
        null,
        "feedback-ci-failed",
        "human-review",
        "ci",
        (run) => run,
      ),
    ).toThrow(/pending workflow/);
    expect(() =>
      f.store.mutateCompatibility({
        expectedRevision: current.revision,
        expectedOwnerGeneration: 1,
        key: "test",
        current: () => ({ value: {}, result: null }),
        validate: (value) => value,
        lifecycleTransition: { event: "feedback-ci-failed", to: "ci" },
      }),
    ).toThrow(/pending workflow/);
    f.store.mutateCompatibility({
      expectedRevision: current.revision,
      expectedOwnerGeneration: 1,
      key: "test",
      current: () => ({ value: {}, result: null }),
      validate: (value) => value,
      runState: { operation: { id: "replacement", kind: "ci", generation: 1 } },
    });
    expect(() =>
      f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1),
    ).toThrow(/Superseded/);
    f.event(
      {
        type: "observe",
        outcome: "verified",
        evidence: f.evidence(10),
        resourceId: "original-effect",
        attentionRequired: false,
      },
      10,
    );
    expect(f.store.read()!.lifecycle).toBe("human-review");
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("completed");
  });

  it("preserves an unsupported on-disk mutation schema byte-for-byte", () => {
    const f = fixture();
    f.add();
    const file = path.join(f.pinned.storageRoot, "attempts/attempt.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
    raw.pendingOperations[0]!.mutation!.version = 99 as 1;
    const original = JSON.stringify(raw);
    fs.writeFileSync(file, original);
    expect(() => f.reopen().read()).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });
  it.each(Object.keys(mutationPolicies) as MutationIntent["kind"][])(
    "declares stable policy and rejects changed identity for %s",
    (kind) => {
      const f = fixture();
      const run = f.add(kind);
      expect(run.pendingOperations[0]!.mutation!.policy).toBe(mutationPolicies[kind]);
      expect(
        f.store.persistMutationIntent(run.revision, 1, "effect", f.intent(kind), at(0)),
      ).toEqual(run);
      expect(() =>
        f.store.persistMutationIntent(
          run.revision,
          1,
          "effect",
          { ...f.intent(kind), target: "other" },
          at(0),
        ),
      ).toThrow(/identity/);
    },
  );

  it.each(["intent", "dispatch", "acceptance", "response", "completion"] as const)(
    "preserves independently observed effect across %s boundary restart",
    (barrier) => {
      const f = fixture();
      const service = new StatefulService();
      f.add("github-pr-create");
      if (barrier !== "intent") f.dispatch();
      if (!["intent", "dispatch"].includes(barrier)) {
        service.request(f.intent().correlationId);
        service.accept();
      }
      if (["response", "completion"].includes(barrier))
        f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1);
      if (barrier === "completion")
        f.event(
          {
            type: "observe",
            outcome: "verified",
            evidence: f.evidence(10),
            resourceId: service.observe(f.intent().correlationId),
            attentionRequired: false,
          },
          10,
        );
      const restarted = f.reopen();
      if (barrier === "intent") {
        f.event({ type: "dispatch", nextRecheckAt: at(10) }, 0, restarted);
        service.request(f.intent().correlationId);
        service.accept();
      } else if (barrier === "dispatch") {
        // No request was sent, but that cannot be inferred from a dispatch checkpoint.
        f.event(
          {
            type: "observe",
            outcome: "absent",
            evidence: f.evidence(10),
            nextRecheckAt: at(20),
            attentionRequired: true,
          },
          10,
          restarted,
        );
        expect(() => f.event({ type: "dispatch", nextRecheckAt: at(30) }, 20, restarted)).toThrow(
          /discovery/,
        );
        expect(isConclusiveOperationResolution(restarted.read()!.pendingOperations[0]!)).toBe(
          false,
        );
        expect(service.effects.size).toBe(0);
        return;
      }
      if (barrier !== "completion")
        f.event(
          {
            type: "observe",
            outcome: "verified",
            evidence: f.evidence(10),
            resourceId: service.observe(f.intent().correlationId),
            attentionRequired: false,
          },
          10,
          restarted,
        );
      expect(service.effects.size).toBe(1);
      expect(service.ledger.filter((entry) => entry === "request")).toHaveLength(1);
      expect(restarted.read()!.pendingOperations[0]!.status).toBe("completed");
      expect(() => f.event({ type: "dispatch", nextRecheckAt: at(30) }, 20, restarted)).toThrow(
        /immutable/,
      );
    },
  );

  it.each(["trello-comment", "github-reply", "github-pr-create", "trello-move"] as const)(
    "does not resend %s after timeout/negative read and late acceptance",
    (kind) => {
      const f = fixture();
      const service = new StatefulService();
      f.add(kind);
      f.dispatch();
      service.request(f.intent().correlationId);
      f.event({ type: "response", outcome: "unknown", evidence: f.evidence(1) }, 1);
      expect(service.observe(f.intent().correlationId)).toBeUndefined();
      f.event(
        {
          type: "observe",
          outcome: "absent",
          evidence: f.evidence(10),
          nextRecheckAt: at(20),
          attentionRequired: true,
        },
        10,
      );
      const restarted = f.reopen();
      expect(() => f.event({ type: "dispatch", nextRecheckAt: at(30) }, 20, restarted)).toThrow(
        /discovery/,
      );
      expect(() =>
        f.event(
          {
            type: "observe",
            outcome: "uncertain",
            evidence: f.evidence(11),
            nextRecheckAt: at(30),
            attentionRequired: true,
          },
          11,
          restarted,
        ),
      ).toThrow(/not due/);
      service.accept();
      f.event(
        {
          type: "observe",
          outcome: "verified",
          evidence: f.evidence(20),
          resourceId: service.observe(f.intent().correlationId),
          attentionRequired: false,
        },
        20,
        restarted,
      );
      expect(service.ledger).toEqual(["request", "read", "accept", "read"]);
      expect(restarted.read()!.pendingOperations[0]!.status).toBe("completed");
    },
  );

  it("retains non-discoverable uncertainty, attention and paced rechecks across restart", () => {
    const f = fixture();
    f.add();
    f.dispatch();
    for (const seconds of [10, 20, 30])
      f.event(
        {
          type: "observe",
          outcome: "uncertain",
          evidence: f.evidence(seconds),
          nextRecheckAt: at(seconds + 10),
          attentionRequired: true,
        },
        seconds,
        f.reopen(),
      );
    const mutation = f.store.read()!.pendingOperations[0]!.mutation!;
    expect(mutation.dispatches).toHaveLength(1);
    expect(mutation.observations).toHaveLength(3);
    expect(mutation.nextRecheckAt).toBe(at(40));
    expect(mutation.attentionRequired).toBe(true);
  });

  it("retries only proven non-delivery, retaining the earlier dispatch and fencing late results", () => {
    const f = fixture();
    f.add();
    f.dispatch();
    f.event(
      {
        type: "response",
        outcome: "not-delivered",
        evidence: {
          ...f.evidence(1),
          nonDeliveryProof: "provider-rejected-before-acceptance",
        },
      },
      1,
    );
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("failed");
    expect(() => f.event({ type: "dispatch", nextRecheckAt: at(20) }, 2)).toThrow(/not due/);
    f.event({ type: "dispatch", nextRecheckAt: at(20) }, 10);
    expect(f.store.read()!.pendingOperations[0]!.mutation!.dispatches).toHaveLength(2);
    expect(() =>
      f.event(
        { type: "response", outcome: "accepted", evidence: f.evidence(11) },
        11,
        f.store,
        1,
        1,
      ),
    ).toThrow(/generation/);
  });

  it("fences stale revisions and owners; new owner discovers rather than replaying", () => {
    const f = fixture();
    f.add();
    const dispatched = f.dispatch();
    f.lease.token = "new-token";
    f.store.takeOwnership(dispatched.revision, 1, "new-token");
    expect(() =>
      f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1),
    ).toThrow(/generation/);
    expect(() =>
      f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1, f.store, 2),
    ).toThrow(/Stale/);
    f.event(
      {
        type: "observe",
        outcome: "verified",
        evidence: f.evidence(10),
        resourceId: "actual-resource",
        attentionRequired: false,
      },
      10,
      f.store,
      2,
    );
    expect(() =>
      f.store.recordMutationEvent(
        dispatched.revision,
        2,
        "effect",
        1,
        { type: "dispatch", nextRecheckAt: at(30) },
        at(20),
      ),
    ).toThrow(/revision/);
  });

  it("preserves legacy entries without fabricating mutation proof and rejects malformed extensions", () => {
    const f = fixture();
    const old = f.store.read()!;
    expect(parseRunRecord(old)).toEqual(old);
    f.add();
    f.dispatch();
    const run = f.store.read()!;
    for (const mutate of [
      (r: RunRecord) => {
        r.pendingOperations[0]!.mutation!.version = 2 as 1;
      },
      (r: RunRecord) => {
        r.pendingOperations[0]!.mutation!.policy = "discoverable";
      },
      (r: RunRecord) => {
        r.pendingOperations[0]!.status = "completed";
      },
      (r: RunRecord) => {
        r.artifacts = [];
      },
      (r: RunRecord) => {
        r.pendingOperations.push(r.pendingOperations[0]!);
      },
    ]) {
      const broken = structuredClone(run);
      mutate(broken);
      expect(() => parseRunRecord(broken)).toThrow();
    }
    expect(() =>
      f.event(
        {
          type: "observe",
          outcome: "verified",
          evidence: f.evidence(10),
          attentionRequired: false,
        },
        10,
      ),
    ).toThrow(/identity/);
    expect(f.reopen().read()).toEqual(run);
  });

  it("does not complete on accepted response and blocks terminal release until uncertainty resolves", async () => {
    const f = fixture("human-review");
    f.add();
    f.dispatch();
    f.event({ type: "response", outcome: "accepted", evidence: f.evidence(1) }, 1);
    expect(f.store.read()!.pendingOperations[0]!.status).toBe("ambiguous");
    // Terminal PR/Trello evidence does not erase already-dispatched effects.
    const current = f.store.read()!;
    f.store.transition(current.revision, 1, null, "merged", "human-review", "done", (run) => run, {
      prOutcome: "merged",
      prObservationId: "pr",
      prVerifiedAt: at(10),
      trelloListId: "done",
      trelloObservationId: "card",
      trelloVerifiedAt: at(10),
    });
    let released = false;
    const authority = new ProjectRunAuthority("p", f.store, 1, async () => {
      released = true;
    });
    await expect(authority.releaseVerifiedTerminal()).rejects.toThrow(/synchronization/);
    expect(released).toBe(false);
    f.event(
      {
        type: "observe",
        outcome: "verified",
        evidence: f.evidence(10),
        resourceId: "comment-42",
        attentionRequired: false,
      },
      10,
    );
    await authority.releaseVerifiedTerminal();
    expect(released).toBe(true);
    expect(
      f.reopen().read()!.pendingOperations[0]!.mutation!.dispatches[0]!.response!.outcome,
    ).toBe("accepted");
  });

  it("releases terminal workflow and hands off the registry while old notification acceptance remains ambiguous", async () => {
    const f = fixture("human-review");
    const outbox = new NotificationOutbox(
      f.pinned.storageRoot,
      "p",
      () => {},
      () => 0,
    );
    outbox.enqueue("attempt:ready", { subject: "PR ready", text: "Task card" });
    await outbox.drain(
      {
        send: async () => {
          throw new Error("lost SMTP acknowledgment");
        },
      },
      () => {},
    );
    const current = f.store.read()!;
    const terminal = f.store.transition(
      current.revision,
      1,
      null,
      "merged",
      "human-review",
      "done",
      (run) => run,
      {
        prOutcome: "merged",
        prObservationId: "pr",
        prVerifiedAt: at(0),
        trelloListId: "done",
        trelloObservationId: "card",
        trelloVerifiedAt: at(0),
      },
    );
    let released = false;
    await new ProjectRunAuthority("p", f.store, 1, async () => {
      released = true;
    }).releaseVerifiedTerminal();
    expect(released).toBe(true);
    expect(terminal.pendingOperations).toEqual([]);
    const registry = new RunRegistry(f.pinned.storageRoot, "integration", f.lease);
    registry.handoff(f.store, null, 1);
    const next = new RunStore(f.pinned.storageRoot, "next", f.pinned, f.lease);
    next.create({
      ...terminal,
      attemptId: "next",
      artifacts: [],
      cardId: "next-card",
      revision: 1,
      lifecycle: "preparing",
      checkpoint: "preparing",
      publicationState: "none",
      terminalSync: "not-applicable",
      terminalEvidence: null,
      expectedTrelloListId: null,
    });
    registry.handoff(next, registry.read(), 2);
    expect(registry.read()?.attemptId).toBe("next");
    const reopened = new NotificationOutbox(
      f.pinned.storageRoot,
      "p",
      () => {},
      () => 15_000,
    );
    let sends = 0;
    reopened.enqueue("next:failed", { subject: "Failed", text: "Next task" }, "failed");
    await reopened.drain(
      {
        send: async () => {
          sends++;
        },
      },
      () => {},
    );
    expect(sends).toBe(1);
    expect(
      reopened.records().find((entry) => entry.eventKey === "attempt:ready")?.dispatches[0]
        ?.outcome,
    ).toBe("ambiguous");
  });
});
