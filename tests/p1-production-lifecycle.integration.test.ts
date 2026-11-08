import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
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
import {
  OpenCodeClient,
  type OpenCodeRunOptions,
} from "../src/opencode/opencode-client.js";
import { getCommitResultPath } from "../src/opencode/commit-result.js";
import {
  CommandRunner,
  type CommandRunOptions,
} from "../src/process/command-runner.js";
import { pollProject } from "../src/orchestrator/poll-project.js";
import { TaskExecutionStore } from "../src/task-session/task-execution-store.js";
import type { TrelloCard, TrelloClient } from "../src/trello/trello-client.js";

const execFile = promisify(nodeExecFile);
let roots: string[] = [];
const leases: ProjectOwnershipLease[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("P1 production lifecycle through pollProject", () => {
  it.each([
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      terminalReadRaceAt: 2,
    },
    {
      draft: true,
      terminal: "closed",
      destination: "backlog",
      ackLoss: false,
      terminalReadRaceAt: 3,
    },
    {
      draft: false,
      terminal: "merged",
      destination: "done",
      ackLoss: false,
      terminalReadRaceAt: 3,
    },
    { draft: false, terminal: "merged", destination: "done", ackLoss: true },
  ] as const)(
    ({
      draft,
      terminal,
      ackLoss,
    }: {
      draft: boolean;
      terminal: string;
      ackLoss: boolean;
    }) =>
      ackLoss
        ? "reconciles an accepted PR whose create acknowledgement was lost without claiming the next card"
        : `publishes a ${draft ? "draft" : "normal"} PR and waits for human ${terminal} before releasing the next card`,
    async ({
      draft,
      terminal,
      destination,
      ackLoss,
      terminalReadRaceAt = 2,
    }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-lifecycle-"));
      roots.push(root);
      const home = path.join(root, "home");
      const source = path.join(root, "source");
      const remote = path.join(root, "remote.git");
      const worktrees = path.join(root, "worktrees");
      const contextRoot = path.join(root, "context");
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
      const gitRun = async (cwd: string, ...args: string[]) =>
        runGit(cwd, args);
      await gitRun(root, "init", "--bare", "--initial-branch=main", remote);
      await gitRun(root, "clone", remote, source);
      await gitRun(source, "config", "user.name", "Fixture");
      await gitRun(source, "config", "user.email", "fixture@example.test");
      fs.writeFileSync(
        path.join(source, "app.js"),
        "module.exports = 'base';\n",
      );
      await gitRun(source, "add", ".");
      await gitRun(source, "commit", "-m", "initial");
      await gitRun(source, "push", "-u", "origin", "main");
      await gitRun(
        source,
        "remote",
        "set-url",
        "origin",
        "https://github.com/owner/repo.git",
      );

      const project: ProjectConfig & { contextRoot: string } = {
        id: "p1",
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
          validationCommand: "node validate.js",
          gitIdentity: { name: "Agent", email: "agent@example.test" },
        },
        opencode: {
          refinement: { model: "refine", variant: "high" },
          implementation: { model: "implement", variant: "high" },
          review: { model: "review", variant: "high" },
          remediation: { model: "repair", variant: "high", maxPasses: 1 },
          commit: { model: "commit", variant: "low" },
          timeoutMinutes: 1,
        },
      };
      const coordinationRoot = path.join(root, "coordination");
      fs.mkdirSync(coordinationRoot);
      provisionCoordinationNamespace(coordinationRoot, "p1-test");
      const orchestrationConfig = {
        projects: [project],
        workflow: {
          contextRoot,
          coordinationRoot,
          coordinationNamespaceId: "p1-test",
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
        "p1-test",
      );
      leases.push(lease);
      const hostPin = (
        await verifyAndPinProjects(orchestrationConfig, [lease])
      )[0]!;
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
        "if (process.env.FAIL_VALIDATION === '1') process.exit(1);\n",
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
      const trello = {
        getCards: async (listId: string) =>
          cards
            .filter((card) => lists.get(card.id) === listId)
            .map((card) => {
              ledger.push({
                service: "trello",
                action: `read-cards:${listId}`,
                actor: "orchestrator",
                id: card.id,
              });
              return { ...card, idList: listId };
            }),
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
                entry.service === "trello" &&
                entry.action === "comment" &&
                entry.id === id,
            )
            .map((entry, index) => ({
              id: `comment-${index}`,
              text: entry.detail!,
            })),
        getCardAttachments: async () => [],
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
      let loseCreateAcknowledgement = false;
      let feedbackReads = 0;
      let terminalRaceTarget: "MERGED" | "CLOSED" | null = null;
      let terminalRaceReads = 0;
      let terminalRaceReadAt = 2;
      let github = {
        findPullRequest: async (input: { headBranch: string }) => {
          const pr = prs.get(input.headBranch);
          return pr ? { number: pr.number, url: pr.url } : null;
        },
        findPullRequestState: async (input: { headBranch: string }) => {
          const pr = prs.get(input.headBranch);
          if (terminalRaceTarget !== null && pr?.state === "OPEN") {
            terminalRaceReads += 1;
            if (terminalRaceReads === terminalRaceReadAt)
              pr.state = terminalRaceTarget;
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
        ensurePullRequestDraft: async (input: { pullRequestUrl: string }) => {
          const pr = [...prs.values()].find(
            ({ url }) => url === input.pullRequestUrl,
          );
          if (pr) pr.isDraft = true;
        },
        getPullRequestPublicationFields: async (input: {
          pullRequestUrl: string;
        }) => {
          const pr = [...prs.values()].find(
            (candidate) => candidate.url === input.pullRequestUrl,
          );
          if (!pr) throw new Error("PR not found");
          return { title: pr.title, body: pr.body, isDraft: pr.isDraft };
        },
        createPullRequest: async (input: {
          headBranch: string;
          draft?: boolean;
          title: string;
          body: string;
        }) => {
          requests.push(input.headBranch);
          ledger.push({
            service: "github",
            action: "request:create-pr",
            actor: "orchestrator",
            detail: input.headBranch,
          });
          if (prs.has(input.headBranch))
            throw new Error("duplicate pull request for branch");
          const sha = await git.getRemoteBranchSha(
            source,
            "origin",
            input.headBranch,
            project,
          );
          if (!sha)
            throw new Error(
              `missing pushed remote head for ${input.headBranch}`,
            );
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
            throw new Error(
              "simulated lost create-PR acknowledgement after acceptance",
            );
          }
          return { number, url };
        },
        getCiObservations: async ({ headSha }: { headSha: string }) => ({
          headSha,
          checks: [
            {
              source: "check-run" as const,
              id: 1,
              name: "Build",
              headSha,
              status: "completed" as const,
              conclusion: "success",
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
        }),
        findChangesRequestedPullRequest: async () => null,
        getPullRequestConversationComments: async () => {
          feedbackReads += 1;
          return [];
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
      const openCode = new OpenCodeClient(
        async (options: OpenCodeRunOptions) => {
          const cardId = path.basename(options.cwd);
          openCodeCards.push(cardId);
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
            if (!identity)
              throw new Error(
                "review prompt did not contain snapshot identity",
              );
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
                    details: "Implemented",
                    evidence: ["app.js"],
                  },
                ],
                blockingFindings: [],
                reviewedContentIdentity: identity,
              }),
              errorOutput: "",
            };
          }
          if (options.prompt.includes("Implement the approved task plan")) {
            if (
              options.sessionId !== sessionId ||
              options.sessionLabel === undefined
            )
              throw new Error(
                "implementation did not resume named primary session",
              );
            const child = await execFile(
              process.execPath,
              [
                "-e",
                "require('fs').writeFileSync('app.js', \"module.exports = 'implemented';\\n\")",
              ],
              { cwd: options.cwd, env, timeout: 10_000 },
            );
            void child;
          }
          if (options.prompt.includes("Generate the commit message")) {
            const resultPath = getCommitResultPath(options.cwd);
            fs.mkdirSync(path.dirname(resultPath), { recursive: true });
            fs.writeFileSync(
              resultPath,
              JSON.stringify({ message: "feat: implement requested change" }),
            );
          }
          return { exitCode: 0, output: "completed", errorOutput: "" };
        },
      );
      const commands = new CommandRunner(async (options: CommandRunOptions) => {
        if (options.command.startsWith("opencode session list"))
          return {
            exitCode: 0,
            output: JSON.stringify([{ id: sessionId, directory: options.cwd }]),
            errorOutput: "",
          };
        try {
          const result = await execFile("/bin/sh", ["-c", options.command], {
            cwd: options.cwd,
            env: {
              ...env,
              ...(draft && options.command.includes("node validate.js")
                ? { FAIL_VALIDATION: "1" }
                : {}),
            },
            timeout: options.timeoutMilliseconds ?? 20_000,
          });
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
          return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            output: failure.stdout ?? "",
            errorOutput: failure.stderr ?? failure.message,
          };
        }
      });
      const signal = new AbortController().signal;
      const authorities = new Map<string, ProjectRunAuthority>();
      let activeAuthority: ProjectRunAuthority | undefined;
      vi.useFakeTimers({ toFake: ["Date"] });
      const poll = async () => {
        vi.setSystemTime(Date.now() + 15_001);
        if (activeAuthority === undefined) {
          const eligible = await trello.getCards(project.trello.readyListId);
          const selected = eligible.find((card) =>
            card.idLabels.includes("feature"),
          );
          if (selected === undefined) return;
          activeAuthority = await ProjectRunAuthority.createPreparingAttempt({
            projectId: project.id,
            cardId: selected.id,
            taskKind: "implementation",
            pinned,
            projectLease: lease,
            coordinationRoot,
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
          activeAuthority.claim();
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
            ),
          ),
        );
        const completed = authority.store.read();
        if (
          completed &&
          ["done", "refined", "failed", "cancelled"].includes(
            completed.lifecycle,
          ) &&
          completed.terminalSync === "verified"
        ) {
          await authority.releaseVerifiedTerminal();
          activeAuthority = undefined;
        }
      };
      const store = {
        read: (cardId: string) => {
          const authority = authorities.get(cardId);
          return new TaskExecutionStore(contextRoot, project, authority).read(
            cardId,
          );
        },
      };
      loseCreateAcknowledgement = ackLoss;
      if (ackLoss) {
        for (let pass = 0; pass < 8 && accepted.length === 0; pass++)
          await poll();
        expect(accepted).toHaveLength(1);
        expect(prs.get("agent/first")).toBeDefined();
        // Reconstruct application clients around independently retained service resources.
        git = new GitClient(runGit);
        github = Object.assign(
          Object.create(Object.getPrototypeOf(github)) as GitHubClient,
          github,
        );
        expect(requests).toEqual(["agent/first"]);
        expect(accepted).toHaveLength(1);
        expect(prs.size).toBe(1);
        const acceptedHead = prs.get("agent/first")!.headRefOid;
        expect(
          await git.getRemoteBranchSha(
            source,
            "origin",
            "agent/first",
            project,
          ),
        ).toBe(acceptedHead);
        expect(await gitRun(source, "show", `${acceptedHead}:app.js`)).toBe(
          "module.exports = 'implemented';",
        );
        expect(await git.getHeadSha(path.join(worktrees, "first"))).toMatch(
          /^[0-9a-f]{40}$/u,
        );
        expect(
          fs.readFileSync(path.join(worktrees, "first", "app.js"), "utf8"),
        ).toBe("module.exports = 'implemented';\n");
        expect(lists.get("first")).toBe("working");
        expect(fs.existsSync(path.join(worktrees, "first"))).toBe(true);
        expect(lists.get("next")).toBe("ready");
        expect(store.read("next")).toBeNull();
        expect(fs.existsSync(path.join(worktrees, "next"))).toBe(false);
        expect(openCodeCards).not.toContain("next");
        expect(store.read("first")?.phase).toBe("publication");
        expect(
          fs.existsSync(
            path.join(contextRoot, "task-executions", project.id, "first.json"),
          ),
        ).toBe(false);
        expect(
          ledger.some(
            ({ service, action }) =>
              service === "github" && action === "accept:create-pr",
          ),
        ).toBe(true);
        // P4 replaces the P1 characterization blockage: the retained dispatch
        // and correlation marker now authorize readback, never another create.
      }
      for (
        let attempt = 0;
        attempt < 15 && store.read("first")?.phase !== "human-feedback";
        attempt += 1
      )
        await poll();
      const record = store.read("first");
      expect(record?.phase).toBe("human-feedback");
      const firstPr = prs.get("agent/first");
      expect(firstPr).toBeDefined();
      expect(firstPr?.isDraft).toBe(draft);
      expect(requests).toEqual(["agent/first"]);
      expect(accepted).toEqual([firstPr?.url]);
      expect(lists.get("first")).toBe("review");
      const recoveryStore = new TaskExecutionStore(
        contextRoot,
        project,
        activeAuthority!,
      );
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
          notificationId: "p1/first/human-feedback/dependency",
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
      lists.set("first", "review");
      const returned = recoveryStore.read("first")!;
      recoveryStore.compareAndSwap("first", returned.revision, {
        ...returned,
        recoveryWait: {
          ...returned.recoveryWait!,
          retryAt: new Date(Date.now() - 1).toISOString(),
        },
        revision: returned.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await poll();
      expect(recoveryStore.read("first")?.recoveryWait).toBeUndefined();
      expect(recoveryStore.read("first")?.phase).toBe("human-feedback");
      await poll();
      expect(lists.get("next")).toBe("ready");
      expect(
        ledger.some(
          (event) => event.id === "next" && event.action === "move:working",
        ),
      ).toBe(false);
      expect(store.read("next")).toBeNull();
      expect(fs.existsSync(path.join(worktrees, "next"))).toBe(false);
      expect(
        [...prs.values()].filter(
          ({ headBranch }) => headBranch === "agent/next",
        ),
      ).toHaveLength(0);
      firstPr!.reviewDecision = "APPROVED";
      await poll();
      expect(lists.get("next")).toBe("ready");
      expect(store.read("next")).toBeNull();
      const sha = (await git.getRemoteBranchSha(
        source,
        "origin",
        "agent/first",
        project,
      ))!;
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(await gitRun(source, "show", `${sha}:app.js`)).toBe(
        "module.exports = 'implemented';",
      );
      expect(
        Number(
          await gitRun(source, "rev-list", "--count", `${initialHead}..${sha}`),
        ),
      ).toBe(1);
      // Exercise terminal handling against the canonical authority-backed task
      // projection, including a durable recovery wait (not a standalone store).
      const terminalTaskStore = new TaskExecutionStore(
        contextRoot,
        project,
        activeAuthority!,
      );
      const waitingTask = terminalTaskStore.read("first")!;
      terminalTaskStore.compareAndSwap("first", waitingTask.revision, {
        ...waitingTask,
        recoveryWait: {
          kind: "dependency",
          reason: "GitHub temporarily unavailable",
          resumePhase: "human-feedback",
          since: new Date().toISOString(),
          retryAt: new Date(
            Date.now() + (terminalReadRaceAt === 3 ? -1 : 60_000),
          ).toISOString(),
          attempts: 1,
          notificationId: "p1/first/terminal-test/dependency",
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
      await poll();
      expect(terminalRaceReads).toBe(terminalReadRaceAt);
      expect(terminalTaskStore.read("first")).toMatchObject({
        phase: "human-feedback",
        recoveryWait: { resumePhase: "human-feedback" },
      });
      expect(authorities.get("first")?.store.read()?.lifecycle).toBe("waiting");
      expect(lists.get("first")).toBe("review");
      expect(openCodeCards).toHaveLength(openCodeCountBeforeRace);
      for (
        let attempt = 0;
        attempt < 12 && activeAuthority !== undefined;
        attempt += 1
      )
        await poll();
      expect(lists.get("first")).toBe(destination);
      expect(terminalRaceReads).toBeGreaterThanOrEqual(2);
      const firstAuthority = authorities.get("first");
      expect(firstAuthority?.store.read()).toMatchObject({
        lifecycle: terminal === "merged" ? "done" : "cancelled",
        terminalSync: "verified",
      });
      expect(terminalTaskStore.read("first")?.recoveryWait).toBeUndefined();
      if (terminal === "merged")
        expect(terminalTaskStore.read("first")?.phase).toBe("done");
      const terminalReadback = await (
        trello as unknown as {
          getCard: (id: string) => Promise<TrelloCard>;
        }
      ).getCard("first");
      expect(terminalReadback.idList).toBe(destination);
      expect(
        ledger.some(
          (event) => event.id === "next" && event.action === "move:working",
        ),
      ).toBe(false);
      expect(
        (await trello.getCards("ready")).some(({ id }) => id === "next"),
      ).toBe(true);
      expect(
        ledger.some(
          (event) =>
            event.id === "41" &&
            event.actor === "human" &&
            event.action === `human-${terminal}`,
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
          ({ actor, action }) =>
            actor === "human" && action === `human-${terminal}`,
        ),
      ).toBeLessThan(ledger.length);
      trapNextClaim = true;
      await expect(poll()).rejects.toThrow("observed next claim boundary");
      expect(authorities.get("next")?.store.read()).toMatchObject({
        cardId: "next",
        lifecycle: "planning",
      });
      expect(
        fs.existsSync(
          path.join(contextRoot, "task-executions", project.id, "next.json"),
        ),
      ).toBe(false);
      expect(
        ledger.some(
          (event) => event.id === "next" && event.action === "move:working",
        ),
      ).toBe(true);
      const terminalDestinationReadIndex = ledger.reduce(
        (lastIndex, entry, index) =>
          entry.id === "first" &&
          entry.action === "read-card" &&
          entry.detail === destination
            ? index
            : lastIndex,
        -1,
      );
      expect(
        ledger.findIndex(
          ({ actor, action }) =>
            actor === "human" && action === `human-${terminal}`,
        ),
      ).toBeLessThan(terminalDestinationReadIndex);
      expect(terminalDestinationReadIndex).toBeLessThan(
        ledger.findIndex(
          ({ id, action }) => id === "next" && action === "move:working",
        ),
      );
      expect(
        gitCalls.some((args) =>
          args.some((arg) => /(^|:)force|--force/u.test(arg)),
        ),
      ).toBe(false);
      expect(gitCalls.some((args) => args.includes("rebase"))).toBe(false);
      expect(
        ledger.some((event) => /auto.?merge|merge-pr/u.test(event.action)),
      ).toBe(false);
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
      expect(firstPr?.isDraft).toBe(draft);
      expect(
        ledger.filter(
          ({ action }) =>
            action.startsWith("attempt:") && /merge/u.test(action),
        ),
      ).toHaveLength(0);
      expect(
        ledger.filter(({ action }) => action === "comment").length,
      ).toBeGreaterThan(0);
      expect(
        ledger.some(
          ({ action, detail }) =>
            action === "comment" && detail?.includes(firstPr!.url),
        ),
      ).toBe(true);
    },
    20_000,
  );
});
