import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { observeContainedProcess } from "../src/process/contained-process.js";

function fixture() {
  const status = new EventEmitter();
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, status, null],
    stdout,
  });
  const failed = vi.fn();
  const observer = observeContainedProcess(child as unknown as ChildProcess, failed);
  const send = (value: unknown) => status.emit("data", `${JSON.stringify(value)}\n`);
  return { observer, failed, stdout, status, send };
}

it("requires the private final result and does not parse tool stdout as process status", () => {
  const f = fixture();
  f.stdout.emit("data", '{"type":"result","spawned":true,"code":0,"signal":null}\n');
  expect(() => f.observer.result(0, null)).toThrow("without a verified payload result");
  f.send({ type: "started" });
  f.send({ type: "result", spawned: true, code: 0, signal: null });
  expect(f.observer.result(0, null)).toMatchObject({ code: 0, signal: null, spawned: true });
});

it("does not invent a never-spawned payload when the supervisor is interrupted before reporting", () => {
  const f = fixture();
  expect(f.observer.result(null, "SIGKILL")).toMatchObject({
    spawned: undefined,
    code: null,
    signal: "SIGKILL",
  });
});

it.each([
  { type: "result", spawned: true, code: null, signal: null },
  { type: "result", spawned: true, code: 0, signal: "SIGTERM" },
  { type: "result", spawned: true, code: null, signal: "toString" },
  { type: "result", spawned: false, code: 0, signal: null },
  { type: "result", spawned: true, code: 256, signal: null },
])("rejects contradictory or unsupported supervisor status (%#)", (result) => {
  const f = fixture();
  f.send({ type: "started" });
  f.send(result);
  expect(() => f.observer.result(0, null)).toThrow("incomplete or malformed");
  expect(f.failed).toHaveBeenCalledTimes(1);
});

it("bounds malformed status evidence and never includes its raw payload in errors", () => {
  const f = fixture();
  f.status.emit("data", "STATUS_PRIVATE_CANARY".repeat(1000));
  f.status.emit("data", "ignored".repeat(10000));
  expect(f.failed).toHaveBeenCalledTimes(1);
  expect(f.failed.mock.calls[0]?.[0].message).not.toContain("STATUS_PRIVATE_CANARY");
});
