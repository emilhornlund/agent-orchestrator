import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireProjectOwnership,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import * as guard from "../src/refinement/refinement-card-guard.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
} from "../src/refinement/refinement-mutation-snapshot.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import { TrelloClient } from "../src/trello/trello-client.js";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-labels-"));
  roots.push(root);
  const f = await notificationAuthorityFixture(root, "labels", undefined, true);
  leases.push(f.lease);
  vi.stubGlobal("fetch", f.fetch);
  return f;
}
const snapshot = (authority: ProjectRunAuthority) =>
  authority.read(refinementMutationSnapshotKey, refinementMutationSnapshotSchema.parse)!;
const advance = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
};

it("requests only the content history available from Trello's nested REST endpoint", async () => {
  const fetch = vi.fn(async (url: URL) =>
    Response.json(url.pathname.endsWith("/members/me") ? { id: "actor" } : []),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    new TrelloClient({ apiKey: "key", token: "token" }).getRefinementHistory("card"),
  ).resolves.toEqual({ actorId: "actor", actions: [] });
  const url = fetch.mock.calls[1]![0];
  expect(url.pathname).toBe("/1/cards/card/actions");
  expect(url.searchParams.get("filter")).toBe("updateCard:name,updateCard:desc");
  expect(url.searchParams.get("limit")).toBe("1000");
});

it("completes refinement with label events excluded from polling responses", async () => {
  const f = await fixture();
  await f.poll();
  expect(f.history.some((action) => action.type === "addLabelToCard")).toBe(true);
  expect(f.history.some((action) => action.type === "removeLabelFromCard")).toBe(true);
  const history = await f.trello.getRefinementHistory(f.card.id);
  expect(history.actions.length).toBeGreaterThan(0);
  expect(history.actions.every((action) => action.type === "updateCard")).toBe(true);
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  expect(f.card.idLabels).toEqual([f.project.trello.featureLabelId]);
  expect(f.authority.store.read()!.lifecycle).toBe("refined");
});

it.each([
  ["add", "accepted"],
  ["remove", "accepted"],
  ["add", "lost"],
  ["remove", "lost"],
] as const)(
  "resumes a persisted %s label checkpoint after lease takeover (%s acknowledgement) without replay",
  async (direction, acknowledgement) => {
    const f = await fixture();
    // Reproduce the old guard's exact observation behavior: it requires label
    // history instead of receiving the journal's already-dispatched request.
    const originalGuard = guard.guardRefinementFields;
    const legacy = vi
      .spyOn(guard, "guardRefinementFields")
      .mockImplementation((trello, authority, stage, change) =>
        originalGuard(
          trello,
          authority,
          stage,
          stage === "after" &&
            change &&
            "labelId" in change &&
            change.present === (direction === "add")
            ? undefined
            : change,
        ),
      );
    let lost = false;
    vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
      const result = await f.fetch(url, init);
      if (
        acknowledgement === "lost" &&
        !lost &&
        url.pathname.includes("/idLabels") &&
        init?.method === (direction === "add" ? "POST" : "DELETE")
      ) {
        lost = true;
        throw new TypeError("lost label acknowledgement");
      }
      return result;
    });
    await f.poll();
    legacy.mockRestore();
    const before = f.authority.store.read()!;
    const pending = before.pendingOperations.find(
      (entry) => entry.kind === "trello-labels" && entry.status === "ambiguous",
    )!;
    expect(pending).toBeDefined();
    expect(pending.mutation!.dispatches).toHaveLength(1);
    expect(pending.mutation!.dispatches[0]!.response?.outcome).toBe(
      acknowledgement === "lost" ? "unknown" : "accepted",
    );
    expect(snapshot(f.authority).reconciliation?.pending).toBeDefined();
    expect(snapshot(f.authority).reconciliation?.conflict).toBeUndefined();
    expect(f.card.idList).toBe(f.project.trello.workingListId);
    expect(f.card.desc).toBe("Complete intended fields");
    expect(f.card.idLabels).toContain(f.project.trello.featureLabelId);
    const requests = [...f.requests];

    await f.lease.release();
    const lease = await acquireProjectOwnership(
      f.context.coordinationRoot,
      f.lease.identity,
      f.config.workflow.coordinationNamespaceId!,
    );
    leases.push(lease);
    const authority = await ProjectRunAuthority.resumeAttempt({
      projectId: f.project.id,
      attemptId: before.attemptId,
      pinned: f.pinned,
      projectLease: lease,
      coordinationRoot: f.context.coordinationRoot,
    });
    expect(authority.ownerGeneration).toBeGreaterThan(before.owner.generation);
    const trello = new TrelloClient({ apiKey: "key", token: "token" });
    const poll = () =>
      pollProject(
        trello,
        f.git,
        f.github,
        f.openCode,
        f.commands,
        f.project,
        new AbortController().signal,
        f.notifier,
        undefined,
        undefined,
        authority,
      );
    await poll();
    expect(f.requests.filter((request) => !request.startsWith("GET:"))).toEqual(
      requests.filter((request) => !request.startsWith("GET:")),
    );
    advance();
    await poll();
    await poll();
    expect(f.card.idList).toBe(f.project.trello.backlogListId);
    expect(f.card.idLabels).toEqual([f.project.trello.featureLabelId]);
    expect(f.engineer).toHaveBeenCalledOnce();
    const after = authority.store.read()!;
    expect(after.attemptId).toBe(before.attemptId);
    expect(after.lifecycle).toBe("refined");
    const reconciled = after.pendingOperations.find((entry) => entry.id === pending.id)!;
    expect(reconciled.status).toBe("completed");
    expect(reconciled.mutation!.dispatches).toEqual(pending.mutation!.dispatches);
    expect(snapshot(authority).reconciliation?.pending).toBeUndefined();
    expect(
      f.requests.filter((request) => request.startsWith("POST:") && request.includes("/idLabels")),
    ).toHaveLength(1);
    expect(
      f.requests.filter(
        (request) => request.startsWith("DELETE:") && request.includes("/idLabels"),
      ),
    ).toHaveLength(1);
    expect(
      f.requests.filter((request) => request.startsWith("POST:") && request.endsWith("/comments")),
    ).toHaveLength(1);
  },
  30_000,
);

it.each(["title", "description", "unrelated-label"] as const)(
  "preserves a concurrent %s change during label verification without further writes",
  async (field) => {
    const f = await fixture();
    let raced = false;
    vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
      const result = await f.fetch(url, init);
      if (!raced && init?.method === "POST" && url.pathname.endsWith("/idLabels")) {
        raced = true;
        if (field === "unrelated-label") f.card.idLabels.push("human-label");
        else {
          const key = field === "title" ? "name" : "desc";
          const old = { [key]: f.card[key] };
          f.card[key] = "Preserve human content";
          // Same-actor edits must not be mistaken for the bound label request.
          f.record({
            type: "updateCard",
            data: { old, card: { id: f.card.id, [key]: f.card[key] } },
          });
        }
        f.saveCard();
      }
      return result;
    });
    await f.poll();
    expect(raced).toBe(true);
    expect(snapshot(f.authority).reconciliation?.conflict).toBeDefined();
    const writes = f.requests.filter((request) => !request.startsWith("GET:"));
    advance();
    await f.poll();
    expect(f.requests.filter((request) => !request.startsWith("GET:"))).toEqual(writes);
    expect(f.card.idList).toBe(f.project.trello.workingListId);
    if (field === "unrelated-label") expect(f.card.idLabels).toContain("human-label");
    else expect(f.card[field === "title" ? "name" : "desc"]).toBe("Preserve human content");
    expect(f.authority.store.read()!.lifecycle).toBe("refinement");
  },
);

it("waits on absent label readback, then adopts late visibility without repeating the write", async () => {
  const f = await fixture();
  let sends = 0;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (init?.method === "POST" && url.pathname.endsWith("/idLabels")) {
      sends += 1;
      return Response.json({});
    }
    return f.fetch(url, init);
  });
  await f.poll();
  advance();
  await f.poll();
  expect(sends).toBe(1);
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(snapshot(f.authority).reconciliation?.pending).toBeDefined();
  expect(snapshot(f.authority).reconciliation?.conflict).toBeUndefined();
  f.card.idLabels.push(f.project.trello.featureLabelId);
  f.saveCard();
  advance();
  await f.poll();
  await f.poll();
  expect(sends).toBe(1);
  expect(f.engineer).toHaveBeenCalledOnce();
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  expect(f.authority.store.read()!.lifecycle).toBe("refined");
});

it("continues requiring content history rather than treating all matching fields as verified", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    const result = await f.fetch(url, init);
    return url.pathname.endsWith("/actions") &&
      url.searchParams.get("filter")?.includes("updateCard:name")
      ? Response.json([])
      : result;
  });
  await f.poll();
  advance();
  await f.poll();
  expect(f.card.desc).toBe("Complete intended fields");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(f.card.idLabels).toEqual([f.project.trello.refinementLabelId]);
  expect(snapshot(f.authority).reconciliation?.pending).toBeDefined();
  expect(
    f.authority.store
      .read()!
      .pendingOperations.some(
        (entry) => entry.kind === "trello-content" && entry.status === "ambiguous",
      ),
  ).toBe(true);
});

it("does not adopt a label applied before a journaled dispatch", async () => {
  const f = await fixture();
  const original = guard.refinementCardFields(f.card);
  guard.writeRefinementSnapshot(f.authority, {
    cardId: f.card.id,
    original,
    intended: { ...original, type: "feature", labels: [f.project.trello.featureLabelId] },
    reconciliation: { actorId: "orchestrator", cursor: null, verified: original },
  });
  f.card.idLabels.push(f.project.trello.featureLabelId);
  f.saveCard();
  await expect(
    f.authority.run(() => f.trello.addLabel(f.card.id, f.project.trello.featureLabelId)),
  ).rejects.toThrow("outside verified writes");
  const entry = f.authority.store
    .read()!
    .pendingOperations.find((item) => item.kind === "trello-labels")!;
  expect(entry.mutation!.dispatches).toHaveLength(0);
  expect(f.requests.every((request) => request.startsWith("GET:"))).toBe(true);
  expect(snapshot(f.authority).reconciliation?.conflict).toBeDefined();
});

it("rejects pending label fields that do not match the journal observer's single-label request", async () => {
  const f = await fixture();
  const originalGuard = guard.guardRefinementFields;
  vi.spyOn(guard, "guardRefinementFields").mockImplementation((trello, authority, stage, change) =>
    originalGuard(
      trello,
      authority,
      stage,
      stage === "after" && change && "labelId" in change
        ? { ...change, labelId: "different-label" }
        : change,
    ),
  );
  await f.poll();
  expect(snapshot(f.authority).reconciliation?.conflict).toContain("journaled single-label change");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(
    f.authority.store
      .read()!
      .pendingOperations.some(
        (entry) => entry.kind === "trello-labels" && entry.status === "ambiguous",
      ),
  ).toBe(true);
});

it("does not complete a label journal if full fields change at the final pinned readback", async () => {
  const f = await fixture();
  let sent = false;
  let reads = 0;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (sent && !init?.method && url.pathname === `/1/cards/${f.card.id}` && ++reads === 2) {
      const old = { desc: f.card.desc };
      f.card.desc = "Human change at pinned readback";
      f.record({ type: "updateCard", data: { old, card: { id: f.card.id, desc: f.card.desc } } });
      f.saveCard();
    }
    const result = await f.fetch(url, init);
    if (init?.method === "POST" && url.pathname.endsWith("/idLabels")) sent = true;
    return result;
  });
  await f.poll();
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(f.card.desc).toBe("Human change at pinned readback");
  expect(
    f.authority.store
      .read()!
      .pendingOperations.some(
        (entry) => entry.kind === "trello-labels" && entry.status === "ambiguous",
      ),
  ).toBe(true);
  const writes = f.requests.filter((request) => !request.startsWith("GET:"));
  advance();
  await f.poll();
  expect(f.requests.filter((request) => !request.startsWith("GET:"))).toEqual(writes);
  expect(f.card.idList).toBe(f.project.trello.workingListId);
});
