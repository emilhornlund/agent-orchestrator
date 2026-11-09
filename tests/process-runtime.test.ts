import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginProcessEvidence,
  drainProcessGroup,
  ProcessEvidenceError,
  ProcessGroupTerminationError,
  getProcessRuntime,
  registerProcessSecrets,
} from "../src/process/process-runtime.js";
import { redactSecrets } from "../src/security/redact-secrets.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-runtime-test-"));
afterEach(() => vi.restoreAllMocks());

describe("process evidence failure containment", () => {
  it("registers dynamically issued project tokens for subsequent redaction", () => {
    const token = "dynamic-app-installation-token-unique";
    registerProcessSecrets([token]);
    expect(getProcessRuntime().secretValues).toContain(token);
    expect(
      redactSecrets(`response ${token}`, getProcessRuntime().secretValues),
    ).toBe("response [REDACTED]");
  });

  it("rejects initialization failure as typed error and removes partial artifacts", () => {
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => beginProcessEvidence("cmd", root)).toThrow(
      ProcessEvidenceError,
    );
    expect(write).toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "process-executions"))).toBe(false);
  });

  it("records append failure without throwing from stream callbacks", () => {
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const evidence = beginProcessEvidence("cmd", root);
    expect(() => evidence.append("stdout", "output")).not.toThrow();
    expect(evidence.failure).toBeInstanceOf(ProcessEvidenceError);
    append.mockRestore();
    expect(() => evidence.finish("success")).not.toThrow();
  });

  it("durably proves spawn failure was never dispatched when no child PID exists", () => {
    const evidence = beginProcessEvidence("opencode run", root);
    evidence.finish("spawn-failure");
    const metadata = JSON.parse(
      fs.readFileSync(evidence.metadataPath, "utf8"),
    ) as { status: string; dispatchState: string; pid?: number };
    expect(metadata).toMatchObject({
      status: "spawn-failure",
      dispatchState: "not-dispatched",
    });
    expect(metadata.pid).toBeUndefined();
  });

  it("throws explicit typed failure when terminal metadata cannot be written", () => {
    const evidence = beginProcessEvidence("cmd", root);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => evidence.finish("success")).toThrow(ProcessEvidenceError);
  });
});

describe("Linux process-group liveness uncertainty", () => {
  it("recognizes a valid zombie as non-executing", async () => {
    if (process.platform !== "linux") return;
    vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) =>
      args[0] === "/proc"
        ? ["321"]
        : Reflect.apply(
            fs.readdirSync,
            fs,
            args as never[],
          )) as typeof fs.readdirSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) =>
      args[0] === "/proc/321/stat"
        ? "321 (zombie fixture) Z 1 321 0"
        : Reflect.apply(
            fs.readFileSync,
            fs,
            args as never[],
          )) as typeof fs.readFileSync);
    vi.spyOn(process, "kill").mockImplementation(((
      target: number,
      signal: NodeJS.Signals | 0,
    ) => {
      if (
        target === -321 &&
        (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL")
      )
        return true;
      throw new Error(`unexpected signal target ${target}`);
    }) as typeof process.kill);
    await expect(
      drainProcessGroup(321, () => true, 0),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["EACCES", "permission denied"],
    ["EIO", "I/O error"],
  ])(
    "does not declare a group gone on %s reading proc stat",
    async (code, message) => {
      if (process.platform !== "linux") return;
      vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) => {
        if (args[0] === "/proc") return ["321"];
        return Reflect.apply(fs.readdirSync, fs, args as never[]);
      }) as typeof fs.readdirSync);
      vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
        if (args[0] === "/proc/321/stat") {
          const error = new Error(message) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return Reflect.apply(fs.readFileSync, fs, args as never[]);
      }) as typeof fs.readFileSync);
      vi.spyOn(process, "kill").mockImplementation(((
        target: number,
        signal: NodeJS.Signals | 0,
      ) => {
        if (
          target === -321 &&
          (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL")
        )
          return true;
        throw new Error(`unexpected signal target ${target}`);
      }) as typeof process.kill);
      await expect(
        drainProcessGroup(321, () => true, 0),
      ).rejects.toBeInstanceOf(ProcessGroupTerminationError);
    },
  );

  it("treats malformed stat data as ambiguous rather than dead", async () => {
    if (process.platform !== "linux") return;
    vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) =>
      args[0] === "/proc"
        ? ["321"]
        : Reflect.apply(
            fs.readdirSync,
            fs,
            args as never[],
          )) as typeof fs.readdirSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) =>
      args[0] === "/proc/321/stat"
        ? "malformed"
        : Reflect.apply(
            fs.readFileSync,
            fs,
            args as never[],
          )) as typeof fs.readFileSync);
    vi.spyOn(process, "kill").mockImplementation(((
      target: number,
      signal: NodeJS.Signals | 0,
    ) => {
      if (
        target === -321 &&
        (signal === 0 || signal === "SIGTERM" || signal === "SIGKILL")
      )
        return true;
      throw new Error(`unexpected signal target ${target}`);
    }) as typeof process.kill);
    await expect(drainProcessGroup(321, () => true, 0)).rejects.toBeInstanceOf(
      ProcessGroupTerminationError,
    );
  });
});
