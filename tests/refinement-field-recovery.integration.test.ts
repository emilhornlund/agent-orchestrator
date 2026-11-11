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

it("fails exhausted invalid analysis only after verifying untouched original fields and the Failed transition", async () => {
  const f = await fixture();
  f.engineer.mockImplementation(async ({ cwd }) => {
    const { getRefinementResultPath } =
      await import("../src/refinement/refinement-result.js");
    fs.mkdirSync(path.dirname(getRefinementResultPath(cwd)), {
      recursive: true,
    });
    fs.writeFileSync(getRefinementResultPath(cwd), "{}");
    return { exitCode: 0, output: "", errorOutput: "" };
  });
  await f.poll();
  expect(f.engineer).toHaveBeenCalledTimes(3);
  expect(f.card).toMatchObject({
    name: "Task",
    desc: "Original",
    idLabels: [f.project.trello.refinementLabelId],
    idList: f.project.trello.failedListId,
  });
  expect(f.authority.store.read()!.lifecycle).toBe("failed");
  expect(
    f.requests.filter((r) => r.startsWith("POST:") && r.endsWith("comments")),
  ).toHaveLength(1);
});

it("does not terminally fail over human field changes discovered after invalid analysis", async () => {
  const f = await fixture();
  f.engineer.mockImplementation(async ({ cwd }) => {
    const { getRefinementResultPath } =
      await import("../src/refinement/refinement-result.js");
    fs.mkdirSync(path.dirname(getRefinementResultPath(cwd)), {
      recursive: true,
    });
    fs.writeFileSync(getRefinementResultPath(cwd), "{}");
    f.card.desc = "Human clarification";
    return { exitCode: 0, output: "", errorOutput: "" };
  });
  await expect(f.poll()).rejects.toThrow("conflicting current fields");
  expect(f.engineer).toHaveBeenCalledTimes(3);
  expect(f.card.desc).toBe("Human clarification");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(f.authority.store.read()!.lifecycle).toBe("refinement");
});

it("recovers a lost completion-comment acknowledgement in Backlog without duplicate effects", async () => {
  const f = await fixture();
  let lost = false;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    const result = await f.fetch(url, init);
    if (!lost && init?.method === "POST" && url.pathname.endsWith("comments")) {
      lost = true;
      throw new TypeError("lost comment acknowledgement");
    }
    return result;
  });
  await f.poll();
  expect(lost).toBe(true);
  expect(f.card.idList).toBe(f.project.trello.backlogListId);
  expect(f.authority.store.read()!.lifecycle).toBe("refinement");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60000);
  await f.poll();
  await f.poll();
  expect(f.authority.store.read()!.lifecycle).toBe("refined");
  expect(f.engineer).toHaveBeenCalledOnce();
  expect(
    f.requests.filter((r) => r.startsWith("POST:") && r.endsWith("comments")),
  ).toHaveLength(1);
});

it("resumes only completion after successful cleanup and a final Backlog-read outage", async () => {
  const f = await fixture();
  const readCards = f.trello.getCards.bind(f.trello);
  let failed = false;
  vi.spyOn(f.trello, "getCards").mockImplementation(async (listId) => {
    if (!failed && listId === f.project.trello.backlogListId) {
      failed = true;
      throw new Error("completion read outage");
    }
    return readCards(listId);
  });
  await expect(f.poll()).rejects.toThrow("completion read outage");
  expect(
    fs.existsSync(path.join(f.project.repository.worktreeRoot, f.card.id)),
  ).toBe(false);
  await f.poll();
  expect(f.authority.store.read()!.lifecycle).toBe("refined");
  expect(f.engineer).toHaveBeenCalledOnce();
  expect(
    f.requests.filter((r) => r.startsWith("POST:") && r.endsWith("comments")),
  ).toHaveLength(1);
});

it("does not release completion when human fields change during final Backlog readback", async () => {
  const f = await fixture();
  const readCards = f.trello.getCards.bind(f.trello);
  vi.spyOn(f.trello, "getCards").mockImplementation(async (listId) => {
    if (listId === f.project.trello.backlogListId) {
      const old = { desc: f.card.desc };
      f.card.desc = "Human final revision";
      f.record(
        {
          type: "updateCard",
          data: { old, card: { id: f.card.id, desc: f.card.desc } },
        },
        "human",
      );
    }
    return readCards(listId);
  });
  await expect(f.poll()).rejects.toThrow("completion is not verified");
  expect(f.authority.store.read()!.lifecycle).toBe("refinement");
  expect(f.card.desc).toBe("Human final revision");
});

it("restores attributable title, description and classification after bounded conclusive field rejection before Failed", async () => {
  const f = await fixture();
  f.card.idLabels.push(f.project.trello.bugLabelId);
  f.saveCard();
  let rejected = 0;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (
      init?.method === "DELETE" &&
      url.pathname.endsWith(`/idLabels/${f.project.trello.refinementLabelId}`)
    ) {
      rejected++;
      return Response.json({ message: "invalid label" }, { status: 400 });
    }
    return f.fetch(url, init);
  });
  await f.poll();
  expect(f.card.name).toBe("Refined task");
  expect(f.card.idLabels).not.toContain(f.project.trello.bugLabelId);
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let pass = 0; pass < 5; pass++) {
    vi.setSystemTime(Date.now() + 60000);
    await f.poll();
  }
  expect(rejected).toBe(3);
  expect(f.card).toMatchObject({
    name: "Task",
    desc: "Original",
    idList: f.project.trello.failedListId,
  });
  expect(new Set(f.card.idLabels)).toEqual(
    new Set([f.project.trello.refinementLabelId, f.project.trello.bugLabelId]),
  );
  expect(f.authority.store.read()!.lifecycle).toBe("failed");
  expect(
    f.authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    )?.reconciliation?.mode,
  ).toBe("restored");
});

it("does not restore rejected partial writes over a detected human revision", async () => {
  const f = await fixture();
  let rejected = 0;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (init?.method === "POST" && url.pathname.endsWith("idLabels")) {
      rejected++;
      if (rejected === 3) {
        const old = { desc: f.card.desc };
        f.card.desc = "Human content after rejection";
        f.record(
          {
            type: "updateCard",
            data: { old, card: { id: f.card.id, desc: f.card.desc } },
          },
          "human",
        );
      }
      return Response.json({ message: "invalid label" }, { status: 400 });
    }
    return f.fetch(url, init);
  });
  await f.poll();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let pass = 0; pass < 4; pass++) {
    vi.setSystemTime(Date.now() + 60000);
    await f.poll();
  }
  expect(rejected).toBe(3);
  expect(f.card.desc).toBe("Human content after rejection");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(f.authority.store.read()!.lifecycle).toBe("refinement");
});

it("retains uncertain partial acceptance without replay or restoration based on negative reads", async () => {
  const f = await fixture();
  let dispatched = 0;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (init?.method === "POST" && url.pathname.endsWith("idLabels")) {
      dispatched++;
      throw new TypeError("unknown acceptance");
    }
    return f.fetch(url, init);
  });
  await f.poll();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let pass = 0; pass < 5; pass++) {
    vi.setSystemTime(Date.now() + 60000);
    await f.poll();
  }
  expect(dispatched).toBe(1);
  expect(f.card.name).toBe("Refined task");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
  expect(
    f.authority.read(
      refinementMutationSnapshotKey,
      refinementMutationSnapshotSchema.parse,
    )?.reconciliation?.mode,
  ).toBeUndefined();
});

it("detects human edits racing with compensation and preserves history instead of confirming restoration", async () => {
  const f = await fixture();
  let raced = false;
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    if (init?.method === "POST" && url.pathname.endsWith("idLabels"))
      return Response.json({ message: "invalid label" }, { status: 400 });
    if (init?.method === "PUT" && String(init.body).includes('"name":"Task"')) {
      raced = true;
      const old = { desc: f.card.desc };
      f.card.desc = "Human restoration race";
      f.record(
        {
          type: "updateCard",
          data: { old, card: { id: f.card.id, desc: f.card.desc } },
        },
        "human",
      );
    }
    return f.fetch(url, init);
  });
  await f.poll();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let pass = 0; pass < 5; pass++) {
    vi.setSystemTime(Date.now() + 60000);
    await f.poll();
  }
  expect(raced).toBe(true);
  const state = f.authority.read(
    refinementMutationSnapshotKey,
    refinementMutationSnapshotSchema.parse,
  )!.reconciliation!;
  expect(state.conflict).toBeDefined();
  expect(JSON.stringify(state.evidence)).toContain("Human restoration race");
  expect(state.mode).toBe("restoring");
  expect(f.card.idList).toBe(f.project.trello.workingListId);
});
