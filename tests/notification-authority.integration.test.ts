import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import { runOrchestrator } from "../src/orchestrator/run-orchestrator.js";
import {
  NotificationPreparationError,
  createNotificationObligation,
  notificationObligationSchema,
} from "../src/notifications/notification-outbox.js";
import { enqueueNotification } from "../src/notifications/email-notifier.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { ProjectOwnershipLease } from "../src/coordination/project-ownership.js";

let root: string;
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const setup = async (ids: string[], sharedRoot = false) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notification-authority-"));
  const fixtures: Awaited<ReturnType<typeof notificationAuthorityFixture>>[] =
    [];
  for (const id of ids) {
    const f = await notificationAuthorityFixture(
      root,
      id,
      sharedRoot
        ? {
            storageRoot: path.join(root, "shared-state"),
            coordinationRoot: path.join(root, "shared-coordination"),
            otherProjects: fixtures.map((other) => ({
              project: other.project,
              lease: other.lease,
            })),
          }
        : undefined,
    );
    leases.push(f.lease);
    fixtures.push(f);
  }
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    const f = fixtures.find((item) =>
      url.pathname.includes(`/${item.project.id}-`),
    );
    if (!f) throw new Error(`Unknown fixture URL ${url.pathname}`);
    return f.fetch(url, init);
  });
  return fixtures;
};
describe("notification authority through production polling and workers", () => {
  it.each([
    "malformed",
    "unsupported",
    "missing-artifact",
    "corrupt-artifact",
  ] as const)(
    "isolates A's %s source in a shared runtime root while B drains existing and recovered events exactly once",
    async (corruption) => {
      const [a, b] = await setup(["a", "b"], true);
      if (!a || !b) throw new Error("Missing fixture");
      expect(a.pinned.storageRoot).toBe(b.pinned.storageRoot);
      expect(a.config.workflow.coordinationRoot).toBe(
        b.config.workflow.coordinationRoot,
      );
      a.lease.assertHeld();
      b.lease.assertHeld();
      const persistSourceOnly = (f: typeof a, identity: string) => {
        const event = createNotificationObligation(
          f.project.id,
          `${f.project.id}:${f.authority.store.attemptId}:attentionRequired:${identity}`,
          { subject: identity, text: `Project: ${f.project.id}; ${identity}` },
          "attentionRequired",
        );
        f.authority.mutate(
          `notification-event-${event.id}`,
          event,
          (value) => ({ value, result: undefined }),
          notificationObligationSchema.parse,
        );
        return event;
      };
      const untrusted = persistSourceOnly(
        a,
        "A_SOURCE_MUST_NOT_BE_DERIVED_OR_LOGGED",
      );
      b.authority.run(() =>
        enqueueNotification(
          b.notifier,
          b.project.id,
          "attentionRequired",
          "existing",
          { subject: "B existing", text: "B existing event" },
        ),
      );
      persistSourceOnly(b, "B recovered event");
      expect(b.outbox().records()).toHaveLength(1);
      const sourcePath = path.join(
        a.pinned.storageRoot,
        "attempts",
        `${a.authority.store.attemptId}.json`,
      );
      let artifactPath: string | undefined;
      if (corruption.endsWith("artifact")) {
        const artifact = a.authority.store.writeArtifact(
          Buffer.from("A source artifact"),
        );
        a.authority.store.referenceMutationArtifact(
          a.authority.store.read()!.revision,
          a.authority.ownerGeneration,
          artifact,
        );
        artifactPath = artifact.path;
        if (corruption === "missing-artifact") fs.unlinkSync(artifact.path);
        else fs.writeFileSync(artifact.path, "corrupt A artifact");
      } else if (corruption === "malformed") {
        fs.writeFileSync(sourcePath, "{A_SOURCE_MUST_NOT_BE_DERIVED_OR_LOGGED");
      } else {
        const source = JSON.parse(
          fs.readFileSync(sourcePath, "utf8"),
        ) as Record<string, unknown>;
        fs.writeFileSync(
          sourcePath,
          JSON.stringify({ ...source, version: 999 }),
        );
      }
      const preservedSource = fs.readFileSync(sourcePath);
      const report = vi.fn();
      await b.outbox().drain(b.notifier, report);
      await b.outbox().drain(b.notifier, report);
      expect(b.sink).toHaveLength(2);
      expect(b.sink.filter((text) => text === "B existing event")).toHaveLength(
        1,
      );
      expect(
        b.sink.filter((text) => text.includes("B recovered event")),
      ).toHaveLength(1);
      expect(a.notifier.send).not.toHaveBeenCalled();
      expect(
        b
          .outbox()
          .records()
          .every((record) => record.dispatches.at(-1)?.outcome === "confirmed"),
      ).toBe(true);
      expect(
        b
          .outbox()
          .records()
          .some((record) => record.id === untrusted.id),
      ).toBe(false);
      expect(fs.readFileSync(sourcePath)).toEqual(preservedSource);
      if (artifactPath) {
        if (corruption === "missing-artifact")
          expect(fs.existsSync(artifactPath)).toBe(false);
        else
          expect(fs.readFileSync(artifactPath, "utf8")).toBe(
            "corrupt A artifact",
          );
      }
      const sourceId = createHash("sha256")
        .update(path.basename(sourcePath))
        .digest("hex");
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining(
          `source attempt filename sha256:${sourceId} unavailable or invalid; evidence preserved`,
        ),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "A_SOURCE_MUST_NOT_BE_DERIVED_OR_LOGGED",
      );
    },
    30_000,
  );
  it("requires final intended refinement fields in the bound move observation, not merely a completed destination move", async () => {
    const [a] = await setup(["a"]);
    if (!a) throw new Error("Missing fixture");
    const move = a.trello.moveCard.bind(a.trello);
    vi.spyOn(a.trello, "moveCard").mockImplementation((card, list, options) => {
      if (list === a.project.trello.backlogListId) {
        a.card.desc = "Concurrent wrong fields";
        a.saveCard();
      }
      return move(card, list, options);
    });
    await a.poll();
    const completedMove = a.authority.store
      .read()!
      .pendingOperations.find(
        (op) =>
          op.id === a.outbox().records()[0]?.trigger?.binding?.operationId,
      );
    expect(completedMove?.status).toBe("completed");
    await a.outbox().drain(a.notifier, () => {});
    expect(a.sink).toHaveLength(0);
    expect(
      a.outbox().records()[0]?.trigger?.binding?.refinementHash,
    ).toBeDefined();
    expect(a.outbox().records()[0]?.dispatches).toHaveLength(0);
  }, 30_000);
  it("finishes/refines/releases A with broken delivery storage while B progresses, then recovers the original event after later movement", async () => {
    const [a, b] = await setup(["a", "b"]);
    if (!a || !b) throw new Error("Missing fixture");
    fs.writeFileSync(
      path.join(a.pinned.storageRoot, "notifications"),
      "delivery storage unavailable",
    );
    const controller = new AbortController();
    const worker = runOrchestrator(
      a.trello,
      a.git,
      a.github,
      a.openCode,
      a.commands,
      { ...a.config, projects: [a.project, b.project] },
      controller.signal,
      a.notifier,
      undefined,
      new Map([
        ["a", a.context],
        ["b", b.context],
      ]),
    );
    // One injected OpenCode/Git implementation serves both independently pinned projects.
    try {
      await vi.waitFor(
        () => {
          expect(a.authority.store.read()?.lifecycle).toBe("refined");
          expect(b.authority.store.read()?.lifecycle).toBe("refined");
          for (const f of [a, b])
            expect(
              f.authority.run(() =>
                new TaskMutationQueue(
                  f.pinned.storageRoot,
                  f.project,
                ).getActive(),
              ),
            ).toBeNull();
        },
        { timeout: 15_000 },
      );
    } finally {
      controller.abort();
      await worker;
    }
    for (const f of [a, b]) {
      expect(
        f.authority.run(() =>
          new TaskMutationQueue(f.pinned.storageRoot, f.project).getActive(),
        ),
      ).toBeNull();
      await f.authority.releaseVerifiedTerminal();
      expect(
        f.authority.store
          .read()
          ?.pendingOperations.every((op) => op.status === "completed"),
      ).toBe(true);
    }
    expect(a.sink.filter((text) => text.includes("Project: a"))).toHaveLength(
      0,
    );
    expect(a.sink.filter((text) => text.includes("Project: b"))).toHaveLength(
      1,
    );
    expect(a.authority.store.read()?.compatibility).toEqual(
      expect.objectContaining({
        [Object.keys(a.authority.store.read()!.compatibility).find((key) =>
          key.startsWith("notification-event-"),
        )!]: expect.any(Object),
      }),
    );
    a.card.idList = a.project.trello.readyListId;
    a.card.desc = "Later human/replacement task";
    a.saveCard();
    fs.unlinkSync(path.join(a.pinned.storageRoot, "notifications"));
    await a.outbox().drain(a.notifier, () => {});
    expect(a.sink.filter((text) => text.includes("Project: a"))).toHaveLength(
      1,
    );
    expect(a.sink.join("\n")).toContain("Refined task title: Refined task");
  }, 30_000);
  it("retains a paced initial-handoff wait without engineering failure, recursive attention, or releasing A; B still finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a, b] = await setup(["a", "b"]);
    if (!a || !b) throw new Error("Missing fixture");
    const original = a.authority.store.mutateCompatibility.bind(
      a.authority.store,
    );
    const failure = vi
      .spyOn(a.authority.store, "mutateCompatibility")
      .mockImplementation((options) => {
        if (options.key.startsWith("notification-event-"))
          throw new Error("Initial event storage unavailable");
        return original(options);
      });
    await a.poll();
    expect(a.authority.store.read()?.lifecycle).toBe("refinement");
    expect(a.card.idList).toBe(a.project.trello.workingListId);
    expect(
      a.authority.store.read()?.compatibility["notification-storage-wait"],
    ).toBeDefined();
    expect(
      a.authority.run(() =>
        new TaskMutationQueue(a.pinned.storageRoot, a.project).getActive(),
      ),
    ).not.toBeNull();
    await a.poll();
    expect(a.engineer).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const worker = runOrchestrator(
      a.trello,
      a.git,
      a.github,
      a.openCode,
      a.commands,
      { ...a.config, projects: [a.project, b.project] },
      controller.signal,
      a.notifier,
      undefined,
      new Map([
        ["a", a.context],
        ["b", b.context],
      ]),
    );
    try {
      await vi.waitFor(
        () => {
          expect(b.authority.store.read()?.lifecycle).toBe("refined");
          expect(
            b.authority.run(() =>
              new TaskMutationQueue(
                b.pinned.storageRoot,
                b.project,
              ).getActive(),
            ),
          ).toBeNull();
        },
        { timeout: 15_000 },
      );
      expect(a.authority.store.read()?.lifecycle).toBe("refinement");
    } finally {
      controller.abort();
      await worker;
    }
    expect(a.sink.join("\n")).not.toContain("Attention Required");
    failure.mockRestore();
    vi.setSystemTime(Date.now() + 15_001);
    await a.poll();
    expect(a.authority.store.read()?.lifecycle).toBe("refined");
    expect(
      a.engineer.mock.calls.filter(([options]) =>
        options.cwd.startsWith(a.project.repository.worktreeRoot),
      ),
    ).toHaveLength(1);
  }, 30_000);
  it.each(["fields", "final-move"] as const)(
    "never authorizes an old event after failure at %s and manual/replacement Backlog movement",
    async (boundary) => {
      const [a] = await setup(["a"]);
      if (!a) throw new Error("Missing fixture");
      const move = a.trello.moveCard.bind(a.trello);
      if (boundary === "fields")
        vi.spyOn(a.trello, "updateCardContent").mockRejectedValue(
          new NotificationPreparationError(
            "Interrupted during field finalization",
          ),
        );
      else
        vi.spyOn(a.trello, "moveCard").mockImplementation(
          (card, list, options) => {
            if (list === a.project.trello.backlogListId)
              throw new NotificationPreparationError(
                "Interrupted before final mutation",
              );
            return move(card, list, options);
          },
        );
      await a.poll();
      expect(a.authority.store.read()?.lifecycle).toBe("refinement");
      if (boundary === "final-move")
        expect(a.outbox().records()[0]?.trigger?.binding).toBeDefined();
      else expect(a.outbox().records()).toHaveLength(0);
      a.card.name = "Unrelated replacement";
      a.card.desc = "Wrong fields";
      a.card.idLabels = [];
      a.card.idList = a.project.trello.backlogListId;
      a.saveCard();
      await a.outbox().drain(a.notifier, () => {});
      expect(a.sink).toHaveLength(0);
      expect(
        a
          .outbox()
          .records()
          .every((record) => record.dispatches.length === 0),
      ).toBe(true);
    },
    30_000,
  );
});
