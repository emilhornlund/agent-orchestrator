import fs from "node:fs";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import type { TrelloClient } from "../trello/trello-client.js";
import type { GitHubClient } from "../github/github-client.js";
import type { GitClient } from "../git/git-client.js";
import { gitMutationRequestSchema } from "../git/git-mutation-request.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import {
  withMutationReconciliation,
  WorkflowMutationWaitingError,
} from "../task-session/workflow-mutation.js";

const string = z.string().min(1);
const card = { cardId: string };
const pr = { cwd: string, repository: string, pullRequestUrl: string };
const requestSchema = z.discriminatedUnion("route", [
  z.strictObject({
    route: z.literal("trello-move"),
    args: z.strictObject({
      ...card,
      listId: string,
      options: z.strictObject({ dueComplete: z.boolean().optional() }),
    }),
  }),
  z.strictObject({
    route: z.literal("trello-content"),
    args: z.strictObject({ ...card, title: string, description: z.string() }),
  }),
  z.strictObject({
    route: z.literal("trello-labels"),
    args: z.strictObject({ ...card, labelId: string, present: z.boolean() }),
  }),
  z.strictObject({
    route: z.literal("trello-comment"),
    args: z.strictObject({ ...card, text: z.string() }),
  }),
  z.strictObject({
    route: z.literal("github-pr-body"),
    args: z.strictObject({
      ...pr,
      body: z.string(),
      expectedBody: z.string().optional(),
    }),
  }),
  z.strictObject({
    route: z.literal("github-pr-draft"),
    args: z.strictObject(pr),
  }),
  z.strictObject({
    route: z.literal("github-pr-ready"),
    args: z.strictObject({
      ...pr,
      headBranch: string,
      expectedHeadSha: string,
      expectedBody: z.string(),
    }),
  }),
  z.strictObject({
    route: z.literal("github-conversation-reply"),
    args: z.strictObject({ ...pr, body: string }),
  }),
  z.strictObject({
    route: z.literal("github-thread-reply"),
    args: z.strictObject({ ...pr, body: string, threadId: string }),
  }),
]);

export function hasVerifiedWorkflowMove(
  authority: ProjectRunAuthority,
  listId: string,
): boolean {
  const run = authority.store.read()!;
  return run.pendingOperations.some((entry) => {
    if (
      !entry.id.startsWith("workflow:") ||
      entry.kind !== "trello-move" ||
      entry.status !== "completed"
    )
      return false;
    const reference = run.artifacts.find(
      (artifact) => artifact.id === entry.mutation?.intent.payloadId,
    );
    if (!reference) return false;
    const request = requestSchema.parse(
      JSON.parse(fs.readFileSync(reference.path, "utf8")),
    );
    return (
      request.route === "trello-move" &&
      request.args.cardId === run.cardId &&
      request.args.listId === listId
    );
  });
}

/** Bounded readback before legacy recovery, next-card selection or release.
 * Dispatch history is authoritative; absence never enables a second send. */
export async function reconcileWorkflowMutations(options: {
  project: ProjectConfig;
  trello: TrelloClient;
  github: GitHubClient;
  git: GitClient;
}): Promise<boolean> {
  const authority = ProjectRunAuthority.current(options.project.id);
  if (!authority) return false;
  const pending = authority.store
    .read()!
    .pendingOperations.filter(
      (entry) =>
        entry.id.startsWith("workflow:") &&
        !["completed", "cancelled"].includes(entry.status),
    );
  for (const entry of pending) {
    if (
      entry.mutation?.nextRecheckAt &&
      Date.now() < Date.parse(entry.mutation.nextRecheckAt)
    )
      continue;
    const run = authority.store.read()!;
    if (
      entry.mutation?.dispatches.length === 0 &&
      (["done", "refined", "failed", "cancelled"].includes(run.lifecycle) ||
        entry.mutation.executionFence.id !== run.operation.id ||
        entry.mutation.executionFence.generation !== run.operation.generation)
    ) {
      const now = new Date().toISOString();
      const reason = ["done", "refined", "failed", "cancelled"].includes(
        run.lifecycle,
      )
        ? "terminal-observed"
        : "execution-superseded";
      const evidence = authority.store.writeArtifact(
        Buffer.from(
          JSON.stringify({
            reason,
            operation: run.operation,
            terminalEvidence: run.terminalEvidence,
          }),
        ),
        "application/json",
      );
      authority.store.referenceMutationArtifact(
        run.revision,
        authority.ownerGeneration,
        evidence,
      );
      authority.store.recordMutationEvent(
        authority.store.read()!.revision,
        authority.ownerGeneration,
        entry.id,
        entry.generation,
        {
          type: "cancel",
          reason,
          evidence: {
            observationId: `cancel:${entry.id}`,
            observedAt: now,
            artifactId: evidence.id,
          },
        },
        now,
      );
      continue;
    }
    const reference = run.artifacts.find(
      (artifact) => artifact.id === entry.mutation?.intent.payloadId,
    );
    if (!reference)
      throw new Error(
        "Workflow mutation payload is missing; preserving ownership",
      );
    const request = z
      .union([requestSchema, gitMutationRequestSchema])
      .parse(JSON.parse(fs.readFileSync(reference.path, "utf8")));
    const { trello, github, project } = options;
    try {
      await withMutationReconciliation(entry.id, async () => {
        switch (request.route) {
          case "git-commit":
          case "git-worktree":
          case "git-push":
          case "git-cleanup":
            return options.git.reconcileMutation(request, project);
          case "trello-move":
            return trello.moveCard(
              request.args.cardId,
              request.args.listId,
              request.args.options.dueComplete === undefined
                ? {}
                : { dueComplete: request.args.options.dueComplete },
            );
          case "trello-content":
            return trello.updateCardContent(
              request.args.cardId,
              request.args.title,
              request.args.description,
            );
          case "trello-labels":
            return request.args.present
              ? trello.addLabel(request.args.cardId, request.args.labelId)
              : trello.removeLabel(request.args.cardId, request.args.labelId);
          case "trello-comment":
            return trello.addComment(request.args.cardId, request.args.text);
          case "github-pr-body":
            return github.editPullRequestDescription({
              ...request.args,
              project,
            });
          case "github-pr-draft":
            return github.ensurePullRequestDraft({ ...request.args, project });
          case "github-pr-ready":
            return github.ensurePullRequestReady({ ...request.args, project });
          case "github-conversation-reply":
            return github.replyToConversationComment({
              ...request.args,
              project,
            });
          case "github-thread-reply":
            return github.replyToReviewThread({ ...request.args, project });
        }
      });
    } catch (error) {
      if (!(error instanceof WorkflowMutationWaitingError)) throw error;
    }
  }
  return pending.length > 0;
}
