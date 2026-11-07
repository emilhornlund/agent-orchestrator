import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  OpenCodeClient,
  OpenCodeRunAbortedError,
  OpenCodeTimeoutError,
} from "../src/opencode/opencode-client.js";
import { PROCESS_CAPTURE_MAX_BYTES } from "../src/process/process-runtime.js";

interface FakeChild extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

describe("OpenCode streaming output", () => {
  let directory: string;

  beforeEach(() => {
    spawnMock.mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-stream-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function run(
    child: FakeChild,
    options: { signal?: AbortSignal; timeoutMilliseconds?: number } = {},
  ) {
    spawnMock.mockReturnValue(child);
    return new OpenCodeClient().run({
      cwd: directory,
      model: "test-model",
      variant: "high",
      timeoutMilliseconds: options.timeoutMilliseconds ?? 60_000,
      prompt: "work",
      signal: options.signal ?? new AbortController().signal,
      sessionLogPath: path.join(directory, "card.log"),
      secretValues: ["secret-value"],
    });
  }

  it("streams stdout and stderr to the card log before the child exits", async () => {
    const child = fakeChild();
    const result = run(child);
    child.stdout.emit("data", Buffer.from("stdout event\n"));
    child.stderr.emit("data", Buffer.from("stderr event\n"));

    const log = fs.readFileSync(path.join(directory, "card.log"), "utf8");
    expect(log).toContain("stdout event\n");
    expect(log).toContain("stderr event\n");
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({
      exitCode: 0,
      output: "stdout event\n",
      errorOutput: "stderr event\n",
    });
  });

  it("uses only each project's explicitly selected provider credential at spawn", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-project-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-project-secret");
    vi.stubEnv("TRELLO_API_KEY", "must-not-leak");
    const modelRuns = [
      [
        "openai/gpt-test",
        "OPENAI_API_KEY",
        "openai-project-secret",
        "ANTHROPIC_API_KEY",
      ],
      [
        "anthropic/claude-test",
        "ANTHROPIC_API_KEY",
        "anthropic-project-secret",
        "OPENAI_API_KEY",
      ],
    ] as const;

    for (const [model, allowedKey, allowedValue, excludedKey] of modelRuns) {
      const child = fakeChild();
      spawnMock.mockReturnValueOnce(child);
      const result = new OpenCodeClient().run({
        cwd: directory,
        model,
        variant: "high",
        timeoutMilliseconds: 60_000,
        prompt: "work",
        signal: new AbortController().signal,
      });
      const env = spawnMock.mock.calls.at(-1)![2].env as NodeJS.ProcessEnv;
      expect(env[allowedKey]).toBe(allowedValue);
      expect(env).not.toHaveProperty(excludedKey);
      expect(env).not.toHaveProperty("TRELLO_API_KEY");
      child.emit("close", 0);
      await expect(result).resolves.toMatchObject({ exitCode: 0 });
    }
  });

  it("redacts registered PEM literal and encoded forms from the actual OpenCode prompt argument", async () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nsynthetic-open-code-pem\n-----END PRIVATE KEY-----";
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const prompt = `Inspect this attachment: ${pem}; encoded=${Buffer.from(pem).toString("base64url")}`;
    const result = new OpenCodeClient().run({
      cwd: directory,
      model: "openai/gpt-test",
      variant: "high",
      timeoutMilliseconds: 60_000,
      prompt,
      signal: new AbortController().signal,
      secretValues: [pem],
    });
    const args = spawnMock.mock.calls[0]![1] as string[];
    const actualPrompt = args.at(-1)!;
    expect(actualPrompt).not.toContain(pem);
    expect(actualPrompt).not.toContain(Buffer.from(pem).toString("base64url"));
    expect(actualPrompt.match(/\[REDACTED\]/gu)).toHaveLength(2);
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({ exitCode: 0 });
  });

  it("redacts secrets split across chunks and captures full structured output", async () => {
    const child = fakeChild();
    const result = run(child);
    const events = [
      JSON.stringify({ type: "step_start", sessionID: "ses_created" }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "secret-value" },
      }),
    ].join("\n");
    const secretStart = events.indexOf("secret-value");
    const splitAt = secretStart + "secret-".length;
    child.stdout.emit("data", Buffer.from(events.slice(0, splitAt)));
    child.stdout.emit("data", Buffer.from(events.slice(splitAt)));
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({
      output: events.replace("secret-value", "[REDACTED]"),
    });
    expect(
      fs.readFileSync(path.join(directory, "card.log"), "utf8"),
    ).not.toContain("secret-value");
  });

  it("captures a session ID from the complete structured stream", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = new OpenCodeClient().run({
      cwd: directory,
      model: "test-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      prompt: "create",
      signal: new AbortController().signal,
      sessionLogPath: path.join(directory, "card.log"),
      captureSessionId: true,
    });
    child.stdout.emit("data", Buffer.from('{"type":"step_start","session'));
    child.stdout.emit("data", Buffer.from('ID":"ses_created"}\n'));
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({
      sessionId: "ses_created",
      output: '{"type":"step_start","sessionID":"ses_created"}\n',
    });
  });

  it("redacts configured secrets supplied by the OpenCode client", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = new OpenCodeClient(undefined, ["configured-secret"]).run({
      cwd: directory,
      model: "test-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      prompt: "work",
      signal: new AbortController().signal,
      sessionLogPath: path.join(directory, "card.log"),
    });
    child.stdout.emit("data", Buffer.from("configured-secret\n"));
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({ output: "[REDACTED]\n" });
  });

  it("preserves streamed output when process startup fails", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = new OpenCodeClient().run({
      cwd: directory,
      model: "test-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      prompt: "work",
      signal: new AbortController().signal,
      sessionLogPath: path.join(directory, "card.log"),
    });
    child.stdout.emit("data", Buffer.from("partial startup output\n"));
    child.emit("error", new Error("spawn failed"));
    await expect(result).rejects.toThrow(
      /OpenCode spawn failure; diagnostics: process-executions\//,
    );
    expect(fs.readFileSync(path.join(directory, "card.log"), "utf8")).toContain(
      "partial startup output\n",
    );
  });

  it("handles large streams incrementally without writing card output to container streams", async () => {
    const child = fakeChild();
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const result = run(child);
    for (let i = 0; i < 500; i += 1)
      child.stdout.emit("data", Buffer.from(`${"x".repeat(2048)}\n`));
    expect(fs.statSync(path.join(directory, "card.log")).size).toBeGreaterThan(
      1_000_000,
    );
    child.emit("close", 0);
    const captured = await result;
    expect(captured.output.length).toBeGreaterThan(1_000_000);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it("bounds captured OpenCode output and references the separate evidence artifact", async () => {
    const child = fakeChild();
    const result = run(child);
    child.stdout.emit("data", Buffer.alloc(PROCESS_CAPTURE_MAX_BYTES + 1, "x"));
    child.emit("close", 0);
    await expect(result).rejects.toThrow(
      new RegExp(
        `stdout exceeded the ${PROCESS_CAPTURE_MAX_BYTES}-byte output limit; diagnostics: process-executions/`,
      ),
    );
  });

  it("rejects cancellation and timeout while retaining already-streamed output", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const controller = new AbortController();
    const aborted = run(child, { signal: controller.signal });
    child.stdout.emit("data", Buffer.from("before abort\n"));
    controller.abort();
    child.emit("close", null);
    await expect(aborted).rejects.toBeInstanceOf(OpenCodeRunAbortedError);

    const secondChild = fakeChild();
    const timeout = run(secondChild, { timeoutMilliseconds: 1_000 });
    secondChild.stdout.emit("data", Buffer.from("before timeout\n"));
    const rejection =
      expect(timeout).rejects.toBeInstanceOf(OpenCodeTimeoutError);
    await vi.advanceTimersByTimeAsync(6_000);
    secondChild.emit("close", null);
    await rejection;
  });
});
