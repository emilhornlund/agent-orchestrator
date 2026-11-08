# P4-T1: durable workflow mutation foundation

The T1 snapshot below is retained as foundation evidence. Initial production
publication is subsequently integrated by [P4-T2](p4-initial-publication.md);
remaining global mutation routes and notification delivery are not claimed here.

Concrete remaining workflow routes and their evidence are now inventoried in
[P4-T3](p4-mutation-routing.md). T3 adds discoverable owned-worktree creation and
permits immediate positive independent verification only after a same-owner
accepted response; negative/unknown/recovery reads remain paced. The historical
T1-only scope and evidence below are otherwise retained.

This is foundation evidence, not P4 completion or realistic provider evidence.
Production publication, Trello/GitHub/Git mutation routing, and email delivery
remain T2, T3, and T4 respectively. No external service was contacted.

## Authority and compatibility

`RunStore.pendingOperations[].mutation` is a strict, version-1 extension of the
existing version-1 attempt envelope. There is no parallel mutation file, mutable
side store, provider framework, or replay engine. The surrounding operation's
status, generation and completion evidence are derived from the journal; its
legacy `intent` field must exactly equal the journal intent. Payload and evidence
are content-addressed, integrity-checked attempt artifacts, not log messages.

The reader accepts unextended P2/P3 records unchanged, without inventing dispatch,
intent, correlation, or completion proof. Existing legacy operations retain their
P2 resolution semantics; they do not become safe to resend through this API.
New mutations use only the journal API, not legacy operation discovery or
workflow transition callbacks. The first mutation write adds the extension in
the same atomic, fsynced, revision/lease-checked envelope. There is no bulk rewrite
or destructive migration. Unknown extension versions, policies, fields,
contradictory states and missing artifacts reject reads/writes and preserve the
original. The old strict P2/P3 reader rejects the new operation field, rather
than silently ignoring it. Thus rollback after adoption requires a compatible
reader or forward fix; do not strip the extension or restore an older snapshot.

## Vocabulary and allowed events

`durable-mutation.ts` enumerates concrete Trello move/content/labels/comment,
GitHub PR create/body/draft/reply, and Git commit/push/cleanup effects. Each kind
has one fixed policy: desired-state, discoverable, or non-idempotent. An intent
binds a stable operation ID, unique correlation ID, target and immutable payload
hash. Reusing an identity with changed content or target is rejected. Integration
adapters must validate the target against pinned resources and validate the
concrete payload before persisting intent; opaque target strings are identities,
not commands or evidence of provenance.

| Event                    | Preconditions                                                                                | Durable outcome                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Intent                   | Active attempt, current lease/revision, durable referenced payload                           | Pending, never dispatched                                                                 |
| Dispatch                 | Current execution and owner fences; first send or conclusive prior non-delivery; recheck due | Ambiguous before calling external code; new dispatch generation and future recheck        |
| Response                 | Matching dispatch/owner/execution; one response                                              | Accepted, unknown or proven non-delivery evidence; acceptance alone is **not** completion |
| Observe verified         | Authoritative intended-field/effect verification and bound actual identity                   | Completed, immutable verification and all prior attempts retained                         |
| Observe absent/uncertain | Recheck due, future recheck supplied                                                         | Still ambiguous; persisted attention flag and recheck                                     |
| Observe not delivered    | Conclusive provider-rejected-before-acceptance or transport-proven-not-sent evidence         | Failed dispatch, eligible for paced retry with original intent; no lost history           |

Never-dispatched intents can be explicitly cancelled after terminal observation or
execution supersession. Cancellation preserves the original intent/fence plus its
reason, evidence artifact, recording time, resolving owner generation, and current
execution fence. Its distinct `cancelled` status is conclusively resolved locally;
it never fabricates dispatch, provider rejection, or successful completion. Once
**any** dispatch checkpoint exists, cancellation is forbidden, even if delivery is
subsequently proven not to have occurred. Such a proven failed dispatch is already
conclusively resolved; uncertain dispatched effects still require discovery.
Cancellation is immutable across restart, and an operation identity cannot be
rebound to a replacement execution. Retain it and use a separate identity for new
work. The existing strict extension reader accepts records without cancellation
unchanged; older readers reject cancellation fields/status rather than ignore them.

Absence, timeout, transport failure after possible send, or a successful response
shape never establishes non-delivery or verifies intended fields. Concrete
reconcilers must substantiate proof through the referenced artifact. The core
cannot know provider truth from a caller's enum. It deliberately permits **no**
resend after possible acceptance, including desired-state effects. Desired-state
reconcilers can complete after readback; adding repeat-after-read semantics later
requires explicit field/concurrency safety proof, not a negative lookup. No
provider idempotency guarantee or unconditional exactly-once effect is claimed.

## Integration contract for T2/T3/T4

1. Sanitize outbound content at the existing P3 boundary **before** hashing it;
   persist exactly what will be sent, never credentials/raw diagnostics. Use
   `writeArtifact` then `referenceMutationArtifact`; orphan artifacts are safe.
2. `persistMutationIntent` before calling external code. Use a deterministic
   attempt-scoped ID and correlation marker where supported. Never synthesize an
   intent for a legacy write whose dispatch is already uncertain.
3. `recordMutationEvent(..., dispatch, ...)` before invoking the client through
   the existing lease-bound `ProjectRunAuthority.dispatch`. Schedule a controlled
   future recheck even if the process dies before reaching the network. Persist
   sanitized response evidence without calling it verified completion.
4. Read the provider's actual fields/history/refs, independently of its write
   response. Bind actual PR/comment/reply/object identity and record `observe`.
   Reconcile after restart rather than dispatch again. New owners may discover
   old effects but cannot record old workers' responses. Revision, mutation
   generation, owner generation and initiating execution generation are fenced.
5. T2 must bind actual PR identity before Trello synchronization. Keep completed
   effects if any later effect fails. T3 must verify destinations/fields, managed
   content and allowed transitions, including human edits and Git provenance;
   journal completion alone does not grant permission for a lifecycle change.
6. Unresolved workflow entries block terminal **release**, registry handoff and
   replacement claims. A verified terminal observation may still be recorded so
   in-flight effects can be reconciled without reopening workflow state. Terminal
   attempts cannot dispatch more effects. Refinement uses the same release gate.
   For never-dispatched intent, record explicit cancellation before release. The
   legacy terminal-projection API still requires conclusive operations: use the
   authoritative terminal-observation transition followed by cancellation, or
   supersede/cancel the old execution before committing that projection.
7. T4 must keep notification-only uncertainty in its non-blocking delivery record,
   not these workflow `pendingOperations`. Reuse intent/response/verification and
   proof distinctions, but do not introduce email as a terminal prerequisite.

No scheduler, automatic recheck loop, alert sender, notification outbox, client
adapter, or production route is added by T1. The persisted due time and attention
flag are inputs for later concrete reconciliation, not claims that it is wired.

## Acceptance evidence and limits

`tests/durable-mutation.test.ts` exercises REQ-WF-001 AC1–5 at the journal
boundary: all policies, stable identity, immutable completion, malformed and
unsupported records, artifact references, conclusive non-delivery versus absence,
late acceptance after negative reads, paced restart rechecks, stale revision /
owner / dispatch / execution fences, and terminal release blocking. A stateful
service substitute has an independently observable effect map and ordered
request/read/acceptance ledger. Explicit SIGKILL tests interrupt a child writer
after intent, dispatch, acceptance, response and durable completion; the parent
reopens actual filesystem state and independently inspects substitute resources
and its separate request/acceptance ledger. The subprocess fixture uses a test
lease, not a second production owner; actual ownership contention remains P2's
regression coverage.

Review regressions also kill the writer after terminal observation and after
cancellation, take ownership with a new fence, and verify cancellation can finish
terminal release without any service request. Execution-supersession tests verify
cancellation unblocks lifecycle advancement while retaining both fences.
Cancellation/rebinding after dispatch is rejected for uncertain, proven
non-delivery, and verified histories; forged cancellation records are rejected.

These are focused unit/filesystem/subprocess integration evidence supporting
VER-WF-001-01/02/03, not completion of those scenarios across production routes.
The subprocess service is a deterministic filesystem substitute, not Trello or
GitHub API compatibility evidence. Provider idempotency, full two-project
application lifecycles, actual field/history races, production PR recovery,
notification delivery, container runs and realistic services remain later-task
obligations. Recorded test clocks/delays are fixture values, not product defaults.
