import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../src/main.js";
import * as startup from "../src/startup/run-startup.js";
import {
  installProcessHandlers,
  type ProcessEventSource,
  RuntimeLifecycle,
} from "../src/runtime/runtime-lifecycle.js";

interface TestLogger {
  event: ReturnType<typeof vi.fn<(message: string) => void>>;
  error: ReturnType<typeof vi.fn<(message: string) => void>>;
}

type Handler = (...args: never[]) => void;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createLogger(): TestLogger {
  return {
    event: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

function createProcessEventSource(): {
  processObject: ProcessEventSource;
  handlers: Map<string, Handler>;
  removeListener: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, Handler>();
  const removeListener = vi.fn(
    (event: string, handler: Handler): ProcessEventSource => {
      if (handlers.get(event) === handler) {
        handlers.delete(event);
      }

      return processObject;
    },
  );
  const processObject = {
    on: vi.fn((event: string, handler: Handler): ProcessEventSource => {
      handlers.set(event, handler);
      return processObject;
    }),
    removeListener,
  } as unknown as ProcessEventSource;

  return { processObject, handlers, removeListener };
}

describe("RuntimeLifecycle", () => {
  it("logs a startup failure, aborts, and returns a non-zero bootstrap status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-lifecycle-"));
    temporaryDirectories.push(root);
    fs.writeFileSync(path.join(root, "config.yaml"), "projects: []\n");

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const testLogger = createLogger();
    const lifecycle = new RuntimeLifecycle({ logger: testLogger });
    const { processObject } = createProcessEventSource();

    try {
      await expect(bootstrap(lifecycle, processObject)).resolves.toBe(1);
    } finally {
      cwd.mockRestore();
    }

    expect(lifecycle.signal.aborted).toBe(true);
    expect(testLogger.error).toHaveBeenCalledOnce();
    expect(testLogger.error.mock.calls[0]?.[0]).toContain(
      "Fatal startup failure; requesting coordinated shutdown",
    );
    expect(testLogger.error.mock.calls[0]?.[0]).toContain(
      "Invalid configuration",
    );
  });

  it("rejects duplicate project IDs before starting project workers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-lifecycle-"));
    const config = fs
      .readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")
      .replace('id: "project"', 'id: "duplicate-project"')
      .replace('id: "another-project"', 'id: "duplicate-project"');
    fs.writeFileSync(path.join(root, "config.yaml"), config);

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const runStartup = vi.spyOn(startup, "runStartup");
    const testLogger = createLogger();
    const lifecycle = new RuntimeLifecycle({ logger: testLogger });
    const { processObject } = createProcessEventSource();

    try {
      await expect(bootstrap(lifecycle, processObject)).resolves.toBe(1);
      expect(runStartup).not.toHaveBeenCalled();
    } finally {
      runStartup.mockRestore();
      cwd.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(testLogger.error.mock.calls[0]?.[0]).toContain(
      'Duplicate project ID "duplicate-project"',
    );
  });

  it.each([
    ["uncaught exception", "uncaughtException", new Error("exception boom")],
    [
      "unhandled promise rejection",
      "unhandledRejection",
      new Error("rejection boom"),
    ],
  ] as const)(
    "handles a %s at the process boundary",
    (source, event, error) => {
      const testLogger = createLogger();
      const lifecycle = new RuntimeLifecycle({ logger: testLogger });
      const { processObject, handlers } = createProcessEventSource();
      const removeProcessHandlers = installProcessHandlers(
        lifecycle,
        processObject,
      );

      handlers.get(event)?.(error as never);

      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.exitCode).toBe(1);
      expect(lifecycle.fatalFailure?.source).toBe(source);
      expect(testLogger.error).toHaveBeenCalledOnce();
      expect(testLogger.error.mock.calls[0]?.[0]).toContain(`Fatal ${source}`);
      expect(testLogger.error.mock.calls[0]?.[0]).toContain(error.message);

      removeProcessHandlers();
    },
  );

  it("makes signal shutdown idempotent and keeps intentional shutdown successful", () => {
    const testLogger = createLogger();
    const lifecycle = new RuntimeLifecycle({ logger: testLogger });

    lifecycle.requestSignalShutdown("SIGINT");
    lifecycle.requestSignalShutdown("SIGTERM");

    expect(lifecycle.shutdownKind).toBe("signal");
    expect(lifecycle.exitCode).toBe(0);
    expect(testLogger.event).toHaveBeenCalledOnce();
    expect(testLogger.event).toHaveBeenCalledWith(
      "Received SIGINT; shutting down...",
    );
  });

  it("preserves the first fatal diagnostic when fatal events repeat", () => {
    const testLogger = createLogger();
    const lifecycle = new RuntimeLifecycle({
      logger: testLogger,
      secretValues: ["secret-token"],
    });
    const firstError = new Error("first failure token=secret-token");

    lifecycle.requestFatal("uncaught exception", firstError);
    lifecycle.requestFatal(
      "unhandled promise rejection",
      new Error("second failure"),
    );

    expect(lifecycle.fatalFailure?.error).toBe(firstError);
    expect(lifecycle.fatalFailure?.source).toBe("uncaught exception");
    expect(lifecycle.shutdownKind).toBe("fatal");
    expect(testLogger.error).toHaveBeenCalledOnce();
    expect(testLogger.error.mock.calls[0]?.[0]).toContain("first failure");
    expect(testLogger.error.mock.calls[0]?.[0]).not.toContain("secret-token");
  });

  it("routes both signals and process-level failures through removable handlers", () => {
    const testLogger = createLogger();
    const lifecycle = new RuntimeLifecycle({ logger: testLogger });
    const { processObject, handlers, removeListener } =
      createProcessEventSource();
    const removeProcessHandlers = installProcessHandlers(
      lifecycle,
      processObject,
    );

    handlers.get("SIGTERM")?.("SIGTERM" as never);

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.exitCode).toBe(0);

    removeProcessHandlers();

    expect(removeListener).toHaveBeenCalledTimes(4);
  });
});
