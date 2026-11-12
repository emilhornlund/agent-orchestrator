import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GitClient } from "../src/git/git-client.js";
import { beginInitialPublication } from "../src/orchestrator/initial-publication.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";

describe("VER-WF-001-03 concrete provider-idempotent Git object/ref variant", () => {
  it("discovers a late same-object ref after a negative read; provider replay changes neither identity nor effect count", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ref-"));
    const f = createPublicationFixture(root);
    const ledger: { type: string; sha?: string }[] = [];
    const save = () =>
      fs.writeFileSync(path.join(root, "provider-ledger.json"), JSON.stringify(ledger));
    let accept: (() => string) | undefined;
    let requests = 0;
    const git = new GitClient(async (cwd, args, environment) => {
      const execute = () =>
        execFileSync(
          "git",
          args.map((arg) =>
            arg === "https://github.com/owner/repo.git" &&
            ["fetch", "push", "ls-remote"].includes(args[0]!)
              ? path.join(root, "remote.git")
              : arg,
          ),
          { cwd, env: { ...f.isolated.env, ...environment }, encoding: "utf8" },
        ).trim();
      if (args[0] === "push") {
        requests++;
        ledger.push({ type: "dispatch" });
        save();
        accept = execute;
        throw new Error("Dispatched immutable Git ref transaction still in flight");
      }
      if (args[0] === "ls-remote") {
        ledger.push({ type: "read" });
        save();
      }
      return execute();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const identity = await getTaskSessionSourceSnapshotIdentity(git, f.worktreePath);
      f.authority.run(() =>
        beginInitialPublication(
          {
            project: f.project,
            card: f.services.card(),
            git,
            trello: f.services.trello,
            github: f.services.github,
            worktreePath: f.worktreePath,
            branch: "agent/card",
            commitMessage: "feat: stable provider object identity",
            reviewResult: "Passed",
            remediationResult: "Not required",
          },
          "Observed implementation",
          identity,
        ),
      );
      let current = f;
      const poll = () =>
        pollProject(
          current.services.trello,
          git,
          current.services.github,
          {} as never,
          {} as never,
          current.project,
          new AbortController().signal,
          undefined,
          undefined,
          undefined,
          current.authority,
        );
      for (let pass = 0; pass < 8 && !accept; pass++) {
        await poll();
        vi.setSystemTime(Date.now() + 15_001);
      }
      expect(accept).toBeDefined();
      const intent = current.store.read()!.pendingOperations.find((op) => op.id === "initial:push")!
        .mutation!.intent;
      await poll();
      expect(
        current.store
          .read()!
          .pendingOperations.find((op) => op.id === "initial:push")!
          .mutation!.observations.at(-1)?.outcome,
      ).toBe("absent");
      expect(
        current.store.read()!.pendingOperations.find((op) => op.id === "initial:push")!.status,
      ).toBe("ambiguous");
      expect(requests).toBe(1);
      ledger.push({ type: "negative-read-after-dispatch" });
      save();
      expect(
        f.isolated.git(
          path.join(root, "remote.git"),
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/agent/card",
        ),
      ).toBe("");
      current = { ...current, ...reopenPublicationFixture(root, "new-owner") };
      accept!();
      const sha = f.isolated.git(
        path.join(root, "remote.git"),
        "rev-parse",
        "refs/heads/agent/card",
      );
      ledger.push({ type: "late-accepted", sha });
      save();
      for (let pass = 0; pass < 8 && current.store.read()!.lifecycle === "publication"; pass++) {
        vi.setSystemTime(Date.now() + 15_001);
        await poll();
      }
      const op = current.store.read()!.pendingOperations.find((op) => op.id === "initial:push")!;
      expect(op.status).toBe("completed");
      expect(op.mutation!.intent).toEqual(intent);
      expect(requests).toBe(1);
      // Independent provider oracle repeats the exact captured transport, NOT an
      // orchestrator resend. Git's content-addressed object and same-value ref
      // transaction have an intrinsically stable effect identity.
      accept!();
      ledger.push({ type: "observer-provider-replay", sha });
      save();
      expect(
        f.isolated.git(path.join(root, "remote.git"), "rev-parse", "refs/heads/agent/card"),
      ).toBe(sha);
      expect(
        f.isolated.git(path.join(root, "remote.git"), "rev-list", "--count", "main..agent/card"),
      ).toBe("1");
      expect(current.services.read().prs).toHaveLength(1);
      expect(
        ledger.findIndex((entry) => entry.type === "negative-read-after-dispatch"),
      ).toBeGreaterThan(ledger.findIndex((entry) => entry.type === "dispatch"));
      expect(
        ledger.findIndex((entry) => entry.type === "negative-read-after-dispatch"),
      ).toBeLessThan(ledger.findIndex((entry) => entry.type === "late-accepted"));
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
