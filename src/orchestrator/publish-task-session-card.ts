import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GitClient } from "../git/git-client.js";
import type { ImplementationReviewResult } from "../task-session/implementation-review-result.js";
import {
  decideHumanReviewPublication,
  type VerifiedPublicationDecisionInput,
} from "../task-session/verified-publication-decision.js";
import {
  clearPendingCommitState,
  readPendingCommitState,
  writePendingCommitState,
  writeTrustedCommitState,
} from "./trusted-commit-state.js";
import {
  publishCard,
  prepareInitialPublicationBody,
  type PublishCardOptions,
} from "./publish-card.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  assertSetupInventoryIdentity,
  captureSetupEffects,
} from "../process/run-setup.js";
import { setupFileIdentity } from "../process/setup-commit-scope.js";
import { resolveSetupCommitScope } from "../process/setup-commit-scope.js";
import type { SetupInventory } from "../process/setup-commit-scope.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import {
  beginInitialPublication,
  resumeInitialPublication,
  PublicationWaitingError,
} from "./initial-publication.js";

export interface PublishTaskSessionCardOptions extends Omit<
  PublishCardOptions,
  "commitSha" | "beforePushVerification"
> {
  git: GitClient;
  commitMessage: string;
  initialEvidence: VerifiedPublicationDecisionInput;
  verifyPreparedContent: () => Promise<VerifiedPublicationDecisionInput>;
  exhaustedReview?: ImplementationReviewResult;
}

function assertPublicationEvidence(
  input: VerifiedPublicationDecisionInput,
  exhaustedReview: ImplementationReviewResult | undefined,
  allowStaleExhaustedReview = false,
): void {
  const decision = decideHumanReviewPublication(input, exhaustedReview, {
    allowStaleExhaustedReview,
  });
  if (!decision.allowed) {
    throw new Error(
      `Task-session publication is blocked: ${decision.reasons.join("; ")}`,
    );
  }
}

async function assertScopedPostCommitWorktree(
  options: PublishTaskSessionCardOptions,
): Promise<void> {
  if (options.setupDisposition === undefined) {
    const status = await options.git.getStatus(options.worktreePath);
    if (status.trim())
      throw new Error(`Task-session commit left repository changes: ${status}`);
    return;
  }
  const excluded = options.setupDisposition.exclude;
  const actualPaths = (
    await options.git.getUnstagedChangedPaths(options.worktreePath)
  ).sort();
  if (
    JSON.stringify(actualPaths) !==
    JSON.stringify(excluded.map((entry) => entry.path).sort())
  )
    throw new Error("Task publication worktree contains unexpected changes");
  if (
    (await options.git.getIndexTreeSha(options.worktreePath)) !==
    (await options.git.getCommitTreeSha(options.worktreePath))
  )
    throw new Error("Task publication index differs from committed tree");
  const inventory = JSON.parse(
    (await captureSetupEffects(options.git, options.worktreePath)).toString(
      "utf8",
    ),
  ) as {
    files: {
      path: string;
      kind: string;
      mode: number;
      sha256?: string;
      bytes?: number;
      target?: string;
    }[];
  };
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  for (const entry of excluded) {
    const current = byPath.get(entry.path);
    if (
      (entry.identity === "absent" && current !== undefined) ||
      (entry.identity !== "absent" &&
        (!current || setupFileIdentity(current) !== entry.identity))
    )
      throw new Error(
        `Preserved setup content changed after review: ${entry.path}`,
      );
  }
}

/** Reuse the initial relevance judgment as provenance, never as authorization
 * for the current correction tree. Only its excluded identities remain fenced. */
export async function resolveExistingPrSetupDisposition(
  options: PublishTaskSessionCardOptions,
): Promise<NonNullable<PublishCardOptions["setupDisposition"]> | undefined> {
  if (options.setupDisposition !== undefined) return options.setupDisposition;
  if (options.expectedExistingPullRequestUrl === undefined) return undefined;
  if (
    options.project.repository.setupCommand === undefined &&
    ProjectRunAuthority.current(options.project.id) === undefined
  )
    return undefined;

  const authority = ProjectRunAuthority.current(options.project.id);
  const run = authority?.store.read();
  if (!run || !authority)
    throw new Error(
      "Historical setup scope proof is unavailable; correction publication blocked",
    );
  const task = new TaskExecutionStore(
    run.pinned.storageRoot,
    options.project,
    authority,
  ).read(options.card.id);
  const setupWasConfigured =
    options.project.repository.setupCommand !== undefined ||
    (task?.setup?.command !== undefined && task.setup.command !== null);
  if (!setupWasConfigured) return undefined;
  if (
    task?.setup?.status !== "passed" ||
    task.setup.before === undefined ||
    task.setup.after === undefined ||
    task.setup.relevance === undefined ||
    !/^sha256:[a-f0-9]{64}$/u.test(task.setup.relevance) ||
    !task.setup.history ||
    task.setup.history.length === 0 ||
    task.setup.history.length !== task.setup.attempts ||
    task.setup.history[0]?.before !== task.setup.before ||
    task.setup.history.at(-1)?.before !==
      (task.setup.attemptBefore ?? task.setup.before) ||
    task.setup.history.at(-1)?.after !== task.setup.after ||
    task.setup.history.at(-1)?.outcome !== "passed"
  )
    throw new Error(
      "Historical setup scope proof is missing or unverifiable; correction publication blocked",
    );
  const store = new TaskExecutionStore(
    run.pinned.storageRoot,
    options.project,
    authority,
  );
  const artifact = store.readPrimaryResultArtifact(
    task.setup.relevance,
  ) as Record<string, unknown>;
  if (
    artifact.version !== 1 ||
    artifact.before !== task.setup.before ||
    artifact.after !== task.setup.after ||
    typeof artifact.verdict !== "object" ||
    artifact.verdict === null ||
    typeof artifact.current !== "object" ||
    artifact.current === null
  )
    throw new Error(
      "Historical setup scope artifact is malformed; correction publication blocked",
    );
  const before = store.readPrimaryResultArtifact(task.setup.before);
  const attemptBefore = store.readPrimaryResultArtifact(
    task.setup.attemptBefore ?? task.setup.before,
  );
  const after = store.readPrimaryResultArtifact(task.setup.after);
  assertSetupInventoryIdentity(before, options.worktreePath, options.branch);
  assertSetupInventoryIdentity(
    attemptBefore,
    options.worktreePath,
    options.branch,
  );
  assertSetupInventoryIdentity(after, options.worktreePath, options.branch);
  assertSetupInventoryIdentity(
    artifact.current,
    options.worktreePath,
    options.branch,
  );
  const scope = resolveSetupCommitScope(
    before as SetupInventory,
    after as SetupInventory,
    artifact.current as SetupInventory,
    artifact.verdict,
  );
  if (
    JSON.stringify(scope) !== JSON.stringify(artifact.scope) ||
    task.setup.history[0]?.before !== task.setup.before ||
    task.setup.history.at(-1)?.after !== task.setup.after ||
    task.setup.history.at(-1)?.outcome !== "passed"
  )
    throw new Error(
      "Historical setup scope proof does not match task provenance; correction publication blocked",
    );

  const current = JSON.parse(
    (await captureSetupEffects(options.git, options.worktreePath)).toString(
      "utf8",
    ),
  ) as SetupInventory;
  assertSetupInventoryIdentity(current, options.worktreePath, options.branch);
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  for (const entry of scope.exclude) {
    const actual = currentByPath.get(entry.path);
    if (
      (entry.identity === "absent" && actual !== undefined) ||
      (entry.identity !== "absent" &&
        (!actual || setupFileIdentity(actual) !== entry.identity))
    )
      throw new Error(
        `Excluded setup output changed since initial publication: ${entry.path}; correction scope judgment required`,
      );
  }
  return {
    version: 1,
    artifactReference: task.setup.relevance,
    contextDigest: scope.contextDigest,
    exclude: scope.exclude,
  };
}

/** Commit one verified task snapshot, then reuse the established safe publication path. */
export async function publishTaskSessionCard(
  options: PublishTaskSessionCardOptions,
): Promise<string> {
  const setupDisposition = await resolveExistingPrSetupDisposition(options);
  const scopedOptions: PublishTaskSessionCardOptions = {
    ...options,
    ...(setupDisposition === undefined ? {} : { setupDisposition }),
  };
  if (
    options.project.repository.setupCommand !== undefined &&
    setupDisposition === undefined
  )
    throw new Error(
      "Setup commit disposition is unavailable; initial task publication blocked",
    );
  if (
    ProjectRunAuthority.current(options.project.id) &&
    (await resumeInitialPublication(options))
  )
    throw new PublicationWaitingError();
  assertPublicationEvidence(options.initialEvidence, options.exhaustedReview);
  if (
    options.expectedExistingPullRequestUrl === undefined &&
    ProjectRunAuthority.isProjectLeaseScoped(options.project.id) &&
    !ProjectRunAuthority.current(options.project.id)
  )
    throw new Error(
      "Lease-scoped initial publication requires durable attempt authority",
    );
  if (
    options.expectedExistingPullRequestUrl === undefined &&
    ProjectRunAuthority.current(options.project.id)
  ) {
    const preparedEvidence = await options.verifyPreparedContent();
    assertPublicationEvidence(preparedEvidence, options.exhaustedReview);
    beginInitialPublication(
      options,
      await prepareInitialPublicationBody(options, false),
      preparedEvidence.currentContentIdentity,
    );
    await resumeInitialPublication(options);
    throw new PublicationWaitingError();
  }
  const headBefore = await options.git.getHeadSha(options.worktreePath);
  if (readPendingCommitState(options.project, options.card.id) !== null)
    throw new Error("Unresolved pending task commit intent requires recovery");
  writePendingCommitState(options.project, options.card.id, {
    version: 1,
    kind: "pending-commit",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: options.branch,
    defaultBranch: options.project.repository.defaultBranch,
    parentSha: headBefore,
  });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-task-session-commit-"),
  );
  const messagePath = path.join(temporaryDirectory, "message");
  let commitSha: string;

  try {
    fs.writeFileSync(messagePath, options.commitMessage, {
      encoding: "utf8",
      mode: 0o600,
    });
    await options.git.stageAllExcept(
      options.worktreePath,
      setupDisposition?.exclude.map((file) => file.path) ?? [],
    );
    await options.git.commit(
      options.worktreePath,
      messagePath,
      options.project.repository.gitIdentity,
    );
    commitSha = await options.git.getHeadSha(options.worktreePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  if (commitSha === headBefore) {
    throw new Error("Task-session commit did not advance HEAD");
  }

  const commitCount = await options.git.getCommitCountBetween(
    options.worktreePath,
    headBefore,
    commitSha,
  );
  if (commitCount !== 1) {
    throw new Error(
      `Expected exactly one task-session commit, found ${commitCount}`,
    );
  }
  await assertScopedPostCommitWorktree(scopedOptions);

  writeTrustedCommitState(options.project, options.card.id, {
    version: 1,
    kind: "trusted-commit",
    projectId: options.project.id,
    cardId: options.card.id,
    taskBranch: options.branch,
    defaultBranch: options.project.repository.defaultBranch,
    commitSha,
  });

  clearPendingCommitState(options.project, options.card.id);

  await publishCard({
    ...options,
    commitSha,
    beforePushVerification: async () => {
      await assertScopedPostCommitWorktree(scopedOptions);
      const preparedEvidence = await options.verifyPreparedContent();
      const preparedHead = await options.git.getHeadSha(options.worktreePath);
      await assertScopedPostCommitWorktree(scopedOptions);
      const allowStaleExhaustedReview =
        options.exhaustedReview !== undefined && preparedHead !== commitSha;
      assertPublicationEvidence(
        preparedEvidence,
        options.exhaustedReview,
        allowStaleExhaustedReview,
      );
    },
  });
  return options.git.getHeadSha(options.worktreePath);
}
