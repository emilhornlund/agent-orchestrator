import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withActiveLogFile } from "../src/logging/active-log-files.js";
import { cleanupLogRetention } from "../src/logging/log-retention.js";

const originalCwd = process.cwd();
const now = new Date("2026-01-15T00:00:00.000Z");
const cutoff = new Date("2026-01-01T00:00:00.000Z");
let temporaryDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    temporaryDirectory = undefined;
  }
});

function useTemporaryWorkingDirectory(): void {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-retention-test-"),
  );
  process.chdir(temporaryDirectory);
}

function createFile(relativePath: string, modifiedAt: Date): string {
  const filePath = path.join(process.cwd(), "logs", relativePath);

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });
  fs.writeFileSync(filePath, "log content", "utf8");
  fs.utimesSync(filePath, modifiedAt, modifiedAt);

  return filePath;
}

describe("cleanupLogRetention", () => {
  it("removes expired daily and session logs but retains the cutoff and newer files", () => {
    useTemporaryWorkingDirectory();

    const expiredDaily = createFile(
      "orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const expiredTestDaily = createFile(
      "test-orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const cutoffDaily = createFile("orchestrator-2026-01-01.log", cutoff);
    const newerDaily = createFile(
      "test-orchestrator-2026-01-02.log",
      new Date("2026-01-02T00:00:00.001Z"),
    );
    const expiredSession = createFile(
      "sessions/project-1/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const cutoffSession = createFile("sessions/project-1/card-2.log", cutoff);
    const newerSession = createFile(
      "sessions/project-1/card-3.log",
      new Date("2026-01-02T00:00:00.001Z"),
    );

    cleanupLogRetention(14, now);

    expect(fs.existsSync(expiredDaily)).toBe(false);
    expect(fs.existsSync(expiredTestDaily)).toBe(false);
    expect(fs.existsSync(expiredSession)).toBe(false);
    expect(fs.existsSync(cutoffDaily)).toBe(true);
    expect(fs.existsSync(newerDaily)).toBe(true);
    expect(fs.existsSync(cutoffSession)).toBe(true);
    expect(fs.existsSync(newerSession)).toBe(true);
  });

  it("does not remove active log files or unrelated entries", () => {
    useTemporaryWorkingDirectory();

    const activeLog = createFile(
      "sessions/project-1/active-card.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const unrelatedFile = createFile(
      "notes.txt",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const unrelatedDirectory = path.join(process.cwd(), "logs", "archive");

    fs.mkdirSync(unrelatedDirectory, {
      recursive: true,
    });
    const unrelatedNestedLog = path.join(unrelatedDirectory, "old.log");
    fs.writeFileSync(unrelatedNestedLog, "unrelated", "utf8");
    fs.utimesSync(
      unrelatedNestedLog,
      new Date("2025-12-31T23:59:59.999Z"),
      new Date("2025-12-31T23:59:59.999Z"),
    );

    withActiveLogFile(activeLog, () => {
      cleanupLogRetention(14, now);
    });

    expect(fs.existsSync(activeLog)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(fs.existsSync(unrelatedNestedLog)).toBe(true);
  });

  it("preserves symbolic links and never follows their targets", () => {
    useTemporaryWorkingDirectory();

    const outsideDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "orchestrator-retention-target-"),
    );
    const outsideFile = path.join(outsideDirectory, "outside.log");

    try {
      fs.writeFileSync(outsideFile, "outside", "utf8");
      fs.utimesSync(
        outsideFile,
        new Date("2025-12-31T23:59:59.999Z"),
        new Date("2025-12-31T23:59:59.999Z"),
      );

      const dailyLink = path.join(
        process.cwd(),
        "logs",
        "orchestrator-2025-12-31.log",
      );
      const sessionLink = path.join(
        process.cwd(),
        "logs",
        "sessions",
        "project-1",
        "card-1.log",
      );

      fs.mkdirSync(path.dirname(sessionLink), {
        recursive: true,
      });
      fs.symlinkSync(outsideFile, dailyLink);
      fs.symlinkSync(outsideFile, sessionLink);

      cleanupLogRetention(14, now);

      expect(fs.lstatSync(dailyLink).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(sessionLink).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      fs.rmSync(outsideDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("treats missing log directories as a no-op", () => {
    useTemporaryWorkingDirectory();

    expect(() => cleanupLogRetention(14, now)).not.toThrow();
  });

  it("reports removal failures and continues with other files", () => {
    useTemporaryWorkingDirectory();

    const failedPath = createFile(
      "orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const removablePath = createFile(
      "test-orchestrator-2025-12-31.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const originalUnlink = fs.unlinkSync;

    vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === failedPath) {
        throw new Error("permission denied");
      }

      return originalUnlink(filePath);
    });

    cleanupLogRetention(14, now);

    expect(fs.existsSync(failedPath)).toBe(true);
    expect(fs.existsSync(removablePath)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Log retention could not remove ${failedPath}`,
    );
    expect(diagnostic).toContain("permission denied");
  });

  it("reports scan failures and continues with other project directories", () => {
    useTemporaryWorkingDirectory();

    const failedProjectDirectory = path.join(
      process.cwd(),
      "logs",
      "sessions",
      "unavailable-project",
    );
    const failedProjectLog = createFile(
      "sessions/unavailable-project/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const availableProjectLog = createFile(
      "sessions/available-project/card-1.log",
      new Date("2025-12-31T23:59:59.999Z"),
    );
    const originalReadDirectory = fs.readdirSync;

    vi.spyOn(fs, "readdirSync").mockImplementation((directoryPath, options) => {
      if (String(directoryPath) === failedProjectDirectory) {
        throw new Error("directory unavailable");
      }

      return originalReadDirectory(directoryPath, options);
    });

    cleanupLogRetention(14, now);

    expect(fs.existsSync(failedProjectLog)).toBe(true);
    expect(fs.existsSync(availableProjectLog)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Log retention could not scan ${failedProjectDirectory}`,
    );
    expect(diagnostic).toContain("directory unavailable");
  });
});
