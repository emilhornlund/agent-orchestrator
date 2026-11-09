# P4-T2: initial publication reconciliation

This records the initial-publication integration after T1. It does not declare
P4 complete, change advisory policy, or establish live provider compatibility.

The subsequent [P4-T3 routing inventory](p4-mutation-routing.md) covers remaining
client mutations. T2's sender now explicitly carries its existing journal dispatch
scope, avoiding nested T3 intents while preserving the original `initial:*`
identities, destination fences, crash recovery and verification sequence.
That scope is now a single-use capability bound to current durable dispatch proof
and the exact operation/target/payload, never a boolean authority bypass. New
commit payloads retain identity/signing fields, commit discovery verifies the
actual checked-out task branch/local ref, and push transport explicitly uses the
recorded immutable SHA with a full destination ref. Old accepted commit payloads
remain readable for discovery; missing identity proof does not authorize a new
commit dispatch. The T3 inventory records the independent-review regressions.

## Production route and authority

`publishTaskSessionCard` establishes a versioned `initial-publication-v1`
checkpoint inside the existing authoritative attempt envelope. It records the
sanitized task/presentation inputs, original base, execution fence, verified source
identity, and controlled waiting state. No parallel publication file or second
mutable authority is introduced. Payloads and observations are T1 content-addressed
artifacts referenced by the same attempt's mutation ledger.

Initial production publication always uses this route. There is no configuration
or per-call flag to disable journaling. Lease-scoped calls without an attempt
authority reject, including multi-project lease scopes. Existing unowned utility
calls retain their prior compatibility behavior; they are not a supported
production owner. Supplying an expected existing PR selects the existing-PR route,
which verifies that PR rather than authorizing initial creation; its remaining
mutation integration belongs to T3.

`pollProject` and `runOrchestrator` resume the checkpoint before general session
recovery or deferred startup Trello validation can absorb it into a legacy
attention/exhaustion block. Each invocation is bounded. Rechecks have a persisted
15-second minimum; the configured polling interval may make them less frequent.
The active queue event remains occupied while its execution token is yielded for
the next poll. It is never retired to permit another card. Source, integration,
storage, base-branch and execution fences are checked before further publication.

The concrete sequence is:

1. Check original source identity, owned worktree/branch/common Git directory,
   current Trello list and absence of unjournaled publication history. Preserve
   changed or ambiguous work rather than staging a replacement implementation.
2. Record a commit intent binding parent, exact tree, sanitized message and explicit
   `cleanup: verbatim` before
   commit dispatch. Recover by actual single-parent commit/tree/message and clean
   worktree, retaining the immutable observed SHA. Staging is local preparation,
   not evidence of commit acceptance. Optional description generation remains
   read-only and post-commit; its finalized sanitized body is checkpointed before
   any PR dispatch and is not regenerated during creation reconciliation.
   Message preparation adds a final LF only when absent and preserves leading
   blank lines, trailing spaces, repeated blank lines and comment/scissors text.
   Dispatch always supplies `--cleanup=verbatim`, overriding `commit.cleanup`.
   Independent readback frames `%B` so the process adapter's outer trimming does
   not erase message whitespace; verification compares the exact message, not a
   `trimEnd()` approximation. Existing non-initial commit callers are unchanged.
3. Resolve effective fetch and **all** push URLs using Git's `get-url --all` and
   `get-url --push --all`, including `insteadOf`/`pushInsteadOf`. Require one
   supported GitHub destination per direction matching the pinned repository;
   even duplicate or empty extra configured URLs are rejected. Reject additional
   non-identity rewrites of concrete URLs rather than replay ambiguous chains.
   Persist both concrete destinations in the checkpoint and push intent. Recheck
   their exact bindings on resumed passes, immediately before dispatch/readback,
   and before interrupted local handoff. Fetch without rebasing and push using
   the concrete URLs, not the mutable `origin` alias. Verify the actual ref at the
   bound **push** destination. A different destination or remote head is a
   preservation/blockage condition, not
   permission to overwrite it. Completed push/commit identities are never rebound
   to a later HEAD.
4. Persist PR creation intent with head/base, title, exact sanitized body, draft
   state and attempt marker before dispatch. Read all-state PR metadata and
   independent title/body/draft fields. Verify repository, actual URL/number,
   branch, head and marker-bearing payload; store the actual identity in the task
   projection and attempt resource manifest **before any Trello effect**.
5. Journal the initial Human Review move and verify the card in the pinned
   destination, including its actual `idList`. A successful-looking move response
   does not complete it. Journal the initial summary comment with stable marker
   and exact-text readback. Verify the PR and destination again before the atomic
   publication-to-CI transition. Interrupted local queue/checkpoint closure resumes
   without repeating external writes. Other Trello moves/comments remain T3.

## Uncertainty and compatibility

Possible acceptance is never resent because a read returned no result. Lost
acknowledgments, negative reads and outages preserve the original dispatch and
artifacts. A late accepted creation is discovered with its original marker and
bound to the same attempt. Blank or malformed GitHub JSON is not absence.

Only explicit evidence permits another dispatch generation: a process spawn
failure proves no command was launched, the local destination guard proves the
Git push method was never invoked, or a concrete Trello 400/401/403/404/405/
422 rejection proves that request was rejected before acceptance. A timeout,
generic exception, nonzero Git/gh exit, 5xx, missing ref, or negative PR/comment
lookup does **not** provide this proof. The response/evidence history is retained
when a proven non-delivery is retried. If a dispatch checkpoint survives but
neither acceptance nor non-delivery can be established, controlled waiting and
operator attention are the honest result; this is not an exactly-once guarantee.

Waiting records expose due time, reason and an orchestrator-authored diagnostic;
raw exception/process text is not copied into the payload or journal. Prolonged
waiting becomes attention-visible after five minutes and can send one best-effort
attention notification. The checkpoint is still automatically rechecked. Email
delivery records, reliable retry and crash-safe notification handoff are T4:
the existing pre-send notification claim is not proof of transport delivery.
Notification failure cannot undo the verified workflow.

No legacy pending-commit intent is upgraded into new dispatch proof. A legacy
trusted commit without an initial-publication checkpoint also cannot establish
that an old PR-creation request was never sent. These cases retain their original
records and work and block for explicit reconciliation. Unknown/malformed
checkpoint/schema/artifact data is not destructively migrated or removed.
The pending pre-review T2 checkpoint lacking explicit commit-cleanup proof, or a push
intent lacking concrete destination evidence, also remains blocked and preserved;
the new reader does not synthesize historical transport or cleanup proof.

Human terminal outcomes or conflicting/unattributable external edits discovered
during this initial checkpoint stop new writes and preserve ownership. Full
terminal precedence/observation composition remains P7/P10; this change does not
reopen a closed PR or recreate its branch to evade such a conflict. P5 session
restoration and P6 advisory policy are unchanged.

## Executable evidence

`tests/initial-publication.integration.test.ts` uses real local Git repositories,
bare remotes, task worktrees, subprocess execution, and filesystem RunStore state.
Its Trello/GitHub substitutes maintain their own resource files and append-only
request/read/acceptance ledger, independently of the application state. It drives
`publishTaskSessionCard`, `pollProject`, and a timed `runOrchestrator` recovery run.
Clocks are accelerated fixture clocks; the production recheck delay is not
overridden. Test leases in the subprocess fixture are not a second production
ownership implementation.
For transport simulation, the fixture's Git executor maps the canonical GitHub
URL to a real local bare repository only for fetch/push/ls-remote execution. Real
Git configuration discovery runs without that transport mapping, so wrong
push URLs and configured rewrites are genuinely observed and rejected by the
production destination fence. No network call to GitHub is needed.

Coverage includes:

- REQ-WF-001 / VER-WF-001-01/02/03, applicable initial paths: journal-before-send;
  independent field/destination readback; accepted-but-unacknowledged effects;
  negative reads followed by late acceptance; no uncertain resend; rejected
  legacy provenance; source/pin/owner fences; and preserved queue occupancy.
- REQ-PR-005 AC1–4 / VER-PR-005-01: persisted verified identity before a lost or
  rejected Trello move; accepted creation after a negative lookup; restart and
  same-PR completion; independent single initial commit/PR/move/comment counts.
- REQ-PR-006 AC1–4 / VER-PR-006-01: prolonged pre-creation and post-acceptance
  outages, preserved work, paced reads, automatic recovery without an absorbing
  attention state, and one attention notification in the production worker test.
  In the accepted-create/lost-response and accepted-move/lost-response retryAt
  parameter cases, a separately rooted `project-b` authority completes normal
  publication while A remains in publication wait; A's active queue owner remains
  occupied. The worker attention case also reopens the durable outbox reader and
  drains twice, asserting the same single attention event identity and no repeat
  send after confirmed delivery. These are controlled simulated-service cases,
  not a complete multi-project outage matrix or transport-uncertainty proof.
- SIGKILL at PR intent, dispatch, acceptance, response and durable verification;
  SIGKILL after actual Git commit/push and Trello move/comment acceptance; and
  after the atomic publication projection before local queue/checkpoint closure.
  Dispatch-without-provable-delivery deliberately remains unresolved, with no
  replacement request. Other acceptance boundaries recover the original effect.
- Known literal/base64 canaries checked in checkpoint, journal artifacts, commit
  message and outbound PR/comment payloads. This supplements P3; it is not a
  universal secret-detection claim.
- Independent-review regressions cover correct fetch plus wrong pushurl,
  multiple/duplicate/empty URLs, fetch/push/second rewrites, explicit-pushurl
  rewriting, a supported terminal alias, and destination changes after push
  intent or acceptance across SIGKILL/restart. The unintended bare remote stays
  untouched and project ownership/work remain preserved; restoring the original
  configuration resumes the same commit with one push dispatch. Equivalent-repo
  URL spelling changes are also fenced once the concrete URL is bound.
- Whitespace variants with `commit.cleanup=strip`, `whitespace` and `scissors`
  survive SIGKILL after actual commit acceptance. An independent `cat-file`
  observer checks exact stored message bytes, then restart produces one initial
  commit and eventual publication without resending the commit.

The existing `tests/p1-production-lifecycle.integration.test.ts` now models the
new paced reads and comment/PR field observations. Its former accepted-PR
characterization blockage is replaced by automatic same-PR recovery, while its
real lease/registry, normal/draft, single-commit, next-card exclusion, human
merge/closure and source-checkout preservation assertions remain.

Client parser regressions are in `tests/github-client.test.ts` and
`tests/trello-client.test.ts`. T1 reducer/fencing/crash tests remain unchanged.
Focused commands and full `yarn validate` are reported with the implementation
handoff. No live Trello/GitHub/OpenCode service, email transport or container was
used for this task. Full fault permutations, realistic compatibility and complete
two-project composed lifecycle evidence remain T5/later phase evidence obligations;
the B assertion is a focused independent publication slice and does not claim
simultaneous production-worker scheduling of both projects. These tests are not
substitutes for those levels.

## Subsequent task guidance

- T3 should reuse the concrete proof distinctions and authoritative journal for
  remaining moves/comments, replies, body/draft/activity changes, corrections and
  cleanup. Do not treat initial-publication completion as blanket authorization
  for another lifecycle mutation or blindly repeat desired-state writes.
- T4 must replace best-effort notification claims with non-blocking delivery
  records/outbox semantics, including the crash between workflow completion and
  notification scheduling. Do not put email uncertainty in workflow operations.
- T5 should extend the independently observed services/ledger and actual prior
  writer artifacts, not infer provider acceptance from logs or a canned response.
