import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SmtpEmailNotifier } from "../src/notifications/smtp-email-notifier.js";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("SMTP test server did not expose a port");
  }

  return address.port;
}

describe("SmtpEmailNotifier", () => {
  it("delivers an authenticated plain SMTP message through the configured connection", async () => {
    let payload = "";
    const server = net.createServer((socket) => {
      let input = "";
      let receivingData = false;
      socket.write("220 test SMTP server\r\n");

      socket.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");

        while (true) {
          if (receivingData) {
            const terminator = input.indexOf("\r\n.\r\n");

            if (terminator === -1) {
              return;
            }

            payload = input.slice(0, terminator);
            input = input.slice(terminator + "\r\n.\r\n".length);
            receivingData = false;
            socket.write("250 message accepted\r\n");
            continue;
          }

          const lineEnd = input.indexOf("\r\n");

          if (lineEnd === -1) {
            return;
          }

          const line = input.slice(0, lineEnd);
          input = input.slice(lineEnd + 2);

          if (line === "EHLO localhost") {
            socket.write("250-localhost\r\n250 AUTH LOGIN\r\n");
          } else if (line === "AUTH LOGIN") {
            socket.write("334 VXNlcm5hbWU6\r\n");
          } else if (line === Buffer.from("smtp-user").toString("base64")) {
            socket.write("334 UGFzc3dvcmQ6\r\n");
          } else if (line === Buffer.from("smtp-password").toString("base64")) {
            socket.write("235 authenticated\r\n");
          } else if (line.startsWith("MAIL FROM:")) {
            socket.write("250 sender accepted\r\n");
          } else if (line.startsWith("RCPT TO:")) {
            socket.write("250 recipient accepted\r\n");
          } else if (line === "DATA") {
            receivingData = true;
            socket.write("354 send message\r\n");
          } else if (line === "QUIT") {
            socket.write("221 closing\r\n");
            socket.end();
          }
        }
      });
    });
    const port = await listen(server);
    const removeAbortListener = vi.fn();
    const notifier = new SmtpEmailNotifier({
      recipients: ["reviewers@example.com"],
      from: "agent-orchestrator@example.com",
      host: "127.0.0.1",
      port,
      secure: false,
      username: "smtp-user",
      password: "smtp-password",
      timeoutMilliseconds: 1_000,
      signal: {
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener: removeAbortListener,
      } as unknown as AbortSignal,
    });

    await notifier.send({
      subject: "[Agent Orchestrator] Human Review",
      text: "Event: Human Review\nTrello card URL: https://trello.example/card-1",
    });

    expect(payload).toContain("Subject: [Agent Orchestrator] Human Review");
    expect(payload).toContain("Trello card URL: https://trello.example/card-1");
    expect(payload).not.toContain("smtp-password");
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("reports an SMTP rejection without retrying", async () => {
    let recipientAttempts = 0;
    const server = net.createServer((socket) => {
      let input = "";
      socket.write("220 test SMTP server\r\n");

      socket.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");

        while (true) {
          const lineEnd = input.indexOf("\r\n");

          if (lineEnd === -1) {
            return;
          }

          const line = input.slice(0, lineEnd);
          input = input.slice(lineEnd + 2);

          if (line === "EHLO localhost") {
            socket.write("250 localhost\r\n");
          } else if (line === "AUTH LOGIN") {
            socket.write("550 authentication rejected\r\n");
          } else if (line.startsWith("RCPT TO:")) {
            recipientAttempts += 1;
          } else if (line === "QUIT") {
            socket.write("221 closing\r\n");
            socket.end();
          }
        }
      });
    });
    const port = await listen(server);
    const notifier = new SmtpEmailNotifier({
      recipients: ["reviewers@example.com"],
      from: "agent-orchestrator@example.com",
      host: "127.0.0.1",
      port,
      secure: false,
      username: "smtp-user",
      password: "smtp-password",
      timeoutMilliseconds: 1_000,
    });

    await expect(
      notifier.send({ subject: "Subject", text: "Body" }),
    ).rejects.toThrow("SMTP authentication failed");

    expect(recipientAttempts).toBe(0);
  });
});
