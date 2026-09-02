import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCardContextDirectories,
  resolveCardAttachmentPath,
  resolveCardAttachmentsDirectory,
  resolveCardAttachmentsManifestPath,
  resolveCardContextDirectory,
  resolveCardContextPaths,
} from "../src/context/card-context-storage.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();

  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function makeTemporaryDirectory(): string {
  temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-context-"),
  );

  return temporaryDirectory;
}

describe("card context storage", () => {
  it("resolves the exact card layout without requiring existing data", () => {
    const root = path.join(makeTemporaryDirectory(), "context-root");
    const expectedCardDirectory = path.join(root, "project-one", "card-one");
    const expectedAttachmentsDirectory = path.join(
      expectedCardDirectory,
      "attachments",
    );
    const expectedManifestPath = path.join(
      expectedCardDirectory,
      "attachments.json",
    );

    expect(resolveCardContextDirectory(root, "project-one", "card-one")).toBe(
      expectedCardDirectory,
    );
    expect(
      resolveCardAttachmentsDirectory(root, "project-one", "card-one"),
    ).toBe(expectedAttachmentsDirectory);
    expect(
      resolveCardAttachmentsManifestPath(root, "project-one", "card-one"),
    ).toBe(expectedManifestPath);
    expect(
      resolveCardAttachmentPath(root, "project-one", "card-one", "invoice.pdf"),
    ).toBe(path.join(expectedAttachmentsDirectory, "invoice.pdf"));
    expect(fs.existsSync(root)).toBe(false);
  });

  it("creates recursive card directories idempotently and preserves data", () => {
    const root = path.join(
      makeTemporaryDirectory(),
      "missing",
      "nested",
      "context-root",
    );

    const paths = createCardContextDirectories(root, "project-one", "card-one");
    const markerPath = path.join(paths.contextDirectory, "future-context.txt");

    fs.writeFileSync(paths.manifestPath, '{"attachments":[]}', "utf8");
    fs.writeFileSync(markerPath, "preserve me", "utf8");

    expect(
      createCardContextDirectories(root, "project-one", "card-one"),
    ).toEqual(paths);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).toBe(
      '{"attachments":[]}',
    );
    expect(fs.readFileSync(markerPath, "utf8")).toBe("preserve me");
    expect(fs.statSync(paths.contextDirectory).isDirectory()).toBe(true);
    expect(fs.statSync(paths.attachmentsDirectory).isDirectory()).toBe(true);
  });

  it("accepts a context directory created concurrently", () => {
    const root = path.join(makeTemporaryDirectory(), "context-root");
    const paths = resolveCardContextPaths(root, "project-one", "card-one");
    const originalMkdirSync = fs.mkdirSync;

    vi.spyOn(fs, "mkdirSync").mockImplementation((targetPath, options) => {
      if (targetPath.toString() === root) {
        originalMkdirSync(targetPath, options);
        const error = new Error("already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }

      return originalMkdirSync(targetPath, options);
    });

    expect(() =>
      createCardContextDirectories(root, "project-one", "card-one"),
    ).not.toThrow();
    expect(fs.lstatSync(paths.contextDirectory).isDirectory()).toBe(true);
  });

  it.each([
    ["blank", ""],
    ["whitespace", "  "],
    ["dot", "."],
    ["dot-dot", ".."],
    ["traversal", "../outside"],
    ["separator", "project/child"],
    ["backslash separator", "project\\child"],
    ["absolute", "/outside"],
    ["NUL-containing", "project\0outside"],
  ])("rejects an invalid project ID: %s", (_label, projectId) => {
    const root = path.join(makeTemporaryDirectory(), "context-root");

    expect(() =>
      resolveCardContextDirectory(root, projectId, "card-one"),
    ).toThrow("project ID");
  });

  it.each([
    ["blank", ""],
    ["dot-dot", ".."],
    ["traversal", "../outside"],
    ["separator", "card/child"],
    ["absolute", "/outside"],
    ["NUL-containing", "card\0outside"],
  ])("rejects an invalid card ID: %s", (_label, cardId) => {
    const root = path.join(makeTemporaryDirectory(), "context-root");

    expect(() =>
      resolveCardContextDirectory(root, "project-one", cardId),
    ).toThrow("card ID");
  });

  it.each([
    ["blank", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["traversal", "../outside"],
    ["separator", "invoice/other.pdf"],
    ["absolute", "/outside.pdf"],
    ["NUL-containing", "invoice\0.pdf"],
  ])("rejects an invalid attachment filename: %s", (_label, filename) => {
    const root = path.join(makeTemporaryDirectory(), "context-root");

    expect(() =>
      resolveCardAttachmentPath(root, "project-one", "card-one", filename),
    ).toThrow("attachment filename");
  });

  it("keeps attachment paths below the card attachments directory boundary", () => {
    const root = path.join(makeTemporaryDirectory(), "context");
    const paths = resolveCardContextPaths(root, "project-one", "card-one");
    const attachmentPath = resolveCardAttachmentPath(
      root,
      "project-one",
      "card-one",
      "report.txt",
    );

    expect(
      attachmentPath.startsWith(`${paths.attachmentsDirectory}${path.sep}`),
    ).toBe(true);
    expect(
      attachmentPath.startsWith(
        `${path.join(root, "project-one-other")}${path.sep}`,
      ),
    ).toBe(false);
  });

  it("rejects symbolic-link managed directories", () => {
    const base = makeTemporaryDirectory();
    const root = path.join(base, "context-root");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);

    fs.symlinkSync(outside, path.join(root, "project-one"), "dir");

    expect(() =>
      resolveCardContextDirectory(root, "project-one", "card-one"),
    ).toThrow("symbolic-link");
  });

  it("rejects symbolic-link card and attachments directories", () => {
    const base = makeTemporaryDirectory();
    const root = path.join(base, "context-root");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(root, "project-one"), { recursive: true });
    fs.mkdirSync(outside);

    fs.symlinkSync(outside, path.join(root, "project-one", "card-one"), "dir");

    expect(() =>
      resolveCardContextDirectory(root, "project-one", "card-one"),
    ).toThrow("symbolic-link");

    fs.rmSync(path.join(root, "project-one", "card-one"), {
      force: true,
    });
    fs.mkdirSync(path.join(root, "project-one", "card-one"));
    fs.symlinkSync(
      outside,
      path.join(root, "project-one", "card-one", "attachments"),
      "dir",
    );

    expect(() =>
      resolveCardAttachmentsDirectory(root, "project-one", "card-one"),
    ).toThrow("symbolic-link");
  });

  it("rejects non-directory managed paths", () => {
    const base = makeTemporaryDirectory();
    const root = path.join(base, "context-root");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "project-one"), "not a directory", "utf8");

    expect(() =>
      resolveCardContextDirectory(root, "project-one", "card-one"),
    ).toThrow("non-directory");
  });

  it("rejects a symbolic-link manifest or attachment file", () => {
    const base = makeTemporaryDirectory();
    const root = path.join(base, "context-root");
    const paths = createCardContextDirectories(root, "project-one", "card-one");
    const outsideManifest = path.join(base, "outside-manifest.json");
    const outsideAttachment = path.join(base, "outside.txt");
    fs.writeFileSync(outsideManifest, "{}", "utf8");
    fs.writeFileSync(outsideAttachment, "outside", "utf8");
    fs.symlinkSync(outsideManifest, paths.manifestPath);
    fs.symlinkSync(
      outsideAttachment,
      path.join(paths.attachmentsDirectory, "file.txt"),
    );

    expect(() =>
      resolveCardAttachmentsManifestPath(root, "project-one", "card-one"),
    ).toThrow("symbolic-link");
    expect(() =>
      resolveCardAttachmentPath(root, "project-one", "card-one", "file.txt"),
    ).toThrow("symbolic-link");
  });

  it("reports filesystem creation failures with the affected path", () => {
    const root = path.join(makeTemporaryDirectory(), "context-root");
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("permission denied");
    });

    let thrown: Error | undefined;

    try {
      createCardContextDirectories(root, "project-one", "card-one");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain(root);
    expect(thrown?.message).toContain("permission denied");
    expect(mkdir).toHaveBeenCalled();
  });
});
