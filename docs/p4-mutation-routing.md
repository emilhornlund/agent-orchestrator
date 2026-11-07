# P4-T3: concrete workflow mutation routing

This is foundation/integration evidence, not P4 completion or live-provider
compatibility evidence. Read alongside [T1](p4-mutation-foundation.md) and
[T2](p4-initial-publication.md). No production service was contacted.

## Authority and execution

`RunStore.pendingOperations[].mutation` remains the only effect authority. The
client adapters store strict concrete request payloads and independent observations
as integrity-checked attempt artifacts. There is no new mutable mutation file,
provider abstraction, or command replay engine. The reconciliation switch accepts
only enumerated Trello/GitHub/Git requests; it never executes persisted commands.
Existing commit/trusted-state and feedback records remain workflow projections;
they cannot authorize resending a journaled uncertain write.

Client mutation methods require attempt authority in production lease scopes,
including scopes containing multiple projects. Unowned client utility calls retain
their existing behavior. These are not an alternative production owner. T2 wraps
its already-journaled sender in an asynchronous dispatch scope: those transport
calls do not create T3 intents or recursively dispatch another reconciler.

Independent-review hardening replaces the original boolean dispatch bypass with
an authority-bound, single-use capability. Activation requires a current,
unresponded durable dispatch from the same owner and initiating execution. Its
concrete route, target and payload are derived from the persisted artifact and
checked against the pinned card/repository/owned resources. Every mutation method
still resolves and checks authority; only the exact matching method invocation
can consume the capability. Unrelated routes/cards/repositories/projects/fields,
new PR creation outside its own initial intent, nested scopes, repeated activation
or use, stale response/owner/execution proof, and escaped asynchronous use are
rejected. Local preparation/destructive Git utility methods cannot run inside a
dispatch capability. The process-local anti-reuse set is only a capability fence,
not another persisted effect authority or evidence of remote acceptance.
The private Trello/gh/Git transport boundary rechecks the live capability after
asynchronous credential/validation work and permits at most one mutating request.
An unawaited method that consumed its capability but resumes only after scope
exit cannot send a late request.

Mutation arguments are captured before asynchronous work. Journaled commit
transport writes the authorized message bytes to a private file instead of
reopening the caller's mutable `-F` file. New T2 commit intents also bind the exact
Git identity/signing fields. Historical accepted commits remain discoverable with
their old payloads; an old intent lacking those identity fields cannot authorize
a new commit dispatch.

Intent IDs bind execution generation, payload digest and occurrence. Re-entering
the last identical request reuses its immutable result. An intervening different
effect on the same field permits a new occurrence (for example activity A, B, A),
without rebinding an old completed effect. Correlation markers are attempt-scoped.
New owners reconcile the original identity, including after execution supersession
or terminal observation; they do not re-persist/rebind its intent.

The production worker and `pollProject` reconcile pending T3 entries before legacy
recovery, next-card selection or terminal release. Each pass is bounded; dispatched
uncertainty has a persisted minimum 15-second readback time and attention flag.
Production pending-obligation polling sleeps at least 15 seconds even if the
ordinary poll interval is shorter. Preflight failures retain never-dispatched
intent, rather than inventing possible network acceptance. Such intents may be
cancelled after durable terminal observation/execution supersession. Already
dispatched entries cannot be cancelled. Missing/malformed payloads preserve
ownership and fail closed.

One acknowledged write can have an immediate **positive independent readback**
recorded by the same owner. The reducer explicitly permits only that exception to
its recheck deadline. A response alone, negative read, failed read, or recovery
lookup cannot use it. Unknown acceptance always waits for the controlled recheck.
No desired-state effect is automatically resent after possible acceptance.

Commit completion additionally requires that the worktree is checked out on the
intended task branch and that its exact local `refs/heads/...` names the discovered
commit. Push dispatch checks both that checked-out branch and the exact local
task ref against the intended SHA. Both initial and noninitial journaled pushes
send the **immutable SHA** to a fully qualified remote ref (`SHA:refs/heads/...`),
with ordinary fast-forward checks and no force option. A final local ref race
cannot substitute a different source object at Git's push invocation. Refused
branch/HEAD/ref races retain the original intent and do not falsely complete on
restart. This does not claim atomic prevention of all concurrent local edits.
Journaled push also supplies `--no-follow-tags`, so `push.followTags=true` cannot
silently publish additional tag refs outside the intended mutation.

Concrete Trello 400/401/403/404/405/422 write rejection can establish non-delivery
for that operation and permit a later paced dispatch with the same intent. Read
errors, generic errors, timeouts, 5xx, nonzero Git/gh results, missing refs, and
negative comment/reply lookups do not establish non-delivery. T3 Git/gh failures
are conservatively uncertain; T2 retains its more specific transport proof rules.

## Reachable workflow mutation inventory

All callers of these public mutation methods share their adapter; this includes
failure/clarification, initial claim, feedback, CI, existing-PR publication,
refinement, and merged/closed reconciliation. There is no per-caller opt-out.

| Concrete route                                                      | Policy and persisted intent                                                                          | Independent completion evidence                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial commit/push/PR create/Human Review move/publication comment | T2 original checkpoint and `initial:*` intents; no T3 double journal                                 | T2 exact commit/tree/message, bound push destination/ref, repository/head/base/actual PR/marker/title/body/draft, pinned card destination and exact comment                                                         |
| `TrelloClient.moveCard`                                             | Desired state; board/card, intended list and optional `dueComplete`                                  | Direct card read checks actual card ID, board, `idList`, and requested `dueComplete`; configured destination and allowed source lists checked before send; automatic Ready requeue and open-PR Failed moves refused |
| `TrelloClient.addComment`                                           | Non-idempotent; exact sanitized text plus stable mutation marker                                     | Independent card identity/board read and comments read; exactly one exact-text-and-marker match binds actual action ID; absence never resends                                                                       |
| `TrelloClient.updateCardContent`                                    | Refinement-only desired state; exact title/description                                               | Pinned direct card read compares both fields, not the PUT response; preflight compares original/intended snapshot and pauses known conflicts                                                                        |
| `TrelloClient.addLabel` / `removeLabel`                             | Refinement-only desired membership per label                                                         | Label belongs to pinned board and intended snapshot; direct card read verifies actual requested membership, not response status                                                                                     |
| `GitHubClient.editPullRequestDescription`                           | Desired exact sanitized body on owned pinned PR                                                      | Separate PR body read equals entire intended body; repository/URL/number must match attempt PR resource; open-PR preflight                                                                                          |
| `GitHubClient.updatePullRequestDescriptionStatus`                   | Current managed-region rendering delegates its final exact body to the preceding route               | Fresh current body is retained by managed renderer; independent whole-body readback; no direct `gh pr edit` bypass                                                                                                  |
| `GitHubClient.ensurePullRequestDraft`                               | Desired `isDraft: true` on owned PR                                                                  | Separate publication-fields read verifies actual `isDraft`; open-PR preflight; existing `ready --undo` response is not proof                                                                                        |
| `GitHubClient.replyToReviewThread`                                  | Non-idempotent exact sanitized reply plus stable marker, bound to owned PR/thread                    | Independent thread discovery verifies PR/thread and exactly one full-body match, binding actual comment database ID                                                                                                 |
| `GitHubClient.replyToConversationComment`                           | Non-idempotent exact sanitized reply plus stable marker on owned PR conversation                     | Independent PR conversation read requires exactly one full-body match and actual comment ID                                                                                                                         |
| Noninitial `GitClient.commit`                                       | Discoverable parent/tree/branch/exact sanitized message, explicit verbatim cleanup and identity      | Actual single-parent commit, tree, exact framed message, SHA and clean worktree; no rebinding completed identity to a later HEAD                                                                                    |
| Noninitial `GitClient.push`                                         | Discoverable intended SHA/ref and concrete effective fetch/push destinations                         | Re-resolved pinned GitHub destination plus `ls-remote` at the bound **push** destination equals intended SHA; ordinary push only                                                                                    |
| `GitClient.addWorktree` / `addWorktreeWithNewBranch`                | Discoverable owned-resource creation; source/common repo, exact path/branch/start SHA, creation mode | Actual non-symlink worktree, current branch, HEAD/start object and common Git directory; persisted P2 resource manifest is prerequisite                                                                             |
| `GitClient.removeWorktree`                                          | Desired absence; owned exact path and original HEAD before dispatch                                  | Both filesystem absence and absence from independent `git worktree list --porcelain`; source/common repo and dirty/symlink/branch/head checks before deletion                                                       |
| `GitClient.deleteBranch`                                            | Desired absence; owned exact local ref and original object                                           | Independent exact local-ref absence; changed original ref refuses deletion                                                                                                                                          |
| `GitClient.deleteRemoteBranch`                                      | Desired absence; owned task ref, original object and bound push URL                                  | Revalidated concrete destination and actual remote-ref absence; changed ref refuses deletion; already absent is a verified no-op                                                                                    |

`GitHubClient.createPullRequest` refuses production calls outside T2's durable
sender. No production mark-ready operation currently exists (only mark-draft);
adding one must supply a desired-state intent and actual `isDraft: false` proof.
No merge, force-push, thread-resolution, approval, review dismissal, or replacement
PR mutation is introduced.

### Other effects and deliberately non-workflow preparation

This inventory does not disguise local preparation or other phase-owned effects
as journaled workflow outcomes:

| Boundary                                                                                   | Concrete policy / authority                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git fetch, object reads, stage/index preparation and repository bootstrap clone            | Fetch refreshes object/ref caches and staging prepares the owned worktree index; neither proves a commit/push/transition. Bootstrap creates only a missing configured checkout through existing startup guards. P2 pins and P3 lease/process/source guards remain. These are not remote repository writes. Publication/cleanup never derives acceptance from fetch/stage success. |
| Git broad `worktree prune`                                                                 | Disabled (no-op) under production attempt authority: no attempt-scoped proof exists for pruning unrelated registrations. Owned worktree removal performs its own verified deregistration. Utility behavior is unchanged.                                                                                                                                                          |
| `resetHard`, `resetHardTo`, `cleanUntracked`, `createRefIfAbsent`, `prepareReviewWorktree` | No reachable production call sites in the current task-session dispatcher; retained utility/legacy code is not publication authority. Rebase and force-with-lease methods remain disabled. P8 must not reactivate the legacy destructive review preparation path.                                                                                                                 |
| OpenCode session creation/binding, engineering/setup/quality processes                     | Existing P2 session/queue intents and P3 execution evidence; not Trello/GitHub publication effects. Full primary recovery/setup/context protocol is P5. No agent is authorized by this journal to publish remote workflow effects.                                                                                                                                                |
| Attachment/result materialization and runtime artifacts/registry/queue writes              | Local owned storage/preparation, protected by existing P2/P3 filesystem and credential boundaries; not external workflow outcomes.                                                                                                                                                                                                                                                |
| GitHub App token exchange                                                                  | Authentication, not task publication; existing protected credential provider and expiry/cache policy, no task-transition completion inferred.                                                                                                                                                                                                                                     |
| Email notification delivery                                                                | Explicit remaining T4 route: existing best-effort calls/pre-send claims are **not** journal verification or delivery proof. Notification uncertainty must remain nonblocking and outside workflow pending operations.                                                                                                                                                             |

## Failure and lifecycle composition

Completed effects and their exact evidence survive later failures. Pending comment
errors are rethrown rather than being treated as completed best-effort workflow
notes. Closed/merged outcome comments are ensured for owned terminal reconciliation
even when the card already reached its destination; journal identity deduplicates
them. RunStore's terminal release/registry gates still require all workflow
obligations to resolve. Cleanup dispatch boundaries have the same gate; unsafe
pre-dispatch cleanup can preserve artifacts without pretending they were deleted.

The legacy feedback ledger no longer interprets `absent` after `sending` or
`outcome-unknown` as permission to send again. Found actual replies can still be
bound; unresolved legacy replies remain preserved rather than receiving invented
new dispatch provenance.

An accepted initial Working claim is recoverable across the local handoff gap:
the verified move payload, current Working card, matching queue event and actual
owned worktree/common-repo proof are required before creating the missing planning
projection. This is not permission to adopt arbitrary unowned Working cards.

Refinement saves the complete original title/description/labels and complete
intended result before its first field write. Re-entry uses that result instead of
rerunning the agent, and pending fields prevent failure cleanup/terminal release.
Full P9 read-only enforcement, change-history/race attribution, compensation and
end-to-end resumption (especially the final Backlog handoff) remain later work.

## Evidence, limits and follow-up

`tests/workflow-mutations.integration.test.ts` uses actual filesystem RunStore
reopening and real local Git, plus independently mutable Trello/GitHub resources
and request/acceptance ledgers. It covers late accepted comments/replies after
negative reads, wrong destination/`dueComplete`/body/refinement fields, exact
readback instead of response shape, missing production authority, real accepted
commit/removal with lost acknowledgments, unknown cleanup refusal, and terminal
release blocking followed by read-only reconciliation without any new write.
`tests/publish-verified-feedback-replies.test.ts` reopens the legacy ledger between
unknown-send absence and late discovery. Existing T1 SIGKILL/fencing tests and T2
publication crash/transport/redaction tests remain regression obligations. The P1
production lifecycle fixture tolerates multiple controlled terminal passes rather
than requiring synchronous cleanup completion.

Independent-review regressions in the same stateful suite exercise valid T2
comment and PR-creation capabilities against unrelated routes/cards/repositories,
changed payloads/fields/projects, a replacement authority, nested/repeated/stale
or escaped capability use, mutable argument objects and mutable commit-message
files. Rejected cases make no mutation transport request. Real Git/bare-remote
tests switch or detach HEAD, or change the task ref between intent and dispatch;
they also change the source ref at the actual push command boundary and observe
that only the intended immutable object reaches the remote. Lost-acknowledgment
push recovery additionally covers strict request parsing that reorders JSON keys:
artifact identity stays unchanged, while semantic request comparison ignores only
object-key order, not extra fields, values, or array order.

The independent-review focused run passed 287 tests in seven files:

```sh
yarn vitest run tests/workflow-mutations.integration.test.ts tests/durable-mutation.test.ts tests/initial-publication.integration.test.ts tests/p1-production-lifecycle.integration.test.ts tests/github-client.test.ts tests/trello-client.test.ts tests/git-client.test.ts
```

Focused validation executed:

```sh
yarn vitest run tests/workflow-mutations.integration.test.ts tests/durable-mutation.test.ts tests/initial-publication.integration.test.ts tests/p1-production-lifecycle.integration.test.ts tests/publish-verified-feedback-replies.test.ts
yarn vitest run tests/workflow-mutations.integration.test.ts tests/durable-mutation.test.ts tests/publish-verified-feedback-replies.test.ts tests/task-session-terminal-pr.test.ts
yarn validate
```

The second focused command passed 61 tests in four files. Full validation runs
lint, formatting, strict typecheck and the complete Vitest suite; exact final
counts are reported in the implementation handoff. The earlier formatting-check
failure for this new inventory was fixed with Prettier and rerun, not suppressed.

These support REQ-WF-001 AC1–5 and VER-WF-001-01/02/03 at concrete adapter and
filesystem integration levels, with PR-005/006 publication regression. They do not
establish a complete live-service or local/container lifecycle phase matrix.

- **T4:** replace notification pre-send claims with a durable nonblocking outbox,
  including the crash between verified workflow completion and event scheduling.
  Preserve four required event types and actual draft/outstanding-issue evidence;
  never put SMTP uncertainty in workflow pending operations.
- **T5:** extend this independently observed matrix to every concrete request,
  rejection/dispatch/acceptance/response/durable-completion boundary and actual
  previous-writer upgrade artifacts, including two-project isolation. Add real
  provider pagination/history/actor evidence and disposable container runs; do not
  label unexecuted variants passed.
- **P7/P9/P10:** complete terminal-event precedence while work is running,
  never-dispatched preflight intent cancellation after verified terminal outcomes,
  managed-body read/write races, human-edit/history compensation, exact final
  refinement handoff, cleanup preservation of clean local-only commits and closed
  PR history, and deliberate-retry provenance. Field readback is not atomic
  compare-and-write or complete actor attribution. Conservative unresolved cases
  retain ownership/operator attention; this foundation does not claim exactly-once
  external effects or complete later-phase lifecycle recovery.
