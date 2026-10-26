import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitClient } from "../src/git/git-client.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { decideHumanReviewPublication } from "../src/task-session/verified-publication-decision.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function createRepository(): {
  repositoryPath: string;
  runGit: (...args: string[]) => void;
} {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-source-snapshot-"),
  );
  const repositoryPath = path.join(temporaryRoot, "repository");
  fs.mkdirSync(repositoryPath);
  const runGit = (...args: string[]) => {
    execFileSync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: "pipe",
    });
  };

  runGit("init");
  runGit("config", "user.name", "Snapshot Test");
  runGit("config", "user.email", "snapshot@example.com");
  runGit("checkout", "-b", "main");
  fs.writeFileSync(path.join(repositoryPath, "tracked.txt"), "base content\n");
  runGit("add", "tracked.txt");
  runGit("commit", "-m", "base");

  return { repositoryPath, runGit };
}

describe("getTaskSessionSourceSnapshotIdentity", () => {
  it("is deterministic for unchanged source and changes for a tracked edit or deletion", async () => {
    const { repositoryPath } = createRepository();
    const git = new GitClient();
    const trackedPath = path.join(repositoryPath, "tracked.txt");
    const baseIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );

    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(baseIdentity);

    fs.writeFileSync(trackedPath, "edited content\n");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(baseIdentity);

    fs.writeFileSync(trackedPath, "base content\n");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(baseIdentity);

    fs.unlinkSync(trackedPath);
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(baseIdentity);
  });

  it("ignores staged index metadata when the working copy matches HEAD", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    const trackedPath = path.join(repositoryPath, "tracked.txt");
    const baseIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );

    fs.writeFileSync(trackedPath, "staged content\n");
    runGit("add", "tracked.txt");
    fs.writeFileSync(trackedPath, "base content\n");

    const stagedIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    expect(stagedIdentity).toBe(baseIdentity);

    runGit("reset", "--quiet", "HEAD");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(baseIdentity);
  });

  it("includes staged renames and both contents of staged/unstaged paths", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    const baseIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );

    runGit("mv", "tracked.txt", "renamed.txt");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(baseIdentity);

    runGit("reset", "--quiet", "HEAD");
    fs.renameSync(
      path.join(repositoryPath, "renamed.txt"),
      path.join(repositoryPath, "working-rename.txt"),
    );
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(baseIdentity);
  });

  it("includes untracked file paths and contents", async () => {
    const { repositoryPath } = createRepository();
    const git = new GitClient();
    const baseIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    const untrackedPath = path.join(repositoryPath, "new-file.txt");

    fs.writeFileSync(untrackedPath, "untracked contents\n");
    const firstUntrackedIdentity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    expect(firstUntrackedIdentity).not.toBe(baseIdentity);

    fs.writeFileSync(untrackedPath, "changed untracked contents\n");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(firstUntrackedIdentity);
  });

  it("keeps identical source identity through staging and commit", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    fs.writeFileSync(
      path.join(repositoryPath, "tracked.txt"),
      "feature change\n",
    );
    const beforeCommit = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    runGit("add", "tracked.txt");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(beforeCommit);
    runGit("commit", "-m", "feature");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(beforeCommit);
  });

  it("keeps identity through a committed deletion", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    fs.unlinkSync(path.join(repositoryPath, "tracked.txt"));
    const beforeCommit = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    runGit("add", "-A");
    runGit("commit", "-m", "delete tracked");
    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).toBe(beforeCommit);
  });

  it("preserves exhausted reviews across commits", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    fs.writeFileSync(
      path.join(repositoryPath, "tracked.txt"),
      "feature change\n",
    );
    const identity = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );
    const validation: TaskSessionValidationResult = {
      command: "yarn validate",
      startedAt: "2026-10-26T07:00:00.000Z",
      completedAt: "2026-10-26T07:01:00.000Z",
      exitCode: 0,
      status: "passed",
      timedOut: false,
      aborted: false,
      diagnostic: "passed",
      contentIdentity: identity,
    };
    const review: ImplementationReviewResult = {
      version: 1,
      projectId: "project",
      cardId: "card",
      verdict: "fail",
      reviewedContentIdentity: identity,
      requirementAssessments: [],
      blockingFindings: [
        {
          kind: "defect",
          summary: "Requires human review",
          detail: "Unresolved",
        },
      ],
    };
    const decision = async () =>
      decideHumanReviewPublication(
        {
          currentContentIdentity: await getTaskSessionSourceSnapshotIdentity(
            git,
            repositoryPath,
          ),
          validationCommand: validation.command,
          validation,
          coverage: null,
          review,
        },
        review,
      );

    expect((await decision()).allowed).toBe(true);
    runGit("add", "tracked.txt");
    runGit("commit", "-m", "feature");
    expect((await decision()).allowed).toBe(true);
    fs.writeFileSync(
      path.join(repositoryPath, "tracked.txt"),
      "unauthorized\n",
    );
    expect((await decision()).allowed).toBe(false);
  });

  it("invalidates a snapshot after a local rebase", async () => {
    const { repositoryPath, runGit } = createRepository();
    const git = new GitClient();
    runGit("checkout", "-b", "agent/card-one");
    fs.writeFileSync(
      path.join(repositoryPath, "tracked.txt"),
      "feature change\n",
    );
    runGit("add", "tracked.txt");
    runGit("commit", "-m", "feature change");
    const beforeRebase = await getTaskSessionSourceSnapshotIdentity(
      git,
      repositoryPath,
    );

    runGit("checkout", "main");
    fs.writeFileSync(path.join(repositoryPath, "upstream.txt"), "upstream\n");
    runGit("add", "upstream.txt");
    runGit("commit", "-m", "upstream change");
    runGit("checkout", "agent/card-one");
    runGit("rebase", "main");

    expect(
      await getTaskSessionSourceSnapshotIdentity(git, repositoryPath),
    ).not.toBe(beforeRebase);
  });
});
