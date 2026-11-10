import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "../config/config.js";
import type { GitHubClient } from "../github/github-client.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";

const arrivalSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  cardId: z.string().min(1),
  pullRequestUrl: z.url(),
  headSha: z.string().min(1),
  observedAt: z.string().datetime(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  artifactId: z.string().min(1),
});
const inboxSchema = z.strictObject({
  version: z.literal(1),
  arrivals: z.array(arrivalSchema),
});
export type ActivePrArrival = z.infer<typeof arrivalSchema>;
const inboxKey = "active-pr-observations";

export function readActivePrArrivals(
  authority: ProjectRunAuthority,
): readonly ActivePrArrival[] {
  return (
    authority.read(inboxKey, (value) => inboxSchema.parse(value))?.arrivals ??
    []
  );
}

/** Observation has its own projection: it never advances the writer's checkpoint,
 * acquires its queue, or touches the task worktree. Artifacts retain arrivals even
 * when a later refresh edits/deletes feedback before the writer is free. */
export async function observeActivePullRequest(options: {
  project: ProjectConfig & { contextRoot?: string };
  github: GitHubClient;
  authority: ProjectRunAuthority;
}): Promise<void> {
  const { project, github, authority } = options;
  authority.assertHeld();
  if (!authority.cardId || !project.contextRoot) return;
  const tasks = new TaskExecutionStore(project.contextRoot, project, authority);
  const task = tasks.read(authority.cardId);
  if (!task?.pullRequest || task.phase === "done") return;
  const lookup = {
    cwd: project.repository.path,
    repository: project.repository.github,
    headBranch: task.expectedBranch ?? `agent/${task.cardId}`,
    baseBranch: project.repository.defaultBranch,
    project,
  };
  const pr = await github.findPullRequestState(lookup);
  if (!pr || pr.url !== task.pullRequest.url || !pr.headRefOid)
    throw new Error(
      "Active PR observation could not verify the owned PR identity",
    );
  const [owner, repository] = project.repository.github.split("/");
  if (
    pr.headRefName !== lookup.headBranch ||
    pr.baseRefName !== lookup.baseBranch ||
    pr.headRepositoryOwner?.login !== owner ||
    pr.headRepository?.name !== repository ||
    (pr.state === "MERGED") !== (pr.mergedAt !== null)
  )
    throw new Error(
      "Active PR observation has ambiguous repository or terminal identity",
    );
  const current =
    pr.state === "OPEN"
      ? {
          feedback: await github.findChangesRequestedPullRequest(lookup, true),
          comments: await github.getPullRequestConversationComments({
            ...lookup,
            pullRequestUrl: pr.url,
          }),
          ci: await github.getCiObservations({
            ...lookup,
            defaultBranch: project.repository.defaultBranch,
            headSha: pr.headRefOid,
            pullRequestNumber: task.pullRequest.number,
          }),
        }
      : null;
  if (current !== null) {
    const confirmed = await github.findPullRequestState(lookup);
    if (
      confirmed?.url !== pr.url ||
      confirmed.state !== pr.state ||
      confirmed.headRefOid !== pr.headRefOid ||
      (current.feedback !== null &&
        current.feedback.headSha !== pr.headRefOid) ||
      current.ci.headSha !== pr.headRefOid
    )
      return;
  }
  const latest = tasks.read(task.cardId);
  // A writer may have published during these reads. Discard this mixed snapshot,
  // not the writer's completion; the next paced observation reads the new head.
  if (
    latest?.pullRequest?.url !== task.pullRequest.url ||
    latest.pullRequest.headSha !== task.pullRequest.headSha
  )
    return;
  authority.assertHeld();
  const content = sanitizeControlledText(
    JSON.stringify({ pullRequest: pr, current }),
  );
  const id = createHash("sha256").update(content).digest("hex");
  if (readActivePrArrivals(authority).some((arrival) => arrival.id === id))
    return;
  const artifact = authority.store.writeArtifact(
    Buffer.from(content),
    "application/json",
  );
  authority.mutate(
    inboxKey,
    { version: 1, arrivals: [] },
    (raw) => {
      const inbox = inboxSchema.parse(raw);
      if (inbox.arrivals.some((arrival) => arrival.id === id))
        return { value: inbox, result: undefined };
      return {
        value: inboxSchema.parse({
          ...inbox,
          arrivals: [
            ...inbox.arrivals,
            {
              id,
              cardId: task.cardId,
              pullRequestUrl: pr.url,
              headSha: pr.headRefOid,
              state: pr.state,
              observedAt: new Date().toISOString(),
              artifactId: artifact.id,
            },
          ],
        }),
        result: undefined,
      };
    },
    (value) => inboxSchema.parse(value),
  );
}

/** Run one serialized observer alongside the writer, with bounded error backoff.
 * Await its last read before returning so no timer outlives attempt ownership. */
export async function withActivePrObservation<T>(
  options: {
    project: ProjectConfig & { contextRoot?: string };
    github: GitHubClient;
    authority: ProjectRunAuthority;
    intervalMs: number;
    signal: AbortSignal;
    onError: (error: unknown) => void;
  },
  operation: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const schedule = () => {
    if (stopped || options.signal.aborted) return;
    timer = setTimeout(
      () => {
        pending = options.authority.run(async () => {
          try {
            await observeActivePullRequest(options);
            failures = 0;
          } catch (error) {
            failures = Math.min(failures + 1, 5);
            try {
              options.onError(error);
            } catch {
              // Diagnostics must not replace a writer's successful completion.
            }
          } finally {
            schedule();
          }
        });
      },
      options.intervalMs * 2 ** failures,
    );
  };
  schedule();
  try {
    return await operation();
  } finally {
    stopped = true;
    clearTimeout(timer);
    await pending;
  }
}
