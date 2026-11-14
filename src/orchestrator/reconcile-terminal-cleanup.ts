import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectConfig } from "../config/config.js";
import type { ProjectOwnershipLease } from "../coordination/project-ownership.js";
import type { GitClient } from "../git/git-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { TrelloClient } from "../trello/trello-client.js";
import { logger } from "../logging/logger.js";
import { parseRunRecord, type RunRecord } from "../task-session/run-record.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  terminalPrFenceFromRun,
  terminalStopProofValid,
} from "../task-session/terminal-pr-fence.js";
import {
  cleanupRetryLimit,
  terminalCleanupSchema,
  terminalCleanupKey,
} from "../task-session/terminal-cleanup-state.js";
import {
  cleanupTerminalResources,
  preserveTerminalResources,
} from "./cleanup-terminal-resources.js";
import { reconcileWorkflowMutations } from "./reconcile-workflow-mutations.js";

/** One due attempt per idle poll, three attempts total, durable restart pacing. */
export async function reconcileTerminalCleanup(options: {
  project: ProjectConfig;
  pinned: RunRecord["pinned"];
  projectLease: ProjectOwnershipLease;
  git: GitClient;
  github: GitHubClient;
  trello: TrelloClient;
  signal: AbortSignal;
  now?: Date;
}): Promise<void> {
  const { project, pinned, projectLease, git, github, trello, signal } = options;
  if (signal.aborted) return;
  projectLease.assertHeld();
  const directory = path.join(pinned.storageRoot, "attempts");
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe cleanup attempt inventory");
  const now = options.now ?? new Date();
  const candidates: RunRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = parseRunRecord(
      JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")),
    );
    if (entry.name !== `${record.attemptId}.json`)
      throw new Error("Cleanup attempt filename identity mismatch");
    if (
      record.projectId !== project.id ||
      !["done", "cancelled"].includes(record.lifecycle) ||
      record.terminalSync !== "verified" ||
      !["merged", "closed-unmerged"].includes(record.publicationState)
    )
      continue;
    if (!isDeepStrictEqual(record.pinned, pinned)) continue;
    const fence = terminalPrFenceFromRun(record);
    if (!fence || fence.preserveArtifacts || !fence.stoppedAt || !fence.proofArtifact) continue;
    const raw = record.compatibility[terminalCleanupKey];
    const state = raw === undefined ? null : terminalCleanupSchema.parse(raw);
    if (
      state &&
      (state.status === "removed" ||
        state.reason === "interrupted-work" ||
        (state.attempts >= cleanupRetryLimit && state.status !== "pending") ||
        (state.retryAt && Date.parse(state.retryAt) > now.getTime()))
    )
      continue;
    candidates.push(record);
  }
  const record = candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (!record || signal.aborted) return;
  const authority = ProjectRunAuthority.resumeTerminalCleanup({
    projectId: project.id,
    attemptId: record.attemptId,
    pinned,
    projectLease,
  });
  await authority.run(async () => {
    if (!terminalStopProofValid(authority)) {
      preserveTerminalResources(project.id);
      return;
    }
    if (await reconcileWorkflowMutations({ project, trello, github, git })) return;
    const fence = terminalPrFenceFromRun(authority.store.read()!)!;
    try {
      await cleanupTerminalResources({
        project,
        git,
        cardId: record.cardId,
        headSha: fence.headSha,
        signal,
        now,
        ...(fence.state === "CLOSED"
          ? {
              verifyHistory: async () => {
                const commits = await github.getPullRequestCommitShas({
                  cwd: project.repository.path,
                  repository: project.repository.github,
                  pullRequestNumber: Number(new URL(fence.url).pathname.split("/").at(-1)),
                  project,
                });
                if (commits.at(-1) !== fence.headSha)
                  throw new Error("Closed PR history does not preserve the implementation");
              },
            }
          : {}),
      });
    } catch {
      logger
        .child({ projectId: project.id, cardId: record.cardId })
        .warn(
          "Terminal resource cleanup remains preserved; inspect terminal-resource-cleanup in the attempt record",
        );
    }
  });
}
