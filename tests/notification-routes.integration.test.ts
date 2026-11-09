import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationRouteFixture,
  type NotificationRoute,
} from "./support/notification-route-fixture.js";
import { NotificationPreparationError } from "../src/notifications/notification-outbox.js";

const roots: string[] = [];
const root = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "notification-route-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of roots.splice(0))
    fs.rmSync(value, { recursive: true, force: true });
});
const routes: NotificationRoute[] = ["publication", "refinement", "failure"];
describe("legacy/unowned route triggers cannot substitute for authoritative mutation proof", () => {
  it.each(routes)(
    "retains an unbound %s trigger without promotion even when the notifier is reached",
    async (route) => {
      const directory = root();
      const rename = fs.renameSync;
      let failWrites = false;
      const spy = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((source, destination) => {
          if (
            failWrites &&
            String(destination).includes(`${path.sep}notifications${path.sep}`)
          )
            throw Object.assign(new Error("Injected storage failure"), {
              code: "EIO",
            });
          rename(source, destination);
        });
      const fixture = notificationRouteFixture(directory, route, () => {
        failWrites = true;
      });
      await fixture.run();
      expect(fixture.open().records()[0]?.trigger).toBeDefined();
      expect(fs.existsSync(path.join(directory, "sink.jsonl"))).toBe(false);
      // Simulate a subsequent task/manual move before notification recovery.
      // Position/history cannot identify the original attempt's verified effect.
      fs.writeFileSync(
        path.join(directory, "external-card.json"),
        JSON.stringify({ ...fixture.read(), idList: "ready" }),
      );
      spy.mockRestore();
      const restarted = notificationRouteFixture(directory, route);
      await restarted.open().drain(restarted.notifier, () => {});
      expect(restarted.open().records()[0]?.dispatches).toHaveLength(0);
      expect(
        fs
          .readFileSync(path.join(directory, "requests.jsonl"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      expect(fs.existsSync(path.join(directory, "sink.jsonl"))).toBe(false);
    },
  );
  it.each(routes)(
    "does not invent %s mutation provenance after SIGKILL and a later transition",
    async (route) => {
      const directory = root();
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/notification-route-crash.ts",
          directory,
          route,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("Writer exited before barrier");
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const restarted = notificationRouteFixture(directory, route);
        expect(restarted.read().idList).toBe(
          route === "publication"
            ? "review"
            : route === "refinement"
              ? "backlog"
              : "failed",
        );
        expect(restarted.open().records()[0]?.trigger).toBeDefined();
        expect(fs.existsSync(path.join(directory, "sink.jsonl"))).toBe(false);
        fs.writeFileSync(
          path.join(directory, "external-card.json"),
          JSON.stringify({ ...restarted.read(), idList: "ready" }),
        );
        // Recovery does not rerun engineering, workflow writes or the old route.
        await restarted.open().drain(restarted.notifier, () => {});
        await restarted.open().drain(restarted.notifier, () => {});
        expect(fs.existsSync(path.join(directory, "sink.jsonl"))).toBe(false);
        expect(
          fs
            .readFileSync(path.join(directory, "requests.jsonl"), "utf8")
            .trim()
            .split("\n"),
        ).toHaveLength(1);
        expect(restarted.open().records()[0]?.dispatches).toHaveLength(0);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
  it.each(routes)(
    "does not catch-forget %s preparation storage failure or perform its terminal transition",
    async (route) => {
      const directory = root();
      fs.writeFileSync(
        path.join(directory, "notifications"),
        "storage unavailable",
      );
      const fixture = notificationRouteFixture(directory, route);
      await expect(fixture.run()).rejects.toBeInstanceOf(
        NotificationPreparationError,
      );
      expect(fixture.read().idList).toBe("working");
      expect(fs.existsSync(path.join(directory, "requests.jsonl"))).toBe(false);
      fs.unlinkSync(path.join(directory, "notifications"));
      await fixture.run();
      expect(fixture.open().records()[0]?.trigger).toBeDefined();
      expect(fs.existsSync(path.join(directory, "sink.jsonl"))).toBe(false);
    },
  );
});
