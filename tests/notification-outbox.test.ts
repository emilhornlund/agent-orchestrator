import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotificationOutbox,
  NotificationNotDeliveredError,
  NOTIFICATION_RECHECK_MS,
  NotificationPreparationError,
} from "../src/notifications/notification-outbox.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";
import {
  createEmailNotifier,
  enqueueNotification,
  notifyFailed,
  notifyHumanReview,
  notifyAttentionRequired,
  notifyRefinementCompletion,
  notifyCompletion,
} from "../src/notifications/email-notifier.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { Logger } from "../src/logging/logger.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notification-"));
  roots.push(root);
  let now = 0;
  let held = true;
  const open = () =>
    new NotificationOutbox(
      root,
      "p",
      () => {
        if (!held) throw new Error("Lost lease");
      },
      () => now,
    );
  return {
    root,
    open,
    tick: () => {
      now += NOTIFICATION_RECHECK_MS;
    },
    loseLease: () => {
      held = false;
    },
  };
}
const message = {
  subject: "PR ready",
  text: "Project p / Task c / https://github.com/o/r/pull/1",
};
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("notification-only durable outbox", () => {
  it("keeps preparation non-sendable until verified, paces recovery, and isolates observation outages", async () => {
    const f = fixture();
    f.open().enqueue("prepared", message, "humanReview", undefined, {
      cardId: "card",
      boardId: "board",
      listId: "review",
    });
    f.open().enqueue("independent", message);
    const send = vi.fn(async () => {});
    const report = vi.fn();
    await f.open().drain({ send }, report, async () => {
      throw new Error("Trello read unavailable");
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      f
        .open()
        .records()
        .find((record) => record.eventKey === "prepared")?.trigger,
    ).toBeDefined();
    const observe = vi.fn(async () => true);
    await f.open().drain({ send }, report, observe);
    expect(observe).not.toHaveBeenCalled();
    f.tick();
    await f.open().drain({ send }, report, async () => false);
    expect(send).toHaveBeenCalledTimes(1);
    f.tick();
    await f.open().drain({ send }, report, observe);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      f
        .open()
        .records()
        .find((record) => record.eventKey === "prepared")?.trigger,
    ).toBeUndefined();
  });
  it.each([
    "humanReview",
    "failed",
    "attentionRequired",
    "refinementComplete",
    "done",
  ] as const)(
    "propagates %s preparation failure instead of logging and forgetting",
    async (event) => {
      const f = fixture();
      const outbox = f.open();
      vi.spyOn(outbox, "enqueue").mockImplementation(() => {
        throw new Error("Disk unavailable");
      });
      const notifier = { send: vi.fn(async () => {}) };
      const project = { id: "p" } as ProjectConfig;
      const card = {
        id: "card",
        name: "Task",
        url: "https://trello.com/c/card",
        desc: "",
        idList: "review",
        idLabels: [],
      };
      const log = {
        event: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger;
      await expect(
        outbox.run(() => {
          switch (event) {
            case "humanReview":
              return notifyHumanReview(
                notifier,
                {
                  project,
                  card,
                  pullRequestUrl: "https://github.com/o/r/pull/1",
                  commitSha: "sha",
                  reviewResult: "Passed",
                  remediationResult: "Not required",
                  publicationContext: "Verified",
                },
                log,
              );
            case "failed":
              return notifyFailed(
                notifier,
                { project, card, category: "Workflow", reason: "Failed" },
                log,
              );
            case "attentionRequired":
              return notifyAttentionRequired(
                notifier,
                { project, category: "Workflow", reason: "Waiting" },
                log,
              );
            case "refinementComplete":
              return notifyRefinementCompletion(
                notifier,
                {
                  project,
                  card,
                  result: {
                    title: "Task",
                    description: "Refined",
                    type: "feature",
                  },
                },
                log,
              );
            case "done":
              return notifyCompletion(
                notifier,
                {
                  project,
                  card,
                  pullRequestUrl: "https://github.com/o/r/pull/1",
                },
                log,
              );
          }
        }),
      ).rejects.toBeInstanceOf(NotificationPreparationError);
      expect(notifier.send).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    },
  );
  it("does not let over 100 old incompatible targets starve an actionable current event", async () => {
    const f = fixture();
    for (let i = 0; i < 105; i++)
      f.open().enqueue(`old-${i}`, message, "humanReview", "old-target");
    f.tick();
    f.open().enqueue("current", message, "humanReview", "current-target");
    const send = vi.fn(async () => {});
    await f.open().drain({ send, deliveryTarget: "current-target" }, () => {});
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      f
        .open()
        .records()
        .find((entry) => entry.eventKey === "current")?.dispatches[0]?.outcome,
    ).toBe("confirmed");
    expect(
      f
        .open()
        .records()
        .filter((entry) => entry.eventKey.startsWith("old-"))
        .every((entry) => entry.dispatches.length === 0),
    ).toBe(true);
  });
  it("retains provider correlation and reports partial acceptance without duplicating accepted recipients", async () => {
    const f = fixture();
    f.open().enqueue("event", message);
    const report = vi.fn();
    const send = vi.fn(async () => ({
      providerId: "provider-queue-42",
      partial: true,
    }));
    await f.open().drain({ send }, report);
    f.tick();
    await f.open().drain({ send }, report);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.open().records()[0]?.dispatches[0]?.providerId).toBe(
      "provider-queue-42",
    );
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("partial recipient acceptance"),
    );
  });
  it("returns from the production helper while SMTP is still awaiting acceptance", async () => {
    const f = fixture();
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const log = {
      event: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    await f.open().run(() =>
      notifyFailed(
        { send: async () => pending },
        {
          project: { id: "p" } as ProjectConfig,
          card: { name: "Task", url: "https://trello.com/c/task" },
          category: "Workflow",
          reason: "Primary failed",
        },
        log,
      ),
    );
    expect(f.open().records()[0]?.dispatches[0]?.outcome).toBe("ambiguous");
    acknowledge();
    await vi.waitFor(() =>
      expect(f.open().records()[0]?.dispatches[0]?.outcome).toBe("confirmed"),
    );
  });
  it("pins transport identity, respects per-event disablement, and isolates projects", async () => {
    const f = fixture();
    f.open().enqueue("attempt:event", message, "failed", "smtp-original");
    const send = vi.fn(async () => {});
    const report = vi.fn();
    await f.open().drain({ send, deliveryTarget: "smtp-changed" }, report);
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("identity changed"),
    );
    await f
      .open()
      .drain(
        { send, deliveryTarget: "smtp-original", isEventEnabled: () => false },
        report,
      );
    expect(send).not.toHaveBeenCalled();
    const other = new NotificationOutbox(f.root, "other-project", () => {});
    other.enqueue("attempt:event", message);
    await other.drain({ send }, report);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.open().records()[0]?.dispatches).toEqual([]);
    await f.open().drain({ send, deliveryTarget: "smtp-original" }, report);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not require infrastructure when disabled", () => {
    expect(createEmailNotifier(undefined, {})).toBeUndefined();
    expect(
      enqueueNotification(undefined, "p", "failed", "c", message),
    ).toBeUndefined();
  });
  it("persists intent, retries only proven non-delivery after restart and pacing, deduplicates actual confirmation", async () => {
    const f = fixture();
    f.open().enqueue("attempt-old:humanReview:sha", message);
    const sink: string[] = [];
    const send = vi.fn(async (outbound: { text: string }) => {
      if (send.mock.calls.length === 1)
        throw new NotificationNotDeliveredError("rejected");
      sink.push(outbound.text);
    });
    await f.open().drain({ send }, () => {});
    expect(f.open().records()[0]?.dispatches[0]?.outcome).toBe(
      "known-not-delivered",
    );
    await f.open().drain({ send }, () => {});
    expect(send).toHaveBeenCalledTimes(1);
    f.tick();
    await f.open().drain({ send }, () => {});
    f.open().enqueue("attempt-old:humanReview:sha", {
      ...message,
      text: "later rendering",
    });
    f.open().enqueue("attempt-next:failed:c", message);
    await f.open().drain({ send }, () => {});
    expect(sink).toHaveLength(2);
    expect(
      f
        .open()
        .records()
        .flatMap((r) => r.dispatches),
    ).toHaveLength(3);
  });
  it("keeps late acceptance observable, never resends on absence, and reconciles provider correlation evidence", async () => {
    const f = fixture();
    f.open().enqueue("attempt:attention", message);
    const accepted: string[] = [];
    const send = vi.fn(async () => {
      throw new Error("lost response");
    });
    const report = vi.fn();
    await f.open().drain({ send }, report);
    f.tick();
    await f
      .open()
      .drain({ send, lookupDelivery: async () => "ambiguous" }, report);
    accepted.push(f.open().records()[0]!.messageId);
    f.tick();
    await f.open().drain(
      {
        send,
        lookupDelivery: async (id) =>
          accepted.includes(id) ? "confirmed" : "ambiguous",
      },
      report,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("no automatic resend"),
    );
    expect(f.open().records()[0]?.dispatches[0]?.outcome).toBe("confirmed");
  });
  it("redacts stored and outbound known literal/encoded secrets and never stores raw exceptions", async () => {
    const f = fixture();
    const secret = 'outbox /+=& "known\\credential"';
    registerProcessSecrets([secret]);
    const forms = [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(secret).replaceAll("%20", "+"),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      JSON.stringify(secret).slice(1, -1),
    ];
    f.open().enqueue(`event:${secret}`, {
      subject: secret,
      text: forms.join("\n"),
    });
    const send = vi.fn(async () => {
      throw new Error(secret);
    });
    await f.open().drain({ send }, () => {});
    const stored = JSON.stringify(f.open().records());
    for (const form of forms) {
      expect(stored).not.toContain(form);
      expect(JSON.stringify(send.mock.calls)).not.toContain(form);
    }
  });
  it("fences stale send responses and rejects malformed records without deleting them", async () => {
    const f = fixture();
    f.open().enqueue("event", message);
    await expect(
      f.open().drain(
        {
          send: async () => {
            f.loseLease();
          },
        },
        () => {},
      ),
    ).rejects.toThrow("Lost lease");
    const g = fixture();
    const entry = g.open().enqueue("event", message);
    const directory = path.join(g.root, "notifications");
    const projectDirectory = path.join(
      directory,
      fs.readdirSync(directory)[0]!,
    );
    const file = path.join(projectDirectory, `${entry.id}.json`);
    fs.writeFileSync(file, '{"version":99}');
    expect(() => g.open().records()).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe('{"version":99}');
  });
  it.each(["intent", "dispatch", "acceptance", "response", "confirmed"])(
    "preserves %s across SIGKILL without blind resend",
    async (barrier) => {
      const f = fixture();
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/p4-notification-crash.ts",
          f.root,
          barrier,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        await once(child, "message");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const send = vi.fn(async () => {});
        f.tick();
        await f.open().drain({ send }, () => {});
        expect(send).toHaveBeenCalledTimes(barrier === "intent" ? 1 : 0);
        const accepted = fs.existsSync(path.join(f.root, "sink.jsonl"))
          ? fs
              .readFileSync(path.join(f.root, "sink.jsonl"), "utf8")
              .trim()
              .split("\n")
          : [];
        expect(accepted).toHaveLength(
          ["acceptance", "response", "confirmed"].includes(barrier) ? 1 : 0,
        );
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
