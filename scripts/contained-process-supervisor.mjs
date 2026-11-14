import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";
import { Buffer } from "node:buffer";

// This program may broadcast signals only as init of a private PID namespace.
// Its private status/control descriptors are not inherited by the task payload.
if (process.pid !== 1) process.exit(125);
const report = (value) => {
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(3, bytes, offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {
    /* Parent loss still requires namespace teardown. */
  }
};
const stop = (signal) => {
  try {
    process.kill(-1, signal);
  } catch {
    /* No surviving descendants. */
  }
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
const control = new net.Socket({ fd: 4, readable: true, writable: false });
let pending = "";
control.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  if (pending.length > 2048) {
    stop("SIGTERM");
    control.destroy();
    return;
  }
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    try {
      const value = JSON.parse(line);
      if (value.signal === "SIGTERM" || value.signal === "SIGINT") stop(value.signal);
    } catch {
      stop("SIGTERM");
    }
  }
});
control.on("error", () => {
  /* Parent death is also covered by --die-with-parent. */
});
const [command, ...args] = process.argv.slice(2);
if (!command) {
  report({ type: "result", spawned: false, errorCode: "EINVAL", code: null, signal: null });
  process.exit(125);
}
let child;
try {
  child = spawn(command, args, { stdio: ["inherit", "inherit", "inherit", "ignore", "ignore"] });
} catch {
  report({ type: "result", spawned: false, errorCode: "EINVAL", code: null, signal: null });
  process.exit(125);
}
let reported = false;
child.once("spawn", () => report({ type: "started" }));
child.once("error", (error) => {
  if (reported) return;
  reported = true;
  report({
    type: "result",
    spawned: false,
    errorCode: typeof error.code === "string" ? error.code : "UNKNOWN",
    code: null,
    signal: null,
  });
  process.exit(125);
});
child.once("exit", (code, signal) => {
  if (reported) return;
  reported = true;
  report({ type: "result", spawned: true, code, signal });
  // Namespace init exit terminates all remaining descendants in the kernel,
  // including grandchildren which created another session or ignored SIGTERM.
  process.exit(code ?? 128 + (os.constants.signals[signal] ?? 1));
});
