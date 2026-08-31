import net from "node:net";
import type { ConnectionOptions } from "node:tls";
import tls from "node:tls";

import nodemailer from "nodemailer";

import type { EmailMessage, EmailNotifier } from "./email-notifier.js";

type SmtpSocket = net.Socket | tls.TLSSocket;

interface SmtpSocketOptions {
  connection: SmtpSocket;
  secured?: boolean;
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
  tls?: ConnectionOptions;
  signal?: AbortSignal;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactCredentials(
  message: string,
  options: SmtpEmailNotifierOptions,
): string {
  return [options.username, options.password]
    .filter((credential) => credential.length > 0)
    .reduce(
      (redacted, credential) => redacted.split(credential).join("[redacted]"),
      message,
    );
}

function deliveryError(
  error: unknown,
  options: SmtpEmailNotifierOptions,
): Error {
  const message = getErrorMessage(error);

  if (message === "SMTP delivery aborted") {
    return new Error(message);
  }

  return new Error(
    `SMTP delivery failed: ${redactCredentials(message, options)}`,
  );
}

export class SmtpEmailNotifier implements EmailNotifier {
  constructor(private readonly options: SmtpEmailNotifierOptions) {}

  async send(message: EmailMessage): Promise<void> {
    if (this.options.signal?.aborted) {
      throw new Error("SMTP delivery aborted");
    }

    let activeSocket: SmtpSocket | undefined;
    let finishSocketSetup: ((error: Error) => void) | undefined;
    let abortRequested = false;
    const abortError = new Error("SMTP delivery aborted");

    const getSocket = (
      _transportOptions: unknown,
      callback: (
        error: Error | null,
        socketOptions: SmtpSocketOptions | false,
      ) => void,
    ): void => {
      if (abortRequested) {
        callback(abortError, false);
        return;
      }

      const socket = this.options.secure
        ? tls.connect({
            ...(this.options.tls === undefined ? {} : this.options.tls),
            host: this.options.host,
            port: this.options.port,
          })
        : net.createConnection({
            host: this.options.host,
            port: this.options.port,
          });
      activeSocket = socket;

      let settled = false;
      const connectionTimer = setTimeout(() => {
        socket.destroy();
        complete(
          new Error(
            `SMTP connection timed out after ${this.options.timeoutMilliseconds}ms`,
          ),
          false,
        );
      }, this.options.timeoutMilliseconds);

      const complete = (
        error: Error | null,
        socketOptions: SmtpSocketOptions | false,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        finishSocketSetup = undefined;
        if (connectionTimer !== undefined) {
          clearTimeout(connectionTimer);
        }
        socket.removeListener("error", onError);
        callback(error, socketOptions);
      };

      const onError = (error: Error): void => {
        complete(error, false);
      };

      const onReady = (): void => {
        if (abortRequested) {
          socket.destroy();
          complete(abortError, false);
          return;
        }

        complete(
          null,
          this.options.secure
            ? { connection: socket, secured: true }
            : { connection: socket },
        );
      };

      finishSocketSetup = (error) => {
        complete(error, false);
      };
      socket.once(this.options.secure ? "secureConnect" : "connect", onReady);
      socket.once("error", onError);
    };

    const transporter = nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      requireTLS: !this.options.secure,
      auth: {
        user: this.options.username,
        pass: this.options.password,
      },
      connectionTimeout: this.options.timeoutMilliseconds,
      greetingTimeout: this.options.timeoutMilliseconds,
      socketTimeout: this.options.timeoutMilliseconds,
      ...(this.options.tls === undefined ? {} : { tls: this.options.tls }),
      ...(this.options.signal === undefined ? {} : { getSocket }),
    });
    let abortHandler: (() => void) | undefined;
    let rejectAborted: ((reason?: unknown) => void) | undefined;
    const aborted =
      this.options.signal === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            rejectAborted = reject;
          });

    try {
      if (this.options.signal !== undefined) {
        abortHandler = () => {
          abortRequested = true;
          finishSocketSetup?.(abortError);
          activeSocket?.destroy();
          transporter.close();
          rejectAborted?.(abortError);
        };
        this.options.signal.addEventListener("abort", abortHandler, {
          once: true,
        });

        if (this.options.signal.aborted) {
          abortHandler();
        }
      }

      const delivery = abortRequested
        ? Promise.reject(abortError)
        : transporter.sendMail({
            from: this.options.from,
            to: this.options.recipients,
            subject: message.subject,
            text: message.text,
          });

      if (aborted === undefined) {
        await delivery;
      } else {
        await Promise.race([delivery, aborted]);
      }
    } catch (error) {
      throw deliveryError(error, this.options);
    } finally {
      if (this.options.signal !== undefined && abortHandler !== undefined) {
        this.options.signal.removeEventListener("abort", abortHandler);
      }

      activeSocket?.destroy();
      transporter.close();
    }
  }
}
