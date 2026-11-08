import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crashRoutes,
  setupRoute,
  openRoute,
} from "./support/p4-route-crash-fixture.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("finite concrete P4 route x crash boundary inventory", () => {
  it.each(
    crashRoutes.flatMap((route) =>
      ["intent", "dispatch", "acceptance", "response", "completion"].map(
        (barrier) => ({ route, barrier }),
      ),
    ),
  )(
    "$route at $barrier",
    async ({ route, barrier }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "p4-route-crash-"));
      setupRoute(root, route);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/p4-route-crash.ts",
          root,
          route,
          barrier,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const stderr: Buffer[] = [];
      child.stderr?.on("data", (value: Buffer) => stderr.push(value));
      try {
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(Buffer.concat(stderr).toString());
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const f = openRoute(root, undefined, "recovered-owner");
        const original = f.store.read()!.pendingOperations[0]!;
        if (barrier === "response")
          expect(
            original.mutation!.dispatches.at(-1)?.response,
          ).toBeUndefined();
        expect(original.mutation!.intent.correlationId).toContain("route:");
        const requests = () =>
          fs
            .readFileSync(path.join(root, "route-ledger.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type: string; id: string });
        const sentBefore = requests().filter(
          (event) => event.type === "request",
        ).length;
        expect(sentBefore).toBe(
          ["intent", "dispatch"].includes(barrier) ? 0 : 1,
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.parse(f.store.read()!.updatedAt));
        const before = f.store.read()!.revision;
        const beforeDueLedger = requests();
        if (barrier !== "intent") {
          await f.reconcile();
          expect(f.store.read()!.revision).toBe(before);
          expect(requests()).toEqual(beforeDueLedger);
        }
        vi.setSystemTime(Date.now() + 15_001);
        await f.reconcile();
        const op = f.store.read()!.pendingOperations[0]!;
        expect(op.mutation!.intent).toEqual(original.mutation!.intent);
        expect(op.status).toBe(
          barrier === "dispatch" ? "ambiguous" : "completed",
        );
        expect(op.mutation!.dispatches).toHaveLength(1);
        for (let pass = 0; pass < 3; pass++) {
          vi.setSystemTime(Date.now() + 15_001);
          await f.reconcile();
        }
        expect(
          requests().filter((event) => event.type === "request"),
        ).toHaveLength(barrier === "dispatch" ? 0 : 1);
        const accepted = requests().filter(
          (event) => event.type === "accepted",
        );
        expect(accepted).toHaveLength(barrier === "dispatch" ? 0 : 1);
        expect(new Set(accepted.map((event) => event.id)).size).toBe(
          accepted.length,
        );
        if (barrier !== "dispatch")
          expect(op.mutation!.observations.at(-1)?.resourceId).toBeTruthy();
        await expect(f.authority.releaseVerifiedTerminal()).rejects.toThrow();
        expect(f.store.read()!.cardId).toBe("card");
        expect(f.read().comments.length + f.read().replies.length).toBe(
          ["comment", "thread", "conversation"].includes(route) &&
            barrier !== "dispatch"
            ? 1
            : 0,
        );
        if (route === "commit")
          expect(
            f.observeGit(f.worktreePath, "rev-list", "--count", "main..HEAD"),
          ).toBe(barrier === "dispatch" ? "0" : "1");
        if (route === "push")
          expect(
            f.observeGit(
              path.join(root, "remote.git"),
              "for-each-ref",
              "--format=%(objectname)",
              "refs/heads/agent/card",
            ),
          ).toBe(
            barrier === "dispatch"
              ? ""
              : f.observeGit(f.worktreePath, "rev-parse", "HEAD"),
          );
        if (route.startsWith("worktree-"))
          expect(fs.existsSync(f.worktreePath)).toBe(
            route === "worktree-remove"
              ? barrier === "dispatch"
              : barrier !== "dispatch",
          );
        if (route === "branch-delete" || route === "remote-delete")
          expect(
            f.observeGit(
              route === "remote-delete"
                ? path.join(root, "remote.git")
                : f.project.repository.path,
              "for-each-ref",
              "--format=%(objectname)",
              "refs/heads/agent/card",
            ),
          ).toBe(
            barrier === "dispatch"
              ? f.observeGit(f.project.repository.path, "rev-parse", "main")
              : "",
          );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
    30_000,
  );
});
