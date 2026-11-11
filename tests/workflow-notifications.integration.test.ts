import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { smtpSink } from "./support/smtp-sink.js";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import { beginInitialPublication } from "../src/orchestrator/initial-publication.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import {
  NotificationOutbox,
  notificationTriggerObserver,
} from "../src/notifications/notification-outbox.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { EmailNotifier } from "../src/notifications/email-notifier.js";
import type { ProjectOwnershipLease } from "../src/coordination/project-ownership.js";

const sinks: Awaited<ReturnType<typeof smtpSink>>[] = [];
const leases: ProjectOwnershipLease[] = [];
const quiesce: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(quiesce.splice(0).map((wait) => wait()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
});
const tick = () => vi.setSystemTime(Date.now() + 15_001);
const smtpMessageId = (message: string) =>
  /Message-ID: ([^\r\n]+)/iu.exec(message.replace(/\r\n[ \t]+/gu, " "))?.[1];
const decodeSmtpMessage = (message: string) =>
  message
    .replace(/=\r\n/gu, "")
    .replace(/=([0-9A-F]{2})/gu, (_, byte: string) =>
      String.fromCharCode(parseInt(byte, 16)),
    );
function delivery(root: string, project: string) {
  return new NotificationOutbox(
    root,
    project,
    () => {},
    () => Date.now(),
    notificationTriggerObserver(root, project, () => {}),
  );
}
function tracked(notifier: EmailNotifier) {
  let finished = 0;
  const settled = new Set<string>();
  const idle = async () => {
    await vi.waitFor(() => expect(started).toBe(finished));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  quiesce.push(idle);
  let started = 0;
  const sender: EmailNotifier = {
    ...(notifier.deliveryTarget
      ? { deliveryTarget: notifier.deliveryTarget }
      : {}),
    isEventEnabled: (event) => notifier.isEventEnabled?.(event) ?? true,
    send: async (message) => {
      started++;
      try {
        return await notifier.send(message);
      } finally {
        finished++;
        if (message.messageId) settled.add(message.messageId);
      }
    },
  };
  return { sender, finished: () => finished, settled, idle };
}
describe("actual Git/process workflow events -> durable obligation -> outbox -> independent TLS SMTP", () => {
  it.each([
    { draft: false, fault: "move", smtp: "reject" },
    { draft: true, fault: "move", smtp: "lose-ack" },
    { draft: false, fault: "comment", smtp: "lose-ack" },
    { draft: true, fault: "comment", smtp: "reject" },
    { draft: false, fault: "before-create", smtp: "reject" },
    { draft: true, fault: "accepted-response-lost", smtp: "lose-ack" },
  ] as const)(
    "$draft publication / $fault / SMTP $smtp",
    async ({ draft, fault, smtp }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-smtp-"));
      const sink = await smtpSink(root);
      sinks.push(sink);
      sink.mode(smtp);
      const mail = tracked(sink.notifier);
      let f = createPublicationFixture(root);
      f.services.change({
        secondReady: true,
        rejectMove: fault === "move",
        loseCommentResponse: fault === "comment",
        githubOutage: fault === "before-create",
      });
      if (fault === "accepted-response-lost") {
        f.services.change({ loseCreationResponse: true });
        const create = f.services.github.createPullRequest.bind(
          f.services.github,
        );
        f.services.github.createPullRequest = async (input) => {
          try {
            return await create(input);
          } finally {
            f.services.change({ githubOutage: true });
          }
        };
      }
      vi.useFakeTimers({ toFake: ["Date"] });
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
            commitMessage: "feat: real workflow to observed SMTP",
            reviewResult: draft
              ? "Failed: outstanding advisory finding"
              : "Passed",
            remediationResult: draft
              ? "Outstanding issues retained"
              : "Not required",
          },
          "Implementation and observed checks",
          source,
        ),
      );
      const poll = () =>
        pollProject(
          f.services.trello,
          f.git,
          f.services.github,
          {} as never,
          {} as never,
          f.project,
          new AbortController().signal,
          mail.sender,
          undefined,
          undefined,
          f.authority,
        );
      for (let pass = 0; pass < 8; pass++) {
        await poll();
        if (
          fault === "comment" &&
          f.store
            .read()!
            .pendingOperations.some(
              (op) => op.id === "initial:comment" && op.status === "ambiguous",
            )
        )
          break;
        tick();
      }
      expect(f.store.read()!.lifecycle).toBe("publication");
      expect(
        f.authority.run(() =>
          new TaskMutationQueue(f.project.contextRoot, f.project).getActive(),
        )?.cardId,
      ).toBe("card");
      const originalPr = f.services.read().prs[0]?.url;
      if (fault.includes("create") || fault === "accepted-response-lost") {
        vi.setSystemTime(Date.now() + 300_001);
        for (let pass = 0; pass < 3; pass++) {
          await poll();
          tick();
        }
        await vi.waitFor(() => expect(mail.finished()).toBeGreaterThan(0));
        const attentions = delivery(f.project.contextRoot, "p")
          .records()
          .filter((record) => record.event === "attentionRequired");
        expect(attentions).toHaveLength(1);
      }
      // Reopen actual state, with a replacement execution owner, before restoration.
      f = { ...f, ...reopenPublicationFixture(root, "restart-owner") };
      f.services.change({
        githubOutage: false,
        rejectMove: false,
        loseCommentResponse: false,
      });
      for (
        let pass = 0;
        pass < 12 && f.store.read()!.lifecycle === "publication";
        pass++
      ) {
        tick();
        await poll();
      }
      expect(f.services.read().prs).toHaveLength(1);
      if (originalPr) expect(f.services.read().prs[0]!.url).toBe(originalPr);
      expect(f.services.read().requests).toHaveLength(1);
      expect(f.services.read().comments).toHaveLength(1);
      expect(f.services.read().list).toBe("review");
      expect(f.services.read().prs[0]!.draft).toBe(draft);
      expect(
        f.isolated.git(f.worktreePath, "rev-list", "--count", "main..HEAD"),
      ).toBe("1");
      await vi.waitFor(() =>
        expect(
          delivery(f.project.contextRoot, "p")
            .records()
            .some(
              (record) =>
                record.event === "humanReview" && record.dispatches.length > 0,
            ),
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(mail.finished()).toBeGreaterThanOrEqual(
          fault.includes("create") || fault === "accepted-response-lost"
            ? 2
            : 1,
        ),
      );
      const outbox = () => delivery(f.project.contextRoot, "p");
      const event = outbox()
        .records()
        .find((record) => record.event === "humanReview")!;
      await vi.waitFor(() =>
        expect(mail.settled.has(event.messageId)).toBe(true),
      );
      await vi.waitFor(() =>
        expect(
          outbox()
            .records()
            .find((record) => record.id === event.id)
            ?.dispatches.at(-1)?.outcome,
        ).toBe(smtp === "reject" ? "known-not-delivered" : "ambiguous"),
      );
      await mail.idle();
      // Restart delivery, restore relay and observe several controlled windows.
      sink.mode("accept");
      for (let pass = 0; pass < 3; pass++) {
        tick();
        await outbox().drain(sink.notifier, () => {});
        await poll();
      }
      const ready = outbox()
        .records()
        .find((record) => record.event === "humanReview")!;
      expect(ready.dispatches).toHaveLength(smtp === "reject" ? 2 : 1);
      expect(ready.dispatches.at(-1)?.outcome).toBe(
        smtp === "reject" ? "confirmed" : "ambiguous",
      );
      expect(f.store.read()!.publicationState).toBe("open");
      expect(
        f.services
          .entries()
          .filter((entry) => entry.type === "move-card:second"),
      ).toHaveLength(0);
      const ids = sink.messages.map(smtpMessageId);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      const expected = outbox()
        .records()
        .filter((record) =>
          ["humanReview", "attentionRequired"].includes(record.event),
        );
      expect(
        expected.filter((record) => record.event === "humanReview"),
      ).toHaveLength(1);
      expect(
        expected.filter((record) => record.event === "attentionRequired"),
      ).toHaveLength(
        fault === "before-create" || fault === "accepted-response-lost" ? 1 : 0,
      );
      expect(sink.messages).toHaveLength(expected.length);
      for (const record of expected) {
        const accepted = sink.messages.filter(
          (message) => smtpMessageId(message) === record.messageId,
        );
        expect(
          accepted,
          `accepted SMTP count for ${record.event} ${record.messageId}`,
        ).toHaveLength(1);
        const content = decodeSmtpMessage(accepted[0]!);
        expect(content).toContain("Project: p");
        expect(content).toContain("https://trello.com/c/card");
        if (record.event === "humanReview") {
          expect(content).toContain("Event: Human Review");
          expect(content).toContain("https://github.com/owner/repo/pull/1");
          expect(content).toContain(`Actual draft status: ${draft}`);
          if (draft) expect(content).toContain("outstanding advisory finding");
        } else {
          expect(content).toContain("Event: Attention Required");
          expect(content).toContain("Failure category: Git/GitHub");
          expect(content).toContain("Initial publication remains uncertain");
          expect(content).toContain("controlled reconciliation continues");
        }
      }
      const decoded = sink.messages.map(decodeSmtpMessage).join("\n");
      expect(decoded).toContain("https://github.com/owner/repo/pull/1");
      expect(decoded).toContain(`Actual draft status: ${draft}`);
      if (draft) expect(decoded).toContain("outstanding");
    },
    30_000,
  );

  it.each(
    (["refinement", "failure"] as const).flatMap((event) =>
      (["reject", "lose-ack"] as const).map((smtp) => ({ event, smtp })),
    ),
  )(
    "two real-Git projects: $event / SMTP $smtp preserves actual outcomes and project isolation",
    async ({ event, smtp }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-smtp-"));
      const sink = await smtpSink(root);
      sinks.push(sink);
      sink.mode(smtp);
      const a = await notificationAuthorityFixture(root, "a", undefined, true);
      leases.push(a.lease);
      const b = await notificationAuthorityFixture(
        root,
        "b",
        {
          storageRoot: a.pinned.storageRoot,
          coordinationRoot: a.config.workflow.coordinationRoot!,
          otherProjects: [{ project: a.project, lease: a.lease }],
        },
        true,
      );
      leases.push(b.lease);
      let hideClaim = true;
      const secondClaims: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: URL | string, init?: RequestInit) => {
          const url = new URL(input);
          const f = url.pathname.includes("/a-") ? a : b;
          if (
            (init?.method ?? "GET") === "GET" &&
            url.pathname === "/1/lists/a-ready/cards"
          )
            return Response.json([
              ...(a.card.idList === a.project.trello.readyListId
                ? [a.card]
                : []),
              {
                ...a.card,
                id: "a-second",
                idList: a.project.trello.readyListId,
                url: "https://trello.com/c/a-second",
              },
            ]);
          if (url.pathname.includes("a-second") && init?.method === "PUT")
            secondClaims.push(url.pathname);
          if (
            f === a &&
            hideClaim &&
            (init?.method ?? "GET") === "GET" &&
            url.pathname === "/1/cards/a-card"
          )
            return Response.json({
              ...a.card,
              idList: a.project.trello.readyListId,
            });
          const result = await f.fetch(url, init);
          if (
            f === a &&
            hideClaim &&
            init?.method === "PUT" &&
            String(init.body).includes(a.project.trello.workingListId)
          )
            throw new Error("Accepted Working move; acknowledgment lost");
          return result;
        },
      );
      if (event === "failure") {
        a.project.opencode.refinement.model = "openai/test";
        const bin = path.join(root, "failure-bin");
        const home = path.join(root, "failure-home");
        fs.mkdirSync(bin);
        fs.mkdirSync(home);
        fs.writeFileSync(
          path.join(bin, "opencode"),
          `#!${process.execPath}\nprocess.exit(7);\n`,
          { mode: 0o700 },
        );
        const real = new OpenCodeClient();
        a.engineer.mockImplementation((options) =>
          real.run({
            ...options,
            environment: {
              PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: home,
            },
          }),
        );
      }
      const mail = tracked(sink.notifier);
      const poll = (f: typeof a, notifier = mail.sender) =>
        pollProject(
          f.trello,
          f.git,
          f.github,
          f.openCode,
          f.commands,
          f.project,
          new AbortController().signal,
          notifier,
          undefined,
          undefined,
          f.authority,
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      // A workflow mutation is unknown after dispatch; B completes actual Git work.
      await poll(a);
      await mail.idle();
      expect(
        a.authority.store
          .read()!
          .pendingOperations.some((op) => op.status === "ambiguous"),
      ).toBe(true);
      expect(
        a.authority.run(() =>
          new TaskMutationQueue(a.pinned.storageRoot, a.project).getActive(),
        )?.cardId,
      ).toBe("a-card");
      await poll(b);
      await mail.idle();
      expect(b.authority.store.read()!.lifecycle).toBe("refined");
      expect(
        b.authority.run(() =>
          new TaskMutationQueue(b.pinned.storageRoot, b.project).getActive(),
        ),
      ).toBeNull();
      // Resume A from durable claim/owned real-worktree proof, without a new task.
      hideClaim = false;
      for (
        let pass = 0;
        pass < 8 &&
        a.authority.store.read()!.lifecycle !==
          (event === "failure" ? "failed" : "refined");
        pass++
      ) {
        tick();
        await poll(a);
        await mail.idle();
      }
      if (event === "failure") {
        expect(a.engineer).toHaveBeenCalledTimes(3);
        expect(a.authority.store.read()!.lifecycle).toBe("failed");
        expect(a.card.idList).toBe("a-failed");
        // Verified originals/Failed/comment release the queue while preserving
        // the failed worktree and process diagnostics.
        expect(
          a.authority.run(() =>
            new TaskMutationQueue(a.pinned.storageRoot, a.project).getActive(),
          ),
        ).toBeNull();
      } else {
        expect(a.authority.store.read()!.lifecycle).toBe("refined");
        expect(
          a.authority.run(() =>
            new TaskMutationQueue(a.pinned.storageRoot, a.project).getActive(),
          ),
        ).toBeNull();
      }
      // A prepared B obligation may have been observed before its final move was
      // verified. Drive that persisted due check before changing relay behavior.
      await mail.idle();
      tick();
      await delivery(a.pinned.storageRoot, "a").drain(mail.sender, () => {});
      await delivery(b.pinned.storageRoot, "b").drain(mail.sender, () => {});
      if (smtp === "lose-ack")
        await vi.waitFor(() => expect(sink.messages).toHaveLength(2));
      await vi.waitFor(() => expect(mail.finished()).toBeGreaterThanOrEqual(2));
      const old = delivery(a.pinned.storageRoot, "a").records();
      expect(
        old.some(
          (record) =>
            record.event ===
            (event === "failure" ? "failed" : "refinementComplete"),
        ),
      ).toBe(true);
      expect(
        old.every(
          (record) =>
            record.dispatches.at(-1)?.outcome ===
            (smtp === "lose-ack" ? "ambiguous" : "known-not-delivered"),
        ),
      ).toBe(true);
      if (event === "refinement") await a.authority.releaseVerifiedTerminal();
      await b.authority.releaseVerifiedTerminal();
      expect(sink.messages).toHaveLength(smtp === "lose-ack" ? 2 : 0);
      sink.mode("accept");
      for (let pass = 0; pass < 3; pass++) {
        tick();
        await delivery(a.pinned.storageRoot, "a").drain(
          sink.notifier,
          () => {},
        );
        await delivery(b.pinned.storageRoot, "b").drain(
          sink.notifier,
          () => {},
        );
      }
      expect(sink.messages).toHaveLength(2);
      const observed = sink.messages.map(decodeSmtpMessage).join("\n");
      expect(observed).toContain("Project: a");
      expect(observed).toContain("https://trello.com/c/a-card");
      expect(observed).toContain(
        event === "failure" ? "Event: Failed" : "Event: Refinement Complete",
      );
      expect(observed).toContain(
        event === "failure" ? "exited with code 7" : "Classification: feature",
      );
      expect(fs.readFileSync(a.cardPath, "utf8")).toContain(
        event === "failure" ? "a-failed" : "a-backlog",
      );
      expect(fs.readFileSync(b.cardPath, "utf8")).toContain("b-backlog");
      expect(secondClaims).toHaveLength(0);
    },
    30_000,
  );
});
