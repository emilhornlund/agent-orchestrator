import fs from "node:fs";
import { z } from "zod";
import { isAbandonedRefinementWrite } from "../refinement/refinement-card-guard.js";
import {
  terminalPrFenceFromRun,
  terminalMutationAllowed,
  ObservedPrTerminalError,
} from "../task-session/terminal-pr-fence.js";
import { isConclusiveOperationResolution } from "../task-session/run-record.js";
import type { MutationEvent } from "../task-session/durable-mutation.js";
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

export function hasVerifiedWorkflowMove(authority: ProjectRunAuthority, listId: string): boolean {
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
    const request = requestSchema.parse(JSON.parse(fs.readFileSync(reference.path, "utf8")));
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
  const initialWaiting = await reconcileTerminalInitialEffects(
    authority,
    options.trello,
    options.github,
    options.project,
  );
  const initial = authority.store.read()!;
  const pending = authority.store
    .read()!
    .pendingOperations.filter(
      (entry) =>
        entry.id.startsWith("workflow:") &&
        !["completed", "cancelled"].includes(entry.status) &&
        !isAbandonedRefinementWrite(authority, entry) &&
        !(terminalPrFenceFromRun(initial) && isConclusiveOperationResolution(entry)),
    );
  for (const entry of pending) {
    if (entry.mutation?.nextRecheckAt && Date.now() < Date.parse(entry.mutation.nextRecheckAt))
      continue;
    const run = authority.store.read()!;
    const reference = run.artifacts.find(
      (artifact) => artifact.id === entry.mutation?.intent.payloadId,
    );
    if (!reference) throw new Error("Workflow mutation payload is missing; preserving ownership");
    const request = z
      .union([requestSchema, gitMutationRequestSchema])
      .parse(JSON.parse(fs.readFileSync(reference.path, "utf8")));
    const terminal = terminalPrFenceFromRun(run);
    const terminalSuperseded = terminal !== null && !terminalMutationAllowed(run, request);
    if (
      entry.mutation?.dispatches.length === 0 &&
      (terminalSuperseded ||
        ["done", "refined", "failed", "cancelled"].includes(run.lifecycle) ||
        entry.mutation.executionFence.id !== run.operation.id ||
        entry.mutation.executionFence.generation !== run.operation.generation)
    ) {
      const now = new Date().toISOString();
      const reason =
        terminalSuperseded || ["done", "refined", "failed", "cancelled"].includes(run.lifecycle)
          ? "terminal-observed"
          : "execution-superseded";
      const evidence = authority.store.writeArtifact(
        Buffer.from(
          JSON.stringify({
            reason,
            operation: run.operation,
            terminalEvidence: run.terminalEvidence,
            terminalPrObservation: terminal,
          }),
        ),
        "application/json",
      );
      authority.store.referenceMutationArtifact(run.revision, authority.ownerGeneration, evidence);
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
      if (
        !(error instanceof WorkflowMutationWaitingError) &&
        !(error instanceof ObservedPrTerminalError)
      )
        throw error;
    }
  }
  return initialWaiting || pending.length > 0;
}

/** Initial publication uses its original immutable payloads, not workflow-route
 * payloads. After a human outcome only reconcile dispatched effects; never replay. */
async function reconcileTerminalInitialEffects(
  authority: ProjectRunAuthority,
  trello: TrelloClient,
  github: GitHubClient,
  project: ProjectConfig,
): Promise<boolean> {
  const snapshot = authority.store.read()!;
  const fence = terminalPrFenceFromRun(snapshot);
  if (!fence) return false;
  for (const entry of snapshot.pendingOperations.filter(
    (entry) => entry.id.startsWith("initial:") && !isConclusiveOperationResolution(entry),
  )) {
    if (!entry.mutation)
      throw new Error("Initial publication effect has no dispatch evidence; preserve ownership");
    if (entry.mutation.nextRecheckAt && Date.now() < Date.parse(entry.mutation.nextRecheckAt))
      continue;
    const raw: unknown = JSON.parse(
      authority.store.readArtifact(entry.mutation.intent.payloadId).toString("utf8"),
    );
    let actual: { id: string; fields: unknown } | null = null;
    if (entry.mutation.dispatches.length > 0) {
      if (entry.kind === "trello-move") {
        const payload = z.strictObject({ listId: z.string().min(1) }).parse(raw);
        const card = await trello.getCard(snapshot.cardId);
        if (card.id !== snapshot.cardId)
          throw new Error("Initial move readback returned another card");
        if (card.idList === payload.listId) actual = { id: card.id, fields: card };
      } else if (entry.kind === "trello-comment") {
        const payload = z.strictObject({ text: z.string() }).parse(raw);
        const matches = (await trello.getCardComments(snapshot.cardId)).filter(
          (comment) => comment.text === payload.text,
        );
        if (matches.length > 1) throw new Error("Initial comment acceptance is ambiguous");
        if (matches[0]) actual = { id: matches[0].id, fields: matches[0] };
      } else if (entry.kind === "github-pr-create") {
        const payload = z.object({ body: z.string(), title: z.string() }).parse(raw);
        const fields = await github.getPullRequestPublicationFields({
          cwd: project.repository.path,
          repository: project.repository.github,
          pullRequestUrl: fence.url,
          project,
        });
        if (fields.body === payload.body && fields.title === payload.title)
          actual = {
            id: fence.url,
            fields: { ...fields, state: fence.state, headSha: fence.headSha },
          };
      }
    }
    const now = new Date().toISOString();
    const proof = authority.store.writeArtifact(
      Buffer.from(JSON.stringify({ terminal: fence, actual, originalEffect: entry.id })),
      "application/json",
    );
    authority.store.referenceMutationArtifact(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      proof,
    );
    const outcome: MutationEvent =
      entry.mutation.dispatches.length === 0
        ? {
            type: "cancel",
            reason: "terminal-observed",
            evidence: {
              observationId: `terminal:${entry.id}`,
              observedAt: now,
              artifactId: proof.id,
            },
          }
        : {
            type: "observe",
            outcome: actual ? "verified" : "uncertain",
            attentionRequired: !actual,
            ...(actual ? { resourceId: actual.id } : {}),
            evidence: {
              observationId: `terminal:${entry.id}:${now}`,
              observedAt: now,
              artifactId: proof.id,
            },
            ...(actual
              ? {}
              : {
                  nextRecheckAt: new Date(Date.now() + 15_000).toISOString(),
                }),
          };
    authority.store.recordMutationEvent(
      authority.store.read()!.revision,
      authority.ownerGeneration,
      entry.id,
      entry.generation,
      outcome,
      now,
    );
  }
  return authority.store
    .read()!
    .pendingOperations.some(
      (entry) => entry.id.startsWith("initial:") && !isConclusiveOperationResolution(entry),
    );
}
