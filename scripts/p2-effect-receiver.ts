import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { EventEmitter } from "node:events";
import type { Socket } from "node:net";

export type P2Effect = Record<string, unknown>;

export function waitForP2Effect(
  emitter: EventEmitter,
  action: string,
  actor: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<P2Effect> {
  const { timeoutMs = 10_000, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Wait aborted"));
      return;
    }
    const listener = (event: P2Effect) => {
      if (event.action === action && event.actor === actor)
        finish(undefined, event);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off("received", listener);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, event?: P2Effect) => {
      cleanup();
      if (error) reject(error);
      else resolve(event!);
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${action} from ${actor}`)),
      timeoutMs,
    );
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Wait aborted"),
      );
    emitter.on("received", listener);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface P2EffectReceiverOptions {
  token: string;
  accept(event: P2Effect): Promise<P2Effect> | P2Effect;
  maxBodyBytes?: number;
  requestDeadlineMs?: number;
}

const receiverSockets = new WeakMap<Server, Set<Socket>>();

function reply(response: ServerResponse, status: number, body: P2Effect): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Authenticated, bounded HTTP endpoint used only by the P2 contention harness. */
export function createP2EffectReceiver({
  token,
  accept,
  maxBodyBytes = 64 * 1024,
  requestDeadlineMs = 5_000,
}: P2EffectReceiverOptions): Server {
  if (!token) throw new Error("P2 receiver token must not be empty");
  const server = createServer((request: IncomingMessage, response) => {
    if (request.headers["x-p2-receiver-token"] !== token) {
      reply(response, 401, { accepted: false, error: "Unauthorized" });
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      reply(response, 405, { accepted: false, error: "POST required" });
      request.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reply(response, 408, {
        accepted: false,
        error: "Request deadline exceeded",
      });
      request.destroy();
    }, requestDeadlineMs);
    const finish = () => {
      settled = true;
      clearTimeout(timer);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        finish();
        reply(response, 413, {
          accepted: false,
          error: "Request body too large",
        });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      finish();
      void (async () => {
        try {
          const event: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          if (!event || typeof event !== "object" || Array.isArray(event))
            throw new Error("Expected an event object");
          const accepted = await accept(event as P2Effect);
          reply(response, 200, accepted);
        } catch (error) {
          reply(response, 400, {
            accepted: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
    request.on("error", finish);
  });
  server.headersTimeout = requestDeadlineMs;
  server.requestTimeout = requestDeadlineMs;
  server.keepAliveTimeout = 1_000;
  const sockets = new Set<Socket>();
  receiverSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
}

/** Close promptly, destroying connections that failed to finish gracefully. */
export async function closeP2EffectReceiver(
  server: Server,
  timeoutMs = 1_000,
): Promise<void> {
  if (!server.listening) return;
  const sockets = receiverSockets.get(server) ?? new Set<Socket>();
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      if (!finished) {
        finished = true;
        resolve();
      }
    }, timeoutMs);
    server.close((error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
