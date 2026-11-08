#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const entry = {
  args,
  openaiCredentialPresent: process.env.OPENAI_API_KEY !== undefined,
  anthropicCredentialPresent: process.env.ANTHROPIC_API_KEY !== undefined,
  trelloCredentialPresent: process.env.TRELLO_API_KEY !== undefined,
};
fs.appendFileSync("opencode-calls.jsonl", `${JSON.stringify(entry)}\n`);
process.stdout.write(`${JSON.stringify(entry)}\n`);
if (args.includes("provider/missing")) {
  process.stderr.write("Model not found\n");
  process.exitCode = 1;
}
