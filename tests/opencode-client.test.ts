import { describe, expect, it, vi } from "vitest";

import {
  buildOpenCodeConfigContent,
  buildOpenCodeArguments,
  OpenCodeClient,
  OpenCodeRunAbortedError,
  OpenCodeSessionIdCaptureError,
  OpenCodeTimeoutError,
  parseOpenCodeSessionId,
  stripOpenCodePluginPreamble,
  reportUnavailableOpenCodeSelection,
  signalProcessTree,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";

describe("OpenCodeClient", () => {
  it("normalizes only bounded tagged startup banners while retaining strict event parsing", () => {
    const event = JSON.stringify({ type: "step_start", sessionID: "ses_original" });
    expect(parseOpenCodeSessionId(stripOpenCodePluginPreamble(`[plugin] v1\n${event}\n`))).toBe(
      "ses_original",
    );
    for (const output of [
      `not JSON\n${event}\n`,
      `${event}\n[plugin] interleaved\n`,
      `[plugin] v1\n{broken\n${event}\n`,
      `${"[plugin] v1\n".repeat(17)}${event}\n`,
      `[plugin] ${"x".repeat(4096)}\n${event}\n`,
    ])
      expect(() => parseOpenCodeSessionId(stripOpenCodePluginPreamble(output))).toThrow();
  });
  it("denies editing and command tools for read-only reviewer sessions", () => {
    expect(JSON.parse(buildOpenCodeConfigContent(true))).toEqual({
      permission: {
        question: "deny",
        edit: "deny",
        bash: "deny",
        external_directory: "deny",
      },
    });
    expect(JSON.parse(buildOpenCodeConfigContent(false))).toEqual({
      permission: { question: "deny" },
    });
  });

  it("builds unchanged CLI arguments when there is no explicit session", () => {
    expect(
      buildOpenCodeArguments({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        prompt: "Implement the task",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--pure",
      "--model",
      "test-model",
      "--variant",
      "high",
      "--dir",
      "/worktree",
      "Implement the task",
    ]);
  });

  it("omits absent model and variant arguments independently", () => {
    const common = { cwd: "/worktree", prompt: "prompt" };
    expect(buildOpenCodeArguments(common)).toEqual([
      "run",
      "--auto",
      "--pure",
      "--dir",
      "/worktree",
      "prompt",
    ]);
    expect(buildOpenCodeArguments({ ...common, model: "provider/model" })).toEqual([
      "run",
      "--auto",
      "--pure",
      "--model",
      "provider/model",
      "--dir",
      "/worktree",
      "prompt",
    ]);
    expect(buildOpenCodeArguments({ ...common, variant: "high" })).toEqual([
      "run",
      "--auto",
      "--pure",
      "--variant",
      "high",
      "--dir",
      "/worktree",
      "prompt",
    ]);
    expect(
      buildOpenCodeArguments({
        ...common,
        model: "provider/model",
        variant: "high",
      }),
    ).toContain("--model");
  });

  it("retains structured output when resuming an existing planning session", () => {
    const args = buildOpenCodeArguments({
      cwd: "/worktree",
      prompt: "plan",
      sessionId: "ses_original",
      structuredOutput: true,
    });
    expect(args).toContain("--pure");
    expect(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2)).toEqual([
      "--session",
      "ses_original",
    ]);
    expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 2)).toEqual([
      "--format",
      "json",
    ]);
  });

  it("reports explicit unavailable selections without recasting service errors", () => {
    const unavailable = reportUnavailableOpenCodeSelection(
      { exitCode: 1, output: "", errorOutput: "Model not found" },
      { model: "provider/missing", variant: "high" },
    );
    expect(unavailable.errorOutput).toContain(
      'Configured OpenCode selection unavailable: model="provider/missing", variant="high"',
    );
    const transient = reportUnavailableOpenCodeSelection(
      {
        exitCode: 1,
        output: "",
        errorOutput: "Service temporarily unavailable",
      },
      { model: "provider/selected" },
    );
    expect(transient.errorOutput).toBe("Service temporarily unavailable");
    expect(transient.exitCode).toBe(1);
  });

  it("adds only the explicit session argument when a session ID is provided", () => {
    expect(
      buildOpenCodeArguments({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        prompt: "Continue the task",
        sessionId: "ses_session-123",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--pure",
      "--model",
      "test-model",
      "--variant",
      "high",
      "--dir",
      "/worktree",
      "--session",
      "ses_session-123",
      "Continue the task",
    ]);
  });

  it("selects structured JSON events only for session capture", () => {
    expect(
      buildOpenCodeArguments({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        prompt: "Create the task session",
        captureSessionId: true,
      }),
    ).toEqual([
      "run",
      "--auto",
      "--pure",
      "--model",
      "test-model",
      "--variant",
      "high",
      "--dir",
      "/worktree",
      "--format",
      "json",
      "Create the task session",
    ]);
  });

  it("parses one session ID from supported version-one JSON events", () => {
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_created-123" }),
      JSON.stringify({ type: "text", sessionID: "ses_created-123" }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");

    expect(parseOpenCodeSessionId(output)).toBe("ses_created-123");
  });

  it.each([
    ["empty", ""],
    ["missing", JSON.stringify({ type: "text", text: "No ID here" })],
    ["malformed JSON", '{"type":"text"'],
    ["free-form prose", "Created session ses_created-123"],
    [
      "unsupported event version",
      JSON.stringify({
        version: 2,
        type: "text",
        sessionID: "ses_created-123",
      }),
    ],
    ["invalid session identifier", JSON.stringify({ type: "text", sessionID: "invalid session" })],
  ])("rejects %s structured session output", (_description, output) => {
    expect(() => parseOpenCodeSessionId(output)).toThrow();
  });

  it("rejects ambiguous session IDs from a structured event stream", () => {
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_first" }),
      JSON.stringify({ type: "text", sessionID: "ses_second" }),
    ].join("\n");

    expect(() => parseOpenCodeSessionId(output)).toThrow("ambiguous");
  });

  it("runs OpenCode with the provided options", async () => {
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "Completed",
      errorOutput: "",
    });

    const client = new OpenCodeClient(runOpenCode);

    const controller = new AbortController();

    const result = await client.run({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      timeoutMilliseconds: 360 * 60_000,
      prompt: "Implement the task",
      signal: controller.signal,
    });

    expect(runOpenCode).toHaveBeenCalledWith({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      timeoutMilliseconds: 360 * 60_000,
      prompt: "Implement the task",
      signal: controller.signal,
    });

    expect(result).toEqual({
      exitCode: 0,
      output: "Completed",
      errorOutput: "",
    });
  });

  it("forwards an explicit session ID through the process boundary", async () => {
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
      output: "Continued",
      errorOutput: "",
    });
    const client = new OpenCodeClient(runOpenCode);
    const controller = new AbortController();

    await expect(
      client.run({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        timeoutMilliseconds: 60_000,
        prompt: "Continue the task",
        signal: controller.signal,
        sessionId: "ses_session-123",
      }),
    ).resolves.toMatchObject({ sessionId: "ses_session-123" });

    expect(runOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_session-123" }),
    );
  });

  it("returns a captured session ID while retaining structured diagnostics", async () => {
    const output = JSON.stringify({
      type: "step_start",
      sessionID: "ses_created-123",
    });
    const result = {
      exitCode: 0,
      output,
      errorOutput: "warning: optional diagnostic",
    };
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue(result);
    const client = new OpenCodeClient(runOpenCode);

    await expect(
      client.run({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        timeoutMilliseconds: 60_000,
        prompt: "Create a task session",
        signal: new AbortController().signal,
        captureSessionId: true,
      }),
    ).resolves.toEqual({ ...result, sessionId: "ses_created-123" });
    expect(runOpenCode).toHaveBeenCalledWith(expect.objectContaining({ captureSessionId: true }));
  });

  it("preserves process output when session capture fails", async () => {
    const result = {
      exitCode: 0,
      output: "OpenCode emitted no session event",
      errorOutput: "diagnostic from stderr",
    };
    const client = new OpenCodeClient(vi.fn<RunOpenCode>().mockResolvedValue(result));

    await expect(
      client.run({
        cwd: "/worktree",
        model: "test-model",
        variant: "high",
        timeoutMilliseconds: 60_000,
        prompt: "Create a task session",
        signal: new AbortController().signal,
        captureSessionId: true,
      }),
    ).rejects.toMatchObject<Partial<OpenCodeSessionIdCaptureError>>({
      name: "OpenCodeSessionIdCaptureError",
      runResult: result,
    });
  });

  it.each(["", " session", "session id", "--continue", "session/one"])(
    "rejects an invalid session ID before starting OpenCode: %s",
    async (sessionId) => {
      const runOpenCode = vi.fn<RunOpenCode>();
      const client = new OpenCodeClient(runOpenCode);

      await expect(
        client.run({
          cwd: "/worktree",
          model: "test-model",
          variant: "high",
          timeoutMilliseconds: 60_000,
          prompt: "Continue the task",
          signal: new AbortController().signal,
          sessionId,
        }),
      ).rejects.toThrow("Invalid OpenCode session ID");
      expect(runOpenCode).not.toHaveBeenCalled();
    },
  );

  it("signals the process group on non-Windows platforms", () => {
    if (process.platform === "win32") {
      return;
    }

    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const killChild = vi.fn(() => true);

    signalProcessTree(1234, "SIGTERM", killChild);

    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(killChild).not.toHaveBeenCalled();

    kill.mockRestore();
  });

  it("falls back to the child handle when the child pid is unavailable", () => {
    const killChild = vi.fn(() => true);

    signalProcessTree(undefined, "SIGTERM", killChild);

    expect(killChild).toHaveBeenCalledWith("SIGTERM");
  });

  it("ignores ESRCH when the process group is already gone", () => {
    if (process.platform === "win32") {
      return;
    }

    const error = Object.assign(new Error("No such process"), {
      code: "ESRCH",
    });

    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });

    expect(() => {
      signalProcessTree(
        1234,
        "SIGTERM",
        vi.fn(() => true),
      );
    }).not.toThrow();

    kill.mockRestore();
  });

  it("falls back to the child handle when process-group signaling fails", () => {
    if (process.platform === "win32") {
      return;
    }

    const error = Object.assign(new Error("Operation not permitted"), {
      code: "EPERM",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const killChild = vi.fn(() => true);

    signalProcessTree(1234, "SIGTERM", killChild);

    expect(killChild).toHaveBeenCalledWith("SIGTERM");

    kill.mockRestore();
  });

  it("rejects with OpenCodeRunAbortedError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const opencode = new OpenCodeClient();

    try {
      await opencode.run({
        cwd: "/tmp/repository",
        model: "test-model",
        variant: "test-variant",
        timeoutMilliseconds: 60_000,
        prompt: "Test prompt",
        signal: controller.signal,
      });

      throw new Error("Expected OpenCode run to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeRunAbortedError);
      expect((error as Error).message).toBe("OpenCode run aborted");
    }
  });

  it("uses OpenCodeTimeoutError for safety timeouts", () => {
    const error = new OpenCodeTimeoutError(123_000);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OpenCodeTimeoutError");
    expect(error.message).toBe("OpenCode exceeded safety timeout of 123000ms");
  });
});
