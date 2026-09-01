import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logging/logger.js";
import { loadStartupEvent } from "../src/package-version.js";

const timestamp = "2026-08-30T09:00:00.000Z";
let temporaryDirectory: string | undefined;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-logger-test-"),
  );

  vi.spyOn(process, "cwd").mockReturnValue(temporaryDirectory);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
  vi.stubEnv("VITEST", "true");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    temporaryDirectory = undefined;
  }
});

function getDailyLogPath(): string {
  return path.join(
    temporaryDirectory!,
    "logs",
    "test-orchestrator-2026-08-30.log",
  );
}

describe("Logger", () => {
  it("prefixes root event output and preserves the daily log format", () => {
    const logger = new Logger();
    const startupEvent = loadStartupEvent();

    logger.event(startupEvent);

    expect(console.log).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(`${timestamp} ${startupEvent}`);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toBe(
      `${timestamp} INFO  ${startupEvent}\n`,
    );
  });

  it("prefixes warning output with a child logger context on stderr", () => {
    const logger = new Logger({ projectId: "project-1" }).child({
      cardId: "card-1",
    });

    logger.warn("Task warning");

    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      `${timestamp} [project-1] [card:card-1] Task warning`,
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prefixes error output with a child logger context on stderr", () => {
    const logger = new Logger({ projectId: "project-1" }).child({
      cardId: "card-1",
    });

    logger.error("Task failed");

    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      `${timestamp} [project-1] [card:card-1] Task failed`,
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("prefixes every physical line of a multiline message", () => {
    const logger = new Logger({ projectId: "project-1" });
    const message = "first line\nsecond line\r\nthird line\rfourth line";

    logger.event(message);

    expect(console.log).toHaveBeenCalledWith(
      `${timestamp} [project-1] first line\n${timestamp} [project-1] second line\r\n${timestamp} [project-1] third line\r${timestamp} [project-1] fourth line`,
    );
  });

  it("does not emit new console output for debug or info logs", () => {
    const logger = new Logger();

    logger.debug("debug details");
    logger.info("informational details");

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
