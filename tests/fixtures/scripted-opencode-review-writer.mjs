#!/usr/bin/env node
/* global process, setInterval */
import fs from "node:fs";
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "-e",
    `
const fs = require('node:fs');
let sequence = 0;
const heartbeat = () => fs.writeFileSync('writer-child.heartbeat', String(++sequence));
heartbeat();
setInterval(heartbeat, 20);
`,
  ],
  {
    stdio: "ignore",
  },
);
let stopping = false;
child.on("exit", () => {
  if (stopping) process.exit(0);
});
process.on("SIGTERM", () => {
  stopping = true;
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  else child.kill("SIGTERM");
});
fs.writeFileSync("unshipped-review.txt", "Reviewer correction was not published.\n");
fs.writeFileSync("writer-child.pid", String(child.pid));
fs.writeFileSync("writer-started", "ready\n");
process.stdout.write('{"type":"text","part":{"type":"text","text":"correction running"}}\n');
setInterval(() => {}, 1000);
