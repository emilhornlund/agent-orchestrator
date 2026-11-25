import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { actionableFeedbackResponse } from "./support/feedback-classification-response.js";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, ProjectConfig } from "../src/config/config.js";
import { GitClient, type RunGit } from "../src/git/git-client.js";
import {
  acquireProjectOwnership,
  provisionCoordinationNamespace,
  type ProjectOwnershipLease,
} from "../src/coordination/project-ownership.js";
import { verifyAndPinProjects } from "../src/coordination/project-registry.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { RunRecord } from "../src/task-session/run-record.js";
import { withGitHubOperationProject } from "../src/github/github-operation-context.js";
import type { GitHubClient } from "../src/github/github-client.js";
import { GitHubAppApiError } from "../src/github/github-app-authenticator.js";
import { GitHubCredentialResolutionError } from "../src/github/github-credential-provider.js";
import { FeedbackLedgerStore } from "../src/task-session/feedback-ledger-store.js";
import { OpenCodeClient, type OpenCodeRunOptions } from "../src/opencode/opencode-client.js";
import { CommandRunner, type CommandRunOptions } from "../src/process/command-runner.js";
import { beginProcessEvidence, configureProcessRuntime } from "../src/process/process-runtime.js";
import { inspectPublishedFeedbackRecovery } from "../src/orchestrator/published-feedback-recovery.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import {
  hasDueTaskSessionRecoveryWait,
  runOrchestrator,
} from "../src/orchestrator/run-orchestrator.js";
import { runStartup } from "../src/startup/run-startup.js";
import * as FeedbackClassifier from "../src/task-session/classify-current-feedback.js";
import {
  readActivePrObservationHealth,
  observeActivePullRequest,
  withActivePrObservation,
} from "../src/orchestrator/active-pr-observation.js";
import { beginInitialPublication } from "../src/orchestrator/initial-publication.js";
import { getTaskSessionSourceSnapshotIdentity } from "../src/task-session/source-snapshot.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TaskExecutionRecord } from "../src/task-session/task-execution-record.js";
import { TaskPlanStore } from "../src/task-session/task-plan-store.js";
import { TaskMutationQueue } from "../src/task-session/task-mutation-queue.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";
import { createPublicationFixture } from "./support/initial-publication-fixture.js";
import {
  reconcileManagedPullRequestStatus,
  type ManagedPullRequestStatus,
} from "../src/github/pull-request-status.js";
import { readTerminalPrFence } from "../src/task-session/terminal-pr-fence.js";
import { AiExecutionCapacity } from "../src/orchestrator/ai-execution-capacity.js";
import { notificationAuthorityFixture } from "./support/notification-authority-fixture.js";
import { Logger } from "../src/logging/logger.js";
import { transitionTaskExecutionRecord } from "../src/task-session/task-execution-transition.js";

const execFile = promisify(nodeExecFile);
let roots: string[] = [];
let originalProcessPath: string | undefined;
let originalPrimaryMode: string | undefined;
const leases: ProjectOwnershipLease[] = [];
interface LifecycleScenario {
  publishedReadRecovery?: "ci" | "publication" | "classification";
  credentialRecovery?: "live" | "restart" | "legacy-502";
  preparedValidationFailure?: boolean;
  draft: boolean;
  terminal: "merged" | "closed";
  destination: "done" | "backlog";
  ackLoss: boolean;
  quality: "validation" | "none" | "coverage" | "both";
  terminalReadRaceAt?: number;
  correctionFailure?: boolean;
  feedbackQuality?: "validation" | "unavailable" | "no-op" | "classification-outage";
  legacyClassifierLayout?: "direct" | "process-executions";
  terminalDuringFeedback?: "active" | "unknown" | "capacity" | "push-rejected";
  preparedReview?: "material" | "unavailable";
  ciReviewHandoffs?: boolean;
  ciQuality?: "validation" | "unavailable";
  ciBudget?: number;
  targetMerge?: boolean;
  feedbackReviewRecovery?:
    | "before-review"
    | "active-validation"
    | "reserved"
    | "completed"
    | "validation"
    | "reviewed"
    | "unknown";
  ciReviewRecovery?: "reserved" | "completed" | "validation" | "reviewed" | "unknown";
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalProcessPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalProcessPath;
  originalProcessPath = undefined;
  if (originalPrimaryMode === undefined) delete process.env.PRIMARY_MODE;
  else process.env.PRIMARY_MODE = originalPrimaryMode;
  originalPrimaryMode = undefined;
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("task lifecycle through pollProject", () => {
  it.each<LifecycleScenario>([
    ...(["live", "restart", "legacy-502"] as const).map((credentialRecovery) => ({
      draft: false,
      terminal: "merged" as const,
      destination: "done" as const,
      ackLoss: false,
      quality: "both" as const,
      feedbackQuality: "validation" as const,
      credentialRecovery,
    })),
    ...(["ci", "publication", "classification"] as const).map((publishedReadRecovery) => ({
      draft: false,
      terminal: "merged" as const,
      destination: "done" as const,
      ackLoss: false,
      quality: "both" as const,
      publishedReadRecovery,
    })),
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      preparedValidationFailure: true,
    },
    ...(["merged", "closed"] as const).map((terminal) => ({
      draft: false,
      terminal,
      destination: terminal === "merged" ? ("done" as const) : ("backlog" as const),
      ackLoss: false,
      quality: "both" as const,
      terminalDuringFeedback: "active" as const,
    })),
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      terminalDuringFeedback: "unknown",
    },
    {
      draft: false,
      terminal: "closed",
      destination: "backlog",
      ackLoss: false,
      quality: "both",
      terminalDuringFeedback: "capacity",
    },
    {
      draft: false,
      terminal: "closed",
      destination: "backlog",
      ackLoss: false,
      quality: "both",
      terminalDuringFeedback: "push-rejected",
    },
    ...(["direct", "process-executions"] as const).map((legacyClassifierLayout) => ({
      quality: "both" as const,
      draft: false,
      terminal: "merged" as const,
      destination: "done" as const,
      ackLoss: false,
      feedbackQuality: "classification-outage" as const,
      legacyClassifierLayout,
    })),
    ...(["validation", "unavailable", "no-op", "classification-outage"] as const).map(
      (feedbackQuality) => ({
        draft: false,
        terminal: "merged" as const,
        destination: "done" as const,
        ackLoss: false,
        quality: "both" as const,
        feedbackQuality,
      }),
    ),
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      terminalReadRaceAt: 2,
      correctionFailure: true,
      quality: "validation",
    },
    {
      draft: true,
      terminal: "closed",
      destination: "backlog",
      ackLoss: false,
      terminalReadRaceAt: 3,
      correctionFailure: true,
      quality: "validation",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      terminalReadRaceAt: 3,
      quality: "validation",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: true,
      quality: "validation",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "none",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "coverage",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      preparedReview: "material",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      preparedReview: "unavailable",
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      ciReviewHandoffs: true,
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      ciReviewHandoffs: true,
      ciBudget: 3,
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      quality: "both",
      targetMerge: true,
    },
    ...(["validation", "unavailable"] as const).map((ciQuality) => ({
      draft: false,
      terminal: "merged" as const,
      destination: "done" as const,
      ackLoss: false,
      quality: "both" as const,
      ciReviewHandoffs: true,
      ciQuality,
    })),
    ...(
      [
        "before-review",
        "active-validation",
        "reserved",
        "completed",
        "validation",
        "reviewed",
        "unknown",
      ] as const
    ).map((feedbackReviewRecovery) => ({
      draft: false,
      terminal: "merged" as const,
      destination: "done" as const,
      ackLoss: false,
      quality: "both" as const,
      feedbackReviewRecovery,
    })),
    ...(["reserved", "completed", "validation", "reviewed", "unknown"] as const).map(
      (ciReviewRecovery) => ({
        draft: false,
        terminal: "merged" as const,
        destination: "done" as const,
        ackLoss: false,
        quality: "both" as const,
        ciReviewHandoffs: true,
        ciReviewRecovery,
      }),
    ),
  ] as const)(
    "preserves the owned lifecycle (quality=$quality, draft=$draft, terminal=$terminal, ackLoss=$ackLoss, correctionFailure=$correctionFailure, feedbackQuality=$feedbackQuality, legacyClassifierLayout=$legacyClassifierLayout, terminalDuringFeedback=$terminalDuringFeedback, preparedReview=$preparedReview, ciReviewHandoffs=$ciReviewHandoffs, feedbackReviewRecovery=$feedbackReviewRecovery, ciReviewRecovery=$ciReviewRecovery, ciQuality=$ciQuality, targetMerge=$targetMerge, ciBudget=$ciBudget, preparedValidationFailure=$preparedValidationFailure, publishedReadRecovery=$publishedReadRecovery, credentialRecovery=$credentialRecovery)",
    async ({
      draft,
      terminal,
      destination,
      ackLoss,
      terminalReadRaceAt = 2,
      correctionFailure = false,
      feedbackQuality,
      legacyClassifierLayout,
      terminalDuringFeedback,
      quality,
      preparedReview,
      preparedValidationFailure,
      publishedReadRecovery,
      credentialRecovery,
      ciReviewHandoffs = false,
      feedbackReviewRecovery,
      ciReviewRecovery,
      ciQuality,
      targetMerge,
      ciBudget,
    }) => {
      const progress = vi.spyOn(Logger.prototype, "event");
      // Restore the inherited environment even in scenarios without a scripted child.
      originalProcessPath = process.env.PATH;
      originalPrimaryMode = process.env.PRIMARY_MODE;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-lifecycle-"));
      roots.push(root);
      const home = path.join(root, "home");
      const source = path.join(root, "source");
      const remote = path.join(root, "remote.git");
      const worktrees = path.join(root, "worktrees");
      // CI lifecycle scenarios exercise the same explicit attempt resources as
      // production, rather than the legacy card-only fallback.
      const firstWorktreeName = ciReviewHandoffs ? "first--lifecycle-attempt" : "first";
      const firstBranch = `agent/${firstWorktreeName}`;
      const contextRoot = path.join(root, "context");
      const validationMarker = path.join(root, "validation-runs.log");
      const coverageMarker = path.join(root, "coverage-runs.log");
      fs.mkdirSync(home);
      fs.mkdirSync(worktrees);
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
        GIT_CONFIG_SYSTEM: path.join(home, "missing-system-config"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_TEMPLATE_DIR: path.join(home, "empty-templates"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
        GIT_ATTR_NOSYSTEM: "1",
      };
      fs.mkdirSync(env.GIT_TEMPLATE_DIR);
      const gitCalls: string[][] = [];
      const runGit: RunGit = async (cwd, args, override) => {
        gitCalls.push([...args]);
        const result = await execFile(
          "git",
          [
            ...(["fetch", "push", "ls-remote"].includes(args[0] ?? "")
              ? [
                  "-c",
                  `url.${pathToFileURL(remote).href}.insteadOf=https://github.com/owner/repo.git`,
                ]
              : []),
            ...args,
          ],
          {
            cwd,
            env: { ...env, ...override },
            encoding: "utf8",
            timeout: 20_000,
          },
        );
        return result.stdout.trim();
      };
      let git = new GitClient(runGit);
      let changedPreparedSource = false;
      if (preparedReview !== undefined || preparedValidationFailure) {
        const compareAndSwap = TaskExecutionStore.prototype.compareAndSwap;
        vi.spyOn(TaskExecutionStore.prototype, "compareAndSwap").mockImplementation(function (
          this: TaskExecutionStore,
          cardId,
          revision,
          nextRecord,
        ) {
          const persisted = compareAndSwap.call(this, cardId, revision, nextRecord);
          if (
            !changedPreparedSource &&
            cardId === "first" &&
            nextRecord.lastEvent?.type === "review-passed"
          ) {
            fs.writeFileSync(
              path.join(worktrees, firstWorktreeName, "app.js"),
              "module.exports = 'prepared publication source';\n",
            );
            changedPreparedSource = true;
          }
          return persisted;
        });
      }
      const gitRun = async (cwd: string, ...args: string[]) => runGit(cwd, args);
      await gitRun(root, "init", "--bare", "--initial-branch=main", remote);
      await gitRun(root, "clone", remote, source);
      await gitRun(source, "config", "user.name", "Fixture");
      await gitRun(source, "config", "user.email", "fixture@example.test");
      fs.writeFileSync(path.join(source, "app.js"), "module.exports = 'base';\n");
      await gitRun(source, "add", ".");
      await gitRun(source, "commit", "-m", "initial");
      await gitRun(source, "push", "-u", "origin", "main");
      await gitRun(source, "remote", "set-url", "origin", "https://github.com/owner/repo.git");

      const project: ProjectConfig & { contextRoot: string } = {
        id: "lifecycle-project",
        autoMerge: false,
        contextRoot,
        trello: {
          boardId: "board",
          backlogListId: "backlog",
          readyListId: "ready",
          workingListId: "working",
          reviewListId: "review",
          failedListId: "failed",
          doneListId: "done",
          refinementLabelId: "refinement",
          featureLabelId: "feature",
          improvementLabelId: "improvement",
          bugLabelId: "bug",
        },
        repository: {
          path: source,
          github: "owner/repo",
          defaultBranch: "main",
          worktreeRoot: worktrees,
          ...(quality === "none" || quality === "coverage"
            ? {}
            : {
                validationCommand: `${process.execPath} -e 'require("fs").appendFileSync(${JSON.stringify(validationMarker)}, "validation\\n"); if (process.env.FAIL_VALIDATION === "1") process.exit(1);'`,
              }),
          ...(quality === "coverage" || quality === "both"
            ? {
                coverageCommand: `${process.execPath} -e 'require("fs").appendFileSync(${JSON.stringify(coverageMarker)}, "coverage\\n")'`,
              }
            : {}),
          gitIdentity: { name: "Agent", email: "agent@example.test" },
        },
        opencode: {
          refinement: { model: "refine", variant: "high" },
          implementation: { model: "implement", variant: "high" },
          review: { model: "review", variant: "high" },
          remediation: {
            model: "repair",
            variant: "high",
            maxPasses: 1,
            ...(feedbackQuality === "validation" ? { validationMaxPasses: 0 } : {}),
          },
          commit: { model: "commit", variant: "low" },
          timeoutMinutes: 1,
        },
      };
      if (ciReviewHandoffs) project.opencode.remediation.maxPasses = 2;
      if (ciBudget !== undefined) project.opencode.remediation.ciMaxPasses = ciBudget;
      const coordinationRoot = path.join(root, "coordination");
      fs.mkdirSync(coordinationRoot);
      provisionCoordinationNamespace(coordinationRoot, "lifecycle-test");
      const orchestrationConfig = {
        projects: [project],
        workflow: {
          contextRoot,
          coordinationRoot,
          coordinationNamespaceId: "lifecycle-test",
          pollIntervalSeconds: 1,
          logRetentionDays: 30,
          contextRetentionDays: 30,
        },
      } as Config;
      const lease = await acquireProjectOwnership(
        coordinationRoot,
        {
          trelloBoardId: project.trello.boardId,
          githubRepository: project.repository.github,
        },
        "lifecycle-test",
      );
      leases.push(lease);
      const hostPin = (await verifyAndPinProjects(orchestrationConfig, [lease]))[0]!;
      const pinned: RunRecord["pinned"] = {
        integrationId: hostPin.integrationId,
        projectId: project.id,
        boardId: project.trello.boardId,
        lists: {
          ready: project.trello.readyListId,
          working: project.trello.workingListId,
          review: project.trello.reviewListId,
          failed: project.trello.failedListId,
          done: project.trello.doneListId,
          backlog: project.trello.backlogListId,
        },
        repository: hostPin.repository.github,
        repositoryPath: hostPin.repository.path,
        worktreeRoot: hostPin.repository.worktreeRoot,
        storageRoot: hostPin.storageRoot,
      };
      fs.writeFileSync(
        path.join(source, "validate.js"),
        `require('fs').appendFileSync(${JSON.stringify(validationMarker)}, 'validation\\n'); if (process.env.FAIL_VALIDATION === '1') process.exit(1);\n`,
      );
      await gitRun(source, "add", "validate.js");
      await gitRun(source, "commit", "-m", "add validation script");
      await gitRun(source, "push", "origin", "main");
      const initialHead = await git.getHeadSha(source);
      const initialBranch = await git.getCurrentBranch(source);
      const initialStatus = await git.getStatus(source);
      const initialIndex = await git.getIndexEntries(source);
      const initialTracked = await git.getHeadTrackedFiles(source);
      const initialHashes = new Map(
        initialTracked.map((file) => [
          file,
          createHash("sha256")
            .update(fs.readFileSync(path.join(source, file)))
            .digest("hex"),
        ]),
      );
      const cards: TrelloCard[] = ["first", "next"].map((id) => ({
        id,
        name: `Implement ${id}`,
        desc: "Implement the requested change",
        idList: "ready",
        idLabels: ["feature"],
        url: `https://trello.test/${id}`,
      }));
      const lists = new Map(cards.map(({ id }) => [id, "ready"]));
      const ledger: Array<{
        service: string;
        action: string;
        actor: string;
        id?: string;
        detail?: string | undefined;
      }> = [];
      let trapNextClaim = false;
      let blockTerminalDestinationRead = false;
      let ciAttachmentVersion = 0;
      const trello = {
        getCards: async (listId: string) => {
          if (
            blockTerminalDestinationRead &&
            listId === destination &&
            lists.get("first") === destination
          ) {
            ledger.push({
              service: "trello",
              action: `read-cards:${listId}:unavailable`,
              actor: "orchestrator",
              id: "first",
            });
            throw new Error("simulated terminal Trello destination read outage");
          }
          return cards
            .filter((card) => lists.get(card.id) === listId)
            .map((card) => {
              ledger.push({
                service: "trello",
                action: `read-cards:${listId}`,
                actor: "orchestrator",
                id: card.id,
              });
              return { ...card, idList: listId };
            });
        },
        getCard: async (id: string) => {
          const card = cards.find((candidate) => candidate.id === id);
          if (!card) throw new Error(`unexpected card ${id}`);
          ledger.push({
            service: "trello",
            action: "read-card",
            actor: "orchestrator",
            id,
            detail: lists.get(id),
          });
          return { ...card, idList: lists.get(id)! };
        },
        moveCard: async (id: string, listId: string) => {
          if (!lists.has(id)) throw new Error(`unexpected card ${id}`);
          lists.set(id, listId);
          ledger.push({
            service: "trello",
            action: `move:${listId}`,
            actor: "orchestrator",
            id,
          });
          if (trapNextClaim && id === "next" && listId === "working")
            throw new Error("observed next claim boundary");
          if (
            correctionFeedback &&
            id === "first" &&
            listId === "working" &&
            loseFeedbackWorkingAck
          ) {
            loseFeedbackWorkingAck = false;
            throw new Error("lost feedback Working acknowledgment");
          }
          return { ...cards.find((card) => card.id === id)!, idList: listId };
        },
        addComment: async (id: string, comment: string) => {
          ledger.push({
            service: "trello",
            action: "comment",
            actor: "orchestrator",
            id,
            detail: comment,
          });
        },
        getCardComments: async (id: string) =>
          ledger
            .filter(
              (entry) =>
                entry.service === "trello" && entry.action === "comment" && entry.id === id,
            )
            .map((entry, index) => ({
              id: `comment-${index}`,
              text: entry.detail!,
            })),
        getCardAttachments: async () =>
          ciAttachmentVersion === 0
            ? []
            : [
                {
                  id: "current-ci-context",
                  name: "Current CI evidence",
                  mimeType: null,
                  bytes: null,
                  isUpload: false,
                  url: `https://context.test/revision-${ciAttachmentVersion}`,
                },
              ],
      } as unknown as TrelloClient;
      type PullRequestFixture = {
        number: number;
        url: string;
        state: "OPEN" | "MERGED" | "CLOSED";
        headRefOid: string;
        isDraft: boolean;
        reviewDecision: string;
        headBranch: string;
        title: string;
        body: string;
      };
      const prs = new Map<string, PullRequestFixture>();
      const requests: string[] = [];
      const accepted: string[] = [];
      const publicationQualityAtCreate: unknown[] = [];
      const authorities = new Map<string, ProjectRunAuthority>();
      let ciPrimaryCorrections = 0;
      const ciReviewRepairOperationIds: string[] = [];
      const ciReviewRepairDispatches: {
        operationId: string;
        prompt: string;
        sessionId: string | undefined;
      }[] = [];
      let loseCreateAcknowledgement = false;
      let feedbackReads = 0;
      let correctionFeedback = false;
      let loseFeedbackWorkingAck = feedbackQuality === "validation";
      let feedbackBody = "Please handle the empty result.";
      let feedbackPrimaryCorrections = 0;
      let feedbackClassifications = 0;
      let classifierUnavailable = feedbackQuality === "classification-outage";
      const feedbackReplyBodies: string[] = [];
      const feedbackReviewDispatches: {
        operationId: string;
        prompt: string;
        sessionId: string | undefined;
      }[] = [];
      let reviewerRounds = 0;
      let terminalRaceTarget: "MERGED" | "CLOSED" | null = null;
      let terminalRaceReads = 0;
      let terminalRaceReadAt = 2;
      let maintenanceBase: string | undefined;
      let github = {
        getPullRequestCommitShas: async ({ pullRequestNumber }: { pullRequestNumber: number }) => {
          const pr = [...prs.values()].find((entry) => entry.number === pullRequestNumber)!;
          const head =
            (await git.getRemoteBranchSha(source, "origin", "agent/card", project)) ??
            pr.headRefOid;
          return (
            await execFile("git", ["rev-list", "--reverse", head!], {
              cwd: remote,
            })
          ).stdout
            .trim()
            .split("\n");
        },
        getBaseBranchHeadSha: async () =>
          (await git.getRemoteBranchSha(source, "origin", "main", project))!,
        comparePullRequestHeadToBase: async ({ headSha }: { headSha: string }) =>
          !maintenanceBase || (await git.isAncestor(remote, maintenanceBase, headSha))
            ? ("current" as const)
            : ("diverged" as const),
        findPullRequest: async (input: { headBranch: string }) => {
          const pr = prs.get(input.headBranch);
          return pr ? { number: pr.number, url: pr.url } : null;
        },
        findPullRequestState: async (input: { headBranch: string }) => {
          const pr = prs.get(input.headBranch);
          if (terminalRaceTarget !== null && pr?.state === "OPEN") {
            terminalRaceReads += 1;
            if (terminalRaceReads === terminalRaceReadAt) pr.state = terminalRaceTarget;
          }
          ledger.push({
            service: "github",
            action: "read:pr-state",
            actor: "orchestrator",
            id: input.headBranch,
            detail: pr?.state,
          });
          if (!pr) return null;
          const remoteHead = await git.getRemoteBranchSha(
            source,
            "origin",
            input.headBranch,
            project,
          );
          return {
            ...pr,
            headRefOid: remoteHead ?? pr.headRefOid ?? undefined,
            mergedAt: pr.state === "MERGED" ? "now" : null,
            baseRefName: "main",
            headRefName: input.headBranch,
            headRepository: { name: "repo" },
            headRepositoryOwner: { login: "owner" },
          };
        },
        getPullRequestStateByNumber: async ({
          pullRequestNumber,
        }: {
          pullRequestNumber: number;
        }) => {
          const pr = [...prs.values()].find((item) => item.number === pullRequestNumber);
          if (!pr) throw new Error("Numbered test PR is unavailable");
          return github.findPullRequestState({
            cwd: source,
            repository: project.repository.github,
            headBranch: pr.headBranch,
            baseBranch: "main",
            project,
          });
        },
        ensurePullRequestDraft: async (input: { pullRequestUrl: string }) => {
          const pr = [...prs.values()].find(({ url }) => url === input.pullRequestUrl);
          if (pr) pr.isDraft = true;
        },
        getPullRequestPublicationFields: async (input: { pullRequestUrl: string }) => {
          const pr = [...prs.values()].find((candidate) => candidate.url === input.pullRequestUrl);
          if (!pr) throw new Error("PR not found");
          return { title: pr.title, body: pr.body, isDraft: pr.isDraft };
        },
        getPullRequestDescription: async (input: { pullRequestUrl: string }) => {
          const pr = [...prs.values()].find((candidate) => candidate.url === input.pullRequestUrl);
          if (!pr) throw new Error("PR not found");
          return pr.body;
        },
        editPullRequestDescription: async (input: { pullRequestUrl: string; body: string }) => {
          const pr = [...prs.values()].find((candidate) => candidate.url === input.pullRequestUrl);
          if (!pr) throw new Error("PR not found");
          pr.body = input.body;
        },
        updatePullRequestDescriptionStatus: async (input: {
          pullRequestUrl: string;
          status: ManagedPullRequestStatus | null;
        }) => {
          const pr = [...prs.values()].find((candidate) => candidate.url === input.pullRequestUrl);
          if (!pr) throw new Error("PR not found");
          const next = reconcileManagedPullRequestStatus(pr.body, input.status, "main");
          const changed = next !== pr.body;
          pr.body = next;
          return changed;
        },
        createPullRequest: async (input: {
          headBranch: string;
          draft?: boolean;
          title: string;
          body: string;
        }) => {
          if (input.headBranch === firstBranch)
            publicationQualityAtCreate.push(
              new TaskExecutionStore(contextRoot, project, authorities.get("first")).read("first")
                ?.publicationQuality,
            );
          requests.push(input.headBranch);
          ledger.push({
            service: "github",
            action: "request:create-pr",
            actor: "orchestrator",
            detail: input.headBranch,
          });
          if (prs.has(input.headBranch)) throw new Error("duplicate pull request for branch");
          const sha = await git.getRemoteBranchSha(source, "origin", input.headBranch, project);
          if (!sha) throw new Error(`missing pushed remote head for ${input.headBranch}`);
          const number = prs.size + 41;
          const url = `https://github.com/owner/repo/pull/${number}`;
          const pr: PullRequestFixture = {
            number,
            url,
            state: "OPEN",
            headRefOid: sha,
            isDraft: input.draft === true,
            reviewDecision: "REVIEW_REQUIRED",
            headBranch: input.headBranch,
            title: input.title,
            body: input.body,
          };
          prs.set(input.headBranch, pr);
          await execFile(
            "git",
            ["--git-dir", remote, "update-ref", `refs/pull/${number}/head`, sha],
            { env },
          );
          accepted.push(url);
          ledger.push({
            service: "github",
            action: "accept:create-pr",
            actor: "github",
            id: String(number),
            detail: sha,
          });
          if (loseCreateAcknowledgement) {
            loseCreateAcknowledgement = false;
            throw new Error("simulated lost create-PR acknowledgement after acceptance");
          }
          return { number, url };
        },
        getCiObservations: async ({ headSha }: { headSha: string }) => {
          const currentPhase = new TaskExecutionStore(
            contextRoot,
            project,
            authorities.get("first"),
          ).read("first")?.phase;
          const failed =
            ciReviewHandoffs &&
            prs.has(firstBranch) &&
            (currentPhase === "ci" || currentPhase === "human-feedback") &&
            ciPrimaryCorrections < (ciBudget ?? 2);
          return {
            headSha,
            checks: [
              {
                source: "check-run" as const,
                id: 1,
                name: "Build",
                headSha,
                status: "completed" as const,
                conclusion: failed ? ("failure" as const) : ("success" as const),
                url: null,
              },
            ],
            expectationSources: [
              {
                kind: "repository-rules" as const,
                sourceId: "fixture",
                complete: true,
                checkNames: ["Build"],
              },
            ],
          };
        },
        getCiCheckRunDiagnostics: async ({
          headSha,
          checks,
        }: {
          headSha: string;
          checks: readonly { name: string; id: number }[];
        }) =>
          checks.map((check) => ({
            name: check.name,
            headSha,
            checkRunId: check.id,
            logUrl: null,
            available: true,
            diagnostic: "The fixture CI check failed.",
          })),
        findChangesRequestedPullRequest: async (input: { headBranch: string }) => {
          if (!correctionFeedback) return null;
          const pr = prs.get(input.headBranch);
          if (!pr) return null;
          const headSha = credentialRecovery
            ? ((await git.getRemoteBranchSha(source, "origin", input.headBranch, project)) ??
              pr.headRefOid)
            : pr.headRefOid;
          return {
            url: pr.url,
            headSha,
            feedback: {
              reviews: [
                {
                  id: 202,
                  commitSha: pr.headRefOid,
                  body: feedbackQuality === "classification-outage" ? null : feedbackBody,
                  author: "reviewer",
                  submittedAt: "2026-11-01T09:00:00.000Z",
                  inlineComments:
                    feedbackQuality === "classification-outage"
                      ? [
                          {
                            id: 203,
                            body: feedbackBody,
                            author: "reviewer",
                            path: "app.js",
                            line: 1,
                            threadId: "thread-203",
                            isResolved: false,
                            isOutdated: false,
                          },
                          {
                            id: 204,
                            body: "Please preserve the original behavior on success.",
                            author: "reviewer",
                            path: "app.js",
                            line: 1,
                            threadId: "thread-204",
                            isResolved: false,
                            isOutdated: false,
                          },
                        ]
                      : [],
                },
              ],
            },
          };
        },
        getPullRequestConversationComments: async () => {
          feedbackReads += 1;
          return feedbackReplyBodies.map((body, index) => ({
            id: 900 + index,
            author: "automation[bot]",
            authorIsBot: true,
            body,
            createdAt: "2026-11-01T10:00:00.000Z",
            updatedAt: null,
          }));
        },
        replyToConversationComment: async (input: { body: string }) => {
          const id = String(900 + feedbackReplyBodies.length);
          feedbackReplyBodies.push(input.body);
          return { id };
        },
        mergePullRequest: async (input: { pullRequestUrl?: string }) => {
          ledger.push({
            service: "github",
            action: "attempt:merge-pr",
            actor: "orchestrator",
            detail: input.pullRequestUrl,
          });
          throw new Error("forbidden merge adapter invoked");
        },
      } as unknown as GitHubClient;
      const sessionId = "ses_p1_primary";
      const openCodeCards: string[] = [];
      const realRunner = new OpenCodeClient();
      const originalPath = process.env.PATH;
      if (correctionFailure || terminalDuringFeedback === "active") {
        originalProcessPath = originalPath;
        const runnerDirectory = path.join(root, "scripted-bin");
        fs.mkdirSync(runnerDirectory);
        fs.copyFileSync(
          path.join(
            process.cwd(),
            terminalDuringFeedback === "active"
              ? "tests/fixtures/scripted-opencode-review-writer.mjs"
              : "tests/fixtures/scripted-opencode-primary-outage.mjs",
          ),
          path.join(runnerDirectory, "opencode"),
        );
        const runnerFile = path.join(runnerDirectory, "opencode");
        fs.writeFileSync(
          runnerFile,
          fs
            .readFileSync(runnerFile, "utf8")
            .replace(
              'fs.readFileSync(path.join(cwd, "primary-mode"), "utf8")',
              'process.env.PRIMARY_MODE ?? "crash"',
            ),
        );
        fs.chmodSync(path.join(runnerDirectory, "opencode"), 0o755);
        process.env.PATH = `${runnerDirectory}${path.delimiter}${originalPath ?? "/usr/bin:/bin"}`;
        originalPrimaryMode = process.env.PRIMARY_MODE;
        process.env.PRIMARY_MODE = "crash";
        configureProcessRuntime({
          runtimeRoot: path.join(contextRoot, "process-evidence"),
          signal: new AbortController().signal,
        });
      }
      const openCode = new OpenCodeClient(async (options: OpenCodeRunOptions) => {
        if (options.sessionLabel === "Human feedback classification") {
          feedbackClassifications++;
          if (classifierUnavailable)
            return {
              exitCode: 1,
              output: "",
              errorOutput: "",
              failureClassification: "dependency-outage",
            };
          return {
            exitCode: 0,
            output: actionableFeedbackResponse(options.prompt),
            errorOutput: "",
          };
        }
        const cardId = path.basename(options.cwd).split("--")[0]!;
        openCodeCards.push(cardId);
        if (
          ciQuality === "validation" &&
          options.prompt.startsWith("Repair the failing local quality gate")
        ) {
          expect(options.prompt).toContain(
            `https://context.test/revision-${10 + ciPrimaryCorrections}`,
          );
          return {
            exitCode: 0,
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            output: "No useful local correction",
            errorOutput: "",
          };
        }
        if (
          targetMerge &&
          options.prompt.startsWith(
            "Independently review the prepared implementation after target synchronization",
          )
        ) {
          expect(options.readOnly).toBe(true);
          expect(prs.get(firstBranch)?.body).toMatch(/^<!-- agent-orchestrator-status:start -->/u);
          expect(prs.get(firstBranch)?.body).toContain("advisory validation");
          prs.get(firstBranch)!.body += "\nHuman note added during maintenance review.\n";
          return {
            exitCode: 0,
            errorOutput: "",
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId,
              reviewedContentIdentity: await getTaskSessionSourceSnapshotIdentity(git, options.cwd),
              verdict: "pass",
              blockingFindings: [],
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "satisfied",
                  details: "Task preserved after target merge",
                  evidence: ["app.js"],
                },
              ],
            }),
          };
        }
        if (
          (feedbackReviewRecovery !== undefined ||
            feedbackQuality !== undefined ||
            terminalDuringFeedback !== undefined) &&
          correctionFeedback
        ) {
          if (
            options.prompt.startsWith(
              "Address the following verified-as-actionable human PR feedback",
            )
          ) {
            feedbackPrimaryCorrections += 1;
            if (terminalDuringFeedback === "active") return realRunner.run(options);
            if (terminalDuringFeedback === "unknown")
              throw new Error(
                "Primary supervisor outcome is unknown and no process identity is available",
              );
            expect(lists.get("first")).toBe("working");
            expect(
              prs.get(firstBranch)?.body.startsWith("<!-- agent-orchestrator-status:start -->"),
            ).toBe(true);
            expect(prs.get(firstBranch)?.body).toContain("addressing requested review feedback");
            if (feedbackQuality === "no-op")
              return { exitCode: 0, output: "No changes", errorOutput: "" };
            fs.writeFileSync(
              path.join(options.cwd, "app.js"),
              "module.exports = 'feedback correction';\n",
            );
            return {
              exitCode: 0,
              output: "Feedback correction applied",
              errorOutput: "",
            };
          }
          if (options.prompt.startsWith("Address the independent implementation review findings")) {
            const task = new TaskExecutionStore(contextRoot, project, authorities.get(cardId)).read(
              cardId,
            );
            const reservation = task?.reviewRepair?.activePrimaryOperation;
            if (reservation === undefined)
              throw new Error("Feedback review writer lacks a reservation");
            feedbackReviewDispatches.push({
              operationId: reservation.operationId,
              prompt: options.prompt,
              sessionId: options.sessionId,
            });
            if (feedbackReviewRecovery === "unknown")
              throw new Error("Feedback review process outcome is unknown");
            fs.writeFileSync(
              path.join(options.cwd, "app.js"),
              "module.exports = 'reviewed feedback correction';\n",
            );
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                findingDispositions: [],
                requirementDispositions: [],
              }),
              errorOutput: "",
            };
          }
          if (
            options.readOnly &&
            options.prompt.includes("Independently review the implementation")
          ) {
            if (feedbackQuality === "unavailable")
              return {
                exitCode: 1,
                output: "",
                errorOutput: "Provider unavailable",
                failureClassification: "dependency-outage" as const,
              };
            const identity = options.prompt.match(
              /Reviewed source content identity: (sha256:[0-9a-f]{64})/u,
            )?.[1];
            if (identity === undefined) throw new Error("Feedback review omitted source identity");
            const repaired = feedbackQuality !== undefined || feedbackReviewDispatches.length > 0;
            const task = new TaskExecutionStore(contextRoot, project, authorities.get(cardId)).read(
              cardId,
            );
            const prior = task?.reviewRepair?.findings ?? [];
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                projectId: project.id,
                cardId,
                verdict: repaired ? "pass" : "fail",
                requirementAssessments: [
                  {
                    requirementId: "REQ-1",
                    status: repaired ? "satisfied" : "unsatisfied",
                    details: "Feedback correction review",
                    evidence: repaired ? ["app.js"] : [],
                  },
                ],
                blockingFindings: repaired
                  ? []
                  : [
                      {
                        kind: "defect",
                        summary: "Feedback correction needs review remediation",
                        detail: "The empty-result behavior needs the final correction.",
                      },
                    ],
                previousFindingAssessments: prior.map(({ id }) => ({
                  findingId: id,
                  status: "resolved",
                })),
                reviewedContentIdentity: identity,
              }),
              errorOutput: "",
            };
          }
        }
        if (
          ciReviewHandoffs &&
          options.readOnly &&
          options.prompt.includes("Independently review the implementation")
        ) {
          const identity = options.prompt.match(
            /Reviewed source content identity: (sha256:[0-9a-f]{64})/u,
          )?.[1];
          if (identity === undefined) throw new Error("CI review prompt omitted source identity");
          if (ciQuality === "unavailable")
            return {
              exitCode: 1,
              output: "",
              errorOutput: "Provider unavailable",
            };
          const record = new TaskExecutionStore(contextRoot, project, authorities.get(cardId)).read(
            cardId,
          );
          const ciPass = record?.ciRepair?.activePrimaryOperation?.pass ?? 0;
          ciAttachmentVersion = ciPass;
          const reviewRepairCount = record?.retryCounters.review ?? 0;
          const verdict = ciPass === 0 || reviewRepairCount >= ciPass ? "pass" : "fail";
          const includesPriorFindings = !options.prompt.includes(
            "Previously reported blocking findings in this review cycle (empty on the first review):\n[]",
          );
          const trackedFindings = includesPriorFindings
            ? (record?.reviewRepair?.findings ?? [])
            : [];
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId,
              verdict,
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: verdict === "pass" ? "satisfied" : "unsatisfied",
                  details:
                    verdict === "pass"
                      ? "The current CI-corrected source meets the task."
                      : "CI correction exposed a review finding to remediate.",
                  evidence: verdict === "pass" ? ["app.js"] : [],
                },
              ],
              blockingFindings:
                verdict === "pass"
                  ? []
                  : [
                      ...trackedFindings
                        .filter(({ status }) => status === "unresolved")
                        .map(({ id, kind, summary, detail }) => ({
                          id,
                          kind,
                          summary,
                          detail,
                        })),
                      {
                        kind: "defect",
                        summary: `CI correction ${ciPass} requires review remediation`,
                        detail: "The correction left a demonstrable behavior gap in app.js.",
                      },
                    ],
              previousFindingAssessments: trackedFindings.map(({ id, status }) => ({
                findingId: id,
                status: verdict === "pass" || status !== "unresolved" ? "resolved" : "unresolved",
              })),
              reviewedContentIdentity: identity,
            }),
            errorOutput: "",
          };
        }
        if (
          preparedReview !== undefined &&
          options.readOnly &&
          options.prompt.includes("Independently review the implementation")
        ) {
          reviewerRounds += 1;
          const identity = options.prompt.match(
            /Reviewed source content identity: (sha256:[0-9a-f]{64})/u,
          )?.[1];
          if (identity === undefined) throw new Error("review prompt omitted source identity");
          if (reviewerRounds === 1)
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                projectId: project.id,
                cardId,
                verdict: "pass",
                requirementAssessments: [
                  {
                    requirementId: "REQ-1",
                    status: "satisfied",
                    details: "The initial implementation meets the request.",
                    evidence: ["app.js"],
                  },
                ],
                blockingFindings: [],
                previousFindingAssessments: [],
                reviewedContentIdentity: identity,
              }),
              errorOutput: "",
            };
          if (preparedReview === "unavailable")
            return {
              exitCode: 1,
              output: "",
              errorOutput: "follow-up review service unavailable",
            };
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId,
              verdict: "fail",
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "unsatisfied",
                  details: "The prepared source loses the requested value after reload.",
                  evidence: [],
                },
              ],
              blockingFindings: [
                {
                  kind: "defect",
                  summary: "Prepared source loses state after reload",
                  detail: "The changed publication source restores the default value.",
                  location: { filePath: "app.js", line: 1 },
                },
              ],
              previousFindingAssessments: [],
              reviewedContentIdentity: identity,
            }),
            errorOutput: "",
          };
        }
        if (
          correctionFailure &&
          options.prompt.startsWith(
            "Address the following verified-as-actionable human PR feedback",
          )
        ) {
          return realRunner.run(options);
        }
        if (
          ciReviewHandoffs &&
          options.prompt.startsWith("Repair the required GitHub CI failures")
        ) {
          expect(prs.get(firstBranch)?.body).toMatch(/^<!-- agent-orchestrator-status:start -->/u);
          expect(prs.get(firstBranch)?.body).toContain("addressing observed CI failures");
          ciPrimaryCorrections += 1;
          fs.writeFileSync(
            path.join(options.cwd, "app.js"),
            `module.exports = 'CI correction ${ciPrimaryCorrections}';\n`,
          );
          return {
            exitCode: 0,
            output: "CI correction applied",
            errorOutput: "",
          };
        }
        if (
          ciReviewHandoffs &&
          options.prompt.startsWith("Address the independent implementation review findings")
        ) {
          const taskStore = new TaskExecutionStore(contextRoot, project, authorities.get(cardId));
          const task = taskStore.read(cardId);
          const review = task?.reviewRepair?.finalReview;
          const pending = task?.reviewRepair?.activePrimaryOperation;
          if (review === undefined || pending === undefined)
            throw new Error("CI review repair lacks its durable reservation");
          ciReviewRepairOperationIds.push(pending.operationId);
          expect(options.prompt).toContain(`https://context.test/revision-${ciPrimaryCorrections}`);
          ciReviewRepairDispatches.push({
            operationId: pending.operationId,
            prompt: options.prompt,
            sessionId: options.sessionId,
          });
          if (ciReviewRecovery === "unknown")
            throw new Error("CI review process outcome is unknown");
          fs.writeFileSync(
            path.join(options.cwd, "app.js"),
            `module.exports = 'CI review repair ${pending.pass}';\n`,
          );
          const dispositions = {
            version: 1,
            findingDispositions: review.blockingFindings.flatMap(({ id }) =>
              id === undefined
                ? []
                : [
                    {
                      findingId: id,
                      status: "addressed",
                      rationale: "The CI-correction defect was corrected in the current source.",
                    },
                  ],
            ),
            requirementDispositions: review.requirementAssessments
              .filter(({ status }) => status === "unsatisfied")
              .map(({ requirementId }) => ({
                requirementId,
                status: "addressed",
                rationale: "The requested behavior is implemented in the current source.",
              })),
          };
          return {
            exitCode: 0,
            output: JSON.stringify({
              type: "text",
              part: {
                type: "text",
                text: `${JSON.stringify(dispositions)}\nREVIEW_REPAIR_FINISHED_EARLY`,
              },
            }),
            errorOutput: "",
          };
        }
        if (options.captureSessionId)
          return {
            exitCode: 0,
            sessionId,
            output:
              JSON.stringify({ type: "step_start", sessionID: sessionId }) +
              "\n" +
              JSON.stringify({
                type: "text",
                sessionID: sessionId,
                part: {
                  type: "text",
                  text: JSON.stringify({
                    version: 1,
                    projectId: project.id,
                    cardId,
                    requirements: [
                      {
                        id: "REQ-1",
                        text: "Implement change",
                        verification: "Run validation",
                      },
                    ],
                    steps: [
                      {
                        id: "STEP-1",
                        description: "Implement change",
                        requirementIds: ["REQ-1"],
                        verification: "Run validation",
                      },
                    ],
                    assumptions: [],
                    blockers: [],
                  }),
                },
              }),
            errorOutput: "",
          };
        if (options.readOnly) {
          const identity = options.prompt.match(
            /(?:Reviewed source content identity|Reviewed source identity): (sha256:[0-9a-f]{64})/u,
          )?.[1];
          if (
            options.prompt.includes("Independently verify each actionable human PR feedback item")
          )
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                projectId: project.id,
                cardId,
                headSha: prs.get(firstBranch)!.headRefOid,
                contentIdentity: identity,
                dispositions: [
                  {
                    feedbackId: "review:202",
                    status: "unresolved",
                    reason: "The empty-result behavior still needs a correction.",
                  },
                ],
              }),
              errorOutput: "",
            };
          if (options.prompt.includes("verify the persisted task plan"))
            return {
              exitCode: 0,
              output: JSON.stringify({
                version: 1,
                projectId: project.id,
                cardId,
                planRevision: 1,
                verdict: "pass",
                findings: [],
              }),
              errorOutput: "",
            };
          if (!identity) throw new Error("review prompt did not contain snapshot identity");
          const incidentAdvisoryFinding =
            feedbackQuality === "classification-outage" && !correctionFeedback;
          return {
            exitCode: 0,
            output: JSON.stringify({
              version: 1,
              projectId: project.id,
              cardId,
              verdict: incidentAdvisoryFinding ? "fail" : "pass",
              requirementAssessments: [
                {
                  requirementId: "REQ-1",
                  status: "satisfied",
                  details: "Implemented",
                  evidence: ["app.js"],
                },
              ],
              blockingFindings: incidentAdvisoryFinding
                ? [
                    {
                      kind: "defect",
                      summary: "Retained advisory edge case",
                      detail:
                        "The fixture intentionally leaves a review concern for the human reviewer.",
                      location: { filePath: "app.js", line: 1 },
                    },
                  ]
                : [],
              reviewedContentIdentity: identity,
            }),
            errorOutput: "",
          };
        }
        if (options.prompt.includes("Implement the task plan in this repository")) {
          if (options.sessionId !== sessionId || options.sessionLabel === undefined)
            throw new Error("implementation did not resume named primary session");
          const child = await execFile(
            process.execPath,
            ["-e", "require('fs').writeFileSync('app.js', \"module.exports = 'implemented';\\n\")"],
            { cwd: options.cwd, env, timeout: 10_000 },
          );
          void child;
        }
        if (options.prompt.includes("Generate the commit message")) {
          const resultRelativePath = options.prompt.match(
            /Write exactly one JSON object to ([^\n]+)\./u,
          )?.[1];
          if (resultRelativePath === undefined)
            throw new Error("Commit-message prompt omitted its result path");
          const resultPath = path.join(options.cwd, resultRelativePath);
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              message:
                "fix(task): preserve CI behavior\n\n- Correct the reported CI failure.\n- Preserve the requested implementation.\n\nThe CI correction is complete.",
            }),
          );
        }
        return {
          exitCode: 0,
          output: "All configured validation and coverage passed.",
          errorOutput: "",
        };
      });
      const observedCommands: string[] = [];
      const commandOutcomes: string[] = [];
      const commands = new CommandRunner(async (options: CommandRunOptions) => {
        if (
          preparedValidationFailure &&
          options.command === project.repository.validationCommand &&
          store.read("first")?.phase === "publication"
        )
          return {
            exitCode: 42,
            output: "Prepared validation failed after earlier passing checks",
            errorOutput: "Observed prepared-stage failure",
          };
        if (
          ((feedbackQuality === "validation" && correctionFeedback) ||
            (ciQuality === "validation" && ciPrimaryCorrections > 0)) &&
          options.command === project.repository.validationCommand
        ) {
          if (ciQuality === "validation") ciAttachmentVersion = 10 + ciPrimaryCorrections;
          return {
            exitCode: 1,
            output: "Observed correction test failure",
            errorOutput: "Regression remains",
            timedOut: false,
            aborted: false,
          };
        }
        if (options.command.startsWith("opencode session list"))
          return {
            exitCode: 0,
            output: JSON.stringify([{ id: sessionId, directory: options.cwd }]),
            errorOutput: "",
          };
        observedCommands.push(options.command);
        try {
          const result = await execFile("/bin/sh", ["-c", options.command], {
            cwd: options.cwd,
            env: {
              ...env,
              ...(draft && options.command.includes("validation-runs.log")
                ? { FAIL_VALIDATION: "1" }
                : {}),
            },
            timeout: options.timeoutMilliseconds ?? 20_000,
          });
          commandOutcomes.push(`${options.command}: exit 0`);
          return {
            exitCode: 0,
            output: result.stdout,
            errorOutput: result.stderr,
          };
        } catch (error) {
          const failure = error as Error & {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          commandOutcomes.push(`${options.command}: ${failure.message}`);
          return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            output: failure.stdout ?? "",
            errorOutput: failure.stderr ?? failure.message,
          };
        }
      });
      const lifecycleController = new AbortController();
      const signal = lifecycleController.signal;
      let activeAuthority: ProjectRunAuthority | undefined;
      vi.useFakeTimers({ toFake: ["Date"] });
      const poll = async () => {
        vi.setSystemTime(Date.now() + 15_001);
        if (activeAuthority === undefined) {
          const eligible = await trello.getCards(project.trello.readyListId);
          const selected = eligible.find((card) => card.idLabels.includes("feature"));
          if (selected === undefined) return;
          activeAuthority = await ProjectRunAuthority.createPreparingAttempt({
            projectId: project.id,
            cardId: selected.id,
            taskKind: "implementation",
            pinned,
            projectLease: lease,
            coordinationRoot,
            ...(ciReviewHandoffs && selected.id === "first"
              ? {
                  attemptId: "lifecycle-attempt",
                }
              : {}),
            budgets: {
              validation: {
                limit: 5,
                used: 0,
                episodeId: `${selected.id}:validation`,
                trigger: "initial",
              },
              review: {
                limit: 5,
                used: 0,
                episodeId: `${selected.id}:review`,
                trigger: "initial",
              },
              ci: {
                limit: 2,
                used: 0,
                episodeId: `${selected.id}:ci`,
                trigger: "publication",
              },
            },
          });
          if (ciReviewHandoffs && selected.id === "first") {
            const preparing = activeAuthority.store.read()!;
            activeAuthority.store.transition(
              preparing.revision,
              preparing.owner.generation,
              null,
              "implementation-claimed",
              "preparing",
              "planning",
              (snapshot) => ({
                ...snapshot,
                resources: [
                  {
                    kind: "worktree",
                    id: "first",
                    path: path.join(worktrees, firstWorktreeName),
                    provenance: "attempt-planned",
                  },
                  {
                    kind: "branch",
                    id: "first",
                    path: `refs/heads/${firstBranch}`,
                    provenance: "attempt-planned",
                  },
                ],
              }),
            );
          } else activeAuthority.claim();
          authorities.set(selected.id, activeAuthority);
        }
        const authority = activeAuthority;
        await authority.run(() =>
          withGitHubOperationProject(project, () =>
            pollProject(
              trello,
              git,
              github,
              openCode,
              commands,
              project,
              signal,
              undefined,
              undefined,
              undefined,
              authority,
              1_000,
            ),
          ),
        );
        const completed = authority.store.read();
        if (
          completed &&
          ["done", "refined", "failed", "cancelled"].includes(completed.lifecycle) &&
          completed.terminalSync === "verified"
        ) {
          await authority.releaseVerifiedTerminal();
          activeAuthority = undefined;
        }
      };
      const store = {
        read: (cardId: string) => {
          const authority = authorities.get(cardId);
          return new TaskExecutionStore(contextRoot, project, authority).read(cardId);
        },
      };
      loseCreateAcknowledgement = ackLoss;
      if (ackLoss) {
        for (let pass = 0; pass < 8 && accepted.length === 0; pass++) await poll();
        expect(accepted).toHaveLength(1);
        expect(prs.get(firstBranch)).toBeDefined();
        // Reconstruct application clients around independently retained service resources.
        git = new GitClient(runGit);
        github = Object.assign(
          Object.create(Object.getPrototypeOf(github)) as GitHubClient,
          github,
        );
        expect(requests).toEqual([firstBranch]);
        expect(accepted).toHaveLength(1);
        expect(prs.size).toBe(1);
        const acceptedHead = prs.get(firstBranch)!.headRefOid;
        expect(await git.getRemoteBranchSha(source, "origin", firstBranch, project)).toBe(
          acceptedHead,
        );
        expect(await gitRun(source, "show", `${acceptedHead}:app.js`)).toBe(
          preparedReview === undefined
            ? "module.exports = 'implemented';"
            : "module.exports = 'prepared publication source';",
        );
        expect(await git.getHeadSha(path.join(worktrees, firstWorktreeName))).toMatch(
          /^[0-9a-f]{40}$/u,
        );
        expect(fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"), "utf8")).toBe(
          preparedReview === undefined
            ? "module.exports = 'implemented';\n"
            : "module.exports = 'prepared publication source';\n",
        );
        expect(lists.get("first")).toBe("working");
        expect(fs.existsSync(path.join(worktrees, firstWorktreeName))).toBe(true);
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        expect(fs.existsSync(path.join(worktrees, "next"))).toBe(false);
        expect(openCodeCards).not.toContain("next");
        expect(store.read("first")?.phase).toBe("publication");
        expect(
          fs.existsSync(path.join(contextRoot, "task-executions", project.id, "first.json")),
        ).toBe(false);
        expect(
          ledger.some(
            ({ service, action }) => service === "github" && action === "accept:create-pr",
          ),
        ).toBe(true);
        // Retained dispatch evidence and the correlation marker authorize only
        // readback after restart, never another create.
      }
      if (preparedReview !== undefined) {
        for (let pass = 0; pass < 8 && !prs.has(firstBranch); pass++) await poll();
        const preparedPr = prs.get(firstBranch);
        expect(preparedPr).toBeDefined();
        expect(
          observedCommands.filter((command) => command === project.repository.validationCommand),
        ).toHaveLength(2);
        expect(
          observedCommands.filter((command) => command === project.repository.coverageCommand),
        ).toHaveLength(2);
        expect(reviewerRounds).toBe(2);
        expect(publicationQualityAtCreate).toHaveLength(1);
        const persistedPublicationQuality = publicationQualityAtCreate[0] as {
          contentIdentity: string;
          review: { verdict: string; blockingFindings: unknown[] } | null;
        };
        expect(persistedPublicationQuality.contentIdentity).toMatch(/^sha256:[0-9a-f]{64}$/u);
        if (preparedReview === "material") {
          expect(persistedPublicationQuality.review).toMatchObject({
            verdict: "fail",
            blockingFindings: [
              expect.objectContaining({
                summary: "Prepared source loses state after reload",
              }),
            ],
          });
          expect(preparedPr?.isDraft).toBe(true);
          expect(preparedPr?.body).toMatch(/Independent AI review: failed/iu);
          expect(preparedPr?.body).toContain(
            "The changed publication source restores the default value.",
          );
        } else {
          expect(persistedPublicationQuality.review).toBeNull();
          expect(store.read("first")?.reviewUnavailable).toMatchObject({
            contentIdentity: persistedPublicationQuality.contentIdentity,
            diagnostic: "Independent implementation review exited with code 1",
          });
          expect(preparedPr?.isDraft).toBe(true);
          expect(preparedPr?.body).toContain("Independent AI review: unavailable");
          expect(preparedPr?.body).not.toContain(
            "Independent implementation review exited with code 1",
          );
        }
        return;
      }
      if (ciReviewHandoffs) {
        let ciInterrupted: TaskExecutionRecord | undefined;
        let ciWritesStopped = false;
        const originalCompare = TaskExecutionStore.prototype.compareAndSwap;
        const ciFault = new Error("Simulated CI review checkpoint interruption");
        const ciInterception =
          ciReviewRecovery === undefined
            ? undefined
            : vi.spyOn(TaskExecutionStore.prototype, "compareAndSwap").mockImplementation(function (
                this: TaskExecutionStore,
                cardId,
                revision,
                next,
              ) {
                if (ciWritesStopped) throw ciFault;
                const persisted = originalCompare.call(this, cardId, revision, next);
                const repair = persisted.reviewRepair;
                if (!repair?.cycleId.includes(":ci-review:") || ciInterrupted !== undefined)
                  return persisted;
                const reservation = repair.activePrimaryOperation;
                const entry = reservation && persisted.primaryOperations?.[reservation.operationId];
                const matches =
                  ciReviewRecovery === "reserved"
                    ? reservation !== undefined && entry === undefined
                    : ciReviewRecovery === "completed"
                      ? reservation !== undefined &&
                        entry?.status === "completed" &&
                        persisted.phase === "implementation"
                      : ciReviewRecovery === "validation"
                        ? reservation !== undefined &&
                          entry?.status === "completed" &&
                          persisted.phase === "validation"
                        : ciReviewRecovery === "reviewed" && repair.status === "passed";
                if (matches) {
                  ciInterrupted = persisted;
                  ciWritesStopped = true;
                  throw ciFault;
                }
                return persisted;
              });
        if (ciReviewRecovery !== undefined) {
          for (
            let pass = 0;
            pass < 8 && ciInterrupted === undefined && ciReviewRepairOperationIds.length === 0;
            pass += 1
          ) {
            try {
              await poll();
            } catch (error) {
              expect(error).toBeInstanceOf(Error);
            }
          }
          expect(ciWritesStopped).toBe(ciReviewRecovery !== "unknown");
          ciInterception?.mockRestore();
          ciWritesStopped = false;
          const checkpoint = ciInterrupted ?? store.read("first")!;
          const reservation = checkpoint.reviewRepair?.activePrimaryOperation;
          const savedPrompt =
            reservation?.promptArtifact === undefined
              ? undefined
              : (new TaskExecutionStore(
                  contextRoot,
                  project,
                  activeAuthority,
                ).readPrimaryResultArtifact({
                  reference: reservation.promptArtifact.reference as `sha256:${string}`,
                  bytes: reservation.promptArtifact.bytes,
                  ...(reservation.promptArtifact.path === undefined
                    ? {}
                    : { path: reservation.promptArtifact.path }),
                }) as { prompt: string } | undefined);
          const priorHead = checkpoint.pullRequest!.headSha;
          const sourceBytes = fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"));
          expect(ciPrimaryCorrections).toBe(1);
          expect(checkpoint.retryCounters.review).toBe(1);
          git = new GitClient(runGit);
          for (let pass = 0; pass < (ciReviewRecovery === "unknown" ? 3 : 8); pass += 1) {
            await poll();
            if (
              ciReviewRecovery !== "unknown" &&
              ciPrimaryCorrections === 2 &&
              store.read("first")?.phase === "human-feedback"
            )
              break;
          }
          if (reservation !== undefined)
            expect(ciReviewRepairDispatches[0]).toEqual({
              operationId: reservation.operationId,
              prompt: savedPrompt!.prompt,
              sessionId,
            });
          if (ciReviewRecovery === "unknown") {
            const resumed = store.read("first")!;
            expect(ciPrimaryCorrections).toBe(1);
            expect(ciReviewRepairOperationIds).toHaveLength(1);
            expect(resumed.pullRequest?.headSha).toBe(priorHead);
            expect(resumed.reviewRepair?.activePrimaryOperation).toEqual(reservation);
            expect(resumed.primaryOperations?.[reservation!.operationId]?.status).toBe("ambiguous");
            expect(resumed.phase).toBe("implementation");
            expect(resumed.retryCounters.review).toBe(1);
            expect(fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"))).toEqual(
              sourceBytes,
            );
            expect(lists.get("next")).toBe("ready");
            expect(requests).toEqual([firstBranch]);
            return;
          }
        }
        for (let pass = 0; pass < 20 && ciPrimaryCorrections < (ciBudget ?? 2); pass += 1)
          await poll();
        const ciTask = store.read("first");
        const ciRun = authorities.get("first")?.store.read();
        expect(ciTask?.phase).toBe("human-feedback");
        expect(prs.get(firstBranch)?.body).not.toContain("Agent Orchestrator status:");
        expect(prs.get(firstBranch)?.body).toContain("CI:");
        expect(
          ciPrimaryCorrections,
          JSON.stringify({
            ciReviewHandoffs,
            task: store.read("first"),
            run: authorities.get("first")?.store.read(),
          }),
        ).toBe(ciBudget ?? 2);
        if (ciBudget !== undefined) {
          expect(ciTask?.retryCounters.ci).toBe(ciBudget);
          expect(ciRun?.budgets.ci).toMatchObject({
            limit: ciBudget,
            used: ciBudget,
            episodeId: ciTask?.ciRepair?.cycleId,
          });
          expect(prs.size).toBe(1);
          expect(lists.get("first")).toBe("review");
          return;
        }
        if (ciQuality !== undefined) {
          expect(prs.size).toBe(1);
          expect(prs.get(firstBranch)?.isDraft).toBe(true);
          expect(lists.get("first")).toBe("review");
          expect(await git.getRemoteBranchSha(source, "origin", firstBranch, project)).toBe(
            ciTask?.pullRequest?.headSha,
          );
          expect(ciTask?.ciRepair?.status).toBe("passed");
          expect(
            ciQuality === "validation"
              ? ciTask?.publicationQuality?.validation.status
              : ciTask?.reviewUnavailable,
          ).toBeTruthy();
          return;
        }
        expect(ciReviewRepairOperationIds).toHaveLength(2);
        expect(ciReviewRepairOperationIds[0]).toMatch(/:pass:1$/u);
        expect(ciReviewRepairOperationIds[1]).toMatch(/:pass:2$/u);
        expect(new Set(ciReviewRepairOperationIds).size).toBe(2);
        expect(ciTask?.reviewRepair).toMatchObject({
          cycleId: `${ciTask?.operationKey}:ci-review:${ciTask?.ciRepair?.cycleId}`,
          status: "passed",
          maxAttempts: 2,
        });
        expect(ciTask?.retryCounters.review).toBe(2);
        expect(ciRun?.budgets.review).toMatchObject({
          episodeId: ciTask?.reviewRepair?.cycleId,
          limit: 2,
          used: 2,
        });
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        return;
      }
      for (
        let attempt = 0;
        attempt < 15 && store.read("first")?.phase !== "human-feedback";
        attempt += 1
      )
        await poll();
      const record = store.read("first");
      expect(record?.phase).toBe("human-feedback");
      const firstPr = prs.get(firstBranch);
      expect(firstPr).toBeDefined();
      expect(firstPr!.body).not.toContain(contextRoot);
      if (credentialRecovery) {
        const owner = activeAuthority!;
        const tasks = new TaskExecutionStore(contextRoot, project, owner);
        const worktree = path.join(worktrees, firstWorktreeName);
        const outage = new GitHubCredentialResolutionError(
          project,
          new GitHubAppApiError("Bad Gateway", 502),
        );
        const reason = `Authoritative recovery snapshot could not be read: ${outage.message}`;
        const checkpoint = owner.store.read()!;
        if (credentialRecovery === "legacy-502") {
          tasks.compareAndSwap("first", record!.revision, {
            ...transitionTaskExecutionRecord(record!, {
              type: "attention-required",
              eventId: "historical-502-snapshot-failure",
              projectId: project.id,
              cardId: "first",
              operationKey: record!.operationKey,
              occurredAt: new Date(
                Math.max(Date.now(), Date.parse(record!.updatedAt) + 1),
              ).toISOString(),
            }),
            recoveryAttentionReason: reason,
          });
          expect(owner.store.read()).toMatchObject({
            lifecycle: "waiting",
            checkpoint: "human-review",
            publicationState: "open",
            wait: { reason: "task-attention-required", dependency: "operator", retryAt: null },
          });
          const retained = tasks.read("first")!;
          const inspect = () =>
            owner.run(async () =>
              inspectPublishedFeedbackRecovery({
                project,
                authority: owner,
                task: retained,
                card: await trello.getCard("first"),
                git,
                github,
                commands,
                signal,
              }),
            );
          await expect(inspect()).rejects.toThrow("process termination evidence");
          owner.run(() => {
            const evidence = beginProcessEvidence("opencode run --format json", worktree);
            evidence.finish("success", { exitCode: 0, treeStopped: true });
          });
          const wrongOwner = vi.spyOn(github, "findPullRequestState").mockResolvedValueOnce({
            ...firstPr!,
            mergedAt: null,
            headRepositoryOwner: { login: "another-owner" },
          });
          await expect(inspect()).rejects.toThrow("recorded open PR and exact head");
          wrongOwner.mockRestore();
          const queue = new TaskMutationQueue(contextRoot, project, owner);
          queue.enqueue({
            kind: "feedback",
            projectId: project.id,
            cardId: "first",
            eventId: "older-writer",
            operationKey: "older-writer",
            enqueuedAt: record!.updatedAt,
          });
          expect(queue.claimNext()?.eventId).toBe("older-writer");
          await expect(inspect()).rejects.toThrow();
          expect(hasDueTaskSessionRecoveryWait(owner.store.read())).toBe(false);
          queue.complete("older-writer");
        } else {
          const ci = github.getCiObservations.bind(github);
          const unavailable = vi
            .spyOn(github, "getCiObservations")
            .mockImplementationOnce(ci)
            .mockRejectedValueOnce(outage);
          await poll();
          unavailable.mockRestore();
          const current = tasks.read("first");
          expect(current).toMatchObject({
            phase: "human-feedback",
            recoveryWait: { kind: "dependency", reason },
          });
          const retryAt = Date.parse(current!.recoveryWait!.retryAt);
          expect(hasDueTaskSessionRecoveryWait(owner.store.read(), retryAt - 1)).toBe(false);
          expect(hasDueTaskSessionRecoveryWait(owner.store.read(), retryAt)).toBe(true);
        }
        expect(owner.store.read()?.budgets).toEqual(checkpoint.budgets);
        expect(tasks.read("first")?.retryCounters).toEqual(record!.retryCounters);
        correctionFeedback = true;
        loseFeedbackWorkingAck = false;
        firstPr!.reviewDecision = "CHANGES_REQUESTED";
        await owner.run(() => observeActivePullRequest({ project, github, authority: owner }));
        const queue = new TaskMutationQueue(contextRoot, project, owner);
        const queued = queue
          .list()
          .find((event) => event.kind === "feedback" && event.status === "queued")!;
        expect(queued).toMatchObject({
          dispatchReady: false,
          observationArtifactId: expect.any(String),
        });
        expect(
          new FeedbackLedgerStore(contextRoot, project, owner).read("first")?.entries ?? [],
        ).toEqual([]);
        expect(feedbackPrimaryCorrections).toBe(0);
        if (credentialRecovery !== "legacy-502")
          vi.setSystemTime(Date.parse(tasks.read("first")!.recoveryWait!.retryAt));

        const resumed = new AbortController();
        let finalTask: TaskExecutionRecord | null = null;
        let finalObservation: ReturnType<TaskMutationQueue["get"]>;
        let finalLedger: ReturnType<FeedbackLedgerStore["read"]>;
        let finalRun: RunRecord | null = null;
        const runWorker = async (currentOwner: ProjectRunAuthority, run: () => Promise<void>) => {
          const queue = new TaskMutationQueue(contextRoot, project, currentOwner);
          const capture = () => {
            finalTask = store.read("first");
            finalObservation = queue.get(queued.eventId);
            finalLedger = new FeedbackLedgerStore(contextRoot, project, currentOwner).read("first");
            finalRun = currentOwner.store.read();
          };
          const timer = setInterval(() => {
            capture();
            const task = finalTask;
            if (
              task?.pullRequest?.headSha !== record!.pullRequest!.headSha &&
              lists.get("first") === "review" &&
              finalObservation?.status === "retired" &&
              task?.phase === "human-feedback"
            )
              resumed.abort();
          }, 50);
          try {
            await run();
          } finally {
            clearInterval(timer);
            capture();
          }
        };
        const deadline = setTimeout(() => resumed.abort(), 15_000);
        try {
          if (credentialRecovery === "live") {
            await runWorker(owner, () =>
              runOrchestrator(
                trello,
                git,
                github,
                openCode,
                commands,
                orchestrationConfig,
                resumed.signal,
                undefined,
                undefined,
                new Map([
                  [project.id, { authority: owner, pinned, projectLease: lease, coordinationRoot }],
                ]),
              ),
            );
          } else {
            await lease.release();
            await runStartup(
              orchestrationConfig,
              { trello, git, github, opencode: openCode, commands },
              resumed.signal,
              {
                validateToolchain: async () => undefined,
                validateGitHubCli: async () => undefined,
                validateProjectTrello: async () => undefined,
                validateProjectGitHub: async () => undefined,
                runOrchestrator: (...args) => {
                  const resumedOwner = args[9]?.get(project.id)?.authority;
                  if (!resumedOwner) throw new Error("Startup did not reacquire the owned task");
                  expect(resumedOwner.store.attemptId).toBe(owner.store.attemptId);
                  expect(resumedOwner.store.read()?.budgets).toEqual(checkpoint.budgets);
                  authorities.set("first", resumedOwner);
                  return runWorker(resumedOwner, () => runOrchestrator(...args));
                },
              },
            );
          }
        } finally {
          clearTimeout(deadline);
        }
        expect(finalTask).not.toBeNull();
        const corrected = finalTask! as TaskExecutionRecord;
        const persistedRun = finalRun as RunRecord | null;
        const diagnostic = JSON.stringify({
          phase: corrected.phase,
          wait: persistedRun?.wait,
          probe: persistedRun?.compatibility["legacy-published-feedback-recovery-v1"],
          feedbackPrimaryCorrections,
          lists: [...lists],
        });
        expect(corrected.phase, diagnostic).toBe("human-feedback");
        expect(corrected.pullRequest?.headSha).not.toBe(record!.pullRequest!.headSha);
        expect(corrected.pullRequest?.url).toBe(record!.pullRequest!.url);
        expect(corrected.primarySessionId).toBe(record!.primarySessionId);
        expect(corrected.expectedBranch).toBe(record!.expectedBranch);
        expect(await git.getHeadSha(worktree)).toBe(corrected.pullRequest?.headSha);
        expect(corrected.recoveryWait).toBeUndefined();
        expect(corrected.recoveryAttentionReason).toBeUndefined();
        expect(finalObservation!, diagnostic).toMatchObject({
          status: "retired",
          observationArtifactId: queued.observationArtifactId,
        });
        expect((finalLedger! as ReturnType<FeedbackLedgerStore["read"]>)?.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "202", actionability: "actionable" }),
          ]),
        );
        expect(feedbackPrimaryCorrections).toBe(1);
        expect(requests).toEqual([firstBranch]);
        expect(lists.get("next")).toBe("ready");
        return;
      }
      if (targetMerge) {
        const published = record!.pullRequest!.headSha!;
        firstPr!.reviewDecision = "APPROVED";
        firstPr!.body += "\nHuman release instructions: retain this text.\n";
        const upstream = path.join(root, "upstream");
        await gitRun(root, "clone", remote, upstream);
        await gitRun(upstream, "config", "user.name", "Human");
        await gitRun(upstream, "config", "user.email", "human@example.test");
        fs.writeFileSync(path.join(upstream, "upstream.txt"), "independent target work\n");
        await gitRun(upstream, "add", ".");
        await gitRun(upstream, "commit", "-m", "advance target");
        await gitRun(upstream, "push", "origin", "main");
        maintenanceBase = await git.getHeadSha(upstream);
        await poll();
        const maintained = store.read("first")!;
        expect(maintained.pullRequest!.headSha).not.toBe(published);
        expect(await git.getCommitParentShas(path.join(worktrees, firstWorktreeName))).toEqual([
          published,
          maintenanceBase,
        ]);
        expect(firstPr!.body).toContain("Human release instructions: retain this text.");
        expect(firstPr!.body).toContain("## Quality checks");
        expect(firstPr!.body).not.toContain(contextRoot);
        expect(firstPr!.body).toContain("Human note added during maintenance review.");
        expect(firstPr!.body).not.toContain("Agent Orchestrator status:");
        expect(firstPr!.isDraft).toBe(true);
        expect(lists.get("first")).toBe("review");
        expect(lists.get("next")).toBe("ready");
        expect(prs.size).toBe(1);
        await poll();
        expect(store.read("first")!.pullRequest!.headSha).toBe(maintained.pullRequest!.headSha);
        return;
      }
      expect(firstPr?.isDraft).toBe(
        draft ||
          preparedReview !== undefined ||
          preparedValidationFailure === true ||
          feedbackQuality === "classification-outage",
      );
      const progressMessages = progress.mock.calls.map(([message]) => message);
      if (feedbackQuality === "classification-outage") {
        expect(firstPr?.body).toContain("Retained advisory edge case");
        expect(
          progressMessages.filter((message) =>
            message.startsWith("Continuing remediation: starting review repair 1 of"),
          ),
        ).toHaveLength(1);
      }
      if (publishedReadRecovery) {
        expect(
          observedCommands.filter((command) => command === project.repository.validationCommand),
        ).toHaveLength(1);
        expect(
          observedCommands.filter((command) => command === project.repository.coverageCommand),
        ).toHaveLength(1);
        const owner = authorities.get("first")!;
        const taskStore = new TaskExecutionStore(contextRoot, project, owner);
        const before = taskStore.read("first")!;
        const escalate = () => {
          const current = taskStore.read("first")!;
          taskStore.compareAndSwap("first", current.revision, {
            ...transitionTaskExecutionRecord(current, {
              type: "attention-required",
              eventId: `read-recovery-${current.revision}`,
              projectId: project.id,
              cardId: "first",
              operationKey: current.operationKey,
              occurredAt: new Date(
                Math.max(Date.now() + 1, Date.parse(current.updatedAt) + 1),
              ).toISOString(),
            }),
            recoveryAttentionReason:
              publishedReadRecovery === "classification"
                ? "Human feedback classification unavailable; current requests retained"
                : "Authoritative recovery snapshot could not be read: GitHub CLI returned an invalid commit statuses",
          });
        };
        escalate();
        if (publishedReadRecovery === "classification") {
          const ownedPath = path.join(worktrees, firstWorktreeName);
          const retained = taskStore.read("first")!;
          const recoveryRead = (gitClient = git, githubClient = github) =>
            owner.run(async () =>
              inspectPublishedFeedbackRecovery({
                project,
                authority: owner,
                task: retained,
                card: await trello.getCard("first"),
                git: gitClient,
                github: githubClient,
                commands,
                signal,
              }),
            );
          await expect(recoveryRead()).rejects.toThrow("process termination evidence");
          owner.run(() => {
            const evidence = beginProcessEvidence("opencode run --format json", ownedPath);
            evidence.finish("nonzero", { exitCode: 1, treeStopped: true });
          });
          const wrongBranch = vi
            .spyOn(git, "getCurrentBranch")
            .mockResolvedValueOnce("different-branch");
          await expect(recoveryRead()).rejects.toThrow("unchanged owned worktree and branch");
          wrongBranch.mockRestore();
          const localHead = vi.spyOn(git, "getHeadSha").mockResolvedValueOnce("f".repeat(40));
          await expect(recoveryRead()).rejects.toThrow("trusted commit or local HEAD");
          localHead.mockRestore();
          const differentPr = vi
            .spyOn(github, "findPullRequestState")
            .mockResolvedValueOnce({ ...firstPr!, url: `${firstPr!.url}0`, mergedAt: null });
          await expect(recoveryRead()).rejects.toThrow("recorded open PR and exact head");
          differentPr.mockRestore();
          const accepted = await recoveryRead();
          expect(accepted).toMatchObject({
            attemptId: owner.store.attemptId,
            head: before.pullRequest!.headSha,
            pullRequestUrl: before.pullRequest!.url,
          });
          expect(taskStore.read("first")).toEqual(retained);
          activeAuthority = await ProjectRunAuthority.resumeAttempt({
            projectId: project.id,
            attemptId: owner.store.attemptId,
            pinned,
            projectLease: lease,
            coordinationRoot,
          });
          authorities.set("first", activeAuthority);
        }
        if (publishedReadRecovery === "publication") {
          const current = taskStore.read("first")!;
          taskStore.compareAndSwap("first", current.revision, {
            ...current,
            phase: "publication",
            reviewObservation: undefined,
            revision: current.revision + 1,
            updatedAt: new Date(Date.now() + 2).toISOString(),
          });
          escalate();
        }
        await expect(poll()).resolves.toBeUndefined();
        await expect(poll()).resolves.toBeUndefined();
        expect(["ci", "human-feedback"]).toContain(taskStore.read("first")?.phase);
        expect(taskStore.read("first")?.pullRequest).toEqual(before.pullRequest);
        expect(taskStore.read("first")?.primarySessionId).toBe(before.primarySessionId);
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        expect(lists.get("first")).toBe("review");
        expect(lists.get("next")).toBe("ready");
        return;
      }
      if (draft) {
        expect(
          progressMessages.some((message) =>
            message.startsWith("Local quality checks completed: validation failed;"),
          ),
        ).toBe(true);
        expect(progressMessages).not.toContain("Validation passed");
      }
      if (quality === "none")
        expect(
          progressMessages.some((message) =>
            message.startsWith(
              "Local quality checks completed: validation skipped; coverage skipped;",
            ),
          ),
        ).toBe(true);
      if (preparedValidationFailure) {
        expect(store.read("first")?.publicationQuality?.validation).toMatchObject({
          status: "failed",
          exitCode: 42,
        });
        expect(store.read("first")?.validationRepair).toMatchObject({
          status: "exhausted",
          stopReason: "prepared-check-failed",
        });
        expect(store.read("first")?.retryCounters.validation).toBe(0);
        expect(firstPr?.body).toContain("failed");
        expect(lists.get("first")).toBe("review");
        expect(lists.get("next")).toBe("ready");
        expect(prs.size).toBe(1);
        return;
      }
      if (preparedReview !== undefined) {
        expect(reviewerRounds).toBe(2);
        if (preparedReview === "material") {
          expect(firstPr?.body).toContain("Prepared source loses state after reload");
          expect(firstPr?.body).toContain(
            "The changed publication source restores the default value.",
          );
          expect(firstPr?.body).toContain("REQ-1");
          expect(firstPr?.body).toContain("unsatisfied");
          expect(firstPr?.body).toMatch(/Independent AI review: failed/iu);
        } else {
          expect(firstPr?.body).toContain("Independent AI review: unavailable");
          expect(firstPr?.body).toContain("Independent implementation review exited with code 1");
          expect(firstPr?.body).not.toContain("Independent AI review: passed");
        }
      }
      expect(firstPr?.body).not.toContain("All configured validation and coverage passed.");
      expect(firstPr?.body).not.toContain('"diagnostic":');
      expect(firstPr?.body).not.toContain('"completedAt":');
      if (quality === "none") expect(firstPr?.body).toContain("skipped (not configured)");
      expect(
        fs.existsSync(validationMarker),
        JSON.stringify({
          quality,
          validationMarker,
          observedCommands,
          commandOutcomes,
        }),
      ).toBe(quality === "validation" || quality === "both");
      expect(
        fs.existsSync(coverageMarker),
        JSON.stringify({
          quality,
          coverageMarker,
          observedCommands,
          commandOutcomes,
        }),
      ).toBe(quality === "coverage" || quality === "both");
      if (!draft) {
        expect(publicationQualityAtCreate).toHaveLength(1);
        const persistedQuality = publicationQualityAtCreate[0] as {
          validation: { status?: string; exitCode: number | null };
          coverageEvidence?: { status?: string; exitCode: number | null };
        };
        expect(persistedQuality.validation).toMatchObject(
          quality === "none" || quality === "coverage"
            ? { status: "skipped", exitCode: null }
            : { status: "passed", exitCode: 0 },
        );
        expect(persistedQuality.coverageEvidence).toMatchObject(
          quality === "coverage" || quality === "both"
            ? { status: "passed", exitCode: 0 }
            : { status: "skipped", exitCode: null },
        );
      }
      expect(requests).toEqual([firstBranch]);
      expect(accepted).toEqual([firstPr?.url]);
      expect(lists.get("first")).toBe("review");
      if (terminalDuringFeedback !== undefined) {
        const owned = activeAuthority!;
        const worktree = path.join(worktrees, firstWorktreeName);
        const originalHead = store.read("first")!.pullRequest!.headSha!;
        const beforePrimary = new Set(Object.keys(store.read("first")!.primaryOperations ?? {}));
        const push = vi.spyOn(git, "push");
        const humanOutcome = async () => {
          if (terminal === "merged") {
            const main = (
              await execFile("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { env })
            ).stdout.trim();
            await execFile(
              "git",
              ["--git-dir", remote, "merge-base", "--is-ancestor", main, originalHead],
              { env },
            );
            await execFile(
              "git",
              ["--git-dir", remote, "update-ref", "refs/heads/main", originalHead, main],
              { env },
            );
          }
          await execFile(
            "git",
            ["--git-dir", remote, "update-ref", "-d", `refs/heads/${firstBranch}`, originalHead],
            { env },
          );
          firstPr!.state = terminal === "merged" ? "MERGED" : "CLOSED";
          ledger.push({
            service: "github",
            action: `human:${terminal}`,
            actor: "human",
            id: "41",
          });
        };
        const reconcileOutcome = async () => {
          for (
            let pass = 0;
            pass < 8 && !["done", "cancelled"].includes(owned.store.read()!.lifecycle);
            pass++
          )
            await poll();
          expect(owned.store.read()).toMatchObject({
            lifecycle: terminal === "merged" ? "done" : "cancelled",
            terminalSync: "verified",
          });
          expect(lists.get("first")).toBe(destination);
          expect(readTerminalPrFence(owned)?.stoppedAt).toBeDefined();
          expect(lists.get("next")).toBe("ready");
          expect(store.read("next")).toBeNull();
          expect(requests).toEqual([firstBranch]);
          expect(prs.size).toBe(1);
          expect(push).toHaveBeenCalledTimes(terminalDuringFeedback === "push-rejected" ? 1 : 0);
          expect(firstPr?.body).not.toContain("<!-- agent-orchestrator-status:start -->");
          expect(await git.getRemoteBranchSha(source, "origin", firstBranch, project)).toBeNull();
        };
        correctionFeedback = true;
        if (terminalDuringFeedback === "capacity") {
          const other = await notificationAuthorityFixture(root, "capacity-peer");
          leases.push(other.lease);
          let release!: () => void;
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          let started!: () => void;
          const entered = new Promise<void>((resolve) => {
            started = resolve;
          });
          const busy = new OpenCodeClient(async () => {
            started();
            await hold;
            return { exitCode: 0, output: "done", errorOutput: "" };
          });
          await new AiExecutionCapacity(1, [owned, other.authority], 25).runInScope(
            signal,
            async () => {
              const otherWork = other.authority.run(() =>
                busy.run({
                  cwd: other.project.repository.path,
                  prompt: "hold",
                  readOnly: true,
                  timeoutMilliseconds: 30_000,
                  signal,
                }),
              );
              await entered;
              const waiting = poll();
              try {
                await vi.waitFor(() =>
                  expect(owned.read("ai-execution-capacity", (value) => value)).toMatchObject({
                    state: "queued",
                  }),
                );
                const boundary = ledger.length;
                await humanOutcome();
                await waiting;
                expect(feedbackClassifications).toBe(0);
                expect(feedbackPrimaryCorrections).toBe(0);
                expect(Object.keys(store.read("first")!.primaryOperations ?? {})).toEqual([
                  ...beforePrimary,
                ]);
                await reconcileOutcome();
                expect(ledger.slice(boundary).some((entry) => entry.action === "move:review")).toBe(
                  false,
                );
                expect(
                  other.authority.read("ai-execution-capacity", (value) => value),
                ).toMatchObject({ state: "active" });
              } finally {
                lifecycleController.abort();
                release();
                await Promise.allSettled([waiting, otherWork]);
              }
            },
          );
        } else if (terminalDuringFeedback === "unknown") {
          await poll();
          expect(feedbackPrimaryCorrections).toBe(1);
          const operation = Object.values(store.read("first")!.primaryOperations ?? {}).find(
            (entry) => entry.activity === "feedback-remediation",
          )!;
          expect(operation).toMatchObject({
            status: "ambiguous",
            failureExecutions: 0,
          });
          expect(operation.processExecutionId).toBeUndefined();
          await humanOutcome();
          for (let pass = 0; pass < 4; pass++) await poll();
          expect(readTerminalPrFence(owned)).toMatchObject({ state: "MERGED" });
          expect(readTerminalPrFence(owned)?.stoppedAt).toBeUndefined();
          expect(owned.store.read()!.terminalSync).not.toBe("verified");
          expect(lists.get("first")).toBe("working");
          expect(lists.get("next")).toBe("ready");
          expect(feedbackPrimaryCorrections).toBe(1);
          expect(fs.existsSync(worktree)).toBe(true);
          expect(push).not.toHaveBeenCalled();
          await expect(owned.releaseVerifiedTerminal()).rejects.toThrow("stopped task writers");
        } else if (terminalDuringFeedback === "push-rejected") {
          let boundary = 0;
          push.mockImplementationOnce(async () => {
            boundary = ledger.length;
            await humanOutcome();
            throw new Error("Remote rejected the correction push after human closure");
          });
          await poll();
          await reconcileOutcome();
          expect(feedbackPrimaryCorrections).toBe(1);
          const unshipped = await git.getHeadSha(worktree);
          expect(unshipped).not.toBe(originalHead);
          expect(await git.isAncestor(worktree, originalHead, unshipped)).toBe(true);
          expect(ledger.slice(boundary).some((entry) => entry.action === "move:review")).toBe(
            false,
          );
          expect(readTerminalPrFence(owned)?.preserveArtifacts).toBe(true);
        } else {
          const heartbeatPath = path.join(worktree, "writer-child.heartbeat");
          const running = poll();
          try {
            await vi.waitFor(
              () => {
                expect(fs.existsSync(path.join(worktree, "writer-started"))).toBe(true);
                expect(fs.existsSync(heartbeatPath)).toBe(true);
              },
              { timeout: 10_000 },
            );
            const initialHeartbeat = fs.readFileSync(heartbeatPath, "utf8");
            await vi.waitFor(() =>
              expect(fs.readFileSync(heartbeatPath, "utf8")).not.toBe(initialHeartbeat),
            );
            const boundary = ledger.length;
            await humanOutcome();
            await running;
            await reconcileOutcome();
            expect(feedbackPrimaryCorrections).toBe(1);
            expect(fs.readFileSync(path.join(worktree, "unshipped-review.txt"), "utf8")).toContain(
              "not published",
            );
            expect(ledger.slice(boundary).some((entry) => entry.action === "move:review")).toBe(
              false,
            );
            const operation = Object.values(store.read("first")!.primaryOperations ?? {}).find(
              (entry) => entry.activity === "feedback-remediation",
            )!;
            expect(operation).toMatchObject({
              status: "cancelled",
              executions: 1,
              failureExecutions: 0,
              cancellationEvidence: { source: "stopped-after-dispatch" },
            });
            const execution = JSON.parse(
              fs.readFileSync(operation.processMetadataPath!, "utf8"),
            ) as { treeStopped?: boolean };
            expect(execution.treeStopped).toBe(true);
            // The child PID belongs to its private PID namespace; checking
            // that number in the caller's namespace can identify an unrelated
            // live process. Verify its actual work stopped instead.
            const stoppedHeartbeat = fs.readFileSync(heartbeatPath, "utf8");
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(fs.readFileSync(heartbeatPath, "utf8")).toBe(stoppedHeartbeat);
          } finally {
            lifecycleController.abort();
            await Promise.allSettled([running]);
          }
        }
        expect(fs.readFileSync(path.join(source, "app.js"), "utf8")).toBe(
          "module.exports = 'base';\n",
        );
        return;
      }
      if (feedbackQuality !== undefined) {
        const originalHead = store.read("first")!.pullRequest!.headSha!;
        const originalValidationCycle = store.read("first")!.validationRepair?.cycleId;
        firstPr!.body += "\n\nHuman-only deployment note.";
        correctionFeedback = true;
        if (legacyClassifierLayout) {
          const retained = activeAuthority!;
          const attemptId = retained.store.attemptId;
          const canonical = retained.store.read()!;
          const worktreePath = path.join(worktrees, firstWorktreeName);
          // ec180cc threw this untyped error from the classifier on a nonzero
          // process result. Let the real worker handle the failure at that boundary.
          const legacy = vi
            .spyOn(FeedbackClassifier, "classifyCurrentFeedback")
            .mockImplementationOnce(async () => {
              const root = new TaskExecutionStore(
                contextRoot,
                project,
                retained,
              ).processExecutionDirectory("first")!;
              const evidence = beginProcessEvidence(
                "opencode run",
                worktreePath,
                [],
                legacyClassifierLayout === "direct" ? root : undefined,
              );
              evidence.finish("nonzero", { exitCode: 1, treeStopped: true });
              throw new Error(
                "Human feedback classification unavailable; current requests retained",
              );
            });
          const legacyStop = new AbortController();
          let ready = false;
          const warn = Logger.prototype.error;
          const capture = vi.spyOn(Logger.prototype, "error").mockImplementation(function (
            this: Logger,
            message: string,
          ) {
            warn.call(this, message);
            if (
              message.includes(
                "Human feedback classification unavailable; current requests retained",
              )
            ) {
              ready = true;
              legacyStop.abort();
            }
          });
          await runOrchestrator(
            trello,
            git,
            github,
            openCode,
            commands,
            orchestrationConfig,
            legacyStop.signal,
            undefined,
            undefined,
            new Map([
              [project.id, { authority: retained, pinned, projectLease: lease, coordinationRoot }],
            ]),
          );
          capture.mockRestore();
          legacy.mockRestore();
          expect(ready).toBe(true);
          expect(store.read("first")).toMatchObject({
            phase: "human-feedback",
            primarySessionId: sessionId,
            pullRequest: { headSha: originalHead },
          });
          expect(retained.store.read()!.budgets).toEqual(canonical.budgets);
          expect(
            retained.store.read()!.compatibility["feedback-classification-v1"],
          ).toBeUndefined();
          expect(feedbackPrimaryCorrections).toBe(0);
          expect(lists.get("first")).toBe("review");
          await lease.release();

          const resumed = new AbortController();
          let resumedOwnerReady = false;
          classifierUnavailable = false;
          const deadline = setTimeout(() => resumed.abort(), 15_000);
          const timer = setInterval(() => {
            if (
              resumedOwnerReady &&
              !resumed.signal.aborted &&
              lists.get("first") === "review" &&
              store.read("first")?.pullRequest?.headSha !== originalHead &&
              feedbackPrimaryCorrections === 1
            )
              resumed.abort();
          }, 30);
          try {
            await runStartup(
              orchestrationConfig,
              { trello, git, github, opencode: openCode, commands },
              resumed.signal,
              {
                validateToolchain: async () => undefined,
                validateGitHubCli: async () => undefined,
                validateProjectTrello: async () => undefined,
                validateProjectGitHub: async () => undefined,
                runOrchestrator: (...args) => {
                  const resumedOwner = args[9]?.get(project.id)?.authority;
                  expect(resumedOwner?.store.attemptId).toBe(attemptId);
                  expect(resumedOwner?.store.read()?.budgets).toEqual(canonical.budgets);
                  authorities.set("first", resumedOwner!);
                  resumedOwnerReady = true;
                  return runOrchestrator(...args);
                },
              },
            );
          } finally {
            clearTimeout(deadline);
            clearInterval(timer);
          }
          expect(feedbackPrimaryCorrections).toBe(1);
          expect(prs.size).toBe(1);
          expect(requests).toEqual([firstBranch]);
          expect(lists.get("first")).toBe("review");
          return;
        }
        if (feedbackQuality === "classification-outage") {
          const authority = activeAuthority!;
          const attemptId = authority.store.attemptId;
          const clock = Date.now();
          vi.useRealTimers();
          vi.useFakeTimers();
          vi.setSystemTime(clock);
          const delayedReads = vi
            .spyOn(github, "getPullRequestStateByNumber")
            .mockImplementation(async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              return { ...firstPr!, mergedAt: null };
            });
          try {
            let done!: () => void;
            const activeWriter = new Promise<void>((resolve) => {
              done = resolve;
            });
            const observer = withActivePrObservation(
              {
                project,
                github,
                authority,
                signal,
                intervalMs: 20,
                timeoutMs: 5,
                onError: vi.fn(),
              },
              () => activeWriter,
            );
            try {
              await vi.advanceTimersByTimeAsync(85);
              expect(readActivePrObservationHealth(authority)).toMatchObject({
                status: "degraded",
                identity: "timeout",
                failures: 2,
              });
            } finally {
              done();
              await observer;
              await vi.advanceTimersByTimeAsync(10);
            }
          } finally {
            delayedReads.mockRestore();
            vi.useRealTimers();
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(clock + 100);
          }
          await poll();
          expect(feedbackClassifications).toBe(1);
          expect(feedbackPrimaryCorrections).toBe(0);
          expect(lists.get("first")).toBe("review");
          expect(store.read("first")?.pullRequest?.headSha).toBe(originalHead);
          const retainedClassification = authority.store.read()!.compatibility[
            "feedback-classification-v1"
          ] as { active: Record<string, unknown> };
          expect(Object.values(retainedClassification.active)).toMatchObject([
            { status: "waiting", classification: "provider-unavailable", failures: 0, outages: 1 },
          ]);
          activeAuthority = await ProjectRunAuthority.resumeAttempt({
            projectId: project.id,
            attemptId,
            pinned,
            projectLease: lease,
            coordinationRoot,
          });
          authorities.set("first", activeAuthority);
          expect(readActivePrObservationHealth(activeAuthority)).toMatchObject({
            status: "degraded",
            failures: 2,
          });
          git = new GitClient(runGit);
          classifierUnavailable = false;
          await poll();
          expect(feedbackClassifications).toBe(2);
          expect(activeAuthority.store.attemptId).toBe(attemptId);
          expect(store.read("first")?.feedbackRemediation?.feedbackIds).toEqual([
            "inline-comment:203",
            "inline-comment:204",
          ]);
        } else if (feedbackQuality === "validation") {
          await expect(poll()).rejects.toThrow("lost feedback Working acknowledgment");
          expect(store.read("first")?.feedbackCardMove).toMatchObject({
            fromListId: "review",
            toListId: "working",
          });
          expect(feedbackPrimaryCorrections).toBe(0);
          const moves = ledger.filter(
            (event) =>
              event.service === "trello" && event.id === "first" && event.action === "move:working",
          ).length;
          await poll();
          expect(
            ledger.filter(
              (event) =>
                event.service === "trello" &&
                event.id === "first" &&
                event.action === "move:working",
            ),
          ).toHaveLength(moves);
        } else {
          await poll();
        }
        const corrected = store.read("first")!;
        expect(firstPr?.body).toContain("Human-only deployment note.");
        expect(firstPr?.body).not.toContain("remediation is in progress");
        if (feedbackQuality === "no-op") {
          expect(corrected.pullRequest!.headSha).toBe(originalHead);
          expect(corrected.feedbackRemediation).toMatchObject({
            status: "no-op",
            outcomeReported: true,
          });
          expect(firstPr?.body).toContain("left the source unchanged");
          expect(firstPr?.isDraft).toBe(true);
          expect(lists.get("first")).toBe("review");
          await poll();
          await poll();
          expect(feedbackPrimaryCorrections).toBe(1);
          expect(feedbackReplyBodies).toHaveLength(1);
          expect(feedbackReplyBodies[0]).toContain("This request remains unresolved");
          expect(store.read("first")?.pullRequest?.headSha).toBe(originalHead);
          return;
        }
        expect(corrected.pullRequest!.headSha).not.toBe(originalHead);
        expect(corrected.validationRepair?.cycleId).not.toBe(originalValidationCycle);
        expect(
          await git.isAncestor(
            path.join(worktrees, firstWorktreeName),
            originalHead,
            corrected.pullRequest!.headSha!,
          ),
        ).toBe(true);
        expect(corrected.primarySessionId).toBe(sessionId);
        expect(corrected.phase).toBe("ci");
        expect(corrected.expectedTrelloListId).toBe("review");
        expect(corrected.feedbackCardMove).toBeUndefined();
        expect(lists.get("first")).toBe("review");
        expect(feedbackPrimaryCorrections).toBe(1);
        expect(prs.size).toBe(1);
        expect(firstPr?.isDraft).toBe(true);
        if (feedbackQuality === "validation") {
          expect(corrected.publicationQuality?.validation).toMatchObject({
            status: "failed",
            exitCode: 1,
          });
          expect(firstPr?.body).toContain("failed");
        } else if (feedbackQuality !== "classification-outage") {
          expect(corrected.publicationQuality?.review).toBeNull();
          expect(Object.values(corrected.feedbackRemediation?.reviewSourceAttempts ?? {})).toEqual([
            3,
          ]);
          expect(firstPr?.body).toContain("Independent AI review: unavailable");
        }
        expect(lists.get("next")).toBe("ready");
        return;
      }
      if (feedbackReviewRecovery !== undefined) {
        const originalHead = store.read("first")!.pullRequest!.headSha;
        let writesStopped = false;
        let interrupted: TaskExecutionRecord | undefined;
        const fault = new Error("Simulated feedback checkpoint interruption");
        const compare = TaskExecutionStore.prototype.compareAndSwap;
        const interception = vi
          .spyOn(TaskExecutionStore.prototype, "compareAndSwap")
          .mockImplementation(function (this: TaskExecutionStore, cardId, revision, next) {
            if (writesStopped) throw fault;
            const persisted = compare.call(this, cardId, revision, next);
            const repair = persisted.reviewRepair;
            if (
              (feedbackReviewRecovery === "before-review" ||
                (feedbackReviewRecovery === "active-validation" &&
                  persisted.validationRepair?.status === "active")) &&
              persisted.feedbackRemediation?.status === "changed" &&
              persisted.phase === "validation" &&
              repair === undefined
            ) {
              interrupted = persisted;
              writesStopped = true;
              throw fault;
            }
            if (
              persisted.feedbackRemediation?.status !== "changed" ||
              !repair?.cycleId.includes(":feedback:")
            )
              return persisted;
            const reservation = repair.activePrimaryOperation;
            const primary = reservation && persisted.primaryOperations?.[reservation.operationId];
            const matches =
              feedbackReviewRecovery === "reserved"
                ? reservation !== undefined && primary === undefined
                : feedbackReviewRecovery === "completed"
                  ? reservation !== undefined &&
                    primary?.status === "completed" &&
                    persisted.phase === "implementation"
                  : feedbackReviewRecovery === "validation"
                    ? reservation !== undefined &&
                      primary?.status === "completed" &&
                      persisted.phase === "validation"
                    : feedbackReviewRecovery === "reviewed" && repair.status === "passed";
            if (matches) {
              interrupted = persisted;
              writesStopped = true;
              throw fault;
            }
            return persisted;
          });
        correctionFeedback = true;
        try {
          await poll();
        } catch (error) {
          expect(feedbackReviewRecovery).not.toBe("unknown");
          expect(error).toBeInstanceOf(Error);
        }
        expect(writesStopped).toBe(feedbackReviewRecovery !== "unknown");
        interception.mockRestore();
        writesStopped = false;
        interrupted ??= store.read("first") ?? undefined;
        expect(interrupted?.feedbackRemediation).toMatchObject({
          status: "changed",
          feedbackIds: ["review:202"],
        });
        expect(feedbackPrimaryCorrections).toBe(1);
        const reservation = interrupted?.reviewRepair?.activePrimaryOperation;
        if (
          feedbackReviewRecovery !== "reviewed" &&
          feedbackReviewRecovery !== "before-review" &&
          feedbackReviewRecovery !== "active-validation"
        )
          expect(reservation).toBeDefined();
        const originalPrompt =
          reservation?.promptArtifact === undefined
            ? undefined
            : (new TaskExecutionStore(
                contextRoot,
                project,
                activeAuthority,
              ).readPrimaryResultArtifact({
                reference: reservation.promptArtifact.reference as `sha256:${string}`,
                bytes: reservation.promptArtifact.bytes,
                ...(reservation.promptArtifact.path === undefined
                  ? {}
                  : { path: reservation.promptArtifact.path }),
              }) as { prompt: string } | undefined);
        const beforeRestart = feedbackReviewDispatches.length;
        const reviewedSource = fs.readFileSync(
          path.join(worktrees, firstWorktreeName, "app.js"),
          "utf8",
        );
        // New observations must not replace the round that owns the persisted writer.
        feedbackBody =
          "A different human request arrived while the original correction was paused.";
        git = new GitClient(runGit);
        for (let pass = 0; pass < 5; pass += 1) {
          await poll();
          if (
            feedbackReviewRecovery !== "unknown" &&
            store.read("first")?.pullRequest?.headSha !== originalHead
          )
            break;
        }
        const resumed = store.read("first")!;
        expect(feedbackPrimaryCorrections).toBe(1);
        expect(lists.get("first")).toBe(
          feedbackReviewRecovery === "unknown" ? "working" : "review",
        );
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        if (feedbackReviewRecovery === "unknown") {
          expect(feedbackReviewDispatches).toHaveLength(beforeRestart);
          expect(resumed.pullRequest?.headSha).toBe(originalHead);
          expect(resumed.reviewRepair?.activePrimaryOperation).toEqual(reservation);
          expect(resumed.primaryOperations?.[reservation!.operationId]?.status).toBe("ambiguous");
          expect(resumed.recoveryWait).toBeDefined();
          expect(fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"), "utf8")).toBe(
            reviewedSource,
          );
        } else {
          expect(feedbackReviewDispatches).toHaveLength(1);
          if (reservation !== undefined)
            expect(feedbackReviewDispatches[0]).toEqual({
              operationId: reservation.operationId,
              prompt: originalPrompt!.prompt,
              sessionId,
            });
          expect(resumed.reviewRepair?.activePrimaryOperation).toBeUndefined();
          expect(resumed.reviewRepair).toMatchObject({
            status: "passed",
            maxAttempts: 1,
          });
          expect(resumed.retryCounters.review).toBe(1);
          expect(resumed.phase).toBe("ci");
          expect(resumed.pullRequest?.headSha).not.toBe(originalHead);
          expect(authorities.get("first")?.store.read()?.budgets.review).toMatchObject({
            used: 1,
            episodeId: resumed.reviewRepair?.cycleId,
          });
        }
        return;
      }
      if (correctionFailure) {
        const worktree = path.join(worktrees, firstWorktreeName);
        const unshippedPath = path.join(worktree, "reviewer-followup.ts");
        correctionFeedback = true;
        for (
          let attempt = 0;
          attempt < 8 && store.read("first")?.primaryOperations === undefined;
          attempt += 1
        )
          await poll();
        for (
          let attempt = 0;
          attempt < 8 &&
          (store.read("first")?.primaryOperations?.[
            Object.keys(store.read("first")?.primaryOperations ?? {}).at(-1) ?? ""
          ]?.failureExecutions ?? 0) < 3;
          attempt += 1
        )
          await poll();
        const exhaustedRecord = store.read("first")!;
        fs.writeFileSync(unshippedPath, "local reviewer follow-up\n");
        const correctionOperation = Object.values(exhaustedRecord.primaryOperations ?? {}).find(
          (entry) => entry.activity === "feedback-remediation",
        );
        expect(correctionOperation).toMatchObject({
          status: "exhausted",
          executions: 3,
          failureExecutions: 3,
          accountedExecution: 3,
        });
        const callsFile = path.join(worktree, "primary-cli-calls.jsonl");
        expect(
          fs.existsSync(callsFile),
          JSON.stringify({
            operation: correctionOperation,
            stderr: fs.readFileSync(
              path.join(path.dirname(correctionOperation!.processMetadataPath!), "stderr.txt"),
              "utf8",
            ),
          }),
        ).toBe(true);
        expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toHaveLength(3);
        const metadata = JSON.parse(
          fs.readFileSync(correctionOperation!.processMetadataPath!, "utf8"),
        ) as Record<string, unknown>;
        expect(metadata).toMatchObject({
          status: "nonzero",
          treeStopped: true,
          // Bubblewrap propagates a killed inner process as 128 + SIGKILL.
          // Record the supervisor's actual outcome, not an invented outer signal.
          exitCode: 1,
          signal: "SIGKILL",
        });
        expect(exhaustedRecord).toMatchObject({
          phase: "human-feedback",
          primarySessionId: sessionId,
          pullRequest: { number: 41, url: firstPr!.url },
          recoveryWait: { kind: "dependency", resumePhase: "human-feedback" },
        });
        expect(fs.readFileSync(unshippedPath, "utf8")).toBe("local reviewer follow-up\n");
        expect(lists.get("first")).toBe("review");
        expect(lists.get("next")).toBe("ready");
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        expect(authorities.get("first")?.store.read()).toMatchObject({
          cardId: "first",
          lifecycle: "waiting",
          terminalSync: "not-applicable",
        });
        expect(openCodeCards).not.toContain("next");
        const correctionExecutions = openCodeCards.filter((cardId) => cardId === "first").length;
        const reopenedTaskStore = new TaskExecutionStore(contextRoot, project, activeAuthority!);
        expect(
          reopenedTaskStore.read("first")?.primaryOperations?.[correctionOperation!.id],
        ).toMatchObject({ status: "exhausted", failureExecutions: 3 });
        await poll();
        await poll();
        expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toHaveLength(3);
        expect(openCodeCards.filter((cardId) => cardId === "first")).toHaveLength(
          correctionExecutions,
        );
        expect(store.read("next")).toBeNull();
        expect(lists.get("next")).toBe("ready");
        expect(requests).toEqual([firstBranch]);
        expect(fs.readFileSync(unshippedPath, "utf8")).toBe("local reviewer follow-up\n");
      }
      if (!correctionFailure) {
        const recoveryStore = new TaskExecutionStore(contextRoot, project, activeAuthority!);
        const checkpoint = recoveryStore.read("first")!;
        recoveryStore.compareAndSwap("first", checkpoint.revision, {
          ...checkpoint,
          recoveryWait: {
            kind: "dependency",
            reason: "Human Review dependency temporarily unavailable",
            resumePhase: "human-feedback",
            since: new Date().toISOString(),
            retryAt: new Date(Date.now() + 60_000).toISOString(),
            attempts: 1,
            notificationId: "lifecycle-project/first/human-feedback/dependency",
          },
          revision: checkpoint.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        const feedbackReadsBeforeWait = feedbackReads;
        lists.set("first", "backlog");
        await poll();
        expect(recoveryStore.read("first")).toMatchObject({
          phase: "human-feedback",
          recoveryWait: { resumePhase: "human-feedback" },
        });
        expect(feedbackReads).toBe(feedbackReadsBeforeWait);
        expect(lists.get("next")).toBe("ready");

        // Let the persisted dependency interval expire so canonical polling
        // observes the actual externally moved card rather than short-circuiting
        // on the existing wait. This is still an OPEN PR and must not become a
        // terminal success merely because Trello says Backlog.
        const dependencyWait = recoveryStore.read("first")!;
        recoveryStore.compareAndSwap("first", dependencyWait.revision, {
          ...dependencyWait,
          recoveryWait: {
            ...dependencyWait.recoveryWait!,
            retryAt: new Date(Date.now() - 1).toISOString(),
          },
          revision: dependencyWait.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        const checkpointSession = recoveryStore.read("first")?.primarySessionId;
        const retainedWorktreeBytes = fs.readFileSync(
          path.join(worktrees, firstWorktreeName, "app.js"),
        );
        await poll();
        expect(recoveryStore.read("first")).toMatchObject({
          phase: "human-feedback",
          recoveryWait: { kind: "manual-move", resumePhase: "human-feedback" },
        });
        expect(authorities.get("first")?.store.read()).toMatchObject({
          lifecycle: "waiting",
          terminalSync: "not-applicable",
        });
        expect(recoveryStore.read("first")?.primarySessionId).toBe(checkpointSession);
        expect(fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"))).toEqual(
          retainedWorktreeBytes,
        );
        expect(feedbackReads).toBe(feedbackReadsBeforeWait);
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        const reopenedPausedStore = new TaskExecutionStore(contextRoot, project, activeAuthority!);
        expect(reopenedPausedStore.read("first")?.recoveryWait?.kind).toBe("manual-move");

        // Run a normal production publication for a distinct project while A
        // remains paused. This is independent fixture state and sequential
        // polling, not a simultaneous-worker or live-provider claim.
        vi.useFakeTimers({ toFake: ["Date"] });
        const projectBRoot = path.join(root, "project-b");
        fs.mkdirSync(projectBRoot);
        const projectB = createPublicationFixture(projectBRoot, undefined, "project-b");
        const projectBPlans = new TaskPlanStore(
          projectB.project.contextRoot,
          projectB.project,
          projectB.authority,
        );
        await projectB.authority.run(async () => {
          await projectBPlans.create(
            {
              version: 1,
              projectId: "project-b",
              cardId: "card",
              requirements: [{ id: "REQ-1", text: "Publish", verification: "Check CI" }],
              steps: [
                {
                  id: "STEP-1",
                  description: "Publish project B",
                  requirementIds: ["REQ-1"],
                  verification: "Build passes",
                },
              ],
              assumptions: [],
              blockers: [],
            },
            1,
          );
          await projectBPlans.storeVerification("card", 1, {
            version: 1,
            projectId: "project-b",
            cardId: "card",
            planRevision: 1,
            verdict: "pass",
            findings: [],
          });
        });
        projectB.services.github.getCiObservations = async ({ headSha }) => ({
          headSha,
          checks: [
            {
              source: "check-run",
              id: 1,
              name: "Build",
              headSha,
              status: "completed",
              conclusion: "success",
              url: null,
            },
          ],
          expectationSources: [
            {
              kind: "repository-rules",
              sourceId: "fixture",
              complete: true,
              checkNames: ["Build"],
            },
          ],
        });
        const projectBCard = projectB.services.card();
        const projectBIdentity = await getTaskSessionSourceSnapshotIdentity(
          projectB.git,
          projectB.worktreePath,
        );
        projectB.authority.run(() =>
          beginInitialPublication(
            {
              project: projectB.project,
              card: projectBCard,
              git: projectB.git,
              trello: projectB.services.trello,
              github: projectB.services.github,
              worktreePath: projectB.worktreePath,
              branch: "agent/card",
              commitMessage: "feat: publish project B",
              reviewResult: "Passed",
              remediationResult: "Not required",
            },
            "Trello: https://trello.com/c/card",
            projectBIdentity,
          ),
        );
        for (let attempt = 0; attempt < 12; attempt += 1) {
          vi.setSystemTime(Date.now() + 60_000);
          await projectB.authority.run(() =>
            withGitHubOperationProject(projectB.project, () =>
              pollProject(
                projectB.services.trello,
                projectB.git,
                projectB.services.github,
                {
                  run: () => {
                    throw new Error("Project B publication must not invoke AI");
                  },
                } as never,
                {} as never,
                projectB.project,
                new AbortController().signal,
                undefined,
                undefined,
                undefined,
                projectB.authority,
              ),
            ),
          );
          if (projectB.store.read()?.lifecycle === "human-review") break;
        }
        expect(projectB.store.read()).toMatchObject({
          projectId: "project-b",
          cardId: "card",
          lifecycle: "human-review",
          publicationState: "open",
        });
        expect(projectB.services.read().list).toBe("review");
        expect(projectB.store.read()?.queue).toEqual([]);
        expect(reopenedPausedStore.read("first")).toMatchObject({
          phase: "human-feedback",
          recoveryWait: { kind: "manual-move" },
        });
        expect(fs.readFileSync(path.join(worktrees, firstWorktreeName, "app.js"))).toEqual(
          retainedWorktreeBytes,
        );

        // A terminal-looking Done placement has the same pause semantics:
        // Trello list placement alone cannot assert a merged PR.
        lists.set("first", "done");
        const backlogWait = recoveryStore.read("first")!;
        recoveryStore.compareAndSwap("first", backlogWait.revision, {
          ...backlogWait,
          recoveryWait: {
            ...backlogWait.recoveryWait!,
            retryAt: new Date(Date.now() - 1).toISOString(),
          },
          revision: backlogWait.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        await poll();
        expect(recoveryStore.read("first")).toMatchObject({
          phase: "human-feedback",
          recoveryWait: { kind: "manual-move", resumePhase: "human-feedback" },
        });
        expect(authorities.get("first")?.store.read()).toMatchObject({
          lifecycle: "waiting",
          terminalSync: "not-applicable",
        });
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();

        // Reopen the durable attempt while paused, restore the expected list,
        // then require production polling to revalidate Git/session/PR state
        // before it clears the wait and resumes the same checkpoint.
        lists.set("first", "review");
        await poll();
        expect(reopenedPausedStore.read("first")?.recoveryWait).toBeUndefined();
        expect(reopenedPausedStore.read("first")?.phase).toBe("human-feedback");
        expect(reopenedPausedStore.read("first")?.primarySessionId).toBe(checkpointSession);
        await poll();
        expect(lists.get("next")).toBe("ready");
        expect(ledger.some((event) => event.id === "next" && event.action === "move:working")).toBe(
          false,
        );
        expect(store.read("next")).toBeNull();
        expect(fs.existsSync(path.join(worktrees, "next"))).toBe(false);
        expect(
          [...prs.values()].filter(({ headBranch }) => headBranch === "agent/next"),
        ).toHaveLength(0);
        firstPr!.reviewDecision = "APPROVED";
        await poll();
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        const publishedHeadSha = (await git.getRemoteBranchSha(
          source,
          "origin",
          firstBranch,
          project,
        ))!;
        expect(publishedHeadSha).toMatch(/^[0-9a-f]{40}$/u);
        expect(await gitRun(source, "show", `${publishedHeadSha}:app.js`)).toBe(
          preparedReview === undefined
            ? "module.exports = 'implemented';"
            : "module.exports = 'prepared publication source';",
        );
        expect(
          Number(
            await gitRun(source, "rev-list", "--count", `${initialHead}..${publishedHeadSha}`),
          ),
        ).toBe(1);
      }
      const sha = correctionFailure
        ? firstPr!.headRefOid
        : (await git.getRemoteBranchSha(source, "origin", firstBranch, project))!;
      // Exercise terminal handling against the canonical authority-backed task
      // projection, including a durable recovery wait (not a standalone store).
      const terminalTaskStore = new TaskExecutionStore(contextRoot, project, activeAuthority!);
      const waitingTask = terminalTaskStore.read("first")!;
      terminalTaskStore.compareAndSwap("first", waitingTask.revision, {
        ...waitingTask,
        recoveryWait: {
          kind: "dependency",
          reason: "GitHub temporarily unavailable",
          resumePhase: "human-feedback",
          since: new Date().toISOString(),
          retryAt: new Date(Date.now() + (terminalReadRaceAt === 3 ? -1 : 60_000)).toISOString(),
          attempts: 1,
          notificationId: "lifecycle-project/first/terminal-test/dependency",
        },
        revision: waitingTask.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      expect(terminalTaskStore.read("first")?.recoveryWait).toBeDefined();
      ledger.push({
        service: "github",
        action: `human-${terminal}`,
        actor: "human",
        id: "41",
      });
      // The ordinary review observer first sees OPEN. The independent recovery
      // read then sees the PR become terminal while the card is still in Review.
      firstPr!.state = "OPEN";
      firstPr!.headRefOid = sha;
      terminalRaceTarget = terminal === "merged" ? "MERGED" : "CLOSED";
      terminalRaceReadAt = terminalReadRaceAt;
      const openCodeCountBeforeRace = openCodeCards.length;
      if (correctionFailure) {
        blockTerminalDestinationRead = true;
        let terminalReadFailure: unknown;
        for (let attempt = 0; attempt < 8 && terminalReadFailure === undefined; attempt += 1) {
          try {
            await poll();
          } catch (error) {
            terminalReadFailure = error;
          }
        }
        expect(terminalReadFailure).toBeInstanceOf(Error);
        expect(String(terminalReadFailure)).toContain(
          "simulated terminal Trello destination read outage",
        );
        expect(terminalRaceReads).toBe(terminalReadRaceAt);
        expect(lists.get("first")).toBe(destination);
        expect(authorities.get("first")?.store.read()).toMatchObject({
          cardId: "first",
          lifecycle: "waiting",
          terminalSync: "not-applicable",
        });
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        expect(openCodeCards).toHaveLength(openCodeCountBeforeRace);
        const reopenedTaskStore = new TaskExecutionStore(contextRoot, project, activeAuthority!);
        const exhaustedOperationId =
          terminalTaskStore.read("first")!.feedbackRemediation!.operationId;
        expect(
          reopenedTaskStore.read("first")?.primaryOperations?.[exhaustedOperationId],
        ).toMatchObject({ status: "exhausted", failureExecutions: 3 });
        expect(
          new TaskMutationQueue(contextRoot, project, activeAuthority!)
            .list()
            .find((entry) => entry.eventId === exhaustedOperationId),
        ).toMatchObject({
          kind: "feedback",
          status: "retired",
          retirementReason: "human-pr-terminal",
        });
        await expect(poll()).rejects.toThrow("simulated terminal Trello destination read outage");
        expect(authorities.get("first")?.store.read()).toMatchObject({
          lifecycle: "waiting",
          terminalSync: "not-applicable",
        });
        expect(openCodeCards).toHaveLength(openCodeCountBeforeRace);
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        expect(
          fs.readFileSync(path.join(worktrees, firstWorktreeName, "reviewer-followup.ts"), "utf8"),
        ).toBe("local reviewer follow-up\n");
        blockTerminalDestinationRead = false;
        for (let attempt = 0; attempt < 8 && activeAuthority !== undefined; attempt += 1)
          await poll();
      } else {
        await poll();
      }
      expect(terminalRaceReads).toBe(terminalReadRaceAt);
      // A terminal outcome discovered at the final observation read now bypasses
      // the future dependency wait immediately, rather than requiring another poll.
      if (!correctionFailure) {
        if (terminalReadRaceAt === 3)
          expect(terminalTaskStore.read("first")).toMatchObject({
            phase: "human-feedback",
            recoveryWait: { resumePhase: "human-feedback" },
          });
        else {
          expect(terminalTaskStore.read("first")?.phase).toBe("done");
          expect(terminalTaskStore.read("first")?.recoveryWait).toBeUndefined();
        }
      }
      expect(["review", "working", destination]).toContain(lists.get("first"));
      expect(openCodeCards).toHaveLength(openCodeCountBeforeRace);
      for (let attempt = 0; attempt < 12 && activeAuthority !== undefined; attempt += 1)
        await poll();
      expect(lists.get("first")).toBe(destination);
      expect(terminalRaceReads).toBeGreaterThanOrEqual(2);
      const firstAuthority = authorities.get("first");
      expect(firstAuthority?.store.read()).toMatchObject({
        lifecycle: terminal === "merged" ? "done" : "cancelled",
        terminalSync: "verified",
      });
      if (correctionFailure) {
        expect(openCodeCards).toHaveLength(openCodeCountBeforeRace);
        expect(requests).toEqual([firstBranch]);
        expect(prs.size).toBe(1);
        expect(fs.existsSync(path.join(worktrees, firstWorktreeName))).toBe(true);
        expect(
          fs.readFileSync(path.join(worktrees, firstWorktreeName, "reviewer-followup.ts"), "utf8"),
        ).toBe("local reviewer follow-up\n");
      }
      expect(terminalTaskStore.read("first")?.recoveryWait).toBeUndefined();
      if (terminal === "merged") expect(terminalTaskStore.read("first")?.phase).toBe("done");
      const terminalReadback = await (
        trello as unknown as {
          getCard: (id: string) => Promise<TrelloCard>;
        }
      ).getCard("first");
      expect(terminalReadback.idList).toBe(destination);
      expect(ledger.some((event) => event.id === "next" && event.action === "move:working")).toBe(
        false,
      );
      expect((await trello.getCards("ready")).some(({ id }) => id === "next")).toBe(true);
      expect(
        ledger.some(
          (event) =>
            event.id === "41" && event.actor === "human" && event.action === `human-${terminal}`,
        ),
      ).toBe(true);
      const closureComment = [...ledger]
        .reverse()
        .find(
          ({ service, action, id }) =>
            service === "trello" && action === "comment" && id === "first",
        );
      expect(closureComment?.detail).toContain(firstPr!.url);
      if (terminal === "closed")
        expect(closureComment?.detail).toContain("closed without being merged");
      expect(
        ledger.findIndex(
          ({ actor, action }) => actor === "human" && action === `human-${terminal}`,
        ),
      ).toBeLessThan(ledger.length);
      trapNextClaim = true;
      await expect(poll()).rejects.toThrow("observed next claim boundary");
      expect(authorities.get("next")?.store.read()).toMatchObject({
        cardId: "next",
        lifecycle: "planning",
      });
      expect(
        fs.existsSync(path.join(contextRoot, "task-executions", project.id, "next.json")),
      ).toBe(false);
      expect(ledger.some((event) => event.id === "next" && event.action === "move:working")).toBe(
        true,
      );
      const terminalDestinationReadIndex = ledger.reduce(
        (lastIndex, entry, index) =>
          entry.id === "first" && entry.action === "read-card" && entry.detail === destination
            ? index
            : lastIndex,
        -1,
      );
      expect(
        ledger.findIndex(
          ({ actor, action }) => actor === "human" && action === `human-${terminal}`,
        ),
      ).toBeLessThan(terminalDestinationReadIndex);
      expect(terminalDestinationReadIndex).toBeLessThan(
        ledger.findIndex(({ id, action }) => id === "next" && action === "move:working"),
      );
      expect(gitCalls.some((args) => args.some((arg) => /(^|:)force|--force/u.test(arg)))).toBe(
        false,
      );
      expect(gitCalls.some((args) => args.includes("rebase"))).toBe(false);
      expect(ledger.some((event) => /auto.?merge|merge-pr/u.test(event.action))).toBe(false);
      expect(await git.getHeadSha(source)).toBe(
        await git.resolveCommitSha(source, "refs/remotes/origin/main"),
      );
      expect(await git.getHeadSha(source)).toBe(initialHead);
      expect(await git.getCurrentBranch(source)).toBe(initialBranch);
      expect(await git.getStatus(source)).toBe(initialStatus);
      expect(await git.getIndexEntries(source)).toBe(initialIndex);
      expect(
        new Map(
          initialTracked.map((file) => [
            file,
            createHash("sha256")
              .update(fs.readFileSync(path.join(source, file)))
              .digest("hex"),
          ]),
        ),
      ).toEqual(initialHashes);
      expect(accepted).toEqual([firstPr?.url]);
      expect(firstPr?.number).toBe(41);
      expect(firstPr?.isDraft).toBe(draft || correctionFailure === true);
      expect(
        ledger.filter(({ action }) => action.startsWith("attempt:") && /merge/u.test(action)),
      ).toHaveLength(0);
      expect(ledger.filter(({ action }) => action === "comment").length).toBeGreaterThan(0);
      expect(
        ledger.some(({ action, detail }) => action === "comment" && detail?.includes(firstPr!.url)),
      ).toBe(true);
    },
    60_000,
  );
});
