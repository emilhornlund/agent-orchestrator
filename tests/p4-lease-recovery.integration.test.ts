import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
} from "../src/coordination/project-ownership.js";
import { RunRegistry } from "../src/task-session/run-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import { beginInitialPublication } from "../src/orchestrator/initial-publication.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";

describe("P4 production publication across actual P2 lease takeover", () => {
  it.each(
    ["commit", "push", "pr", "move", "comment"].flatMap((effect) =>
      ["intent", "dispatch", "acceptance", "response", "completion"].map(
        (barrier) => ({ effect, barrier }),
      ),
    ),
  )(
    "preserves $effect at $barrier across SIGKILL and kernel ownership recovery",
    async ({ effect, barrier }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "p4-lease-"));
      const coordination = path.join(root, "coordination");
      fs.mkdirSync(coordination);
      provisionCoordinationNamespace(coordination, "p4-evidence");
      const identity = {
        trelloBoardId: "board",
        githubRepository: "owner/repo",
      };
      const acquire = () =>
        acquireProjectOwnership(coordination, identity, "p4-evidence");
      let owner = await acquire();
      const adapter = () => {
        const held = owner;
        return {
          integrationId: JSON.stringify(identity),
          instanceId: held.instanceId,
          token: held.token,
          assertHeld: () => held.assertHeld(),
        };
      };
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const f = createPublicationFixture(root, adapter());
        f.services.change({ secondReady: true });
        new RunRegistry(
          f.project.contextRoot,
          JSON.stringify(identity),
          adapter(),
        ).handoff(f.store, null, 1);
        const source = await getTaskSessionSourceSnapshotIdentity(
          f.git,
          f.worktreePath,
        );
        f.authority.run(() =>
          beginInitialPublication(
            {
              project: f.project,
              card: f.services.card(),
              git: f.git,
              trello: f.services.trello,
              github: f.services.github,
              worktreePath: f.worktreePath,
              branch: "agent/card",
              commitMessage: "feat: preserve original publication",
              reviewResult: "Passed",
              remediationResult: "Not required",
            },
            "Trello: https://trello.com/c/card",
            source,
          ),
        );
        await owner.release();
        child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "tests/fixtures/p4-publication-crash.ts",
            root,
            barrier,
            String(Date.now()),
            effect,
            "real-lease",
          ],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
        const errors: Buffer[] = [];
        child.stderr?.on("data", (data: Buffer) => errors.push(data));
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(
              `Writer exited before barrier: ${Buffer.concat(errors).toString()}`,
            );
          }),
        ]);
        await expect(acquire()).rejects.toThrow();
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        owner = await acquire();
        const resumed = reopenPublicationFixture(root, owner.token, adapter());
        if (barrier === "response")
          expect(
            resumed.store
              .read()!
              .pendingOperations.find((op) => op.id === `initial:${effect}`)!
              .mutation!.dispatches.at(-1)?.response,
          ).toBeUndefined();
        expect(resumed.store.read()!.owner.generation).toBe(3);
        expect(() => f.store.assertCurrentLease(1)).toThrow();
        expect(
          new RunRegistry(
            f.project.contextRoot,
            JSON.stringify(identity),
            adapter(),
          ).read()?.attemptId,
        ).toBe("attempt");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.parse(resumed.store.read()!.updatedAt) + 15_001);
        for (let pass = 0; pass < 8; pass++) {
          if (resumed.store.read()!.lifecycle === "ci") break;
          await pollProject(
            resumed.services.trello,
            resumed.git,
            resumed.services.github,
            {} as never,
            {} as never,
            resumed.project,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            resumed.authority,
          );
          vi.setSystemTime(Date.now() + 15_001);
        }
        // Observe two additional complete windows after reconciliation, including
        // the open PR path, rather than checking a registry snapshot only before it.
        for (let pass = 0; pass < 2; pass++) {
          await pollProject(
            resumed.services.trello,
            resumed.git,
            resumed.services.github,
            {} as never,
            {} as never,
            resumed.project,
            new AbortController().signal,
            undefined,
            undefined,
            undefined,
            resumed.authority,
          );
          vi.setSystemTime(Date.now() + 15_001);
        }
        const state = resumed.services.read();
        const blocked = barrier === "dispatch";
        const createdPr = !blocked || ["move", "comment"].includes(effect);
        expect(state.requests).toHaveLength(createdPr ? 1 : 0);
        expect(state.prs).toHaveLength(createdPr ? 1 : 0);
        expect(
          f.isolated.git(
            resumed.worktreePath,
            "rev-list",
            "--count",
            "main..HEAD",
          ),
        ).toBe(blocked && effect === "commit" ? "0" : "1");
        expect(
          f.isolated.git(
            resumed.project.repository.path,
            "status",
            "--porcelain",
          ),
        ).toBe("");
        expect(
          resumed.authority.run(() =>
            new TaskMutationQueue(
              resumed.project.contextRoot,
              resumed.project,
            ).getActive(),
          )?.cardId,
        ).toBe(blocked ? "card" : undefined);
        // Publication retires its operation queue, not the active project attempt.
        // The registry must still prevent replacement while this PR is open.
        expect(resumed.store.read()!.publicationState).toBe(
          createdPr ? "open" : "none",
        );
        expect(resumed.store.read()!.lifecycle).toBe(
          blocked ? "publication" : "ci",
        );
        const op = resumed.store
          .read()!
          .pendingOperations.find((entry) => entry.id === `initial:${effect}`)!;
        expect(op.status).toBe(
          barrier === "dispatch" ? "ambiguous" : "completed",
        );
        expect(op.mutation!.dispatches).toHaveLength(1);
        expect(state.comments).toHaveLength(blocked ? 0 : 1);
        expect(state.list).toBe(
          blocked && effect !== "comment" ? "working" : "review",
        );
        expect(
          new RunRegistry(
            f.project.contextRoot,
            JSON.stringify(identity),
            adapter(),
          ).read()?.attemptId,
        ).toBe("attempt");
        expect(
          resumed.services
            .entries()
            .filter((entry) => entry.type === "move-card:second"),
        ).toHaveLength(0);
        expect(resumed.store.read()!.cardId).toBe("card");
      } finally {
        vi.useRealTimers();
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        await owner.release();
        // Retain failed-run artifacts for diagnosis; successful fixtures can be removed by the operator.
      }
    },
    30_000,
  );
});
