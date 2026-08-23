import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendSessionLog,
  getSessionLogPath,
  removeSessionLog,
} from "../src/logging/session-log.js";

const originalCwd = process.cwd();
let temporaryDirectory: string | undefined;

afterEach(() => {
  process.chdir(originalCwd);

  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    temporaryDirectory = undefined;
  }
});

function useTemporaryWorkingDirectory(): void {
  temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-test-"),
  );
  process.chdir(temporaryDirectory);
}

describe("session log", () => {
  it("removes a card session log", () => {
    useTemporaryWorkingDirectory();

    const logPath = getSessionLogPath("project-1", "card-1");

    appendSessionLog(logPath, "session output");

    expect(existsSync(logPath)).toBe(true);

    removeSessionLog("project-1", "card-1");

    expect(existsSync(logPath)).toBe(false);
  });

  it("does not fail when the session log does not exist", () => {
    useTemporaryWorkingDirectory();

    expect(() => {
      removeSessionLog("project-1", "missing-card");
    }).not.toThrow();
  });

  it("keeps distinct project identifiers in distinct log paths", () => {
    const first = getSessionLogPath("project/a", "card-1");
    const second = getSessionLogPath("project_a", "card-1");

    expect(first).not.toBe(second);
  });
});
