#!/usr/bin/env node

/* global process */

const token = process.env.GITHUB_TOKEN;

if (typeof token !== "string" || token.length === 0) {
  process.exit(1);
}

const prompt = (process.argv[2] ?? "").toLowerCase();
process.stdout.write(
  prompt.includes("username") ? "x-access-token\n" : `${token}\n`,
);
