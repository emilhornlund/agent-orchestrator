import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logging/logger.js";

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
  vi.stubEnv("TEST_LOGS", "false");
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
  it("suppresses event console output while preserving the test daily log", () => {
    const logger = new Logger();

    logger.event("Agent Orchestrator started");

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toBe(
      `${timestamp} INFO  Agent Orchestrator started\n`,
    );
  });

  it("suppresses warning output while preserving the test daily log", () => {
    const logger = new Logger({ projectId: "project-1" }).child({
      cardId: "card-1",
    });

    logger.warn("Task warning");

    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toBe(
      `${timestamp} WARN  [project-1] [card:card-1] Task warning\n`,
    );
  });

  it("suppresses error output while preserving the test daily log", () => {
    const logger = new Logger({ projectId: "project-1" }).child({
      cardId: "card-1",
    });

    logger.error("Task failed");

    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(fs.readFileSync(getDailyLogPath(), "utf8")).toBe(
      `${timestamp} ERROR [project-1] [card:card-1] Task failed\n`,
    );
  });

  it("restores console output and formatting when test logs are enabled", () => {
    vi.stubEnv("TEST_LOGS", "true");
    const logger = new Logger({ projectId: "project-1" });
    const message = "first line\nsecond line";

    logger.event(message);
    logger.warn("Task warning");
    logger.error("Task failed");

    expect(console.log).toHaveBeenCalledWith(
      `${timestamp} [project-1] first line\n${timestamp} [project-1] second line`,
    );
    expect(console.warn).toHaveBeenCalledWith(
      `${timestamp} [project-1] Task warning`,
    );
    expect(console.error).toHaveBeenCalledWith(
      `${timestamp} [project-1] Task failed`,
    );
  });

  it("preserves console output outside Vitest regardless of the opt-in", () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("TEST_LOGS", "true");
    const logger = new Logger({ projectId: "project-1" });

    logger.event("Agent Orchestrator started");
    logger.warn("Task warning");
    logger.error("Task failed");

    expect(console.log).toHaveBeenCalledWith(
      `${timestamp} [project-1] Agent Orchestrator started`,
    );
    expect(console.warn).toHaveBeenCalledWith(
      `${timestamp} [project-1] Task warning`,
    );
    expect(console.error).toHaveBeenCalledWith(
      `${timestamp} [project-1] Task failed`,
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
