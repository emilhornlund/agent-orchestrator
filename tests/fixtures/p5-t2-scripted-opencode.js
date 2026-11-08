#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const statePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sessions.json",
);
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { nextId: 1, sessions: [], calls: [] };
const args = process.argv.slice(2);
const readState = () => {
  fs.writeFileSync(statePath, JSON.stringify(state));
};

if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(
    JSON.stringify(
      state.sessions.map(({ id, directory }) => ({ id, directory })),
    ),
  );
  process.exit(0);
}

if (args[0] === "session" && args[1] === "delete") {
  state.sessions = state.sessions.filter(({ id }) => id !== args[2]);
  readState();
  process.exit(0);
}

if (args[0] !== "run") process.exit(2);
const argValue = (name) => args[args.indexOf(name) + 1];
const directory = argValue("--dir");
const existingId = argValue("--session");
const prompt = args.at(-1) ?? "";
let session = state.sessions.find(({ id }) => id === existingId);
if (!session) {
  session = {
    id: `ses_scripted_${state.nextId++}`,
    directory,
    facts: [],
  };
  state.sessions.push(session);
}

const facts = new Set(session.facts);
for (const match of prompt.matchAll(/silver otter \d+|cobalt91|lantern47/gu))
  facts.add(match[0]);
session.facts = [...facts];
state.calls.push({ sessionId: session.id, prompt });
readState();
const response =
  session.facts.join(" ") || "Acknowledged supplied task context.";
if (args.includes("--format") && argValue("--format") === "json") {
  process.stdout.write(
    `${JSON.stringify({ type: "step_start", sessionID: session.id })}\n${JSON.stringify({ type: "text", part: { type: "text", text: response } })}\n`,
  );
} else {
  process.stdout.write(response);
}
