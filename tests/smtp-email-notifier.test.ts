import net from "node:net";
import tls from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { SmtpEmailNotifier } from "../src/notifications/smtp-email-notifier.js";

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUWhkfBYi5FSzO9BOwLxyIO1//mZkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgzMTE3MDU1NVoXDTM2MDgy
ODE3MDU1NVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuySBofCNBz4sFU47GN16pUWaj1BHS/NXk1hn5k3vzMZs
Pu/Jr4b0JMjMyO1OC1/MUW3ysm7JWXhkagWpaJ6d/7/n/aMrIV5SrR9ckYVv6ini
em5QUvIv1DIJtlMiAO7MHKm3jlo/Zby967nPyxqs25w6lJMSA0Cya9i7kwwBa9ze
6mFvnwH8QgkA/SO0ehXEVzJ/YAy7GSzVrAvSF6WuMs4d+yIRkt66k5RIL0DaqmwK
42uJFcZTPtPf8jISPzCJe3AgUnTephZqJ3+gP1TwcXID+tYTsqbhlwO2BUrTpG1F
Gi5P+NGmMcwGBv5ZmOgfYSZpwdiyszdgW/zBgDCvKwIDAQABo28wbTAdBgNVHQ4E
FgQUNWhpSqCqTh5wvRe6un5BVOwZ9XAwHwYDVR0jBBgwFoAUNWhpSqCqTh5wvRe6
un5BVOwZ9XAwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAInY8/uHOC+06bz0I724wTnSnqlcNrYE
CH75XL44g6QFl6MQc6op//5qB+UkFp+pAOG4wvl2We1EGLpoBTZSZiaG6EVkM9v0
NSspMNiGT22it7a2dtnNC0RsR5CGIaadyXpnCgvy0Nv/i1mYbVNFp0fO2qs3mPwT
853TLeNvVjwLoUPwuHLvaGzWjVC9CLeyfGvxAe/+Atx7rB62zv3btwehyKLdDKQg
BxycsxlHYkhw/UIElB8VYNx+tn/MSWLlVhwXITppbGVVLjjFNtQiGMFvOGuamz0/
t2q5xyTo7vK0mvMtaC9eKYd7fLmWAWApHfxQdhvv5uXWe3sfNK8vhqg=
-----END CERTIFICATE-----`;

const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7JIGh8I0HPiwV
TjsY3XqlRZqPUEdL81eTWGfmTe/Mxmw+78mvhvQkyMzI7U4LX8xRbfKybslZeGRq
Balonp3/v+f9oyshXlKtH1yRhW/qKeJ6blBS8i/UMgm2UyIA7swcqbeOWj9lvL3r
uc/LGqzbnDqUkxIDQLJr2LuTDAFr3N7qYW+fAfxCCQD9I7R6FcRXMn9gDLsZLNWs
C9IXpa4yzh37IhGS3rqTlEgvQNqqbArja4kVxlM+09/yMhI/MIl7cCBSdN6mFmon
f6A/VPBxcgP61hOypuGXA7YFStOkbUUaLk/40aYxzAYG/lmY6B9hJmnB2LKzN2Bb
/MGAMK8rAgMBAAECggEAI/4S8o7dyNlTyCs6IX+jUXsQDWUuuTRNkRitLvWpW7SD
6BzdKOWnOhXmkPRXEMf1d2nShi/ZiNwnT97T5Luw/pmtqDIEHxBRjVtdRd2olxxE
IzDpQPK0cTbIeGkHvq8u0Ypws6+2xr3ktxwPE2yHd1tWRvH8QmTki+pstQzXjyNg
2M7bP5YMgTtp1oxioO3a5Hs+Wn0wXdWTNjfoMdTtB3ZFi2BZEMrhL9eZG1N8utJX
+aNlnEaYip8cpvt7Fw+KjyvWuMAKQhBJQkvYtupPDeAQ9RlCkm/Mp5XrGUeUjPeO
S48C726DKf1d36ivmQH8gCfNte46AsMOBeDhBq9sPQKBgQDp7SddmV1KQy99QQV1
o8y8E5baL+Wh1U5gVHcFte6WXtm6/zz9YlW0Bcs4k40DhX8dCiiGHwSTJai0zRH4
C31UhO05RfLH2hwu7CzQo8ZHqTfo5mXNcja+DG2rgFluSA97bQEuRRHV0nY69fe+
i7VX6+R4PZFynPDHMxXdHw6IRQKBgQDMzTgzYfpH2UHTjgJquJT5y+BmDysIGj6Q
uXbATWxAtvSpJH9D1aC8+cJCEgm7K7pZxG+tx4VxZFAy2c/8vbxVeaqkQcbJxKo2
d6HrQ8vf+Kyt1onu0orIsjW3WFFa3p+rNXYynyfhqp/bb56PuYTC2EDmcWGF1R6K
b6zBjmforwKBgQCB2bX/W/GQFolW8u/v5FPylsEnLm0+jyRpjplfHyVobRBZn/Mg
CCTgwFKVfjpJmSH9YbUq9i7Y64+hhTATS3VvpDX2k+B3lZgNZ+ZcjnyzLLivXK1o
BJ1kk4uRJrb945xMfC6qm4aR9bjRc9Xo/K5WNshlAnApefqh6LabPvEXLQKBgQCj
3UuraSiNVlrh/00VwMyKNcM9RcOjfwQyXgKTCR+lg/2sXCRrzUEIEzqIDNC2bt1y
t8a3n924hY/ZsAdHbTSEm42aUXrRs8aRQBVRHXTBpsHbcb35VYJv5I8wPL0TXO8a
WPNSu594Y0H2nI+c5c5A7DC5cVybbZM7JvFuCRhAxwKBgDJMgs6n+IfuIWucBCGr
P7qNAqcZV9OFHLXgTPG39wpKleYVAcwvncSn+m0zDXzM8byT8pXb7OTLoYttXt8l
bUuBz9vIoofgmtPc9syq7gnh41gc8ieHVWdLNFIKER1bwWqjJQPiwi+SLMMbz0/v
2yxB7eTZKWc7Gx+1B8dvOidn
-----END PRIVATE KEY-----`;

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();

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

interface SmtpTestServerOptions {
  implicitTls: boolean;
  rejectAuthentication?: boolean;
  onAuthentication?: () => void;
  onMessage?: (payload: string, encrypted: boolean) => void;
}

function createSmtpTestServer(options: SmtpTestServerOptions): net.Server {
  const secureContext = tls.createSecureContext({
    cert: testCertificate,
    key: testKey,
  });

  const server = options.implicitTls
    ? tls.createServer({ cert: testCertificate, key: testKey }, (socket) =>
        handleConnection(socket, false, true),
      )
    : net.createServer((socket) => handleConnection(socket, true, true));

  function handleConnection(
    socket: net.Socket | tls.TLSSocket,
    advertiseStartTls: boolean,
    sendGreeting: boolean,
  ): void {
    sockets.add(socket);
    socket.on("error", () => undefined);

    if (sendGreeting) {
      socket.write("220 test SMTP server\r\n");
    }

    let input = "";
    let receivingData = false;
    let authStage: "plain" | "username" | "password" | undefined;
    let username = "";

    const authenticate = (password: string): void => {
      options.onAuthentication?.();

      if (options.rejectAuthentication) {
        socket.write(
          "535 authentication rejected for smtp-user smtp-password\r\n",
        );
        return;
      }

      if (username === "smtp-user" && password === "smtp-password") {
        socket.write("235 authenticated\r\n");
      } else {
        socket.write("535 authentication rejected\r\n");
      }
    };

    const processLine = (line: string): void => {
      if (authStage === "plain") {
        const decoded = Buffer.from(line, "base64").toString("utf8");
        const parts = decoded.split("\0");
        username = parts[1] ?? "";
        authStage = undefined;
        authenticate(parts[2] ?? "");
        return;
      }

      if (authStage === "username") {
        username = Buffer.from(line, "base64").toString("utf8");
        authStage = "password";
        socket.write("334 UGFzc3dvcmQ6\r\n");
        return;
      }

      if (authStage === "password") {
        authStage = undefined;
        authenticate(Buffer.from(line, "base64").toString("utf8"));
        return;
      }

      if (line.startsWith("EHLO")) {
        socket.write(
          advertiseStartTls
            ? "250-localhost\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n"
            : "250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n",
        );
      } else if (line === "STARTTLS" && advertiseStartTls) {
        socket.write("220 ready for TLS\r\n");
        socket.removeListener("data", onData);
        const secureSocket = new tls.TLSSocket(socket, {
          isServer: true,
          secureContext,
        });
        handleConnection(secureSocket, false, false);
      } else if (line.startsWith("AUTH PLAIN")) {
        const encoded = line.slice("AUTH PLAIN".length).trim();

        if (encoded.length === 0) {
          authStage = "plain";
          socket.write("334 \r\n");
        } else {
          const decoded = Buffer.from(encoded, "base64").toString("utf8");
          const parts = decoded.split("\0");
          username = parts[1] ?? "";
          authenticate(parts[2] ?? "");
        }
      } else if (line === "AUTH LOGIN") {
        authStage = "username";
        socket.write("334 VXNlcm5hbWU6\r\n");
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
    };

    const onData = (chunk: Buffer): void => {
      input += chunk.toString("utf8");

      while (true) {
        if (receivingData) {
          const terminator = input.indexOf("\r\n.\r\n");

          if (terminator === -1) {
            return;
          }

          const payload = input.slice(0, terminator);
          input = input.slice(terminator + "\r\n.\r\n".length);
          receivingData = false;
          options.onMessage?.(payload, socket instanceof tls.TLSSocket);
          socket.write("250 message accepted\r\n");
          continue;
        }

        const lineEnd = input.indexOf("\r\n");

        if (lineEnd === -1) {
          return;
        }

        const line = input.slice(0, lineEnd);
        input = input.slice(lineEnd + 2);
        processLine(line);
      }
    };

    socket.on("data", onData);
  }

  return server;
}

function notifier(port: number, secure: boolean): SmtpEmailNotifier {
  return new SmtpEmailNotifier({
    recipients: ["reviewers@example.com"],
    from: "agent-orchestrator@example.com",
    host: "127.0.0.1",
    port,
    secure,
    username: "smtp-user",
    password: "smtp-password",
    timeoutMilliseconds: 1_000,
    tls: { ca: testCertificate },
  });
}

describe("SmtpEmailNotifier", () => {
  it("delivers through a required STARTTLS connection", async () => {
    let payload = "";
    let encrypted = false;
    const server = createSmtpTestServer({
      implicitTls: false,
      onMessage: (message, isEncrypted) => {
        payload = message;
        encrypted = isEncrypted;
      },
    });
    const port = await listen(server);

    await notifier(port, false).send({
      subject: "[Agent Orchestrator] Human Review",
      text: "Event: Human Review\nTrello card URL: https://trello.example/card-1",
    });

    expect(encrypted).toBe(true);
    expect(payload).toContain("Subject: [Agent Orchestrator] Human Review");
    expect(payload).toContain("Trello card URL: https://trello.example/card-1");
    expect(payload).not.toContain("smtp-user");
    expect(payload).not.toContain("smtp-password");
  });

  it("delivers through an implicit TLS connection", async () => {
    let payload = "";
    let encrypted = false;
    const server = createSmtpTestServer({
      implicitTls: true,
      onMessage: (message, isEncrypted) => {
        payload = message;
        encrypted = isEncrypted;
      },
    });
    const port = await listen(server);

    await notifier(port, true).send({
      subject: "Subject",
      text: "Body",
    });

    expect(encrypted).toBe(true);
    expect(payload).toContain("Subject: Subject");
    expect(payload).toContain("Body");
  });

  it("reports authentication rejection without retrying or exposing credentials", async () => {
    let authenticationAttempts = 0;
    const server = createSmtpTestServer({
      implicitTls: false,
      rejectAuthentication: true,
      onAuthentication: () => {
        authenticationAttempts += 1;
      },
    });
    const port = await listen(server);

    let thrown: unknown;

    try {
      await notifier(port, false).send({ subject: "Subject", text: "Body" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected SMTP delivery to fail");
    }

    expect(thrown.message).toContain("SMTP delivery failed");
    expect(thrown.message).not.toContain("smtp-user");
    expect(thrown.message).not.toContain("smtp-password");
    expect(authenticationAttempts).toBe(1);
  });

  it("bounds a server that never sends its greeting", async () => {
    const server = net.createServer(() => undefined);
    const port = await listen(server);
    const startedAt = Date.now();

    await expect(
      new SmtpEmailNotifier({
        recipients: ["reviewers@example.com"],
        from: "agent-orchestrator@example.com",
        host: "127.0.0.1",
        port,
        secure: false,
        username: "smtp-user",
        password: "smtp-password",
        timeoutMilliseconds: 50,
      }).send({ subject: "Subject", text: "Body" }),
    ).rejects.toThrow("SMTP delivery failed");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("stops delivery when the abort signal is triggered", async () => {
    const controller = new AbortController();
    const commands: string[] = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        commands.push(chunk.toString("utf8"));
      });
      socket.write("220 test SMTP server\r\n");
      controller.abort();
    });
    const port = await listen(server);

    await expect(
      new SmtpEmailNotifier({
        recipients: ["reviewers@example.com"],
        from: "agent-orchestrator@example.com",
        host: "127.0.0.1",
        port,
        secure: false,
        username: "smtp-user",
        password: "smtp-password",
        timeoutMilliseconds: 1_000,
        signal: controller.signal,
      }).send({ subject: "Subject", text: "Body" }),
    ).rejects.toThrow("SMTP delivery aborted");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands.join("")).not.toContain("EHLO");
  });
});
