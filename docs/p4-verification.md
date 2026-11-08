# P4-T5 — integration and evidence record

## Supervisor validation correction — finite RunStore cells and per-event SMTP

The supervisor independently passed `test:p4` (**343 tests / 18 files**), then
`yarn validate` failed **1 of 1,818 tests**: the single exhaustive test at
`tests/run-store.test.ts:114` exceeded Vitest's unchanged **5,000 ms** default and
took **7,571 ms** on disk-backed TMPDIR. The other **1,817 passed**. Earlier passing
reruns below do not erase that failure or establish that the monolithic test was
reliable.

The correction replaces only that test's outer enumeration with `it.each` cells:
**56 allowed event/source/destination tuples**, each retaining **all** its original
forbidden-destination assertions, including repeated negative checks for every
allowed target. That is still **750 negative transition assertions**, at most
**15 per cell**. Positive lifecycle and ambiguous-observation assertions are
unchanged. Every cell creates its own real filesystem-backed RunStore; production
atomic writes, file/directory fsync and validation are untouched, not mocked or
disabled. Direct whitespace-insensitive diff inspection confirms the original
test body/oracles remain. The original one test becomes 56 tests, so suite counts
increase by **55**, not because transitions or negative cases were dropped.
Directories remain under the cached TMPDIR for diagnosis. No timeout was raised,
no tests were skipped, and no storage safety check was weakened.

The publication/attention SMTP oracle now also obtains each **expected** event
record and stable Message-ID from the outbox and requires **exactly one accepted
DATA message for each ID**. It asserts the expected event set (one readiness event,
one attention event only for the outage variants), exact total accepted count and
event-specific content: project/task link; actual PR link/draft/outstanding
findings for readiness; Git/GitHub failure category and publication uncertainty /
controlled-reconciliation details for attention. Aggregate uniqueness/content
checks remain, but can no longer substitute for proving each event was delivered.

Focused correction command:

```sh
TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp" VITEST_MAX_WORKERS=1 \
  yarn vitest run tests/run-store.test.ts tests/p4-workflow-smtp.integration.test.ts
```

**86 tests / 2 files passed**, start **02:38:36 CET**, **29.68 s**. Matrix inventory
was independently enumerated from `runEventTypes`, `runLifecycleStates` and
`runTransitionMatrix`: 56 allowed tuples / 750 forbidden checks / maximum 15
forbidden checks per cell.

Corrected full-validation command:

```sh
TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp" VITEST_MAX_WORKERS=1 yarn validate
```

**Passed** ESLint, repository-wide formatting, strict TypeScript and **1,873 tests
/ 153 files**, start **02:40:28 CET**, suite **335.96 s**, command **358.06 s**,
exit **0**. As for the preceding expanded serial runs, the unchanged command was
supervised locally across tool calls bounded to 300 s; there is no new test timeout
or worker-count change. Exact output is retained at
`node_modules/.cache/p4-validation-tmp/p4-matrix-cells-validate.log`; the adjacent
`p4-matrix-cells-validate-result.json` records start, finish and exit 0. Earlier
logs/artifacts were not overwritten or removed. Earlier 1,818-test counts below
predate parameterization; the current 55-test increase is solely the split of one
exhaustive test into its 56 finite cells. The supervisor's failure remains part
of this record, rather than being reclassified as a passing flaky rerun.

## Review response — current evidence (supersedes initial T5 limitations below)

The first T5 review failed because locally executable evidence was missing. The
following additions address those findings without changing production policy or
claiming whole-phase completion. The **Initial T5 record** below is preserved as a
historical execution record; its former missing-route/provider/composition entries
are superseded by this section, not current unresolved local blockers.

### Finite mutation / boundary inventory

All listed cells use separate fixtures and a child writer killed with SIGKILL.
Boundaries are **durable intent, durable dispatch before transport, independent
acceptance before response, returned response **before durable response recording**,
and durable verified completion before the next step**. Each entry is exercised
at all five boundaries; no extra permutation of equivalent payloads is implied.

| Concrete route                                                                                                                                      | Five-boundary suite                                    | Independent resources / oracle                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial commit, push, PR create, Human Review move, publication comment                                                                             | `p4-lease-recovery.integration.test.ts` — **25 cases** | Actual Git objects/refs/worktree; separate Trello/PR resource file and append-only service ledger; real P2 kernel lease contention and generations 1→2→3 |
| Trello move, content, add label, remove label, comment                                                                                              | `p4-route-crash.integration.test.ts`                   | Separate card/action JSON; request/read/acceptance ledger; exact observed fields and actual action identity                                              |
| GitHub body, draft, thread reply, conversation reply                                                                                                | Same                                                   | Independent PR body/draft/comment/thread resources; exact text/marker and observed reply ID; gh command boundary substitute                              |
| Noninitial commit, push, owned new-branch worktree, existing-branch worktree, owned worktree removal, local branch deletion, remote branch deletion | Same                                                   | Actual Git, common repo, local bare remote, filesystem registration, SHA/ref/absence readback and independent acceptance identities                      |

The concrete adapter matrix has **16 routes × 5 = 80 cases**. It reopens actual
RunStore storage with a replacement owner, preserves intent/correlation, verifies
no read or write before the 15 s deadline, advances three further reconciliation
windows and checks one request/effect (or zero accepted effects at dispatch-only
death). The latter remains explicitly ambiguous, never resent or falsely complete.
Git acceptance identities are read from actual objects/refs, not generated from
RunStore. Parent assertions independently inspect local and remote refs, commit
counts, worktree presence and non-idempotent comment/reply counts.

Initial publication additionally presents a **second eligible Ready card** in all
25 cases. After owner takeover it resumes publication, polls **two further full
windows**, rereads the actual registry pointer **after** these polls, and checks
the original card/attempt, queue occupancy while uncertain, original open PR and
zero second-card claims. Successful publication retires the operation queue, not
the active task. Missing CI is independently observed as waiting, not invented
successful CI. This corrects review finding 4, rather than relying on a registry
snapshot taken only before recovery.

**Explicit N/A:** status rendering delegates to the exact-body route, so there is
no second remote status write to interrupt; add/remove label and existing/new
worktree modes are separately covered. Broad prune, force push, rebase, merge,
thread resolution and mark-ready have no enabled production mutation route and
are not dispatched for testing. Auth token exchange and local index preparation
are not workflow transitions. SMTP has its own five-boundary subprocess suite
and is composed with actual transaction faults below; it is not a workflow pending
operation. Later-phase semantic field/history and running-terminal races remain
their declared P7/P9/P10 obligations, not missing equivalent P4 journal cells.

### Application boundary to actual observed TLS SMTP

`p4-workflow-smtp.integration.test.ts` has **10 finite composition cases**. It does
not manually build email or substitute Git. Real Git repositories/worktrees/bare
remotes and actual child processes are used; production polling/refinement/failure
and publication routes create obligations. A real TLS SMTP server independently
records DATA, rejection, acceptance, payload and Message-ID. It uses the established
public synthetic localhost certificate/key, not real credentials or a new OpenSSL
CLI dependency. The relay implements SMTP dot unstuffing;
the observer unfolds headers and decodes quoted-printable before content checks.

| Variants                                                                                                      | Application-boundary observations                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normal and draft publication × Trello move rejection or accepted-comment lost response (4)                    | Original PR/commit retained, pending queue excludes second card, restart with new owner completes same publication, exact one PR/comment/commit and actual draft/outstanding-issue email                                                                                                                                                                     |
| Outage before creation; outage after accepted creation/lost response (2)                                      | Preserved real work/intent, multiple controlled windows, prolonged wait emits one attention obligation, restart/recovery binds one PR; actual attention and readiness messages are observed, not merely queued                                                                                                                                               |
| Successful refinement and genuine refinement child exit 7 × SMTP DATA rejection or accepted DATA/lost ACK (4) | Two real P2 project leases sharing storage; A's accepted Working move has hidden readback/lost ACK and keeps its active queue/second card excluded while B completes real-Git refinement; A resumes from actual owned-worktree proof. Genuine failure goes through current production `runRefinement`→`failCard`, not a manually constructed failure message |

For each relay fault the tests reopen delivery records and drain multiple later
windows: concrete rejection permits paced retry; possible acceptance does not.
They inspect the actual recipient sink, stable Message-ID, task/project links,
classification/failure reason, observed draft boolean and unresolved advisory
text. Confirmed/reconciled workflow outcomes remain unchanged. Successful refinement
releases the actual terminal queue/authority **before delivery recovery**, even
with ambiguous accepted email. The existing genuine refinement-failure boundary
preserves its failed queue/worktree after the verified Failed move/comment; this
test asserts that current outcome, not a fabricated P10 failure-release protocol.
Healthy B still completes and releases. New full failure finalization policy is
not implemented under this evidence task.

The fixture waits for automatically scheduled delivery passes to settle before
an independent restart drain, so the oracle does not race the application sender
or mistake a prepared event's later first send for a duplicate. No production
timeouts or assertions were weakened to accommodate the composition.

### Concrete provider-idempotent variant

`p4-provider-idempotency.integration.test.ts` exercises VER-WF-001-03 with an
actual Git **content-addressed commit object / immutable-SHA desired ref**. A
dispatched transport is held in flight while the application observes a negative
remote-ref read. After reopening authority, the original captured Git transaction
is accepted at the local bare provider. Reconciliation binds the original SHA and
intent with **one orchestrator dispatch**. An explicitly labelled independent
provider-oracle replay of the exact same transaction yields `Everything up-to-date`,
the same ref and **one task commit**, not a new side-effect identity.

This is concrete natural provider idempotency, not a synthetic HTTP key API. It
does **not** authorize the orchestrator to replay uncertainty; it still discovers
before advancing. PR/comment/reply APIs in the supported clients expose no
idempotency-key contract; that API-key subvariant is **N/A for those routes**, not
silently simulated. Their late acceptance and negative-read cases use actual
resource/correlation discovery instead. Real GitHub/Trello provider observations
remain blocked on disposable authorization, not on this locally executable case.

### Current scenario/criterion mapping and remaining blockers

| Scenario                   | Criteria                                              | Added evidence / exercised level                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VER-WF-001-01/02/03        | WF-001 AC1–5; shared allowed-transition/release gates | 105 route/barrier child cases, paced reopen/no replay, late concrete provider ref, post-recovery project/queue/next-card exclusion; local unit + integration                       |
| VER-PR-005-01              | PR-005 AC1–4                                          | Five initial effect routes with actual P2 takeover; normal/draft move/comment faults through polling to real SMTP; integration and specified simulated application-boundary slices |
| VER-PR-006-01 (P4 support) | PR-006 AC1–4                                          | Before-create and accepted/lost-response outages with restart, real Git preservation, controlled attention and SMTP counts; integration/application-boundary support               |
| VER-NOT-001-01             | NOT-001 AC1–3                                         | All four genuine event origins, normal/draft actual fields, useful links/content, observed actual TLS DATA; local integration                                                      |
| VER-NOT-002-01             | NOT-002 AC1–3                                         | All four origins composed with rejection or uncertainty, restart drains and sink dedup; actual successful terminal release and independent B progress; local integration           |

The requested finite P4 local route/boundary, composition and provider-identity
gaps are now executable. **Realistic levels remain BLOCKED**: no authorized
disposable Trello Free/GitHub/App/PAT/OpenCode resources or controlled external
relay/inbox were supplied. No provider-specific exactly-once receipt guarantee is
claimed. Full production deployment/container lifecycle parity and later-phase
semantic/race policies are not inferred from these tests. The earlier Podman run
below is retained at its exact tested version; the separate review-additions
container run is recorded below, not retroactively counted in that earlier run.

All commands use the existing cached TMPDIR and `VITEST_MAX_WORKERS=1`:

```sh
TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp" VITEST_MAX_WORKERS=1 yarn test:p4
TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp" VITEST_MAX_WORKERS=1 yarn validate
```

- Focused P4 run: **18 files / 343 tests passed**, start 01:52:17 CET,
  suite **218.09 s**. Includes all 105 subprocess route/barrier cases, 10 actual
  workflow/SMTP compositions and the provider-identity case.
- Full validation before removing the optional test OpenSSL dependency: **153
  files / 1,818 tests passed**, ESLint, Prettier and strict TypeScript passed;
  start 01:56:48 CET, suite **340.93 s**, command **363.17 s**, exit **0**.
  Log: `node_modules/.cache/p4-validation-tmp/p4-review-validate.log`;
  completion/exit manifest: `p4-review-validate-result.json` alongside it.
  Because the expanded **serial** suite exceeds one 300 s tool call, the unchanged
  `yarn validate` command was supervised locally with persistent output and polled
  using calls bounded to 300 s; no test timeout, assertion or worker count changed.
- After switching only the test TLS certificate source to the existing synthetic
  material, the complete new four-suite subset was repeated in offline Podman:
  **4 files / 116 tests passed**, start 01:06:14 UTC, **113.05 s**. Local composition
  tests also passed before the container run. A preliminary OpenSSL availability
  probe in the old P3 test image failed; no dependency was installed, and the
  reusable test material removed that unnecessary CLI prerequisite.
- **Final working-tree validation**, including explicit assertions that a returned
  response was **not** durably recorded and that no independent service read was
  made before the due time: **153 files / 1,818 tests passed**, lint, formatting
  and strict typecheck passed; start **02:17:17 CET**, suite **338.35 s**, command
  **360.64 s**, exit **0**. Exact full output is retained in
  `node_modules/.cache/p4-validation-tmp/p4-response-barrier-validate.log` and the
  adjacent `p4-response-barrier-validate-result.json` records start/finish/exit.
  The preceding post-certificate full rerun also passed with exit 0 and remains
  separately preserved as `p4-review-final-validate.log` / `-result.json`.
- The **21 affected response cells** were then repeated in Podman on the final
  hooks: **2 files / 21 passed**, **84 intentionally filtered** by `-t "at response"`,
  start **01:24:28 UTC**, **16.79 s**. The unfiltered 116-case run above covers the
  unchanged other cells/compositions/provider variant; no failed case was filtered
  out to obtain a passing full matrix. No full production deployment parity is
  inferred from these focused container runs.

Exact review container command (same preexisting image identity and mounts as the
historical container command, no build/network/credentials):

```sh
timeout --kill-after=10s 240s podman run --rm --network none \
  --name agent-orchestrator-p4-review-evidence \
  -e TMPDIR=/evidence -e VITEST_MAX_WORKERS=1 \
  -v "$PWD/src:/workspace/src:ro,Z" \
  -v "$PWD/tests:/workspace/tests:ro,Z" \
  -v "$PWD/package.json:/workspace/package.json:ro,Z" \
  -v "$PWD/node_modules/.cache/p4-validation-tmp/p4-container-evidence:/evidence:Z" \
  localhost/agent-orchestrator-p3-test:latest yarn vitest run \
  tests/p4-lease-recovery.integration.test.ts tests/p4-route-crash.integration.test.ts \
  tests/p4-workflow-smtp.integration.test.ts tests/p4-provider-idempotency.integration.test.ts

timeout --kill-after=10s 120s podman run --rm --network none \
  --name agent-orchestrator-p4-response-evidence \
  -e TMPDIR=/evidence -e VITEST_MAX_WORKERS=1 \
  -v "$PWD/src:/workspace/src:ro,Z" \
  -v "$PWD/tests:/workspace/tests:ro,Z" \
  -v "$PWD/package.json:/workspace/package.json:ro,Z" \
  -v "$PWD/node_modules/.cache/p4-validation-tmp/p4-container-evidence:/evidence:Z" \
  localhost/agent-orchestrator-p3-test:latest yarn vitest run \
  tests/p4-lease-recovery.integration.test.ts tests/p4-route-crash.integration.test.ts \
  -t "at response"
```

Retained review
artifacts are `p4-route-crash-*`, `p4-lease-*`, `p4-provider-ref-*`,
`p4-workflow-smtp-*`, `p4-terminal-smtp-*` below that directory; SMTP ledgers and
actual Git/provider resources remain inspectable. Initial development failures
were fixture defects: missing conversation POST response body; SMTP header folding
and dot-stuffing; not awaiting a prepared B event/delivery pass; and using the wrong
failure-boundary terminal oracle. These were fixed, not hidden. An early new Git
fixture failed an unmapped **fetch** against the canonical URL (authentication was
refused before workflow execution); transport mapping now covers `origin` through
Git's URL rewrite only for fetch/push/ref reads. No live write or production
resource mutation was performed.

## Initial T5 record (historical, superseded where stated above)

## Status, version and limits

**PARTIAL phase-scope evidence; not a declaration that P4 is complete.** Whole-phase
independent review remains required. This record uses the unchanged requirements,
specification, verification plan, implementation audit and rewrite plan (especially
rewrite-plan lines 147–155). It supplements, rather than retroactively upgrades,
[T1](p4-mutation-foundation.md), [T2](p4-initial-publication.md),
[T3](p4-mutation-routing.md) and [T4](p4-notification-delivery.md).

Tested working tree: `architecture/p4-durable-mutations`, HEAD
`4b6ced18641bae8072e717e222ba01b5b4c2bc38` plus the uncommitted T5 changes.
Phase baseline / actual prior writer:
`fe3276074e616bd0f7f288ae8e4e034a5dbf0ab6`.
Preceding P4 commits: `2ac86ad` (journal), `b617b27` (publication),
`2351de2` (routing), `4b6ced1` (notification outbox).
Runs took place on **2026-11-08**, host timezone CET (`+01:00`); the container
timestamps use UTC. Local Linux, Node **24.18.0**, Yarn **1.22.22**,
Vitest **5.0.5**, Git **2.56.0**, Podman **5.8.9**.

No live Trello/GitHub/OpenCode/email account was used, no credentials were probed,
and no production resource was mutated. No disposable external resources or
scoped authorization were supplied. **Realistic provider, controlled inbox,
Free-plan, App/PAT authorization and real OpenCode evidence are BLOCKED**, not
passed by substitution. Local TLS SMTP establishes observed transaction acceptance,
not remote inbox receipt. The container run below is an integration test process,
not a deployed production application or full local/container lifecycle parity.

## Commands and results

All local Yarn invocations use this existing ignored directory because `/tmp` has
**0 free inodes**. No old artifacts were deleted to make tests pass:

```sh
export TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp"
export VITEST_MAX_WORKERS=1
yarn test:p4
TMPDIR="$PWD/node_modules/.cache/p4-validation-tmp" VITEST_MAX_WORKERS=1 yarn validate
```

- `yarn test:p4`: **15 files / 232 tests passed**, 104.04 s, start 01:14:26.
  The script explicitly lists the 15 suites; it does not alias the entire suite or
  claim realistic scenarios. It includes journal, production publication/polling,
  concrete routing, actual TLS SMTP, outbox, authority, terminal, legacy reply,
  real-Git application lifecycle and the new lease/upgrade tests.
- Full `yarn validate`: **passed** ESLint, repository-wide Prettier, strict
  TypeScript and **150 files / 1,707 tests**, suite 235.75 s / command 257.00 s,
  start 01:20:50. This includes the final prior-reader rollback rejection check
  added after the 232-test focused run. Previous baseline was 1,699 tests; T5 adds
  eight cases (five lease barriers, one actual-writer compatibility case, two
  shared-root authority variants). Expected negative-control diagnostics include
  P3 process ambiguity and the old strict reader's rejection of `mutation`; these
  did not fail the suite. `git diff --check` also passed.
- Earlier focused command:
  `yarn vitest run tests/p4-lease-recovery.integration.test.ts tests/p4-upgrade-artifact.integration.test.ts`
  had **4 failed / 2 passed**. Four new fixture runs polled beyond publication into
  CI, which the intentionally publication-only substitute does not implement.
  The bounded recovery loop now stops at durable CI handoff, not at a fabricated
  CI success. A second focused run of those two plus notification-authority,
  workflow-mutations and notification-outbox had **4 failed / 59 passed**: its new
  queue oracle incorrectly required the _publication operation_ to remain active
  after successful publication. The corrected oracle checks operation occupancy
  during uncertainty and, after success, the retired queue **plus open attempt,
  CI lifecycle and unchanged project registry pointer**. These were test-fixture
  defects, not suppressed failures; no timeout or production assertion was relaxed.

Safe offline container command actually executed:

```sh
timeout --kill-after=10s 240s podman run --rm --network none \
  --name agent-orchestrator-p4-evidence \
  -e TMPDIR=/evidence -e VITEST_MAX_WORKERS=1 \
  -v "$PWD/src:/workspace/src:ro,Z" \
  -v "$PWD/tests:/workspace/tests:ro,Z" \
  -v "$PWD/package.json:/workspace/package.json:ro,Z" \
  -v "$PWD/node_modules/.cache/p4-validation-tmp/p4-container-evidence:/evidence:Z" \
  localhost/agent-orchestrator-p3-test:latest yarn vitest run \
  tests/durable-mutation.test.ts tests/initial-publication.integration.test.ts \
  tests/workflow-mutations.integration.test.ts tests/notification-outbox.test.ts \
  tests/notification-authority.integration.test.ts tests/smtp-email-notifier.test.ts \
  tests/p4-lease-recovery.integration.test.ts
```

**7 files / 164 tests passed**, 85.41 s, container start 00:16:44. Existing image
`sha256:6076a730bd3daa62dac1520530b01896f503d90c15bbfe58bb96bd7b1d971b04`,
Node **24.21.0**; no image build, dependency download, production configuration,
host credentials, source checkout Git metadata or external network required.
Only current source/tests/package were mounted read-only; disposable runtime
evidence was mounted writable. The prior-writer test was **not run inside the
container** because it needs Git history deliberately not mounted there. This is
not a restart of a deployed container, cross-host lease mount contention, or
production image/Compose validation. Those remain **PARTIAL / not executed**.

## Evidence inventory and exact level distinctions

The following shorthand identifies executable suites, not log-derived acceptance:

| Evidence | Files / independent oracle                                                                                                                                                                                                                                 | Level actually exercised                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| J        | `durable-mutation.test.ts`: strict policies, transition/fence reducer, persisted artifact hashes, independent filesystem sink/ledger, five SIGKILL barriers                                                                                                | Unit + filesystem/subprocess integration; test lease, not production owner                                                                |
| P        | `initial-publication.integration.test.ts`, `support/initial-publication-fixture.ts`: real Git source/worktree/bare remote, separate resource JSON and append-only request/read/acceptance ledger, production `publishTaskSessionCard`/`pollProject`/worker | Integration; canonical GitHub transport mapped only for Git transport to local bare remote; service adapters are substitutes              |
| L        | **New** `p4-lease-recovery.integration.test.ts`: actual P2 kernel project leases, registry, RunStore, publication queue, child writer and SIGKILL, independent P service files and actual Git                                                              | Integration locally and in Podman; not full startup or complete task lifecycle                                                            |
| W        | `workflow-mutations.integration.test.ts`: actual mutation clients with deterministic fetch/gh boundary substitutes, independent card/comment/reply state and request ledgers; real Git commits/pushes/worktrees/cleanup where applicable                   | Adapter + filesystem/Git integration; not live HTTP/gh API compatibility                                                                  |
| N        | `notification-outbox.test.ts`: versioned filesystem outbox, independent acceptance sink, five child SIGKILL barriers, lookup evidence and deduplication                                                                                                    | Unit + subprocess/filesystem integration                                                                                                  |
| A        | `notification-authority.integration.test.ts`, support fixture: actual P2 leases/pins/authority/queue and production polling/workers, separate external-card files                                                                                          | Application-boundary integration **with substituted Git and in-process scripted engineer**, not F's actual-Git/process complete lifecycle |
| S        | `smtp-email-notifier.test.ts`: actual local TLS SMTP sink, independently captured DATA/Message-ID and acceptance count                                                                                                                                     | Local transport integration; no real inbox/recipient receipt evidence                                                                     |
| E        | `p1-production-lifecycle.integration.test.ts`: production polling, actual Git/processes/ownership/storage, stateful external substitutes, human merge/closure observations                                                                                 | Simulated application-boundary lifecycle evidence for its enumerated variants, not the full F matrix                                      |
| U        | **New** `p4-upgrade-artifact.integration.test.ts` and `fixtures/p4-prior-writer.ts`: archived actual baseline `src`/`package.json`, real prior `RunStore.create/read` in separate process, original bytes/hash manifest                                    | Actual prior/current writer artifact integration locally; not production upgrade/deployment evidence                                      |

Fixture bounds: publication/workflow/outbox reconciliation has a persisted **15 s**
minimum, tests advance Date by **15,001 ms**, not a changed product setting. L uses
at most eight bounded polling passes, retains a real contending-owner rejection,
and observes owner generations **1 → 2 → 3**. P's prolonged outage attention uses
its existing five-minute threshold with an accelerated fixture clock. A's 0.01 s
ordinary poll fixture does not remove the production pending-obligation 15 s wait.
S uses loopback TLS and deterministic negative/lost acknowledgments, not external DNS.

U also invokes the actual archived prior reader after extension adoption: it
rejects the new `mutation` field and leaves the current bytes unchanged. Rolling
back to that strict prior reader is therefore not supported after adoption;
retain evidence and use a compatible forward fix, never strip journal fields.

## Scenario / criterion / variant mapping

**Passed slices** below refer only to the named level and variants. The overall
scenario remains **PARTIAL** where any inherited F prerequisite, variant, or level
is missing. AC labels are the existing specification bullet order.

| Scenario / criteria                                        | Executed variants and evidence                                                                                                                                                                                                                                                                                               | Outcome and missing obligations                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VER-WF-001-01, WF-001 AC1–3                                | J/P/W: rejected writes, uncertain dispatch, lost acceptance response, independent wrong list/fields/body checks, reopen/reconciliation; L: real owner takeover at PR intent/dispatch/acceptance/response/completion                                                                                                          | Passed unit/integration slices. PARTIAL exhaustive service/update × fault × boundary cross-product; realistic counterpart BLOCKED                                                                                                                                                                                  |
| VER-WF-001-02, WF-001 AC1–3 and shared allowed transitions | J + `run-store.test.ts` / `project-run-authority-lifecycle.test.ts`: transition matrix, verified terminal release, stale generation refusal; W rejects Ready requeue/open-PR Failed, wrong fields/unknown cleanup; A rejects manual Backlog as notification proof; E normal/draft open/approved/human merge/unmerged closure | Passed concrete foundation slices. PARTIAL each allowed workflow transition with each unverified outcome and restart; full running-terminal precedence P7/P10 and refinement history P9 not established                                                                                                            |
| VER-WF-001-03, WF-001 AC1–5                                | P: negative PR lookup then late original acceptance; W: Trello comment, thread reply and conversation reply negative lookup then later exact-identity discovery across reopen; J: non-discoverable uncertainty/attention/controlled rechecks; A: healthy B progresses while A waits                                          | Passed listed unit/integration slices; **provider-idempotent variant NOT EXECUTED** (no concrete provider key API used), not silently waived. No production exactly-once guarantee. Joint two-project real-Git late-comment/reply lifecycle remains PARTIAL; realistic provider-controlled late acceptance BLOCKED |
| VER-PR-005-01, PR-005 AC1                                  | P: verified PR identity persisted before failed/rejected/lost Trello move, later read-only recovery binds original                                                                                                                                                                                                           | Passed integration slice; E accepted PR recovery composes with selection and human outcomes                                                                                                                                                                                                                        |
| VER-PR-005-01, PR-005 AC2–3                                | P/L: one initial Git commit and PR; accepted comment/move restart; late accepted PR after negative lookup never triggers second creation; L five barriers with real P2 lease recovery                                                                                                                                        | Passed integration slices. Dispatch-without-network-proof deliberately remains ambiguous (zero PR), never mislabelled successful single-effect completion                                                                                                                                                          |
| VER-PR-005-01, PR-005 AC4                                  | P/E next-card exclusion while pending/open; L verifies active queue during uncertainty, durable original registry pointer and open attempt after success                                                                                                                                                                     | Passed enumerated simulated/integration slices; PARTIAL full F two-project matrix at every move/comment boundary, no blanket lifecycle closure                                                                                                                                                                     |
| VER-PR-006-01, PR-006 AC1–4 (P4 support, P5 closure owner) | P before-create and accepted-response-lost outages: real Git/artifacts retained, paced reads, restart, attention deduplicated, restored service finds one original PR; worker recovers even with deferred startup Trello validation                                                                                          | Passed integration/support slices; PARTIAL complete simulated F lifecycle for each outage/restart variant; generic session/dependency recovery remains P5, not implemented here                                                                                                                                    |
| VER-NOT-001-01, NOT-001 AC1–3                              | S/email-notifier: four events plus normal/draft PR payloads captured at actual local SMTP sink; project/task/links/actual draft/outstanding advisory text; N disabled/per-event disabled/target changes; P readiness/attention and A refinement obligations                                                                  | Passed builder/transport/integration slices. PARTIAL all four genuine lifecycle origins → actual SMTP in one F application fixture, including genuine primary-failure origin (P5/P6/P10); realistic configured transport/inbox BLOCKED                                                                             |
| VER-NOT-002-01, NOT-002 AC1                                | A: broken delivery directory and missing initial durable handoff; real authority/queue shows safe terminal release vs paced retained wait, B progresses. **New shared-root variants** repeat both. J actual registry replacement with old ambiguous notification; N helper returns while sender remains pending              | Passed authority/outbox integration slices. Initial durable handoff storage is not SMTP delivery; no false claim it can be omitted. A uses substituted Git; complete F actual-Git lifecycle composition remains PARTIAL                                                                                            |
| VER-NOT-002-01, NOT-002 AC2–3                              | S refused TCP/untrusted TLS/DNS-pre-DATA/negative DATA → proven non-delivery/paced retry; accepted DATA then lost response → uncertain/no resend; N late provider lookup, restart/dedup, partial recipients, target pin, five SIGKILL barriers                                                                               | Passed unit/local SMTP integration slices; PARTIAL per-event lifecycle × transport fault × restart cross-product; realistic relay/inbox late acceptance BLOCKED                                                                                                                                                    |
| Shared REC-005 AC2–4 / upgrade support                     | U actual baseline writer human-review artifact retains primary session, observed PR resource and consumed CI budget; current read does not rewrite; first intent adds extension with zero fabricated dispatches; malformed outer JSON/version/extension retained                                                             | Passed local artifact compatibility slice; no bulk migration needed for additive v1 extension. P2 legacy import tests remain separate older-version evidence. Interrupted production upgrade and full active-state artifact population remain PARTIAL                                                              |

### Crash coverage is not a cartesian-product claim

| Effect                                                       | Intent / dispatch / acceptance / response / durable completion       | Qualification                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Journal reducer / independent sink                           | All five, J                                                          | Test lease                                                                                            |
| Initial PR creation                                          | All five, P and **L actual kernel takeover**                         | At dispatch-only death, no provider proof means preserved uncertainty, not permission to resend       |
| Initial commit/push/Trello move/comment                      | Actual acceptance and interrupted projection handoff, P              | All five **for every one of these routes NOT EXECUTED**                                               |
| T3 comment/replies/body/draft/fields/labels/worktree/cleanup | Independent accepted/lost acknowledgment/readback/reopen variants, W | No SIGKILL at all five checkpoints for every concrete method; **PARTIAL**                             |
| Notification delivery                                        | All five, N; real SMTP rejection/acceptance loss, S                  | N's process sink is not SMTP; all five SIGKILLs with real SMTP and real lease in one run NOT EXECUTED |
| Terminal observation / never-dispatched cancellation         | SIGKILL/reopen, J                                                    | Full terminal observation during ongoing engineering/push remains P7/P10                              |

These remaining executable permutations are genuine **P4 evidence gaps**, not
external-environment blockers or work silently reassigned to P11. They are disclosed
for the supervisor's whole-phase decision. Later-phase workflow-specific race
variants below are a distinct category.

## Mutation routing inspection

Rechecked the current Trello private PUT/POST/DELETE transports and their public
callers, GitHub `pr create/edit/ready` and API POST paths (including replies), Git
commit/push/worktree/branch cleanup, SMTP sender, and their dispatch-capability
guards. The full concrete policy/target/readback inventory is T3's **Reachable
workflow mutation inventory**; T4 supersedes its historical email-pending row.

- Trello move/content/label/comment methods enter `workflowMutation` under attempt
  authority; transport rechecks the single-use exact-payload capability.
- GitHub create is T2-only; body/status delegates to exact-body intent, draft and
  both reply methods have concrete independent readback. No mark-ready method,
  automatic merge, resolve-thread, approval or replacement-PR mutation exists.
- Git commit/push/create/remove worktree/local/remote branch routes bind objects,
  paths and destinations. Broad prune is disabled under production authority.
  Fetch/index/bootstrap/local artifacts are deliberately preparation, not external
  transition completion; authentication token exchange is not a task mutation.
- Email is only notification delivery state, not a workflow pending operation.
  The actual attempt obligation and independent delivery record are not two
  competing workflow authorities.
- Unowned utility compatibility remains; it is **not** an authorized production
  alternative. W rejects missing single/multi-project authority and wrong/nested/
  reused/stale/escaped capabilities. No additional reachable unjournaled workflow
  write was found in this inspection; no production correction was needed in T5.
  This is a bounded source/callsite review plus regression evidence, not proof
  against arbitrary future callsites or arbitrary agent shell commands.

## P3 repeat on P4 output channels

New W assertions register a synthetic credential with spaces, punctuation, quote
and backslash; exercise **literal, URI percent, form-plus, base64, unpadded
base64url, JSON-escaped** forms through journaled PR description, late conversation
reply and Trello comment. They scan independent outbound payloads, the reopened
RunStore and every referenced artifact, including recovery after a raw exception
containing these forms. N repeats all six forms in event identity, subject/text,
persisted delivery record and captured send arguments. Existing P scans initial
checkpoint/intent/artifacts/real commit message/PR/comment literal and base64; S
scans captured SMTP subject/text literal and base64url. Existing P3 suites run in
full validation. Useful content and `[REDACTED]` markers remain.

**PARTIAL:** no new all-six-form scan for refinement title/description, every thread
reply variant, every cleanup diagnostic, actual remote provider storage, or real
inbox MIME transformation. Unknown/arbitrarily transformed secret absence is not
claimed. Credential-bearing transport authentication is intentionally distinct
from sanitized human-visible payloads; no real credential is present in evidence.

## Retained artifacts, blockers and later phases

L deliberately retains `p4-lease-*` fixtures (actual Git repositories, service ledger,
attempt/registry/queue) below TMPDIR. U retains `p4-prior-writer-*`: archived source,
input, actual prior writer state, `original.json`, and `provenance.json` with full
writer commit, original SHA-256 and prior RunStore source SHA-256. Failed development
runs remain available too. Container L artifacts remain under
`node_modules/.cache/p4-validation-tmp/p4-container-evidence/p4-lease-*`.
Other preexisting suites retain their existing cleanup policy; do not expect their
temporary JSON/Git fixtures to survive a successful run. Test transcripts and the
new retained artifacts, not imaginary permanent fixtures, are the evidence here.

**Genuine external blockers:** scoped disposable Trello Free/GitHub resources,
App/PAT actors/permissions, actual OpenCode sessions, configured SMTP relay and
controlled inbox with acceptance/recipient observation; provider pagination/history
and late-acceptance ordering require such permission and observability. No live
probe was substituted for missing authorization.

**Later-phase scope, not P4 completion evidence:** P5 primary restoration/setup and
generic recoverable dependency policy; P6 advisory-only publication/readiness and
complete material-issue reporting/failure-event origins; P7 running terminal
observation/feedback and managed-body races; P8 additive maintenance/CI episodes;
P9 history-attributed refinement compensation/read-only grounding; P10 preserved
clean local-only commits, closed-PR accessibility and deliberate fresh retry;
P11 full deployed local/container realistic lifecycle parity. None was implemented
or claimed closed by this task. P4's missing integration permutations above remain
explicit even though later phases will also repeat the shared transition scenarios.
