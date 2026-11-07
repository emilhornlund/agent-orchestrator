import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const containerfile = fs.readFileSync(
  path.join(projectRoot, "Containerfile.p3-test"),
  "utf8",
);
const copyInstructions = containerfile
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => /^COPY\s/u.test(line));
if (copyInstructions.length === 0)
  throw new Error("P3 test image has no explicit allowlisted COPY inputs");
const allowedSources = new Set([
  "package.json",
  "yarn.lock",
  "config.example.yaml",
  "config.example.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  ".prettierrc.json",
  ".prettierignore",
  "src",
  "tests",
  "scripts",
]);

const contextRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "p3-container-sentinel-context-"),
);
const sentinels = [
  "config.yaml",
  ".env",
  "logs/orchestrator.log",
  "history/project/task/events.jsonl",
  "runtime/attempts/private.json",
  "protected-keys/app.pem",
];
const image = "localhost/agent-orchestrator-p3-context-check:latest";
const run = (command: string, args: string[], timeout: number): string => {
  const result = spawnSync(command, args, {
    cwd: contextRoot,
    encoding: "utf8",
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  return result.stdout;
};

try {
  for (const instruction of copyInstructions) {
    const tokens = instruction.split(/\s+/u);
    if (tokens[0] !== "COPY" || tokens.some((token) => token === "."))
      throw new Error(
        `P3 test image COPY must enumerate inputs, not copy the context: ${instruction}`,
      );
    const destination = tokens.at(-1);
    if (!destination)
      throw new Error(
        `Malformed P3 test image COPY instruction: ${instruction}`,
      );
    const sources = tokens.slice(1, -1);
    for (const source of sources) {
      if (source.startsWith("--") || !allowedSources.has(source))
        throw new Error(
          `P3 image COPY source is not on the explicit safe allowlist: ${source}`,
        );
      const absoluteSource = path.join(projectRoot, source);
      if (!fs.existsSync(absoluteSource))
        throw new Error(`Allowlisted P3 image input is missing: ${source}`);
      fs.cpSync(absoluteSource, path.join(contextRoot, source), {
        recursive: true,
        dereference: false,
      });
    }
  }

  for (const sentinel of sentinels) {
    const filename = path.join(contextRoot, sentinel);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `SYNTHETIC_CONTEXT_SENTINEL:${sentinel}\n`);
  }

  const checks = [
    `const fs=require("node:fs");`,
    `const forbidden=${JSON.stringify(sentinels.map((entry) => `/workspace/${entry}`))};`,
    `for(const file of forbidden){if(fs.existsSync(file))throw new Error("synthetic context sentinel leaked into image: "+file)}`,
    `for(const file of ${JSON.stringify([
      "/workspace/src/process/process-runtime.ts",
      "/workspace/tests/process-adapter-matrix.integration.test.ts",
      "/workspace/tests/p3-shutdown.integration.test.ts",
      "/workspace/scripts/bounded-process.ts",
      "/workspace/config.example.yaml",
    ])}){if(!fs.existsSync(file))throw new Error("required test input missing: "+file)}`,
  ].join(";");
  const sentinelContainerfile = [
    "FROM docker.io/library/node:24-bookworm-slim",
    "WORKDIR /workspace",
    ...copyInstructions,
    `RUN node -e '${checks}'`,
  ].join("\n");
  fs.writeFileSync(
    path.join(contextRoot, "Containerfile.sentinel"),
    sentinelContainerfile,
  );
  run(
    "podman",
    ["build", "--file", "Containerfile.sentinel", "--tag", image, "."],
    120_000,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "PASS",
      image,
      syntheticSentinelCount: sentinels.length,
      allowlistedCopyInstructions: copyInstructions.length,
    })}\n`,
  );
} finally {
  fs.rmSync(contextRoot, { recursive: true, force: true });
}
