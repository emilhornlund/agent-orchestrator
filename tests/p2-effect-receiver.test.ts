import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeP2EffectReceiver,
  createP2EffectReceiver,
  waitForP2Effect,
} from "../scripts/p2-effect-receiver.js";

const servers: ReturnType<typeof createP2EffectReceiver>[] = [];
async function start(
  options: { maxBodyBytes?: number; requestDeadlineMs?: number } = {},
) {
  const accepted: Record<string, unknown>[] = [];
  const server = createP2EffectReceiver({
    token: "test-secret",
    ...options,
    accept: (event) => {
      accepted.push(event);
      return { accepted: true, ...event };
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP listener");
  return { server, accepted, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => closeP2EffectReceiver(server)),
  );
});

describe("P2 effect receiver security and lifecycle", () => {
  it("rejects unauthenticated requests without invoking the application oracle", async () => {
    const { url, accepted } = await start();
    const response = await fetch(url, {
      method: "POST",
      body: '{"action":"fake"}',
    });
    expect(response.status).toBe(401);
    expect(accepted).toEqual([]);
  });

  it("rejects oversized bodies without invoking the application oracle", async () => {
    const { url, accepted } = await start({ maxBodyBytes: 8 });
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-p2-receiver-token": "test-secret" },
      body: '{"action":"too-large"}',
    });
    expect(response.status).toBe(413);
    expect(accepted).toEqual([]);
  });

  it("terminates a slow body and keeps it out of the application oracle", async () => {
    const { server, accepted } = await start({ requestDeadlineMs: 80 });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No TCP listener");
    const outcome = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(address.port, "127.0.0.1", () => {
        socket.write(
          "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nX-P2-Receiver-Token: test-secret\r\nContent-Length: 100\r\n\r\n{",
        );
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("error", reject);
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 1_000);
    });
    expect(outcome).toMatch(/408|400/);
    expect(accepted).toEqual([]);
  });

  it("cancels missing-heartbeat waits and removes their listeners", async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const waiting = waitForP2Effect(emitter, "heartbeat", "control", {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort(new Error("heartbeat cancelled"));
    await expect(waiting).rejects.toThrow("heartbeat cancelled");
    expect(emitter.listenerCount("received")).toBe(0);
  });

  it("bounds receiver teardown with a stalled client connection", async () => {
    const { server, url } = await start();
    const socket = createConnection(Number(new URL(url).port), "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const before = Date.now();
    await closeP2EffectReceiver(server, 40);
    expect(Date.now() - before).toBeLessThan(500);
    socket.destroy();
  });
});
