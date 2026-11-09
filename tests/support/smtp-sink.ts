import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { testCertificate, testKey } from "./smtp-test-certificate.js";
import { SmtpEmailNotifier } from "../../src/notifications/smtp-email-notifier.js";

/** Disposable real TLS relay. The acceptance ledger is independent of the outbox;
 * the public synthetic localhost key never represents real credentials. */
export async function smtpSink(root: string) {
  const key = path.join(root, "smtp.key"),
    cert = path.join(root, "smtp.crt");
  fs.writeFileSync(key, testKey, { mode: 0o600 });
  fs.writeFileSync(cert, testCertificate);
  let mode: "accept" | "reject" | "lose-ack" = "accept";
  const sockets = new Set<tls.TLSSocket>();
  const messages: string[] = [];
  const ledger = (type: string, payload?: string) =>
    fs.appendFileSync(
      path.join(root, "smtp-ledger.jsonl"),
      `${JSON.stringify({ type, at: Date.now(), ...(payload ? { payload } : {}) })}\n`,
    );
  const server = tls.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.write("220 localhost test relay\r\n");
      let input = "",
        data = false;
      socket.on("data", (chunk: Buffer) => {
        input += chunk.toString();
        while (true) {
          if (data) {
            const end = input.indexOf("\r\n.\r\n");
            if (end < 0) return;
            const payload = input
              .slice(0, end)
              .replace(/(^|\r\n)\.\./gu, "$1.");
            input = input.slice(end + 5);
            data = false;
            ledger("DATA", payload);
            if (mode === "reject") {
              ledger("rejected");
              socket.write("451 deliberately rejected before acceptance\r\n");
            } else {
              messages.push(payload);
              ledger("accepted", payload);
              if (mode === "lose-ack") socket.destroy();
              else socket.write("250 relay accepted\r\n");
            }
            continue;
          }
          const end = input.indexOf("\r\n");
          if (end < 0) return;
          const line = input.slice(0, end);
          input = input.slice(end + 2);
          if (line.startsWith("EHLO"))
            socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH"))
            socket.write("235 authenticated synthetic identity\r\n");
          else if (line.startsWith("MAIL") || line.startsWith("RCPT"))
            socket.write("250 OK\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 continue\r\n");
          } else if (line === "QUIT") {
            socket.end("221 goodbye\r\n");
          }
        }
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing SMTP port");
  const notifier = new SmtpEmailNotifier({
    host: "127.0.0.1",
    port: address.port,
    secure: true,
    from: "agent@example.test",
    recipients: ["observer@example.test"],
    username: "synthetic-user",
    password: "synthetic-password",
    timeoutMilliseconds: 2000,
    tls: { ca: fs.readFileSync(cert) },
  });
  return {
    notifier,
    messages,
    mode: (next: typeof mode) => {
      mode = next;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
