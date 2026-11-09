import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitClient } from "../src/git/git-client.js";
import { buildPrimarySessionContext } from "../src/task-session/build-primary-session-context.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import type { PlanVerificationResult } from "../src/task-session/plan-verification.js";
import type { TrelloCard } from "../src/trello/trello-client.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";

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
  it("carries identity-matched plan-review recommendations into reconstructed context", async () => {
    const worktreePath = path.join(root, "review-advice");
    fs.mkdirSync(worktreePath);
    const advice: PlanVerificationResult = {
      version: 1,
      projectId: "project-one",
      cardId: card.id,
      planRevision: 4,
      verdict: "fail",
      findings: [
        {
          kind: "missing-requirement",
          requirementId: "REQ-1",
          detail: "The plan omits the requested export format.",
        },
      ],
    };

    const bundle = await buildPrimarySessionContext({
      git: git(worktreePath),
      projectId: "project-one",
      card,
      attemptId: "attempt-review-advice",
      worktreePath,
      record,
      plan: { projectId: "project-one", cardId: card.id },
      planRevision: 4,
      planReviewAdvice: advice,
    });

    expect(JSON.parse(bundle.planReviewAdvice!.content)).toEqual(advice);
    await expect(
      buildPrimarySessionContext({
        git: git(worktreePath),
        projectId: "project-one",
        card,
        attemptId: "attempt-review-advice",
        worktreePath,
        record,
        plan: { projectId: "project-one", cardId: card.id },
        planRevision: 3,
        planReviewAdvice: advice,
      }),
    ).rejects.toThrow("does not match the task and plan revision");
  });

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

  it("inventories binary untracked content without emitting or rewriting its bytes", async () => {
    const worktreePath = path.join(root, "binary-repo");
    fs.mkdirSync(worktreePath);
    const original = Buffer.from([0xff, 0x00, 0xc3, 0x28, 0x80]);
    const filePath = path.join(worktreePath, "binary.dat");
    fs.writeFileSync(filePath, original);
    const bundle = await buildPrimarySessionContext({
      git: git(worktreePath, { untracked: ["binary.dat"] }),
      projectId: "project-one",
      card,
      attemptId: "attempt",
      worktreePath,
      record,
      plan: null,
    });
    const entry = JSON.parse(bundle.currentDiff).untracked[0];
    expect(entry.contentStatus).toBe("unsupported-binary");
    expect(entry.contentBase64).toBe("");
    expect(fs.readFileSync(filePath)).toEqual(original);
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

  it("sanitizes registered secrets across reconstruction fields before base64 encoding", async () => {
    const canaries = [
      "card-canary-91",
      "plan-canary-82",
      "diff-canary-73",
      "history-canary-64",
      "feedback-canary-55",
      "file-canary-46",
      "attachment-canary-37",
      'quoted "canary" \\\nvalue',
    ];
    registerProcessSecrets(canaries);
    const worktreePath = path.join(root, "repo");
    const attachmentRoot = path.join(root, "external");
    fs.mkdirSync(worktreePath);
    const attachmentPath = path.join(
      attachmentRoot,
      "project-one",
      card.id,
      "attachments",
      "note.txt",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, `safe attachment ${canaries[6]}`);
    fs.writeFileSync(
      path.join(worktreePath, "new.txt"),
      `safe file ${canaries[5]}`,
    );
    const bundle = await buildPrimarySessionContext({
      git: git(worktreePath, {
        staged: `safe diff ${canaries[2]}`,
        unstaged: `safe unstaged ${canaries[3]}`,
        untracked: ["new.txt"],
      }),
      projectId: "project-one",
      card: {
        ...card,
        name: `Task ${canaries[0]}`,
        desc: `safe card ${canaries[0]}`,
      },
      attemptId: "attempt",
      worktreePath,
      record: {
        ...record,
        operationKey: `safe history ${canaries[4]}`,
      } as TaskExecutionRecord,
      plan: { summary: `safe plan ${canaries[1]} ${canaries[7]}` },
      feedbackContent: `safe feedback ${canaries[4]}`,
      attachments: {
        contextRoot: attachmentRoot,
        projectId: "project-one",
        cardId: card.id,
        manifest: {
          attachments: [
            {
              id: "attachment",
              name: "note.txt",
              mimeType: "text/plain",
              bytes: null,
              url: "https://example.test",
              isUpload: true,
              localFilename: "note.txt",
            },
          ],
        },
      },
    });
    const serialized = JSON.stringify(bundle);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(serialized).toContain("safe");
    const untracked = JSON.parse(bundle.currentDiff).untracked[0];
    expect(Buffer.from(untracked.contentBase64, "base64").toString()).toContain(
      "safe file",
    );
    expect(
      Buffer.from(untracked.contentBase64, "base64").toString(),
    ).not.toContain(canaries[5]);
    expect(
      JSON.parse(bundle.attachmentManifest.content!).manifest[0]
        .readableContent,
    ).toContain("safe attachment");
  });

  it("sanitizes quoted assignment and nested feedback-ledger values before JSON encoding", async () => {
    const secret = 'quote " slash \\ and\nnewline';
    registerProcessSecrets([secret]);
    const worktreePath = path.join(root, "nested-repo");
    fs.mkdirSync(worktreePath);
    const bundle = await buildPrimarySessionContext({
      git: git(worktreePath, { staged: `password="${secret}"` }),
      projectId: "project-one",
      card,
      attemptId: "attempt",
      worktreePath,
      record: {
        ...record,
        reviewObservation: { feedbackIds: ["feedback-one"] },
      } as TaskExecutionRecord,
      plan: { text: `retain safe fact; ${secret}` },
      feedbackContent: JSON.stringify({
        entries: [{ id: "feedback-one", text: `nested ${secret}` }],
      }),
    });
    const diff = JSON.parse(bundle.currentDiff);
    const history = JSON.parse(bundle.history);
    const ledger = JSON.parse(history.feedbackLedger);
    const plan = JSON.parse(bundle.plan.content!);
    expect(diff.staged).not.toContain(secret);
    expect(ledger.entries[0].text).not.toContain(secret);
    expect(plan.text).not.toContain(secret);
    expect(plan.text).toContain("retain safe fact");
  });
});
