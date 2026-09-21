import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GitClient,
  getGitIdentityEnvironment,
  type GitEnvironment,
} from "../src/git/git-client.js";

const execFileAsync = promisify(execFile);

async function runGit(
  cwd: string,
  args: string[],
  environment?: GitEnvironment,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });

  return stdout.trim();
}

describe("GitClient deterministic commit execution", () => {
  it("stages every change, creates exactly one clean commit, and uses the configured identity", async () => {
    const repositoryPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-git-commit-"),
    );
    const messageDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-orchestrator-message-"),
    );
    const identity = {
      name: "Configured Agent",
      email: "configured-agent@example.com",
    };

    try {
      await runGit(repositoryPath, ["init", "-q"]);
      fs.writeFileSync(path.join(repositoryPath, "modified.txt"), "before\n");
      fs.writeFileSync(path.join(repositoryPath, "deleted.txt"), "delete me\n");
      fs.writeFileSync(path.join(repositoryPath, "renamed.txt"), "rename me\n");
      await runGit(repositoryPath, ["add", "-A"]);
      await runGit(
        repositoryPath,
        ["commit", "-m", "initial"],
        getGitIdentityEnvironment(identity),
      );
      const initialHead = await runGit(repositoryPath, ["rev-parse", "HEAD"]);

      fs.writeFileSync(path.join(repositoryPath, "modified.txt"), "after\n");
      fs.rmSync(path.join(repositoryPath, "deleted.txt"));
      fs.renameSync(
        path.join(repositoryPath, "renamed.txt"),
        path.join(repositoryPath, "renamed-final.txt"),
      );
      fs.writeFileSync(path.join(repositoryPath, "added.txt"), "new\n");

      const message =
        "feat(files): apply the deterministic commit\n\n- Stage all file changes.\n- Preserve the complete message.\n\nThe resulting commit is reproducible.";
      const messagePath = path.join(messageDirectory, "message.txt");
      fs.writeFileSync(messagePath, message);
      const git = new GitClient((cwd, args, environment) =>
        runGit(cwd, args, environment),
      );

      await git.stageAll(repositoryPath);
      await git.commit(repositoryPath, messagePath, identity);

      const finalHead = await git.getHeadSha(repositoryPath);
      expect(finalHead).not.toBe(initialHead);
      await expect(
        git.getCommitCountBetween(repositoryPath, initialHead, finalHead),
      ).resolves.toBe(1);
      await expect(git.getStatus(repositoryPath)).resolves.toBe("");
      await expect(git.getCommitMessage(repositoryPath)).resolves.toContain(
        "feat(files): apply the deterministic commit\n\n- Stage all file changes.",
      );
      await expect(
        runGit(repositoryPath, ["show", "-s", "--format=%an <%ae>"]),
      ).resolves.toBe("Configured Agent <configured-agent@example.com>");
      await expect(
        runGit(repositoryPath, ["show", "--format=", "--name-status", "HEAD"]),
      ).resolves.toContain("A\tadded.txt");
      await expect(
        runGit(repositoryPath, ["show", "--format=", "--name-status", "HEAD"]),
      ).resolves.toContain("D\tdeleted.txt");
      await expect(
        runGit(repositoryPath, ["show", "--format=", "--name-status", "HEAD"]),
      ).resolves.toContain("R100\trename");
      await expect(
        runGit(repositoryPath, ["show", "--format=", "--name-status", "HEAD"]),
      ).resolves.toContain("M\tmodified.txt");
    } finally {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
      fs.rmSync(messageDirectory, { recursive: true, force: true });
    }
  });
});
