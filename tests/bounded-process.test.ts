import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  spawnOwnedProcess,
  waitForOwnedProcess,
} from "../scripts/bounded-process.js";

function expectGroupGone(pid: number): void {
  if (process.platform === "linux") {
    const liveMembers = fs.readdirSync("/proc").filter((entry) => {
      if (!/^\d+$/u.test(entry)) return false;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return false;
        throw error;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) throw new Error(`Malformed /proc/${entry}/stat`);
      const fields = stat.slice(closeParen + 2).split(" ");
      const group = Number(fields[2]);
      if (!/^[A-Z]$/u.test(fields[0] ?? "") || !Number.isSafeInteger(group))
        throw new Error(`Malformed /proc/${entry}/stat`);
      return group === pid && fields[0] !== "Z" && fields[0] !== "X";
    });
    expect(liveMembers).toEqual([]);
    return;
  }
  try {
    process.kill(-pid, 0);
    throw new Error(`owned process group ${pid} remains alive`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function pidOf(owned: ReturnType<typeof spawnOwnedProcess>): number {
  if (owned.pid === undefined)
    throw new Error("test child did not receive a PID");
  return owned.pid;
}

describe("bounded subprocess lifecycle", () => {
  it("observes a process that exited and closed before awaiting it", async () => {
    const owned = spawnOwnedProcess(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        stdio: "ignore",
      },
    );
    await owned.closed;
    await expect(
      waitForOwnedProcess(owned, { timeoutMs: 100 }),
    ).resolves.toEqual({ code: 0, signal: null });
    expectGroupGone(pidOf(owned));
  });

  it("SIGKILLs a SIGTERM-resistant owned process group and awaits closure", async () => {
    const owned = spawnOwnedProcess(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: "ignore" },
    );
    await expect(
      waitForOwnedProcess(owned, {
        timeoutMs: 50,
        termGraceMs: 50,
        killGraceMs: 1_000,
      }),
    ).rejects.toThrow(/timed out/);
    expectGroupGone(pidOf(owned));
  });

  it("kills a live descendant when its wrapper exits", async () => {
    const wrapper = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'], { stdio: "ignore" });',
      "process.exit(0);",
    ].join(" ");
    const owned = spawnOwnedProcess(process.execPath, ["-e", wrapper], {
      stdio: "ignore",
    });
    await expect(
      waitForOwnedProcess(owned, {
        timeoutMs: 2_000,
        termGraceMs: 50,
        killGraceMs: 1_000,
      }),
    ).resolves.toEqual({ code: 0, signal: null });
    expectGroupGone(pidOf(owned));
  });

  it("reports spawn errors", async () => {
    const owned = spawnOwnedProcess("/no/such/p2-test-executable", [], {
      stdio: "ignore",
    });
    await expect(
      waitForOwnedProcess(owned, { timeoutMs: 100 }),
    ).rejects.toThrow();
  });
});
