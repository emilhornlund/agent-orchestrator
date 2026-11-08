import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunStore } from "../src/task-session/run-store.js";
import type { RunRecord } from "../src/task-session/run-record.js";

describe("P4 additive schema adoption from the actual P3 writer", () => {
  it("reads prior writer bytes unchanged, extends only on intent, and preserves unsupported/malformed originals", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p4-prior-writer-"));
    const archive = path.join(root, "prior");
    fs.mkdirSync(archive);
    const exec = (command: string, args: string[], cwd = process.cwd()) =>
      execFileSync(command, args, { cwd, timeout: 30_000, encoding: "utf8" });
    const writer = exec("git", ["rev-parse", "fe32760^{commit}"]).trim();
    const tar = path.join(root, "prior.tar");
    exec("git", ["archive", "--output", tar, writer, "src", "package.json"]);
    exec("tar", ["-xf", tar, "-C", archive]);
    fs.symlinkSync(
      path.resolve("node_modules"),
      path.join(archive, "node_modules"),
      "dir",
    );
    fs.mkdirSync(path.join(archive, "tests/fixtures"), { recursive: true });
    fs.copyFileSync(
      "tests/fixtures/p4-prior-writer.ts",
      path.join(archive, "tests/fixtures/p4-prior-writer.ts"),
    );
    const pinned: RunRecord["pinned"] = {
      integrationId: "integration",
      projectId: "p",
      boardId: "board",
      lists: {
        ready: "ready",
        working: "working",
        review: "review",
        done: "done",
        failed: "failed",
        backlog: "backlog",
      },
      repository: "owner/repo",
      repositoryPath: path.join(root, "repo"),
      worktreeRoot: path.join(root, "work"),
      storageRoot: path.join(root, "state"),
    };
    const seed: RunRecord = {
      version: 1,
      revision: 1,
      projectId: "p",
      cardId: "card",
      attemptId: "prior",
      taskKind: "implementation",
      pinned,
      lifecycle: "human-review",
      checkpoint: "human-review",
      publicationState: "open",
      operation: { id: null, kind: null, generation: 0 },
      wait: { reason: null, dependency: null, since: null, retryAt: null },
      owner: { instanceId: "prior-writer", token: "lease", generation: 1 },
      resources: [
        {
          kind: "pull-request",
          id: "73",
          path: "https://github.com/owner/repo/pull/73",
          provenance: "prior-observed",
        },
      ],
      pendingOperations: [],
      queue: [],
      budgets: {
        ci: {
          limit: 2,
          used: 1,
          episodeId: "prior-episode",
          trigger: "prior-failure",
        },
      },
      sessions: { primary: "prior-session" },
      artifacts: [],
      expectedTrelloListId: "review",
      terminalSync: "not-applicable",
      terminalEvidence: null,
      legacy: {},
      compatibility: {},
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const input = path.join(root, "input.json");
    fs.writeFileSync(input, JSON.stringify(seed));
    const prior = exec(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p4-prior-writer.ts", input],
      archive,
    );
    const file = path.join(pinned.storageRoot, "attempts/prior.json");
    const original = fs.readFileSync(file);
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(
      path.join(root, "provenance.json"),
      JSON.stringify({
        writer,
        sha256: digest(original),
        sourceSha256: digest(
          Buffer.from(
            exec("git", ["show", `${writer}:src/task-session/run-store.ts`]),
          ),
        ),
      }),
    );
    const lease = {
      integrationId: "integration",
      ...seed.owner,
      assertHeld() {},
    };
    const open = () => new RunStore(pinned.storageRoot, "prior", pinned, lease);
    expect(open().read()).toEqual(JSON.parse(prior));
    expect(fs.readFileSync(file)).toEqual(original);
    fs.writeFileSync(path.join(root, "original.json"), original);
    const store = open();
    const artifact = store.writeArtifact(Buffer.from("sanitized comment"));
    store.referenceMutationArtifact(1, 1, artifact);
    store.persistMutationIntent(
      2,
      1,
      "new-comment",
      {
        kind: "trello-comment",
        target: "card",
        correlationId: "prior:new-comment",
        payloadId: artifact.id,
      },
      new Date().toISOString(),
    );
    const adopted = open().read()!;
    expect(adopted.sessions).toEqual(seed.sessions);
    expect(adopted.resources).toEqual(seed.resources);
    expect(adopted.budgets).toEqual(seed.budgets);
    expect(adopted.pendingOperations[0]?.mutation?.dispatches).toHaveLength(0);
    const adoptedBytes = fs.readFileSync(file);
    expect(() =>
      exec(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/p4-prior-writer.ts", input, "read"],
        archive,
      ),
    ).toThrow();
    expect(fs.readFileSync(file)).toEqual(adoptedBytes);
    for (const bytes of [
      Buffer.from("{broken"),
      Buffer.from(JSON.stringify({ ...adopted, version: 999 })),
      Buffer.from(
        JSON.stringify({
          ...adopted,
          pendingOperations: adopted.pendingOperations.map((op) => ({
            ...op,
            mutation: { ...op.mutation, version: 999 },
          })),
        }),
      ),
    ]) {
      fs.writeFileSync(file, bytes);
      expect(() => open().read()).toThrow();
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
    // Artifacts and original prior-writer bytes are intentionally retained under TMPDIR.
  }, 30_000);
});
