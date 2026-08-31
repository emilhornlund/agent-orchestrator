import net from "node:net";
import tls from "node:tls";

import type { EmailMessage, EmailNotifier } from "./email-notifier.js";

interface SmtpResponse {
  code: number;
  lines: string[];
}

export interface SmtpEmailNotifierOptions {
  recipients: string[];
  from: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}

type SmtpSocket = net.Socket | tls.TLSSocket;

class SmtpConnection {
  private readonly lines: string[] = [];
  private readonly lineWaiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private buffer = "";
  private closed = false;
  private readonly connected: Promise<void>;
  private rejectConnected: ((error: Error) => void) | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly abortHandler: (() => void) | undefined;

  constructor(
    private readonly socket: SmtpSocket,
    secure: boolean,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ) {
    this.socket.setTimeout(timeoutMilliseconds, () => {
      this.fail(
        new Error(`SMTP connection timed out after ${timeoutMilliseconds}ms`),
      );
      this.socket.destroy();
    });

    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.flushLines();
    });

    this.socket.on("error", (error) => {
      this.fail(error);
    });

    this.socket.on("close", () => {
      if (!this.closed) {
        this.fail(new Error("SMTP connection closed unexpectedly"));
      }
    });

    this.connected = new Promise<void>((resolve, reject) => {
      this.rejectConnected = reject;
      this.socket.once(secure ? "secureConnect" : "connect", () => {
        resolve();
      });
      this.socket.once("error", reject);
    });

    if (signal?.aborted) {
      this.abortSignal = undefined;
      this.abortHandler = undefined;
      this.fail(new Error("SMTP delivery aborted"));
      this.socket.destroy();
    } else if (signal !== undefined) {
      const abortHandler = () => {
        this.fail(new Error("SMTP delivery aborted"));
        this.socket.destroy();
      };

      this.abortSignal = signal;
      this.abortHandler = abortHandler;
      signal.addEventListener("abort", abortHandler, { once: true });
    } else {
      this.abortSignal = undefined;
      this.abortHandler = undefined;
    }
  }

  async waitUntilConnected(): Promise<void> {
    await this.connected;
  }

  async command(command: string, label: string): Promise<SmtpResponse> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(`${command}\r\n`, (error?: Error | null) => {
        if (error == null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });

    const response = await this.response();

    if (response.code >= 400) {
      throw new Error(`SMTP ${label} failed: ${response.lines.join(" ")}`);
    }

    return response;
  }

  async response(): Promise<SmtpResponse> {
    const firstLine = await this.readLine();
    const firstCode = parseResponseCode(firstLine);
    const lines = [firstLine];

    if (firstLine[3] === "-") {
      while (true) {
        const line = await this.readLine();
        lines.push(line);

        if (line.startsWith(`${firstCode} `)) {
          break;
        }
      }
    }

    return { code: firstCode, lines };
  }

  async data(payload: string): Promise<SmtpResponse> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(payload, "utf8", (error?: Error | null) => {
        if (error == null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });

    const line = await this.readLine();
    const code = parseResponseCode(line);
    const response = { code, lines: [line] };

    if (code >= 400) {
      throw new Error(`SMTP message delivery failed: ${line}`);
    }

    return response;
  }

  async quit(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.command("QUIT", "connection close");
    } finally {
      this.closed = true;
      this.socket.end();
    }
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  removeAbortListener(): void {
    if (this.abortSignal !== undefined && this.abortHandler !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

  private readLine(): Promise<string> {
    const line = this.lines.shift();

    if (line !== undefined) {
      return Promise.resolve(line);
    }

    if (this.closed) {
      return Promise.reject(new Error("SMTP connection is closed"));
    }

    return new Promise((resolve, reject) => {
      this.lineWaiters.push({ resolve, reject });
    });
  }

  private flushLines(): void {
    while (true) {
      const lineEnd = this.buffer.indexOf("\n");

      if (lineEnd === -1) {
        return;
      }

      const line = this.buffer.slice(0, lineEnd).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lineEnd + 1);
      const waiter = this.lineWaiters.shift();

      if (waiter === undefined) {
        this.lines.push(line);
      } else {
        waiter.resolve(line);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectConnected?.(error);
    this.rejectConnected = undefined;

    for (const waiter of this.lineWaiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

function parseResponseCode(line: string): number {
  const code = Number.parseInt(line.slice(0, 3), 10);

  if (!/^\d{3}[ -]/.test(line) || !Number.isInteger(code)) {
    throw new Error("SMTP server returned an invalid response");
  }

  return code;
}

function openSocket(options: SmtpEmailNotifierOptions): SmtpSocket {
  if (options.secure) {
    return tls.connect({
      host: options.host,
      port: options.port,
    });
  }

  return net.createConnection({
    host: options.host,
    port: options.port,
  });
}

function encodeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildPayload(
  message: EmailMessage,
  options: SmtpEmailNotifierOptions,
): string {
  const body = message.text.replace(/\r\n|\r|\n/g, "\r\n");
  const dotStuffedBody = body
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");

  return [
    `From: ${encodeHeader(options.from)}`,
    `To: ${options.recipients.map(encodeHeader).join(", ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    dotStuffedBody,
    ".",
    "",
  ].join("\r\n");
}

export class SmtpEmailNotifier implements EmailNotifier {
  constructor(private readonly options: SmtpEmailNotifierOptions) {}

  async send(message: EmailMessage): Promise<void> {
    const connection = new SmtpConnection(
      openSocket(this.options),
      this.options.secure,
      this.options.timeoutMilliseconds,
      this.options.signal,
    );

    try {
      await connection.waitUntilConnected();
      await expectResponse(connection.response(), [220]);
      await expectResponse(
        connection.command("EHLO localhost", "greeting"),
        [250],
      );
      await expectResponse(
        connection.command("AUTH LOGIN", "authentication"),
        [334],
      );
      await expectResponse(
        connection.command(
          Buffer.from(this.options.username).toString("base64"),
          "username authentication",
        ),
        [334],
      );
      await expectResponse(
        connection.command(
          Buffer.from(this.options.password).toString("base64"),
          "password authentication",
        ),
        [235],
      );
      await expectResponse(
        connection.command(
          `MAIL FROM:<${encodeHeader(this.options.from)}>`,
          "sender",
        ),
        [250],
      );

      for (const recipient of this.options.recipients) {
        await expectResponse(
          connection.command(
            `RCPT TO:<${encodeHeader(recipient)}>`,
            "recipient",
          ),
          [250, 251],
        );
      }

      await expectResponse(connection.command("DATA", "message start"), [354]);
      await connection.data(buildPayload(message, this.options));
    } finally {
      try {
        await connection.quit();
      } catch {
        connection.destroy();
      } finally {
        connection.removeAbortListener();
      }
    }
  }
}

async function expectResponse(
  responsePromise: Promise<SmtpResponse>,
  expectedCodes: number[],
): Promise<void> {
  const response = await responsePromise;

  if (!expectedCodes.includes(response.code)) {
    throw new Error(
      `SMTP server returned ${response.code}; expected ${expectedCodes.join(" or ")}`,
    );
  }
}
