import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitClient } from "../src/git/git-client.js";
import { buildPrimarySessionContext } from "../src/task-session/build-primary-session-context.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primary-context-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const card: TrelloCard = {
  id: "card-one",
  name: "Task",
  desc: "Current request",
  idList: "working",
  idLabels: [],
  url: "https://trello.example/card-one",
};
const record = {
  version: 1,
  projectId: "project-one",
  cardId: card.id,
  phase: "implementation",
  primarySessionId: "session-one",
  sessionCreationStatus: "bound",
  expectedBranch: "agent/card-one",
  operationKey: "operation-one",
  revision: 2,
  retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:00:01.000Z",
} as TaskExecutionRecord;

function git(
  worktreePath: string,
  values: {
    status?: string;
    staged?: string;
    unstaged?: string;
    untracked?: string[];
  } = {},
) {
  return {
    getHeadSha: async () => "a".repeat(40),
    getStatus: async () => values.status ?? "",
    getDiff: async (_path: string, staged = false) =>
      staged ? (values.staged ?? "") : (values.unstaged ?? ""),
    getIndexEntries: async () => "",
    getUntrackedFiles: async () => values.untracked ?? [],
    getHeadTrackedFiles: async () => [],
  } as Pick<
    GitClient,
    | "getHeadSha"
    | "getStatus"
    | "getDiff"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getHeadTrackedFiles"
  >;
}

describe("buildPrimarySessionContext", () => {
  it("represents clean, staged-only, and untracked-only source states without empty-diff rejection", async () => {
    const cleanPath = path.join(root, "clean");
    fs.mkdirSync(cleanPath);
    const clean = await buildPrimarySessionContext({
      git: git(cleanPath),
      projectId: "project-one",
      card,
      attemptId: "attempt-canonical",
      worktreePath: cleanPath,
      record,
      plan: null,
    });
    expect(JSON.parse(clean.currentDiff)).toMatchObject({
      status: "clean",
      staged: "",
      unstaged: "",
      untracked: [],
    });

    const stagedPath = path.join(root, "staged");
    fs.mkdirSync(stagedPath);
    const staged = await buildPrimarySessionContext({
      git: git(stagedPath, { status: "M  x", staged: "diff --cached x" }),
      projectId: "project-one",
      card,
      attemptId: "attempt-canonical",
      worktreePath: stagedPath,
      record,
      plan: null,
    });
    expect(JSON.parse(staged.currentDiff).staged).toContain("diff --cached");

    const untrackedPath = path.join(root, "untracked");
    fs.mkdirSync(untrackedPath);
    fs.writeFileSync(path.join(untrackedPath, "new.txt"), "untracked payload");
    const untracked = await buildPrimarySessionContext({
      git: git(untrackedPath, { status: "?? new.txt", untracked: ["new.txt"] }),
      projectId: "project-one",
      card,
      attemptId: "attempt-canonical",
      worktreePath: untrackedPath,
      record,
      plan: null,
    });
    expect(JSON.parse(untracked.currentDiff).untracked[0]).toMatchObject({
      path: "new.txt",
      contentBase64: Buffer.from("untracked payload").toString("base64"),
    });
  });

  it("includes a checked absolute attachment path and content hash", async () => {
    const worktreePath = path.join(root, "repo");
    const attachmentRoot = path.join(root, "external");
    const attachmentPath = path.join(
      attachmentRoot,
      "project-one",
      card.id,
      "attachments",
      "brief.txt",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(attachmentPath, "attachment bytes");
    const bundle = await buildPrimarySessionContext({
      git: git(worktreePath),
      projectId: "project-one",
      card,
      attemptId: "canonical-attempt",
      worktreePath,
      record,
      plan: null,
      attachments: {
        contextRoot: attachmentRoot,
        projectId: "project-one",
        cardId: card.id,
        manifest: {
          attachments: [
            {
              id: "attachment-one",
              name: "brief.txt",
              mimeType: "text/plain",
              bytes: null,
              url: "https://trello.example/attachment",
              isUpload: true,
              localFilename: "brief.txt",
            },
          ],
        },
      },
    });
    const attachmentContext = JSON.parse(bundle.attachmentManifest.content!);
    expect(attachmentContext.manifest[0]).toMatchObject({
      absolutePath: attachmentPath,
      sha256: expect.any(String),
      availability: "materialized",
      readableContent: "attachment bytes",
    });
  });

  it("rejects mismatched attachment identity and symlinked untracked inputs", async () => {
    const worktreePath = path.join(root, "repo");
    fs.mkdirSync(worktreePath);
    await expect(
      buildPrimarySessionContext({
        git: git(worktreePath),
        projectId: "project-one",
        card,
        attemptId: "attempt",
        worktreePath,
        record,
        plan: null,
        attachments: {
          contextRoot: root,
          projectId: "elsewhere",
          cardId: card.id,
          manifest: { attachments: [] },
        },
      }),
    ).rejects.toThrow("identity");
    fs.symlinkSync(
      path.join(root, "target"),
      path.join(worktreePath, "linked"),
    );
    await expect(
      buildPrimarySessionContext({
        git: git(worktreePath, { untracked: ["linked"] }),
        projectId: "project-one",
        card,
        attemptId: "attempt",
        worktreePath,
        record,
        plan: null,
      }),
    ).rejects.toThrow("regular file");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside content");
    fs.symlinkSync(outside, path.join(worktreePath, "directory-link"), "dir");
    await expect(
      buildPrimarySessionContext({
        git: git(worktreePath, { untracked: ["directory-link/secret.txt"] }),
        projectId: "project-one",
        card,
        attemptId: "attempt",
        worktreePath,
        record,
        plan: null,
      }),
    ).rejects.toThrow("Symlink traversal");
  });
});
