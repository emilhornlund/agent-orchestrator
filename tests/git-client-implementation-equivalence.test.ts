import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot !== undefined)
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function makeRepository() {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "git-client-implementation-equivalence-"),
  );
  const repositoryPath = path.join(temporaryRoot, "remote");
  fs.mkdirSync(repositoryPath);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
    }).trim();
  git(["init", "--quiet"]);
  git(["config", "user.name", "Recovery Fixture"]);
  git(["config", "user.email", "recovery@example.test"]);
  fs.writeFileSync(path.join(repositoryPath, "implementation.ts"), "before\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]);

  git(["checkout", "--quiet", "-b", "task-implementation"]);
  fs.writeFileSync(path.join(repositoryPath, "implementation.ts"), "after\n");
  fs.writeFileSync(path.join(repositoryPath, "feature.ts"), "export {};\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "original implementation"]);
  const implementationCommit = git(["rev-parse", "HEAD"]);

  const project = {
    id: "project",
    repository: {
      path: repositoryPath,
      worktreeRoot: path.join(temporaryRoot, "worktrees"),
      github: "owner/repository",
    },
  } as ProjectConfig;
  const runGit: RunGit = async (cwd, args, environment) => {
    const safeArgs = [...args];
    if (safeArgs[0] === "remote" && safeArgs[1] === "add")
      safeArgs[3] = repositoryPath;
    return execFileSync("git", safeArgs, {
      cwd,
      encoding: "utf8",
      env:
        environment === undefined
          ? process.env
          : { ...process.env, ...environment },
    }).trim();
  };
  return {
    repositoryPath,
    baseSha,
    implementationCommit,
    project,
    git,
    client: new GitClient(runGit),
  };
}

async function verifyHistory(
  fixture: ReturnType<typeof makeRepository>,
  pullRequestNumber: number,
  baseSha: string,
  headSha: string,
): Promise<boolean> {
  const commitShas = fixture
    .git(["rev-list", "--reverse", `${baseSha}..${headSha}`])
    .split("\n");
  fixture.git(["update-ref", `refs/pull/${pullRequestNumber}/head`, headSha]);
  return fixture.client.hasEquivalentImplementationCommit({
    project: fixture.project,
    implementationCommit: fixture.implementationCommit,
    pullRequestNumber,
    pullRequestHeadSha: headSha,
    pullRequestCommitShas: commitShas,
  });
}

describe("GitClient implementation change equivalence", () => {
  it("accepts a rebased implementation after the target branch advances", async () => {
    const fixture = makeRepository();
    fixture.git(["checkout", "--quiet", "-b", "recovery", fixture.baseSha]);
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "upstream.txt"),
      "upstream\n",
    );
    fixture.git(["add", "upstream.txt"]);
    fixture.git(["commit", "--quiet", "-m", "target branch update"]);
    const advancedBase = fixture.git(["rev-parse", "HEAD"]);
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "implementation.ts"),
      "after\n",
    );
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "feature.ts"),
      "export {};\n",
    );
    fixture.git(["add", "."]);
    fixture.git(["commit", "--quiet", "-m", "rebased implementation"]);
    const rebasedHead = fixture.git(["rev-parse", "HEAD"]);
    expect(rebasedHead).not.toBe(fixture.implementationCommit);

    await expect(
      verifyHistory(fixture, 71, advancedBase, rebasedHead),
    ).resolves.toBe(true);
  });

  it("accepts a squash-shaped commit with the original aggregate patch", async () => {
    const fixture = makeRepository();
    fixture.git([
      "checkout",
      "--quiet",
      "-b",
      "squash-recovery",
      fixture.baseSha,
    ]);
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "implementation.ts"),
      "after\n",
    );
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "feature.ts"),
      "export {};\n",
    );
    fixture.git(["add", "."]);
    fixture.git(["commit", "--quiet", "-m", "squash: task implementation"]);
    const squashedHead = fixture.git(["rev-parse", "HEAD"]);
    expect(squashedHead).not.toBe(fixture.implementationCommit);

    await expect(
      verifyHistory(fixture, 72, fixture.baseSha, squashedHead),
    ).resolves.toBe(true);
  });

  it("rejects a PR with an unrelated commit before the matching implementation", async () => {
    const fixture = makeRepository();
    fixture.git([
      "checkout",
      "--quiet",
      "-b",
      "recovery-with-extra",
      fixture.baseSha,
    ]);
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "unrelated.ts"),
      "export {};\n",
    );
    fixture.git(["add", "unrelated.ts"]);
    fixture.git(["commit", "--quiet", "-m", "unrelated earlier change"]);
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "implementation.ts"),
      "after\n",
    );
    fs.writeFileSync(
      path.join(fixture.repositoryPath, "feature.ts"),
      "export {};\n",
    );
    fixture.git(["add", "."]);
    fixture.git(["commit", "--quiet", "-m", "matching implementation"]);
    const headSha = fixture.git(["rev-parse", "HEAD"]);

    await expect(
      verifyHistory(fixture, 73, fixture.baseSha, headSha),
    ).resolves.toBe(false);
  });
});
