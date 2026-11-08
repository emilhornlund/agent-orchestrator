import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ProjectConfig } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import { inspectPrimaryOpenCodeSession } from "../src/opencode/inspect-primary-session.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";
import {
  assertPrimarySessionReconstructionReadOnly,
  runWithPrimaryTaskSession,
  type PrimarySessionContextBundle,
  type PrimarySessionRepositoryFingerprint,
} from "../src/task-session/primary-task-session.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { getTaskSessionReadOnlyIdentity } from "../src/task-session/source-snapshot.js";

interface ResumeFixture {
  root: string;
  runtime: string;
  worktree: string;
  source: string;
  emptyXdg: string;
  project: ProjectConfig;
  projectId: string;
  cardId: string;
  expectedBranch: string;
  operationId: string;
  replacementSessionId: string;
  context: PrimarySessionContextBundle;
  baseline: PrimarySessionRepositoryFingerprint;
  sourceCheckoutFingerprint: {
    head: string;
    branch: string;
    index: string;
    refsIdentity: string;
    contentIdentity: string;
  };
  attemptId: string;
  model: string;
  variant: string;
  constellation: string;
  planFact: string;
  attachmentFact: string;
}

const fixture = JSON.parse(process.argv[2] ?? "null") as ResumeFixture;
const environment = {
  HOME: process.env.HOME ?? "",
  PATH: process.env.PATH ?? "",
  XDG_CONFIG_HOME: fixture.emptyXdg,
  TMPDIR: process.env.TMPDIR ?? "",
};
configureProcessRuntime({
  runtimeRoot: path.join(fixture.runtime, "process-artifacts"),
  signal: new AbortController().signal,
});
const store = new TaskExecutionStore(
  path.join(fixture.runtime, "ledger"),
  fixture.project,
);
const commands = new CommandRunner(async (options) => {
  const result = spawnSync(
    "opencode",
    ["session", "list", "--format", "json", "--pure", "--max-count", "10000"],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return {
    exitCode: result.status ?? 1,
    output: result.stdout,
    errorOutput: result.stderr,
  };
}, new AbortController().signal);
const inspect = (sessionId: string) =>
  inspectPrimaryOpenCodeSession({
    commands,
    cwd: fixture.worktree,
    sessionId,
    signal: new AbortController().signal,
    timeoutMilliseconds: 30_000,
  });
const git = new GitClient();
const fingerprint = async (): Promise<PrimarySessionRepositoryFingerprint> => {
  const [
    sourceIdentity,
    head,
    branch,
    branchRef,
    defaultRef,
    refsIdentity,
    readOnlyIdentity,
  ] = await Promise.all([
    getTaskSessionReadOnlyIdentity(git, fixture.source),
    git.getHeadSha(fixture.worktree),
    git.getCurrentBranch(fixture.worktree),
    git.getRefSha(fixture.worktree, `refs/heads/${fixture.expectedBranch}`),
    git.getRefSha(
      fixture.worktree,
      `refs/remotes/origin/${fixture.project.repository.defaultBranch}`,
    ),
    git.getRefsIdentity(fixture.worktree),
    getTaskSessionReadOnlyIdentity(git, fixture.worktree),
  ]);
  return {
    sourceIdentity,
    head,
    branch,
    branchRef,
    refsIdentity: JSON.stringify([defaultRef, refsIdentity, readOnlyIdentity]),
  };
};
const sourceCheckoutFingerprint = async () => ({
  head: await git.getHeadSha(fixture.source),
  branch: await git.getCurrentBranch(fixture.source),
  index: await git.getIndexEntries(fixture.source),
  refsIdentity: await git.getRefsIdentity(fixture.source),
  contentIdentity: await getTaskSessionReadOnlyIdentity(git, fixture.source),
});

if (store.read(fixture.cardId)?.sessionRecovery?.status !== "replacement-bound")
  throw new Error(
    "Fresh parent did not observe a durable replacement-bound session",
  );
const before = await fingerprint();
const sourceBefore = await sourceCheckoutFingerprint();
assertPrimarySessionReconstructionReadOnly(fixture.baseline, before);
const reconstructionVerification = await runWithPrimaryTaskSession(
  store,
  new OpenCodeClient(),
  fixture.projectId,
  fixture.cardId,
  {
    cwd: fixture.worktree,
    model: fixture.model,
    variant: fixture.variant,
    timeoutMilliseconds: 120_000,
    signal: new AbortController().signal,
    readOnly: true,
    prompt: "Summarize the available task context without changing files.",
    environment,
  },
  {
    inspect,
    context: fixture.context,
    baseline: fixture.baseline,
    attemptId: fixture.attemptId,
    contextDirectory: path.join(fixture.runtime, "recovery-context"),
    forbiddenPaths: [fixture.source, fixture.project.repository.worktreeRoot],
  },
  {
    role: "reconstruction",
    operationId: `${fixture.operationId}:production-reconstruction-verification`,
    readOnlyAcknowledged: true,
  },
);
if (reconstructionVerification.exitCode !== 0)
  throw new Error(
    "Production replacement-bound reconstruction verification failed",
  );
const verifiedRecord = store.read(fixture.cardId);
if (verifiedRecord?.sessionRecovery?.status !== "replacement-bound")
  throw new Error("Production verification changed the replacement binding");
store.compareAndSwap(fixture.cardId, verifiedRecord.revision, {
  ...verifiedRecord,
  sessionRecovery: {
    ...verifiedRecord.sessionRecovery,
    status: "reconstruction-verified",
    reconstructionBaseline: undefined,
  },
  revision: verifiedRecord.revision + 1,
  updatedAt: new Date().toISOString(),
});
const result = await runWithPrimaryTaskSession(
  store,
  new OpenCodeClient(),
  fixture.projectId,
  fixture.cardId,
  {
    cwd: fixture.worktree,
    model: fixture.model,
    variant: fixture.variant,
    timeoutMilliseconds: 120_000,
    signal: new AbortController().signal,
    readOnly: true,
    prompt:
      "What useful task facts are available in your context? Do not modify files.",
    environment,
  },
  {
    inspect,
    context: fixture.context,
    baseline: fixture.baseline,
    attemptId: fixture.attemptId,
    contextDirectory: path.join(fixture.runtime, "recovery-context"),
    forbiddenPaths: [fixture.source, fixture.project.repository.worktreeRoot],
  },
  {
    role: "primary",
    operationId: `${fixture.operationId}:post-reconstruction-resume`,
    activity: "post-reconstruction-resume",
    inspectPending: (entry) =>
      inspectPrimaryOperationEvidence(store, fixture.cardId, entry.id, {
        trustedRoot: path.join(fixture.runtime, "process-artifacts"),
        cwd: fixture.worktree,
      }),
  },
);
const after = await fingerprint();
const sourceAfter = await sourceCheckoutFingerprint();
assertPrimarySessionReconstructionReadOnly(fixture.baseline, after);
if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter))
  throw new Error(
    "Configured source checkout HEAD/index/refs/content changed during recovery",
  );
const latest = store.read(fixture.cardId);
if (
  latest?.primarySessionId !== fixture.replacementSessionId ||
  (result.sessionId !== undefined &&
    result.sessionId !== fixture.replacementSessionId)
)
  throw new Error(
    "Normal resume did not preserve the durably bound replacement ID",
  );
store.compareAndSwap(fixture.cardId, latest.revision, {
  ...latest,
  sessionRecovery: {
    ...latest.sessionRecovery!,
    status: "reconstruction-verified",
    reconstructionBaseline: undefined,
  },
  revision: latest.revision + 1,
  updatedAt: new Date().toISOString(),
});
const operationEntries = Object.values(
  store.read(fixture.cardId)?.primaryOperations ?? {},
);
if (operationEntries.some((entry) => entry.activity === "reconstruction"))
  throw new Error(
    "Read-only reconstruction consumed a primary-operation execution",
  );
const output = result.output ?? "";
for (const fact of [
  fixture.constellation,
  fixture.planFact,
  fixture.attachmentFact,
])
  if (!output.includes(fact))
    throw new Error(
      `Fresh-parent model response omitted independent context fact: ${fact}`,
    );
process.stdout.write(
  `${JSON.stringify({
    replacementSessionId: latest.primarySessionId,
    reconstructionVerificationExitCode: reconstructionVerification.exitCode,
    operationId: `${fixture.operationId}:post-reconstruction-resume`,
    executions: store.read(fixture.cardId)?.primaryOperations?.[
      `${fixture.operationId}:post-reconstruction-resume`
    ]?.executions,
    reconstructionPrimaryExecutions: 0,
    baselinePreserved: true,
    sourceCheckoutPreserved: true,
    recalled: [fixture.constellation, fixture.planFact, fixture.attachmentFact],
  })}\n`,
);
