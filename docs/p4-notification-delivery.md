# P4-T4: non-blocking notification delivery

This is T4 implementation evidence, not P4 completion or realistic inbox evidence.
Read with the T1 foundation, T2 publication and T3 routing inventories. The five
architecture documents remain authoritative; later P6/P9/P10 lifecycle wiring is
not claimed here.

## Authority and ordered handoff

The immutable **workflow-event obligation** is authoritative in the original
`RunStore.compatibility[notification-event-<id>]`, committed through the current
attempt's revision/owner/lease fence. It contains sanitized presentation, event
identity, transport-target hash and (when not yet observed) a concrete mutation
binding. This is not a workflow pending operation or a completion prerequisite for
SMTP. The separate outbox owns **only delivery outcomes**. Missing/outdated delivery
files are materialized from original active/terminal/archived attempt obligations;
recovery reads pinned attempts and integrity-checked artifacts without taking over
their owners, changing registry pointers or writing their workflow state.
Each source attempt is a separate recovery failure boundary, including when multiple
projects share one runtime root. Unreadable, unsupported or malformed sources and
missing/corrupt referenced artifacts are retained and reported by the SHA-256 of
their filename (never raw source/exception text). They cannot supply unvalidated
events or abort other valid sources or existing outbox delivery. A source's complete
obligation set is parsed before deriving records from it; lease loss still aborts
processing rather than being swallowed as a source failure.

`notifications/<sha256(projectId)>/<sha256(eventKey)>.json` under the pinned external
runtime storage root is the **notification-only** outbox. It never updates a
workflow outcome, `pendingOperations`, terminal gate or registry pointer. There is
no competing workflow authority. Its versioned strict records retain sanitized
payload/hash, event identity, stable RFC Message-ID, creation time, transport-target
hash when exposed by the sender, dispatch history, observed transport outcome and
persisted recheck deadline. A revision compare-and-swap and canonical project lease
fence writes/responses; private temporary writes, file fsync, rename and directory
fsync protect checkpoints. Unsafe symlink paths and malformed records are preserved
and reported rather than discarded or used as resend permission.

The production worker binds this outbox to the pinned runtime root and canonical
project lease, **not** the active attempt owner. It therefore drains old events
after terminal release, replacement attempts and restart. Standalone attempt-scoped
polling uses the same pinned root with its current attempt fence. A bounded pass
precedes workflow reconciliation, including blocked-project waits. Notifications
disabled at startup require no transport; disabled event flags suppress dispatch
of retained events too. A changed SMTP host/port/security/from/recipient identity is
reported and not silently rebound; credentials are not persisted in the intent.

Delivery runs in a separate bounded asynchronous pass; workflow calls only enqueue
and schedule it. A process-local single-sender guard avoids concurrent passes but
is not acceptance evidence or durable authority. Slow SMTP therefore does not hold
the workflow stack, project release or next attempt hostage. Shutdown/lost ownership
can leave its already-checkpointed dispatch ambiguous for the next owner.

Current notifier helpers durably record the obligation before sending, retaining the four required
events and the existing optional `done` compatibility event. Identity includes the
attempt when available, event kind and observed commit/card/failure identity; it is
not a delivered flag. Confirmed events deduplicate even if later rendering changes.
T2 explicitly enqueues PR readiness **before** the publication-completed projection
and attention **before** `attentionNotified`. Worker and task-session attention
routes enqueue before their persisted suppression checkpoints. Refinement, failure,
existing-PR publication and optional merged-completion routes now persist a
**prepared, non-sendable obligation before the final Trello transition**. It carries
the rendered payload and pinned board/card/destination, original attempt ID,
specific final mutation ID/payload SHA and execution generation. Refinement prepares
only after its preceding field mutations have verified, binds the immutable intended
snapshot hash, and requires the final move's independently observed title,
description and complete label set to match that intended snapshot.

Neither reaching a post-transition notifier nor observing a current destination or
ANY later transition is proof. Recovery requires the bound original mutation to be
completed with verified, integrity-checked evidence in that exact original attempt.
A manual move or replacement execution cannot authorize the old event. Conversely,
a verified original effect remains proof after a later card move or human field
edit; recovery never substitutes current card state for that historical proof.
Legacy unbound triggers remain observable and non-sendable, rather than being
upgraded using list position/history. An unavailable/unproven observation retains
the obligation with paced checks and an explicit diagnostic; preparation alone never
authorizes a send. This is an ordered durable handoff,
not a cross-file transaction; a crash before local completion can retain a valid
notification about independently verified external publication. No email success
is required to finish publication or terminal release.

There is no required post-event outbox promotion write. Once the authoritative
obligation exists, delivery-file/storage failure is reported and cannot prevent
`completeRefinementAuthority`, queue completion, terminal release or another project
progressing. SMTP uncertainty still never becomes workflow state.

Only **missing initial durable handoff** is a typed `NotificationPreparationError`.
The scheduler retains/releases the active queue for recovery (not engineering
failure), polling records a 15-second `notification-storage-wait` in the attempt,
and the project worker handles escaped preparation errors locally. It does not send
attention recursively through the broken dependency or reject the other projects'
workers. If even the wait checkpoint cannot be written, ownership/queue remain
preserved and a process-local pacing fallback plus diagnostic is used, not invented
durable completion. Restoring initial-handoff storage resumes the saved refinement
snapshot without re-running engineering. Initial obligation storage is a prerequisite
for durable handoff, **not** an SMTP or delivery-file prerequisite.

PR messages contain explicit observed draft status (or explicitly unavailable
observation for a failed existing-PR read), PR/task links, project identity and
recorded outstanding advisory results. T2 uses its independently verified draft
field. Existing-PR routes read actual publication fields rather than infer draft
from requested settings. Complete material-issue disposition reporting remains P6.
Known registered secrets/recognized encodings are redacted **before** persistence;
outbound SMTP also uses the existing P3 boundary. Raw transport exceptions and
credentials never become outbox evidence. This is not universal secret detection.

## Transport outcomes

- Empty dispatch history: durable intent, never sent.
- Dispatch: persisted ambiguous **before** calling the sender, with a future due
  time. A crash here cannot establish whether the network was reached.
- Concrete SMTP negative transaction reply: known non-delivery. Retry retains
  original payload/Message-ID and dispatch history, only on a later due pass.
- Generic exception, timeout, abort or lost response: ambiguous. Neither absence
  nor a successful later connection permits resend.
- Successful SMTP transaction: confirmed **relay acceptance**, not recipient receipt.
  That event is never automatically sent again.

The transport privately observes Nodemailer's client-command hook before DATA is
written. TCP refusal, injected DNS failure, TLS negotiation failure and other
failures proven before DATA are known non-delivery, including without an SMTP
response code. Once DATA may have started, socket errors/timeouts/abort remain
ambiguous unless a concrete negative transaction reply proves rejection. Protocol
hook inputs (including authentication/message bytes) are discarded, never logged.

The transport's returned Message-ID is retained as provider correlation evidence.
Partial recipient acceptance is explicitly reported and retained without resending
the whole message (which would duplicate the accepted recipients).

Rechecks/retries have a persisted 15-second minimum and no immediate retry loop.
The 100-action limit is applied only after target compatibility and due-time checks;
old incompatible transport identities cannot consume the current target's budget.
The sender can expose authoritative `lookupDelivery(Message-ID)` evidence; only
confirmed acceptance or proven non-delivery changes an ambiguous outcome. Ordinary
SMTP has no lookup API: its uncertainty is reported with the stable Message-ID for
provider/operator investigation and remains retained without blind resend. There
is no exactly-once receipt guarantee and no automatic operator-resolution command.
Delivery and storage diagnostics are nonblocking at the worker delivery boundary;
the ordered enqueue handoff itself still requires writable durable storage, as do
workflow checkpoints. Do not remove outbox files to retry an uncertain send.

## Evidence and limits / T5 guidance

- `notification-outbox.test.ts`: intent/restart, known rejection and paced retry,
  late acceptance/provider lookup, no negative-lookup resend, confirmed-event
  deduplication, event disablement, target pinning, project isolation, secret
  canaries, malformed retention and lost-lease response fences. A child writer is
  SIGKILLed after intent, dispatch, acceptance, response-before-recording and
  confirmation; a separate sink file is independently inspected after reopening.
- `notification-authority.integration.test.ts`: actual `pollProject` and two-project
  `runOrchestrator`, actual P2 ownership leases/pins/RunStore/queue and actual Trello
  mutation adapters against independent external-card files. Broken A delivery
  storage permits both refinements to complete and release; restoring it recovers
  A's original verified event even after later human/replacement field/list changes.
  Missing initial handoff retains A with a paced checkpoint while B completes; A
  resumes the saved result after restoration. Failures before final fields or the
  final move, followed by manual Backlog, send no completion email. A bound move
  whose final observation has wrong intended fields also sends no completion email.
  Four additional shared-root variants use two real project leases/authorities in
  the same coordination namespace and runtime root. Malformed/unsupported A attempt
  records and missing/corrupt A artifacts remain byte-for-byte preserved (or remain
  missing), are reported without source-content disclosure, and do not prevent B's
  existing and source-recovered events from each delivering exactly once across two
  drain passes. No A event is derived for B.
- `notification-routes.integration.test.ts`: retained utility/no-authority route
  and SIGKILL fixtures now explicitly assert that their unbound triggers cannot be
  promoted by a notifier, list position or later history. The earlier positive
  recovery oracle was unsafe and is superseded by the real-authority suite above;
  these utility fixtures are not production proof.
- `smtp-email-notifier.test.ts`: actual local TLS SMTP sink captures all required
  event payloads, normal/draft evidence and stable Message-ID; rejects DATA before
  acceptance or accepts DATA and closes without acknowledgment. Filesystem reopen
  demonstrates safe retry versus preserved uncertainty and independent sink counts.
  Actual refused TCP and untrusted TLS setup followed by restored local TLS SMTP
  exercise persisted paced retry; an injected resolver proves DNS non-submission
  without relying on external DNS.
- `initial-publication.integration.test.ts`: killed production polling writer after
  workflow publication projection already left the notification intent durable;
  restart delivers once without repeating publication.
- `durable-mutation.test.ts`: ambiguous email does not enter workflow operations,
  prevent verified terminal release or prevent actual registry handoff to another
  attempt. Old uncertainty and new-attempt delivery coexist in the same outbox.
- Existing email, publication, worker, refinement and workflow-mutation tests remain
  regression obligations. Validation commands/counts are reported in the handoff.

These support NOT-001 AC1–3, NOT-002 AC1–3 and WF-001 at unit, filesystem,
subprocess and local SMTP integration levels, not full realistic scenario closure.
T5 should compose all production lifecycle event paths with independent recipient
counts, two-project real leases, every enqueue/dispatch/acceptance boundary, actual
previous-writer artifacts and disposable container restart. Ordinary SMTP cannot
prove late acceptance remotely; a provider-specific controlled inbox/ledger is
needed for realistic reconciliation evidence. No live provider, paid service,
container or production resource was used here. Historical pre-send claims are not
upgraded into invented delivery proof or automatically resent. P6/P9/P10 must reuse
the durable helpers when completing their future lifecycle/resumption routes.
This notification change does not claim P9's complete concurrent-human-edit or
atomic refinement finalization policy; notification evidence specifically rejects
final fields that disagree with the bound intended snapshot.
