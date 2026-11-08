import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectConfig } from "../src/config/config.js";
import { OpenCodeClient } from "../src/opencode/opencode-client.js";
import {
  inspectPrimaryOpenCodeSession,
  parseOpenCodeSessionList,
} from "../src/opencode/inspect-primary-session.js";
import { configureProcessRuntime } from "../src/process/process-runtime.js";
import { inspectPrimaryOperationEvidence } from "../src/task-session/inspect-primary-operation.js";
import {
  runWithPrimaryTaskSession,
  assertPrimarySessionReconstructionReadOnly,
} from "../src/task-session/primary-task-session.js";
import { buildPrimarySessionContext } from "../src/task-session/build-primary-session-context.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import { GitClient } from "../src/git/git-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { getTaskSessionReadOnlyIdentity } from "../src/task-session/source-snapshot.js";
import type { CardAttachmentPromptContext } from "../src/context/card-attachment-prompt.js";
import { resolveCardAttachmentPath } from "../src/context/card-context-storage.js";

const model = process.env.P5_T2_MODEL;
const variant = process.env.P5_T2_VARIANT;
if (!model || !variant)
  throw new Error("Set P5_T2_MODEL and P5_T2_VARIANT explicitly");
if (!process.env.TMPDIR) throw new Error("Set TMPDIR to workspace .p5-tmp");
const root = await mkdtemp(
  join(process.env.TMPDIR, "p5-t2-session-reconstruction-"),
);
const source = join(root, "source");
const worktreeRoot = join(root, "project-worktrees");
const worktree = join(worktreeRoot, "fixture-card");
const runtime = join(root, "runtime");
const emptyXdg = join(root, "empty-xdg");
await Promise.all([
  mkdir(source),
  mkdir(runtime),
  mkdir(emptyXdg),
  mkdir(worktreeRoot),
]);
const git = (args: string[], cwd = source): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const evidencePath = join(runtime, "evidence.json");
const evidence: Record<string, unknown> = {
  root,
  source,
  worktree,
  runtime,
  model,
  variant,
};
const save = async () =>
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
try {
  git(["init", "-q"]);
  await writeFile(join(source, ".gitignore"), "*.ignored-fixture\n");
  git([
    "-c",
    "user.name=verification",
    "-c",
    "user.email=verification.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  git(["branch", "-M", "main"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["worktree", "add", "-q", "-b", "agent/p5-t2-reconstruction", worktree]);
  await writeFile(
    join(worktree, "staged-fixture.txt"),
    "preserve staged bytes\n",
  );
  git(["add", "staged-fixture.txt"], worktree);
  await writeFile(
    join(worktree, "untracked-fixture.txt"),
    "preserve untracked bytes\n",
  );
  await writeFile(
    join(worktree, "preserve.ignored-fixture"),
    "preserve ignored bytes\n",
  );
  const projectId = "p5-t2-session-reconstruction";
  const cardId = "fixture-card";
  const operationId = "fixture-operation:implementation";
  const project: ProjectConfig = {
    id: projectId,
    autoMerge: false,
    trello: {
      boardId: "fixture",
      backlogListId: "fixture",
      readyListId: "fixture",
      workingListId: "fixture",
      reviewListId: "fixture",
      failedListId: "fixture",
      doneListId: "fixture",
      refinementLabelId: "fixture",
      featureLabelId: "fixture",
      improvementLabelId: "fixture",
      bugLabelId: "fixture",
    },
    opencode: {
      refinement: { model, variant },
      implementation: { model, variant },
      review: { model, variant },
      remediation: { model, variant, maxPasses: 1 },
      commit: { model, variant },
      timeoutMinutes: 2,
    },
    repository: {
      path: source,
      worktreeRoot,
      defaultBranch: "main",
      github: "fixture/fixture",
      gitIdentity: { name: "verification", email: "verification.invalid" },
    },
  };
  const constellation = `silver otter ${Math.floor(Math.random() * 900 + 100)}`;
  const planFact = "cobalt91";
  const attachmentFact = "lantern47";
  const client = new OpenCodeClient();
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
    evidence.inspectorListDiagnostic = {
      exitCode: result.status,
      outputCharacters: result.stdout.length,
      startsWithJson: /^[\s]*\[/u.test(result.stdout),
      stdoutPrefix: result.stdout.slice(0, 100),
      stderrPrefix: result.stderr.slice(0, 100),
    };
    await save();
    return {
      exitCode: result.status ?? 1,
      output: result.stdout,
      errorOutput: result.stderr,
    };
  }, new AbortController().signal);
  const environment = {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: emptyXdg,
    TMPDIR: process.env.TMPDIR,
  };
  const initial = await client.run({
    cwd: worktree,
    model,
    variant,
    timeoutMilliseconds: 120_000,
    signal: new AbortController().signal,
    readOnly: true,
    prompt: `Remember harmless constellation ${constellation}. Reply READY.`,
    captureSessionId: true,
    environment,
  });
  if (initial.exitCode !== 0 || !initial.sessionId)
    throw new Error("Advisory session creation failed");
  evidence.oldSessionId = initial.sessionId;
  const store = new TaskExecutionStore(join(runtime, "ledger"), project);
  const timestamp = new Date().toISOString();
  store.create({
    version: 1,
    projectId,
    cardId,
    phase: "implementation",
    primarySessionId: initial.sessionId,
    sessionCreationStatus: "bound",
    expectedBranch: "agent/p5-t2-reconstruction",
    operationKey: "fixture-operation",
    revision: 1,
    retryCounters: { validation: 0, review: 0, ci: 0, humanFeedback: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  configureProcessRuntime({
    runtimeRoot: join(runtime, "process-artifacts"),
    signal: new AbortController().signal,
  });
  const first = await runWithPrimaryTaskSession(
    store,
    client,
    projectId,
    cardId,
    {
      cwd: worktree,
      model,
      variant,
      timeoutMilliseconds: 120_000,
      signal: new AbortController().signal,
      readOnly: true,
      prompt: `Recall ${constellation} and reply READY.`,
      environment,
    },
    {},
    {
      role: "primary",
      operationId,
      activity: "implementation",
      inspectPending: () =>
        inspectPrimaryOperationEvidence(store, cardId, operationId, {
          trustedRoot: join(runtime, "process-artifacts"),
          cwd: worktree,
        }),
    },
  );
  const beforeEntry = store.read(cardId)?.primaryOperations?.[operationId];
  if (
    first.exitCode !== 0 ||
    beforeEntry?.executions !== 1 ||
    beforeEntry.status !== "completed"
  )
    throw new Error("Primary ledger did not complete exactly once");
  evidence.primaryLedgerBefore = beforeEntry;
  evidence.initialProcessExecutionId = first.processExecutionId ?? null;
  await save();
  // Keep one unrelated fixture-owned session present so OpenCode's CLI emits
  // its JSON array after deletion instead of an empty non-JSON stdout stream.
  const control = await client.run({
    cwd: worktree,
    model,
    variant,
    timeoutMilliseconds: 120_000,
    signal: new AbortController().signal,
    readOnly: true,
    prompt: "Reply READY.",
    captureSessionId: true,
    environment,
  });
  if (control.exitCode !== 0 || !control.sessionId)
    throw new Error(
      "Control session creation failed; preserve fixture evidence",
    );
  evidence.controlSessionId = control.sessionId;
  await save();
  const listed = spawnSync(
    "opencode",
    ["session", "list", "--format", "json", "--pure"],
    {
      cwd: worktree,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const listedSessions =
    listed.status === 0 ? parseOpenCodeSessionList(listed.stdout) : [];
  const fixtureListing = listedSessions.filter(
    (session) =>
      session.id === initial.sessionId && session.directory === worktree,
  );
  evidence.fixtureSessionListFact = {
    matchedCount: fixtureListing.length,
    sessionId: initial.sessionId,
    directory: fixtureListing[0]?.directory ?? null,
  };
  await save();
  if (listed.status !== 0 || fixtureListing.length !== 1)
    throw new Error(
      "Cannot establish session is a real CLI session; preserving fixture",
    );
  const deleted = spawnSync(
    "opencode",
    ["session", "delete", initial.sessionId],
    {
      cwd: worktree,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  evidence.deleteExitCode = deleted.status;
  evidence.deleteStdout = deleted.stdout;
  evidence.deleteStderr = deleted.stderr;
  await save();
  if (deleted.status !== 0)
    throw new Error("Exact fixture session deletion failed");
  const inspect = (id: string) =>
    inspectPrimaryOpenCodeSession({
      commands,
      cwd: worktree,
      sessionId: id,
      signal: new AbortController().signal,
      timeoutMilliseconds: 30_000,
    });
  const absent = await inspect(initial.sessionId);
  evidence.inspectionAfterDelete = absent;
  if (absent !== "confirmed-absent")
    throw new Error(`Expected confirmed absent, got ${absent}`);
  const gitClient = new GitClient();
  const card = {
    id: cardId,
    name: "Fixture reconstruction task",
    desc: `Harmless ${constellation}`,
    idList: "fixture-ready",
    idLabels: [],
    url: "https://trello.com/c/fixture",
  };
  const record = store.read(cardId)!;
  const attachmentContextRoot = join(runtime, "context");
  const attachmentPath = resolveCardAttachmentPath(
    attachmentContextRoot,
    projectId,
    cardId,
    "clue.txt",
  );
  await mkdir(dirname(attachmentPath), { recursive: true });
  await writeFile(attachmentPath, attachmentFact);
  const attachments: CardAttachmentPromptContext = {
    projectId,
    cardId,
    contextRoot: attachmentContextRoot,
    manifest: {
      attachments: [
        {
          id: "fixture-attachment",
          name: "clue.txt",
          mimeType: "text/plain",
          bytes: "9",
          url: "https://example.invalid/clue.txt",
          isUpload: true,
          localFilename: "clue.txt",
        },
      ],
    },
  };
  const context = await buildPrimarySessionContext({
    git: gitClient,
    projectId,
    card,
    attemptId: "fixture-attempt",
    worktreePath: worktree,
    record,
    plan: { title: "Fixture plan", expectedFact: planFact },
    attachments,
  });
  if (
    context.attachmentManifest.status !== "available" ||
    typeof context.attachmentManifest.content !== "string"
  )
    throw new Error(
      "Fixture attachment content was not available in recovery context",
    );
  const attachmentEvidence = JSON.parse(context.attachmentManifest.content) as {
    manifest?: Array<{ readableContent?: string }>;
  };
  if (attachmentEvidence.manifest?.[0]?.readableContent !== attachmentFact)
    throw new Error(
      "Production reconstruction context did not inline current text attachment content",
    );
  const fingerprint = async () => {
    const sourceIdentity = await getTaskSessionReadOnlyIdentity(
      gitClient,
      source,
    );
    const readOnlyIdentity = await getTaskSessionReadOnlyIdentity(
      gitClient,
      worktree,
    );
    return {
      sourceIdentity,
      head: git(["rev-parse", "HEAD"], worktree),
      branch: git(["branch", "--show-current"], worktree),
      branchRef: git(
        ["rev-parse", "--verify", "refs/heads/agent/p5-t2-reconstruction"],
        source,
      ),
      refsIdentity: JSON.stringify([
        git(
          [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${project.repository.defaultBranch}`,
          ],
          worktree,
        ),
        await gitClient.getRefsIdentity(worktree),
        readOnlyIdentity,
      ]),
    };
  };
  const baseline = await fingerprint();
  const sourceCheckoutFingerprint = {
    head: git(["rev-parse", "HEAD"], source),
    branch: git(["branch", "--show-current"], source),
    index: await gitClient.getIndexEntries(source),
    refsIdentity: await gitClient.getRefsIdentity(source),
    contentIdentity: await getTaskSessionReadOnlyIdentity(gitClient, source),
  };
  evidence.context = context;
  evidence.baselineBefore = baseline;
  evidence.sourceCheckoutFingerprint = sourceCheckoutFingerprint;
  await save();
  const replacement = await runWithPrimaryTaskSession(
    store,
    client,
    projectId,
    cardId,
    {
      cwd: worktree,
      model,
      variant,
      timeoutMilliseconds: 120_000,
      signal: new AbortController().signal,
      readOnly: true,
      prompt:
        "Acknowledge the supplied reconstructed task context read-only. Do not modify files; reply READY.",
      environment,
    },
    {
      inspect,
      context,
      baseline,
      attemptId: "fixture-attempt",
      contextDirectory: join(runtime, "recovery-context"),
      forbiddenPaths: [source, worktree],
    },
    {
      role: "reconstruction",
      operationId: "fixture-reconstruction",
      readOnlyAcknowledged: true,
    },
  );
  if (replacement.sessionId === undefined)
    throw new Error("Replacement session ID was not returned");
  evidence.replacementSessionId = replacement.sessionId;
  evidence.replacementOutput = replacement.output;
  evidence.planArtifact = context.plan;
  evidence.attachmentArtifact = context.attachmentManifest;
  evidence.baselineAfter = await fingerprint();
  const sourceCheckoutAfter = {
    head: git(["rev-parse", "HEAD"], source),
    branch: git(["branch", "--show-current"], source),
    index: await gitClient.getIndexEntries(source),
    refsIdentity: await gitClient.getRefsIdentity(source),
    contentIdentity: await getTaskSessionReadOnlyIdentity(gitClient, source),
  };
  const ledgerAfter = store.read(cardId)?.primaryOperations?.[operationId];
  evidence.primaryLedgerAfter = ledgerAfter;
  await save();
  assertPrimarySessionReconstructionReadOnly(
    baseline,
    evidence.baselineAfter as typeof baseline,
  );
  if (
    JSON.stringify(sourceCheckoutFingerprint) !==
    JSON.stringify(sourceCheckoutAfter)
  )
    throw new Error(
      "Source checkout HEAD/index/refs/content changed during replacement creation",
    );
  if (
    !replacement.sessionId ||
    replacement.sessionId === initial.sessionId ||
    ledgerAfter?.executions !== 1
  )
    throw new Error("Replacement lineage or primary ledger assertion failed");
  const resumeFixture = {
    root,
    runtime,
    worktree,
    source,
    emptyXdg,
    project,
    projectId,
    cardId,
    expectedBranch: "agent/p5-t2-reconstruction",
    operationId,
    replacementSessionId: replacement.sessionId,
    context,
    baseline,
    sourceCheckoutFingerprint,
    attemptId: "fixture-attempt",
    model,
    variant,
    constellation,
    planFact,
    attachmentFact,
  };
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(
        process.cwd(),
        "scripts/p5-t2-session-reconstruction-resume.ts",
      ),
      JSON.stringify(resumeFixture),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 180_000,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
      },
    },
  );
  if (child.status !== 0)
    throw new Error(
      `Fresh-parent replacement verification failed: ${child.stderr}`,
    );
  const freshParentResult = JSON.parse(child.stdout) as {
    replacementSessionId: string;
    executions: number;
    reconstructionPrimaryExecutions: number;
    recalled: string[];
  };
  evidence.freshParentResult = freshParentResult;
  await save();
  if (
    freshParentResult.replacementSessionId !== replacement.sessionId ||
    freshParentResult.executions !== 1 ||
    freshParentResult.reconstructionPrimaryExecutions !== 0 ||
    !freshParentResult.recalled.includes(planFact) ||
    !freshParentResult.recalled.includes(attachmentFact)
  )
    throw new Error(
      "Fresh-parent reconstruction resume evidence did not satisfy the fixture oracle",
    );
  process.stdout.write(
    `${JSON.stringify({ evidencePath, oldSessionId: initial.sessionId, newSessionId: replacement.sessionId, initialExecutions: 1, resumedExecutions: freshParentResult.executions, reconstructionPrimaryExecutions: 0, recalled: freshParentResult.recalled })}\n`,
  );
} catch (error) {
  evidence.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  await save();
  throw error;
}
