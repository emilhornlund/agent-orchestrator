import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe("OpenCode default selection executable boundary", () => {
  it("uses OpenCode defaults, scopes default-provider credentials, and never substitutes an unavailable explicit selection", async () => {
    const tempRoot = os.tmpdir();
    temporaryRoot = fs.mkdtempSync(path.join(tempRoot, "opencode-default-"));
    const bin = path.join(temporaryRoot, "bin");
    const worktree = path.join(temporaryRoot, "worktree");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree);
    const cli = path.join(bin, "opencode");
    fs.copyFileSync(
      path.join(
        process.cwd(),
        "tests/fixtures/scripted-opencode-selection.mjs",
      ),
      cli,
    );
    fs.chmodSync(cli, 0o755);
    const configPath = path.join(temporaryRoot, "opencode.jsonc");
    fs.writeFileSync(
      configPath,
      '{ // configured default\n "model": "openai/default-model", }',
    );
    const priorPath = process.env.PATH ?? "";
    vi.stubEnv("PATH", `${bin}${path.delimiter}${priorPath}`);
    vi.stubEnv("OPENAI_API_KEY", "default-provider-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-provider-key");
    vi.stubEnv("TRELLO_API_KEY", "unrelated-service-key");
    configureProcessRuntime({
      runtimeRoot: path.join(temporaryRoot, "process-evidence"),
      signal: new AbortController().signal,
    });
    const opencode = new OpenCodeClient();
    const defaultResult = await opencode.run({
      cwd: worktree,
      timeoutMilliseconds: 60_000,
      prompt: "use configured default",
      signal: new AbortController().signal,
      environment: { OPENCODE_CONFIG: configPath },
    });
    expect(defaultResult.exitCode).toBe(0);
    const missingResult = await opencode.run({
      cwd: worktree,
      model: "provider/missing",
      variant: "exact-variant",
      timeoutMilliseconds: 60_000,
      prompt: "do not substitute",
      signal: new AbortController().signal,
      environment: { OPENCODE_CONFIG: configPath },
    });
    expect(missingResult.exitCode).toBe(1);
    expect(missingResult.errorOutput).toContain(
      'Configured OpenCode selection unavailable: model="provider/missing", variant="exact-variant"',
    );
    await expect(
      opencode.run({
        cwd: worktree,
        timeoutMilliseconds: 60_000,
        prompt: "relative config must not be resolved from a different cwd",
        signal: new AbortController().signal,
        environment: { OPENCODE_CONFIG: "relative/opencode.json" },
      }),
    ).rejects.toThrow("OPENCODE_CONFIG must be an absolute path");
    const calls = fs
      .readFileSync(path.join(worktree, "opencode-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            openaiCredentialPresent: boolean;
            anthropicCredentialPresent: boolean;
            trelloCredentialPresent: boolean;
          },
      );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).not.toContain("--model");
    expect(calls[0]?.args).not.toContain("--variant");
    expect(calls[0]).toMatchObject({
      openaiCredentialPresent: true,
      anthropicCredentialPresent: false,
      trelloCredentialPresent: false,
    });
    expect(calls[1]?.args).toContain("provider/missing");
    expect(calls[1]?.args).toContain("exact-variant");
    expect(calls[1]?.args.filter((arg) => arg === "--model")).toHaveLength(1);
  });
});
