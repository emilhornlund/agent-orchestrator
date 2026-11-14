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
import {
  configureProcessRuntime,
  PROCESS_CAPTURE_MAX_BYTES,
} from "../src/process/process-runtime.js";
import { attachContainedChildStatus } from "./support/contained-child-status.js";

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
  return attachContainedChildStatus(child);
}

describe("OpenCode streaming output", () => {
  let directory: string;

  beforeEach(() => {
    spawnMock.mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-stream-"));
    configureProcessRuntime({
      runtimeRoot: path.join(directory, "process-evidence"),
      signal: new AbortController().signal,
    });
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

  it("captures the original session despite tagged plugin bootstrap banners and retains raw evidence", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let metadataPath = "";
    const pending = new OpenCodeClient().run({
      cwd: directory,
      model: "test-model",
      timeoutMilliseconds: 60_000,
      prompt: "plan",
      captureSessionId: true,
      signal: new AbortController().signal,
      onExecutionPrepared: (evidence) => {
        metadataPath = evidence.metadataPath;
      },
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const event = JSON.stringify({ type: "step_start", sessionID: "ses_original" });
    child.stdout.emit("data", `[example-plugin] v1.0\n${event}\n`);
    child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({
      sessionId: "ses_original",
      output: `${event}\n`,
    });
    expect(fs.readFileSync(path.join(path.dirname(metadataPath), "stdout.txt"), "utf8")).toContain(
      "[example-plugin] v1.0",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("finalizes stopped process evidence when startup fails before emitting a session ID", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let metadataPath: string | undefined;
    const pending = new OpenCodeClient().run({
      cwd: directory,
      model: "test-model",
      timeoutMilliseconds: 60_000,
      prompt: "plan",
      captureSessionId: true,
      signal: new AbortController().signal,
      onExecutionPrepared: (evidence) => {
        metadataPath = evidence.metadataPath;
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "OpenCodeSessionIdCaptureError",
      runResult: { exitCode: 1, errorOutput: "startup failed\n" },
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit("spawn");
    expect(JSON.parse(fs.readFileSync(metadataPath!, "utf8"))).toMatchObject({
      status: "running",
      dispatchState: "dispatched",
    });
    child.stderr.emit("data", "startup failed\n");
    child.emit("close", 1, null);
    await rejected;
    expect(JSON.parse(fs.readFileSync(metadataPath!, "utf8"))).toMatchObject({
      status: "nonzero",
      exitCode: 1,
      treeStopped: true,
      dispatchState: "dispatched",
      resultArtifact: { path: "result.json" },
    });
  });

  it("uses only each project's explicitly selected provider credential at spawn", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-project-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-project-secret");
    vi.stubEnv("TRELLO_API_KEY", "must-not-leak");
    const modelRuns = [
      ["openai/gpt-test", "OPENAI_API_KEY", "openai-project-secret", "ANTHROPIC_API_KEY"],
      ["anthropic/claude-test", "ANTHROPIC_API_KEY", "anthropic-project-secret", "OPENAI_API_KEY"],
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

  it("uses the configured default provider to scope credentials without selecting a model", async () => {
    const configPath = path.join(directory, "opencode.jsonc");
    fs.writeFileSync(
      configPath,
      '{\n "model": "openai/default-model", // trailing comma with comment\n /* before closing brace */\n}',
    );
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = new OpenCodeClient().run({
      cwd: directory,
      timeoutMilliseconds: 60_000,
      prompt: "use the configured default",
      signal: new AbortController().signal,
      environment: {
        OPENCODE_CONFIG: configPath,
        OPENAI_API_KEY: "scoped-openai-key",
        ANTHROPIC_API_KEY: "unrelated-anthropic-key",
        TRELLO_API_KEY: "unrelated-secret",
      },
    });
    const [, args, options] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--variant");
    expect(options.env.OPENAI_API_KEY).toBe("scoped-openai-key");
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("TRELLO_API_KEY");
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  });

  it("fails with an actionable auth/config diagnostic when default provider scoping is ambiguous", async () => {
    const pending = new OpenCodeClient().run({
      cwd: directory,
      timeoutMilliseconds: 60_000,
      prompt: "use the configured default",
      signal: new AbortController().signal,
      environment: {
        OPENAI_API_KEY: "scoped-openai-key",
        ANTHROPIC_API_KEY: "unrelated-anthropic-key",
      },
    });
    await expect(pending).rejects.toThrow(
      "OpenCode default model provider could not be resolved safely",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a substitute after an explicit model is unavailable", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = new OpenCodeClient().run({
      cwd: directory,
      model: "openai/unavailable-model",
      variant: "high",
      timeoutMilliseconds: 60_000,
      prompt: "use only selected model",
      signal: new AbortController().signal,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(args).toContain("openai/unavailable-model");
    expect(args).toContain("high");
    child.stderr.emit("data", "Model not found");
    child.emit("close", 1);
    await expect(pending).resolves.toMatchObject({
      exitCode: 1,
      errorOutput: expect.stringContaining(
        'Configured OpenCode selection unavailable: model="openai/unavailable-model", variant="high"',
      ),
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("redacts registered PEM literal and encoded forms from the actual OpenCode prompt argument", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nsynthetic-open-code-pem\n-----END PRIVATE KEY-----";
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
    expect(fs.readFileSync(path.join(directory, "card.log"), "utf8")).not.toContain("secret-value");
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
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = run(child);
    for (let i = 0; i < 500; i += 1)
      child.stdout.emit("data", Buffer.from(`${"x".repeat(2048)}\n`));
    expect(fs.statSync(path.join(directory, "card.log")).size).toBeGreaterThan(1_000_000);
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
    child.emit("close", null, "SIGTERM");
    await expect(aborted).rejects.toBeInstanceOf(OpenCodeRunAbortedError);

    const secondChild = fakeChild();
    const timeout = run(secondChild, { timeoutMilliseconds: 1_000 });
    secondChild.stdout.emit("data", Buffer.from("before timeout\n"));
    const rejection = expect(timeout).rejects.toBeInstanceOf(OpenCodeTimeoutError);
    await vi.advanceTimersByTimeAsync(6_000);
    secondChild.emit("close", null, "SIGTERM");
    await rejection;
  });

  it("retains a genuine nonzero payload result when shutdown races with its close", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const result = run(child, { signal: controller.signal });
    controller.abort();
    child.emit("close", 7);
    await expect(result).resolves.toMatchObject({ exitCode: 7 });
  });
});
