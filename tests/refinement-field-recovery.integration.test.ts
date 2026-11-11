import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import {
  refinementMutationSnapshotKey,
  refinementMutationSnapshotSchema,
} from "../src/refinement/refinement-mutation-snapshot.js";
import type { ProjectOwnershipLease } from "../src/coordination/project-ownership.js";

const roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinement-fields-"));
  roots.push(root);
  const f = await notificationAuthorityFixture(root, "fields", undefined, true);
  leases.push(f.lease);
  vi.stubGlobal("fetch", f.fetch);
  return f;
}

it("completes the actual refinement workflow with full attributed fields", async () => {
  const f = await fixture();
  await f.poll();
  expect(f.card).toMatchObject({
    name: "Refined task",
    desc: "Complete intended fields",
    idList: f.project.trello.backlogListId,
    idLabels: [f.project.trello.featureLabelId],
  });
  expect(
    f.authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    )?.reconciliation,
  ).toMatchObject({
    verified: {
      title: "Refined task",
      description: "Complete intended fields",
      labels: [f.project.trello.featureLabelId],
    },
  });
  expect(f.authority.store.read()!.lifecycle).toBe("refined");
});

it.each(["different-actor", "same-actor"])(
  "preserves a %s human edit accepted between final read and write",
  async (actor) => {
    const f = await fixture();
    let raced = false;
    vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
      if (
        !raced &&
        init?.method === "PUT" &&
        String(init.body).includes('"name"')
      ) {
        raced = true;
        const old = { name: f.card.name, desc: f.card.desc };
        f.card.name = "Human title";
        f.card.desc = "Human content";
        f.record(
          {
            type: "updateCard",
            data: {
              old,
              card: { id: f.card.id, name: f.card.name, desc: f.card.desc },
            },
          },
          actor === "same-actor" ? "orchestrator" : "human",
        );
      }
      return f.fetch(url, init);
    });
    await f.poll();
    expect(raced).toBe(true);
    expect(f.card.idList).toBe(f.project.trello.workingListId);
    const state = f.authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    )!;
    expect(state.reconciliation?.conflict).toContain(
      "Concurrent or unattributable",
    );
    expect(JSON.stringify(state.reconciliation?.evidence)).toContain(
      "Human content",
    );
    expect(f.authority.store.read()!.lifecycle).not.toBe("refined");
    expect(
      f.requests.filter((r) => r.startsWith("POST:") && r.includes("idLabels")),
    ).toEqual([]);
  },
);

it("reconciles an accepted label write after acknowledgement loss without repeating content or labels", async () => {
  const f = await fixture();
  let lost = false;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    const result = await f.fetch(url, init);
    if (!lost && init?.method === "POST" && url.pathname.endsWith("idLabels")) {
      lost = true;
      throw new TypeError("lost acknowledgement");
    }
    return result;
  });
  await f.poll();
  expect(lost).toBe(true);
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  const writes = f.requests.filter(
    (r) =>
      r.startsWith("PUT:") || (r.startsWith("POST:") && r.includes("idLabels")),
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60000);
  await f.poll();
  await f.poll();
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  expect(f.engineer).toHaveBeenCalledOnce();
  expect(
    f.requests
      .filter(
        (r) =>
          r.startsWith("PUT:") ||
          (r.startsWith("POST:") && r.includes("idLabels")),
      )
      .filter((r) => !r.endsWith(f.card.id)),
  ).toEqual(writes.filter((r) => !r.endsWith(f.card.id)));
  expect(
    f.requests.filter((r) => r.startsWith("POST:") && r.includes("idLabels")),
  ).toHaveLength(1);
});

it("retains human content encountered while reconciling a partial update", async () => {
  const f = await fixture();
  let lost = false;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    const result = await f.fetch(url, init);
    if (!lost && init?.method === "POST" && url.pathname.endsWith("idLabels")) {
      lost = true;
      throw new TypeError("lost acknowledgement");
    }
    return result;
  });
  await f.poll();
  const old = { desc: f.card.desc };
  f.card.desc = "Preserve human revision";
  f.record(
    {
      type: "updateCard",
      data: { old, card: { id: f.card.id, desc: f.card.desc } },
    },
    "human",
  );
  const writes = f.requests.filter((request) => !request.startsWith("GET:"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60000);
  await f.poll();
  expect(f.card.desc).toBe("Preserve human revision");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(f.requests.filter((request) => !request.startsWith("GET:"))).toEqual(
    writes,
  );
  expect(
    f.authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    )?.reconciliation?.conflict,
  ).toBeDefined();
});
