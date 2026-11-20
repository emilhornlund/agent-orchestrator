import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createPublicationFixture,
  reopenPublicationFixture,
} from "./support/initial-publication-fixture.js";
import {
  NotificationOutbox,
  createNotificationObligation,
  notificationObligationSchema,
} from "../src/notifications/notification-outbox.js";
import {
  buildAttentionRequiredEmail,
  prepareAttentionNotification,
  type EmailNotifier,
} from "../src/notifications/email-notifier.js";
import { diagnosticEventIdentityText } from "../src/security/bounded-diagnostic.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";

it("reuses a confirmed legacy attention event across repeated artifact paths and service-owner restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attention-event-identity-"));
  try {
    let f = createPublicationFixture(root);
    const send = vi.fn(async () => undefined);
    const notifier: EmailNotifier = { send, deliveryTarget: "test-relay" };
    const reason = (id: string) =>
      `Terminal reconciliation failed\nGitHub CLI timeout; diagnostics: process-executions/${id}/stderr.txt`;
    const details = (text: string) => ({
      project: f.project,
      category: "Workflow",
      reason: text,
      cardIds: ["card"],
    });
    let outbox = new NotificationOutbox(f.project.contextRoot, f.project.id, () => {});
    const originalReason = reason("11111111-1111-4111-8111-111111111111");
    const legacy = createNotificationObligation(
      f.project.id,
      `${f.project.id}:attempt:attentionRequired:Workflow:${originalReason}:card`,
      buildAttentionRequiredEmail(details(originalReason)),
      "attentionRequired",
      notifier.deliveryTarget,
    );
    f.authority.run(() =>
      f.authority.mutate(
        `notification-event-${legacy.id}`,
        legacy,
        (value) => ({ value, result: undefined }),
        notificationObligationSchema.parse,
      ),
    );
    outbox.materialize(legacy);
    await outbox.drain(notifier, () => {});
    expect(send).toHaveBeenCalledOnce();
    const prepare = (text: string) =>
      outbox.run(() =>
        f.authority.run(() => prepareAttentionNotification(notifier, details(text))),
      );
    for (let poll = 0; poll < 3; poll += 1) {
      prepare(reason("22222222-2222-4222-8222-222222222222"));
      await outbox.drain(notifier, () => {});
    }
    f = { ...f, ...reopenPublicationFixture(root, "restarted-owner") };
    outbox = new NotificationOutbox(f.project.contextRoot, f.project.id, () => {});
    prepare(reason("33333333-3333-4333-8333-333333333333"));
    await outbox.drain(notifier, () => {});
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.records()).toHaveLength(1);
    expect(outbox.records()[0]?.id).toBe(legacy.id);
    prepare("A different owned worktree is missing");
    await outbox.drain(notifier, () => {});
    expect(send).toHaveBeenCalledTimes(2);
    const secret = "private\n attention value";
    registerProcessSecrets([secret]);
    prepare(`A new failure contains ${secret}`);
    await outbox.drain(notifier, () => {});
    const latest = outbox
      .records()
      .find((record) => record.message.text.includes("A new failure"))!;
    expect(latest.eventKey).toContain("[REDACTED]");
    expect(JSON.stringify(latest)).not.toContain("attention value");
    expect(diagnosticEventIdentityText(`head ${"a".repeat(40)}`)).not.toBe(
      diagnosticEventIdentityText(`head ${"b".repeat(40)}`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
