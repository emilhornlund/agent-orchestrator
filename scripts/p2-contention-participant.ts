import fs from "node:fs";
import readline from "node:readline";

import type { Config } from "../src/config/config.js";
import { GitClient } from "../src/git/git-client.js";
import type { GitHubClient } from "../src/github/github-client.js";
import type { OpenCodeClient } from "../src/opencode/opencode-client.js";
import { CommandRunner } from "../src/process/command-runner.js";
import { ProjectOwnershipError } from "../src/coordination/project-ownership.js";
import { ProjectRunAuthority } from "../src/task-session/project-run-authority.js";
import type { ProjectRunWorkerContext } from "../src/task-session/project-run-authority.js";
import { runStartup } from "../src/startup/run-startup.js";
import type { TrelloClient } from "../src/trello/trello-client.js";

const configPath = process.env.P2_CONFIG;
const role = process.env.P2_ROLE;
const receiverUrl = process.env.P2_RECEIVER_URL;
const receiverToken = process.env.P2_RECEIVER_TOKEN;
if (!configPath || !role || !receiverUrl || !receiverToken)
  throw new Error("Missing production startup participant arguments");
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
const controller = new AbortController();
let createdAttempts = 0;
let callbacksCompleted = 0;
async function sendBoundaryRequest(
  action: string,
  details: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(receiverUrl!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-p2-receiver-token": receiverToken!,
    },
    body: JSON.stringify({ action, actor: role, ...details }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok || result.accepted !== true)
    throw new Error(
      `Parent effect receiver rejected ${action}: ${JSON.stringify(result)}`,
    );
  return result;
}
const runOrchestrator = async (
  _trello: TrelloClient,
  _git: GitClient,
  _github: GitHubClient,
  _opencode: OpenCodeClient,
  _commands: CommandRunner,
  runtimeConfig: Config,
  _signal: AbortSignal,
  _email: unknown,
  _validate: unknown,
  contexts?: ReadonlyMap<string, ProjectRunWorkerContext>,
) => {
  callbacksCompleted += 1;
  await sendBoundaryRequest("orchestrator-started", {
    projectIds: runtimeConfig.projects.map(({ id }) => id),
  });
  for (const project of runtimeConfig.projects) {
    const context = contexts?.get(project.id);
    if (context?.blockedReason) {
      console.log(
        `BLOCKED:${JSON.stringify({ projectId: project.id, reason: context.blockedReason })}`,
      );
      continue;
    }
    if (!context?.projectLease || !context.pinned)
      throw new Error(
        `Missing production project execution context for ${project.id}`,
      );
    if (context.authority) {
      // A resumed attempt has already emitted its task claim in the prior
      // process. Reattach authority without replaying the task-facing request.
      activeAuthorities.set(project.id, context.authority);
      createdAttempts += 1;
      await sendBoundaryRequest(
        "runstore-resumed",
        authorityDetails(context.authority, context.projectLease),
      );
      continue;
    }
    const authority = await ProjectRunAuthority.createPreparingAttempt({
      projectId: project.id,
      cardId: `fixture-${role}`,
      taskKind: "implementation",
      pinned: context.pinned,
      projectLease: context.projectLease,
      coordinationRoot: config.workflow.coordinationRoot!,
      attemptId: `attempt-${role}-${project.id}`,
      sessions: { primary: `primary-${project.id}` },
      resources: [
        {
          kind: "primary-session",
          id: `primary-${project.id}`,
          path: `${context.pinned.storageRoot}/sessions/primary-${project.id}`,
          provenance: "attempt-created",
        },
      ],
    });
    activeAuthorities.set(project.id, authority);
    createdAttempts += 1;
    authority.claim();
    const details = authorityDetails(authority, context.projectLease);
    await sendBoundaryRequest("runstore-created", details);
    await sendBoundaryRequest("task-claim", details);
    await sendBoundaryRequest("implementation-dispatch", details);
  }
  console.log(
    `STARTED:${JSON.stringify({ role, createdAttempts, callbacksCompleted })}`,
  );
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line === "HEARTBEAT") {
      const [projectId, authority] = [...activeAuthorities.entries()][0] ?? [];
      const context = contexts?.get(projectId);
      if (!authority || !context?.projectLease)
        throw new Error(
          "Independent heartbeat has no active production authority",
        );
      context.projectLease.assertHeld();
      const nonce = `heartbeat-${role}-${Date.now()}`;
      const response = await sendBoundaryRequest("heartbeat", {
        ...authorityDetails(authority, context.projectLease),
        projectId,
        nonce,
      });
      console.log(`HEARTBEAT_RESPONSE:${JSON.stringify(response)}`);
      continue;
    }
    if (line !== "RELEASE") continue;
    controller.abort();
    break;
  }
};

const activeAuthorities = new Map<string, ProjectRunAuthority>();

function authorityDetails(
  authority: ProjectRunAuthority,
  lease: NonNullable<ProjectRunWorkerContext["projectLease"]>,
): Record<string, unknown> {
  const record = authority.store.read();
  if (!record) throw new Error("Production RunStore record disappeared");
  return {
    projectId: authority.projectId,
    attemptId: record.attemptId,
    storageRoot: record.pinned.storageRoot,
    ownerInstanceId: record.owner.instanceId,
    ownerToken: record.owner.token,
    ownerGeneration: record.owner.generation,
    integrationId: record.pinned.integrationId,
    leaseInstanceId: lease.instanceId,
    leaseToken: lease.token,
  };
}

try {
  await runStartup(
    config,
    {
      trello: {} as TrelloClient,
      git: new GitClient(async (_cwd, args) => {
        await sendBoundaryRequest("setup-git", { command: args });
        return "true";
      }),
      github: {} as GitHubClient,
      opencode: {} as OpenCodeClient,
      commands: new CommandRunner(async ({ command, cwd }) => {
        await sendBoundaryRequest("setup-command", { command, cwd });
        return { exitCode: 0, output: "", errorOutput: "" };
      }),
    },
    controller.signal,
    {
      validateToolchain: async () => {
        await sendBoundaryRequest("setup-toolchain");
      },
      validateGitHubCli: async (_github, projects) => {
        await sendBoundaryRequest("setup-github-cli", {
          projectIds: projects.map(({ id }) => id),
        });
      },
      validateProjectTrello: async (_trello, project) => {
        await sendBoundaryRequest("setup-trello", { projectId: project.id });
      },
      validateProjectGitHub: async (_github, project) => {
        await sendBoundaryRequest("setup-github", { projectId: project.id });
      },
      runOrchestrator,
    },
  );
} catch (error) {
  if (!(error instanceof ProjectOwnershipError)) throw error;
  console.log(
    `REJECTED:${JSON.stringify({ name: error.name, message: error.message, createdAttempts, callbacksCompleted })}`,
  );
}
