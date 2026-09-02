import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withActiveCardContext } from "../src/context/active-card-context.js";
import { cleanupCardContextRetention } from "../src/context/card-context-retention.js";

const originalCwd = process.cwd();
const now = new Date("2026-01-15T00:00:00.000Z");
const cutoff = new Date("2026-01-01T00:00:00.000Z");
const expired = new Date("2025-12-31T23:59:59.999Z");
let temporaryDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function useTemporaryContextRoot(): string {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "orchestrator-context-retention-test-"),
  );
  process.chdir(temporaryDirectory);

  return path.join(temporaryDirectory, "context-root");
}

function createContext(
  contextRoot: string,
  projectId: string,
  cardId: string,
  modifiedAt: Date,
): string {
  const directoryPath = path.join(contextRoot, projectId, cardId);

  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(path.join(directoryPath, "context.txt"), "context", "utf8");
  fs.utimesSync(directoryPath, modifiedAt, modifiedAt);

  return directoryPath;
}

describe("cleanupCardContextRetention", () => {
  it("removes expired contexts but retains the exact cutoff and newer contexts", () => {
    const contextRoot = useTemporaryContextRoot();
    const expiredPath = createContext(
      contextRoot,
      "project",
      "expired",
      expired,
    );
    const cutoffPath = createContext(contextRoot, "project", "cutoff", cutoff);
    const newerPath = createContext(
      contextRoot,
      "project",
      "newer",
      new Date("2026-01-02T00:00:00.001Z"),
    );
    fs.mkdirSync(path.join(contextRoot, "project"), { recursive: true });

    cleanupCardContextRetention(contextRoot, 14, now, ["project"]);

    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(fs.existsSync(cutoffPath)).toBe(true);
    expect(fs.existsSync(newerPath)).toBe(true);
    expect(fs.existsSync(path.join(contextRoot, "project"))).toBe(true);
  });

  it("protects an actively processed card context", async () => {
    const contextRoot = useTemporaryContextRoot();
    const activePath = createContext(contextRoot, "project", "active", expired);
    let release: (() => void) | undefined;

    const processing = withActiveCardContext(
      "project",
      "active",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    cleanupCardContextRetention(contextRoot, 14, now, ["project"]);

    expect(fs.existsSync(activePath)).toBe(true);

    release?.();
    await processing;
    cleanupCardContextRetention(contextRoot, 14, now, ["project"]);

    expect(fs.existsSync(activePath)).toBe(false);
  });

  it("preserves unrelated entries and configured paths outside the root", () => {
    const contextRoot = useTemporaryContextRoot();
    const unrelatedDirectory = path.join(
      path.dirname(contextRoot),
      "unrelated",
      "old-card",
    );
    const repositoryDirectory = path.join(
      path.dirname(contextRoot),
      "repository",
      "old-file",
    );
    const unrelatedFile = path.join(contextRoot, "notes.txt");

    fs.mkdirSync(unrelatedDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(repositoryDirectory), { recursive: true });
    fs.writeFileSync(repositoryDirectory, "repository", "utf8");
    fs.mkdirSync(contextRoot, { recursive: true });
    fs.writeFileSync(unrelatedFile, "unrelated", "utf8");
    fs.utimesSync(unrelatedDirectory, expired, expired);

    createContext(contextRoot, "configured-project", "old-card", expired);
    createContext(contextRoot, "unconfigured-project", "old-card", expired);

    cleanupCardContextRetention(path.join(contextRoot, "."), 14, now, [
      "configured-project",
    ]);

    expect(fs.existsSync(unrelatedDirectory)).toBe(true);
    expect(fs.existsSync(repositoryDirectory)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(
      fs.existsSync(path.join(contextRoot, "configured-project", "old-card")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(contextRoot, "unconfigured-project", "old-card")),
    ).toBe(true);
  });

  it("skips symbolic links without following or removing their targets", () => {
    const contextRoot = useTemporaryContextRoot();
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "orchestrator-context-retention-target-"),
    );
    const outsideContext = createContext(
      outsideRoot,
      "outside-project",
      "outside-card",
      expired,
    );
    const linkedProject = path.join(contextRoot, "linked-project");
    const projectDirectory = path.join(contextRoot, "project");
    const linkedCard = path.join(projectDirectory, "linked-card");
    const nestedLinkContext = createContext(
      contextRoot,
      "project",
      "nested-link",
      expired,
    );

    fs.mkdirSync(contextRoot, { recursive: true });
    fs.symlinkSync(path.join(outsideRoot, "outside-project"), linkedProject);
    fs.mkdirSync(projectDirectory, { recursive: true });
    fs.symlinkSync(outsideContext, linkedCard);
    fs.symlinkSync(
      outsideContext,
      path.join(nestedLinkContext, "outside-link"),
    );

    try {
      cleanupCardContextRetention(contextRoot, 14, now, [
        "linked-project",
        "project",
      ]);

      expect(fs.lstatSync(linkedProject).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(linkedCard).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outsideContext)).toBe(true);
      expect(fs.existsSync(nestedLinkContext)).toBe(true);
      expect(
        fs
          .lstatSync(path.join(nestedLinkContext, "outside-link"))
          .isSymbolicLink(),
      ).toBe(true);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("keeps removal inside the opened context root when a project is swapped", () => {
    const contextRoot = useTemporaryContextRoot();
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "orchestrator-context-retention-target-"),
    );
    const outsideContext = createContext(
      outsideRoot,
      "project",
      "card",
      expired,
    );
    const projectDirectory = path.join(contextRoot, "project");
    const contextDirectory = createContext(
      contextRoot,
      "project",
      "card",
      expired,
    );
    const originalRemove = fs.rmSync;
    let swapped = false;

    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (!swapped && path.basename(String(target)) === "card") {
        swapped = true;
        const movedProjectDirectory = `${projectDirectory}-moved`;

        fs.renameSync(projectDirectory, movedProjectDirectory);
        fs.symlinkSync(
          path.join(outsideRoot, "project"),
          projectDirectory,
          "dir",
        );

        try {
          return originalRemove(target, options);
        } finally {
          originalRemove(projectDirectory, { force: true });
          fs.renameSync(movedProjectDirectory, projectDirectory);
        }
      }

      return originalRemove(target, options);
    });

    try {
      cleanupCardContextRetention(contextRoot, 14, now, ["project"]);

      expect(fs.existsSync(contextDirectory)).toBe(false);
      expect(fs.existsSync(outsideContext)).toBe(true);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("treats missing paths and concurrent removals as no-ops", () => {
    const contextRoot = useTemporaryContextRoot();

    expect(() =>
      cleanupCardContextRetention(
        path.join(contextRoot, "not-created"),
        14,
        now,
        ["project"],
      ),
    ).not.toThrow();

    const concurrentlyRemoved = createContext(
      contextRoot,
      "project",
      "concurrent",
      expired,
    );
    const removable = createContext(
      contextRoot,
      "project",
      "removable",
      expired,
    );
    const originalRemove = fs.rmSync;

    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (
        path.basename(String(target)) === path.basename(concurrentlyRemoved)
      ) {
        originalRemove(target, options);
        const error = new Error("context disappeared") as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      }

      return originalRemove(target, options);
    });

    expect(() =>
      cleanupCardContextRetention(contextRoot, 14, now, ["project"]),
    ).not.toThrow();
    expect(fs.existsSync(removable)).toBe(false);
  });

  it("logs failures and continues with independent contexts", () => {
    const contextRoot = useTemporaryContextRoot();
    const failedScan = createContext(
      contextRoot,
      "failed-project",
      "card",
      expired,
    );
    const failedRemoval = createContext(
      contextRoot,
      "project",
      "failed",
      expired,
    );
    const removable = createContext(
      contextRoot,
      "project",
      "removable",
      expired,
    );
    const originalReadDirectory = fs.readdirSync;
    const originalRemove = fs.rmSync;

    vi.spyOn(fs, "readdirSync").mockImplementation((directoryPath, options) => {
      if (String(directoryPath) === path.join(contextRoot, "failed-project")) {
        throw new Error("directory unavailable");
      }

      return originalReadDirectory(directoryPath, options);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.basename(String(target)) === path.basename(failedRemoval)) {
        throw new Error("permission denied");
      }

      return originalRemove(target, options);
    });

    cleanupCardContextRetention(contextRoot, 14, now, [
      "failed-project",
      "project",
    ]);

    expect(fs.existsSync(failedScan)).toBe(true);
    expect(fs.existsSync(failedRemoval)).toBe(true);
    expect(fs.existsSync(removable)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Card context retention could not scan ${path.join(contextRoot, "failed-project")}`,
    );
    expect(diagnostic).toContain("directory unavailable");
    expect(diagnostic).toContain(
      `Card context retention could not remove ${failedRemoval}`,
    );
    expect(diagnostic).toContain("permission denied");
    expect(diagnostic).toContain(
      `Removed expired card context directory ${removable}`,
    );
  });

  it("logs inspection failures and continues with other cards", () => {
    const contextRoot = useTemporaryContextRoot();
    const failedInspection = createContext(
      contextRoot,
      "project",
      "uninspectable",
      expired,
    );
    const removable = createContext(
      contextRoot,
      "project",
      "removable",
      expired,
    );
    const originalInspect = fs.lstatSync;

    vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      if (path.resolve(String(target)) === failedInspection) {
        throw new Error("metadata unavailable");
      }

      return originalInspect(target, options);
    });

    cleanupCardContextRetention(contextRoot, 14, now, ["project"]);

    expect(fs.existsSync(failedInspection)).toBe(true);
    expect(fs.existsSync(removable)).toBe(false);

    const diagnosticPath = path.join(
      process.cwd(),
      "logs",
      `test-orchestrator-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");

    expect(diagnostic).toContain(
      `Card context retention could not inspect ${failedInspection}`,
    );
    expect(diagnostic).toContain("metadata unavailable");
  });
});
