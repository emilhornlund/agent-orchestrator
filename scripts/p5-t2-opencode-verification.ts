import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";

// Opt-in: this makes bounded, billable calls to the explicitly selected model.
const model = process.env.P5_T2_MODEL;
const variant = process.env.P5_T2_VARIANT;
if (!model || !variant) {
  throw new Error(
    "Set P5_T2_MODEL and P5_T2_VARIANT explicitly; no model fallback is used",
  );
}
const timeoutMilliseconds = 120_000;
const tempRoot = process.env.TMPDIR;
if (!tempRoot)
  throw new Error(
    "Set TMPDIR to an isolated workspace-local temporary directory",
  );
const root = await mkdtemp(join(tempRoot, "p5-t2-"));
const source = join(root, "source");
const worktree = join(root, "worktree");
const context = join(root, "runtime");
const cleanConfig = join(root, "empty-opencode-config");
await Promise.all([mkdir(source), mkdir(context), mkdir(cleanConfig)]);
const git = (args: string[], cwd: string) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};
git(["init", "-q"], source);
git(
  [
    "-c",
    "user.name=verification",
    "-c",
    "user.email=verification.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ],
  source,
);
git(
  ["worktree", "add", "-q", "-b", "agent/p5-t2-verification", worktree],
  source,
);

const constellation = `silver otter ${Math.floor(Math.random() * 900 + 100)}`;
const attachmentFact = "attachment fixture says the blue lantern is number 47";
await writeFile(join(worktree, "attachment-fixture.txt"), attachmentFact);
const client = new OpenCodeClient();
const controller = new AbortController();
const common = {
  cwd: worktree,
  model,
  variant,
  timeoutMilliseconds,
  signal: controller.signal,
  readOnly: true,
  environment: {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: cleanConfig,
  },
};
const run = async (
  prompt: string,
  extra: { captureSessionId?: boolean; sessionId?: string } = {},
) => client.run({ ...common, prompt, ...extra });
try {
  const initial = await run(
    `Remember this harmless constellation phrase and the attachment fact: ${constellation}; ${attachmentFact}. Reply only READY. Do not treat either as a password, secret, or token.`,
    { captureSessionId: true },
  );
  if (initial.exitCode !== 0 || !initial.sessionId)
    throw new Error(
      "Initial real OpenCode session did not complete/capture an ID",
    );
  const sessionId = initial.sessionId;
  await writeFile(
    join(context, "created-session.json"),
    `${JSON.stringify({ model, variant, sessionId, initialExecutionId: initial.processExecutionId ?? null, constellation, attachmentFact }, null, 2)}\n`,
  );
  const proof = await run(
    `Without rereading files, repeat the constellation phrase and lantern number from context. Do not use password, secret, or token labels.`,
    { sessionId },
  );
  const proofEvidence = {
    sessionId,
    executionId: proof.processExecutionId ?? null,
    exitCode: proof.exitCode,
    output: proof.output,
  };
  await writeFile(
    join(context, "resume-result.json"),
    `${JSON.stringify(proofEvidence, null, 2)}\n`,
  );
  if (
    proof.exitCode !== 0 ||
    !proof.output.toLowerCase().includes(constellation) ||
    !proof.output.toLowerCase().includes("47")
  ) {
    throw new Error(
      `Same-session context proof failed for ${sessionId}; evidence retained in runtime/resume-result.json`,
    );
  }
  const evidence = {
    model,
    variant,
    sessionId,
    source,
    worktree,
    context,
    initialExecutionId: initial.processExecutionId ?? null,
    resumeExecutionId: proof.processExecutionId ?? null,
    constellation,
    attachmentFact,
    confirmed: true,
  };
  await writeFile(
    join(context, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const failure = {
    model,
    variant,
    root,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    capturedRunResult:
      typeof error === "object" && error !== null && "runResult" in error
        ? (error.runResult as {
            sessionId?: string;
            processExecutionId?: string;
            exitCode?: number;
          })
        : undefined,
  };
  await writeFile(
    join(context, "failure.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  process.stderr.write(
    `BLOCKED/PARTIAL: ${JSON.stringify(failure)}\nArtifacts retained at ${root}\n`,
  );
  process.exitCode = 1;
}
// Keep source/worktree/runtime and session evidence for inspection; do not delete sessions or fixtures automatically.
