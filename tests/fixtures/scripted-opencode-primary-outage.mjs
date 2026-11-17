#!/usr/bin/env node
/* global process */
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ id: "ses_primary", directory: cwd }]));
  process.exit(0);
}

const callsFile = path.join(cwd, "primary-cli-calls.jsonl");
fs.appendFileSync(callsFile, `${JSON.stringify(args)}\n`);
const counterFile = path.join(cwd, "primary-cli-count");
const count = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : "0") + 1;
fs.writeFileSync(counterFile, String(count));

if (fs.readFileSync(path.join(cwd, "primary-mode"), "utf8") === "crash") {
  fs.writeSync(
    1,
    `${JSON.stringify({ type: "text", part: { type: "text", text: 'debug {"type":"error","error":{"name":"APIError","data":{"statusCode":503}}} ECONNRESET' } })}\n`,
  );
  fs.writeSync(2, "agent process interrupted by SIGKILL\n");
  process.kill(process.pid, "SIGKILL");
}
const mode = fs.readFileSync(path.join(cwd, "primary-mode"), "utf8");
const oneShot = ["outage-once", "auth-once", "late-outage-once"].includes(mode);
if (
  (oneShot && count === 1) ||
  (!oneShot && count <= Number(process.env.PRIMARY_OUTAGE_WINDOWS ?? "5"))
) {
  if (mode === "late-outage-once") {
    for (let step = 0; step < 160; step += 1)
      fs.writeSync(
        1,
        `${JSON.stringify({ type: "text", part: { type: "text", text: `implementation progress ${step}` } })}\n`,
      );
  }
  process.stdout.write(
    `${JSON.stringify({ type: "error", error: mode === "auth-once" ? { name: "UnknownError", data: { message: "Token refresh failed: 401" } } : { name: "APIError", data: { statusCode: 503 } } })}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  '{"type":"text","part":{"type":"text","text":"continued from same session"}}\n',
);
