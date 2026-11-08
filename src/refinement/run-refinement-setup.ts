import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import type { Logger } from "../logging/logger.js";
import { getSessionLogPath } from "../logging/session-log.js";
import type {
  CommandRunner,
  CommandRunResult,
} from "../process/command-runner.js";
import {
  assertSetupInventoryIdentity,
  captureSetupEffects,
  runRepositorySetup,
} from "../process/run-setup.js";
import { refinementResultRelativePath } from "./refinement-result.js";
import {
  isVerifiedStoppedExecution,
  isVerifiedSuccessfulExecution,
} from "../process/process-runtime.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";

const setupAttemptSchema = z.strictObject({
  command: z.string().min(1),
  worktreePath: z.string().min(1),
  before: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  after: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
  executionId: z.string().min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  outcome: z.enum(["active", "passed", "failed", "ambiguous"]),
});
const setupStateSchema = z.strictObject({
  command: z.string().min(1).nullable(),
  worktreePath: z.string().min(1),
  status: z.enum([
    "pending",
    "active",
    "passed",
    "failed",
    "ambiguous",
    "not-required",
  ]),
  baseline: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
  attempts: z.array(setupAttemptSchema).max(3),
});
type SetupState = z.infer<typeof setupStateSchema>;

const setupKey = (cardId: string) => `refinement-setup-${cardId}`;
const maxSetupExecutions = 3;

export function hasExhaustedRefinementSetup(
  authority: ProjectRunAuthority,
  cardId: string,
): boolean {
  return (
    authority.read(setupKey(cardId), (value) => setupStateSchema.parse(value))
      ?.status === "failed"
  );
}

export class RefinementSetupAmbiguousError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefinementSetupAmbiguousError";
  }
}

export class RefinementSetupFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefinementSetupFailedError";
  }
}

function readBaseline(
  authority: ProjectRunAuthority,
  reference: string | undefined,
  worktreePath: string,
  cardId: string,
): Buffer {
  if (!reference) throw new Error("Post-setup repository baseline is missing");
  const contents = authority.store.readArtifact(reference);
  assertSetupInventoryIdentity(
    JSON.parse(contents.toString("utf8")) as unknown,
    worktreePath,
    `agent/${cardId}`,
  );
  return contents;
}

/** Check the durable baseline before a restart can dispatch refinement again. */
export async function assertRefinementSetupBaselineUnchanged(options: {
  git: GitClient;
  worktreePath: string;
  baseline: Buffer;
  signal: AbortSignal;
}): Promise<void> {
  const current = await captureSetupEffects(
    options.git,
    options.worktreePath,
    options.signal,
  );
  const parse = (bytes: Buffer) =>
    JSON.parse(bytes.toString("utf8")) as {
      branch: string;
      head: string;
      status: string;
      tracked: string[];
      untracked: string[];
      ignored: string[];
      files: { path: string }[];
      [key: string]: unknown;
    };
  const normalize = (bytes: Buffer) => {
    const inventory = parse(bytes);
    return {
      ...inventory,
      status: inventory.status
        .split("\n")
        .filter((line) => line.slice(3) !== refinementResultRelativePath)
        .join("\n"),
      tracked: inventory.tracked.filter(
        (file) => file !== refinementResultRelativePath,
      ),
      untracked: inventory.untracked.filter(
        (file) => file !== refinementResultRelativePath,
      ),
      ignored: inventory.ignored.filter(
        (file) => file !== refinementResultRelativePath,
      ),
      files: inventory.files.filter(
        (file) => file.path !== refinementResultRelativePath,
      ),
    };
  };
  if (
    JSON.stringify(normalize(options.baseline)) !==
    JSON.stringify(normalize(current))
  )
    throw new RefinementSetupAmbiguousError(
      "Refinement worktree no longer matches the persisted post-setup baseline; preserving it and blocking agent redispatch",
    );
}

/** Run and durably attribute setup before refinement; never dispatch refinement on uncertainty. */
export async function runRefinementSetup(options: {
  commands: CommandRunner;
  git: GitClient;
  project: ProjectConfig;
  cardId: string;
  worktreePath: string;
  signal: AbortSignal;
  cardLog: Logger;
}): Promise<Buffer | undefined> {
  const { commands, git, project, cardId, worktreePath, signal, cardLog } =
    options;
  const command = project.repository.setupCommand ?? null;
  const authority = ProjectRunAuthority.current(project.id);
  if (command === null) {
    if (authority !== undefined) {
      const key = setupKey(cardId);
      const previous = authority.read(key, (value) =>
        setupStateSchema.parse(value),
      );
      if (
        previous !== null &&
        (previous.command !== null || previous.worktreePath !== worktreePath)
      )
        throw new Error("Persisted refinement setup configuration changed");
      const initial: SetupState = {
        command: null,
        worktreePath,
        status: "not-required",
        attempts: [],
      };
      if (previous?.baseline) {
        const baseline = readBaseline(
          authority,
          previous.baseline,
          worktreePath,
          cardId,
        );
        return baseline;
      }
      authority.mutate(
        key,
        initial,
        (current) => ({
          value: setupStateSchema.parse(current),
          result: undefined,
        }),
        (value) => setupStateSchema.parse(value),
      );
      return undefined;
    }
    cardLog.event("Repository setup skipped: no setup command is configured");
    return undefined;
  }
  if (authority === undefined)
    throw new Error(
      "Configured refinement setup requires durable project attempt authority",
    );
  const key = setupKey(cardId);
  const taskStore = new TaskExecutionStore(
    authority.store.read()!.pinned.storageRoot,
    project,
    authority,
  );
  const initial: SetupState = {
    command,
    worktreePath,
    status: command === null ? "not-required" : "pending",
    attempts: [],
  };
  const readState = (): SetupState => {
    const raw = authority.read(key, (value) => setupStateSchema.parse(value));
    const state = raw ?? initial;
    if (state.command !== command || state.worktreePath !== worktreePath)
      throw new Error("Persisted refinement setup identity changed");
    return state;
  };
  const writeState = (state: SetupState): void => {
    authority.mutate(
      key,
      initial,
      () => ({ value: state, result: undefined }),
      (value) => setupStateSchema.parse(value),
    );
  };
  let state = readState();
  if (state.status === "passed") {
    const attempt = state.attempts.at(-1);
    if (!attempt?.after || !attempt.executionId)
      throw new Error(
        "Completed refinement setup has incomplete durable evidence",
      );
    const expected = {
      executionId: attempt.executionId,
      command,
      cwd: worktreePath,
    };
    const processEvidence = taskStore.readProcessExecution(
      cardId,
      attempt.executionId,
    );
    if (!isVerifiedSuccessfulExecution(processEvidence, expected))
      throw new Error(
        "Completed refinement setup process result could not be verified",
      );
    for (const reference of [attempt.before, attempt.after]) {
      const artifact = JSON.parse(
        authority.store.readArtifact(reference).toString("utf8"),
      ) as unknown;
      assertSetupInventoryIdentity(artifact, worktreePath, `agent/${cardId}`);
    }
    cardLog.event("Verified completed repository setup; skipping rerun");
    return readBaseline(
      authority,
      state.baseline ?? attempt.after,
      worktreePath,
      cardId,
    );
  }
  if (state.status === "active") {
    const active = state.attempts.at(-1);
    if (!active?.executionId)
      throw new RefinementSetupAmbiguousError(
        "Repository setup dispatch is uncertain; refinement remains blocked",
      );
    const expected = {
      executionId: active.executionId,
      command,
      cwd: worktreePath,
    };
    let passed: boolean;
    let stopped: boolean;
    let afterRef: string;
    try {
      const evidence = taskStore.readProcessExecution(
        cardId,
        active.executionId,
      );
      passed = isVerifiedSuccessfulExecution(evidence, expected);
      stopped = isVerifiedStoppedExecution(evidence, expected);
    } catch (error) {
      throw new RefinementSetupAmbiguousError(
        "Could not verify the interrupted setup process; preserving it for recovery",
        { cause: error },
      );
    }
    if (!passed && !stopped)
      throw new RefinementSetupAmbiguousError(
        "Repository setup process is still active or ambiguous; refinement remains blocked",
      );
    try {
      const after = await captureSetupEffects(git, worktreePath, signal, true);
      afterRef = authority.store.writeArtifact(after, "application/json").id;
    } catch (error) {
      throw new RefinementSetupAmbiguousError(
        "Could not durably capture interrupted setup effects; preserving them for recovery",
        { cause: error },
      );
    }
    const recovered = {
      ...active,
      after: afterRef,
      exitCode: passed ? 0 : null,
      outcome: passed ? ("passed" as const) : ("failed" as const),
    };
    state = {
      ...state,
      ...(passed ? { baseline: afterRef } : {}),
      status: passed
        ? "passed"
        : state.attempts.length >= maxSetupExecutions
          ? "failed"
          : "pending",
      attempts: [...state.attempts.slice(0, -1), recovered],
    };
    try {
      writeState(state);
    } catch (error) {
      throw new RefinementSetupAmbiguousError(
        "Could not persist recovered setup outcome; preserving it for recovery",
        { cause: error },
      );
    }
    if (passed) {
      cardLog.event("Recovered completed repository setup; skipping rerun");
      return readBaseline(authority, afterRef, worktreePath, cardId);
    }
  }
  if (state.status === "ambiguous")
    throw new RefinementSetupAmbiguousError(
      "Repository setup outcome is ambiguous; refinement remains blocked",
    );
  if (state.status === "failed")
    throw new RefinementSetupFailedError(
      "Repository setup failed after three bounded executions; setup effects and process evidence are preserved",
    );

  while (state.attempts.length < maxSetupExecutions) {
    signal.throwIfAborted();
    const before = await captureSetupEffects(git, worktreePath, signal);
    const beforeRef = authority.store.writeArtifact(
      before,
      "application/json",
    ).id;
    const attempt: z.infer<typeof setupAttemptSchema> = {
      command,
      worktreePath,
      before: beforeRef,
      outcome: "active",
    };
    state = {
      ...state,
      status: "active",
      attempts: [...state.attempts, attempt],
    };
    writeState(state);
    let result: CommandRunResult | undefined;
    let error: unknown;
    let executionId: string | undefined;
    try {
      result = await runRepositorySetup(commands, {
        cwd: worktreePath,
        command,
        timeoutMilliseconds: project.opencode.timeoutMinutes * 60_000,
        signal,
        sessionLogPath: getSessionLogPath(project.id, cardId),
        sessionLabel: "Refinement repository setup",
        onExecutionStarted: (id) => {
          executionId = id;
          const current = state.attempts.at(-1)!;
          state = {
            ...state,
            attempts: [
              ...state.attempts.slice(0, -1),
              { ...current, executionId: id },
            ],
          };
          writeState(state);
        },
      });
      executionId = result.executionId ?? executionId;
      if (result.exitCode !== 0)
        error = new Error(
          `Repository setup exited with code ${result.exitCode}`,
        );
    } catch (caught) {
      error = caught;
    }
    let afterRef: string;
    let passed: boolean;
    let stopped: boolean;
    try {
      const after = await captureSetupEffects(git, worktreePath, signal, true);
      afterRef = authority.store.writeArtifact(after, "application/json").id;
      const expected =
        executionId === undefined
          ? undefined
          : { executionId, command, cwd: worktreePath };
      const processEvidence = executionId
        ? taskStore.readProcessExecution(cardId, executionId)
        : null;
      passed =
        error === undefined &&
        expected !== undefined &&
        isVerifiedSuccessfulExecution(processEvidence, expected);
      stopped =
        expected !== undefined &&
        isVerifiedStoppedExecution(processEvidence, expected);
    } catch (caught) {
      throw new RefinementSetupAmbiguousError(
        "Repository setup process finished or may have finished, but its after-effects/result evidence could not be durably reconciled; preserving for recovery",
        { cause: caught },
      );
    }
    if (!passed && !stopped) {
      state = {
        ...state,
        status: "ambiguous",
        attempts: [
          ...state.attempts.slice(0, -1),
          {
            ...state.attempts.at(-1)!,
            after: afterRef,
            ...(executionId ? { executionId } : {}),
            ...(result ? { exitCode: result.exitCode } : {}),
            outcome: "ambiguous",
          },
        ],
      };
      try {
        writeState(state);
      } catch (caught) {
        throw new RefinementSetupAmbiguousError(
          "Repository setup outcome is known but its durable state could not be recorded; preserving for recovery",
          { cause: caught },
        );
      }
      throw new RefinementSetupAmbiguousError(
        "Repository setup process outcome is ambiguous; refinement was not started",
        { cause: error },
      );
    }
    const outcome = passed ? "passed" : "failed";
    state = {
      ...state,
      ...(passed ? { baseline: afterRef } : {}),
      status: passed
        ? "passed"
        : state.attempts.length >= maxSetupExecutions
          ? "failed"
          : "pending",
      attempts: [
        ...state.attempts.slice(0, -1),
        {
          ...state.attempts.at(-1)!,
          after: afterRef,
          ...(executionId ? { executionId } : {}),
          ...(result ? { exitCode: result.exitCode } : {}),
          outcome,
        },
      ],
    };
    try {
      writeState(state);
    } catch (caught) {
      throw new RefinementSetupAmbiguousError(
        "Repository setup outcome is known but its durable state could not be recorded; preserving for recovery",
        { cause: caught },
      );
    }
    if (passed) {
      cardLog.event("Repository setup completed before refinement");
      return readBaseline(authority, afterRef, worktreePath, cardId);
    }
    cardLog.warn(
      `Repository setup attempt ${state.attempts.length}/${maxSetupExecutions} failed; preserving its worktree effects`,
    );
  }
  throw new RefinementSetupFailedError(
    "Repository setup failed after three bounded executions; setup effects and process evidence are preserved",
  );
}
