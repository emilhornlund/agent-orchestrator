# Rewrite progress

## Current checkpoint

- **P9 in progress on `refactor/p9-recoverable-refinement`, based on `190bb3c`.**
  Initial index/worktree clean; P8 is integrated. Only small local P9 commits are
  authorized, without remote actions or P10 expansion.
- Current inspection: setup attribution and P4 content/label intents exist, but
  refinement results are still repository-local, no bounded invalid-result correction
  exists, and finalization lacks full-field/history conflict reconciliation.
- Ordered remaining work: T1 read-only dispatch/external results and conservative
  baseline recovery; T2 complete-result bounded correction and grounded prompts;
  T3 durable conflict-aware field finalization/restart; T4 verified full Backlog
  outcome/comment/release and combined checks, followed by `yarn validate`.
- T1 implements read-only worktree/Git-metadata mounts with external attempt results,
  preserved prior output outside the writable artifact directory, and durable
  setup-free baselines. Legacy repository-local artifacts are preserved, not reused;
  missing prior setup-free baseline provenance blocks redispatch. Self-review
  inspected production polling/workflow dispatch, setup restart and result paths,
  mount validation and new real-child tests. Fixed writable access to preserved
  results by moving them outside the result mount. Two old test expectations were
  corrected to require preservation instead of deletion of legacy results.
- T1 focused five-suite run passed 28 tests, including actual child/descendant
  filesystem enforcement. Typecheck and changed-file ESLint passed. Documentation
  formatting initially found one wrap issue, corrected before checkpoint. Final
  affected checks are rerun before commit. T2–T4 remain; no full validation claimed.
- T1 checkpoint: `282159f`. T2 adds three bounded complete-result analyses,
  durable invalid/active/validated checkpoints, verified stopped-child recovery,
  validated-output reuse and refreshed correction attachments. The existing distinct
  templates remain; prompts now explicitly identify dependencies and recommend
  splitting without creating cards. Semantic grounding remains the agent's job.
- T2 self-review inspected result parsing, workflow callers, restart persistence,
  execution evidence and attachment refresh. Fixed checkpoint-write/unknown-child
  errors that could otherwise enter terminal failure, and preserved unknown result
  directories/symlinks rather than moving them. Existing setup-only fixtures had no
  child-stop evidence; their assertions now require the explicit retained fence.
  Final five-suite focused run passed 46 tests; typecheck and changed-file ESLint
  passed. One final assertion wrap was formatted after lint caught it; ESLint and
  whitespace checks passed afterward. T3/T4 remain; full validation is not yet run.
- T2 checkpoint: `b252038`. T3 journals original/intended/verified full fields,
  pending own writes and a Trello Free history cursor/actor before dispatch.
  Concrete content/label adapters inspect current fields and history before writing
  and during readback/restart. Own transitions require matching old/new values and
  attribution; detected races (including same-actor edits) retain sanitized human
  history and stop writes. Missing legacy provenance or history continuity is not
  treated as absence of edits. Three proven rejected sends pause for reconciliation.
- Partial accepted writes complete from verified state without replaying analysis
  or accepted effects. Conflicting/unknown outcomes retain ownership rather than
  blindly restoring over human edits or declaring Failed. Self-review inspected
  the new guard/tests, concrete adapters, journal restart, snapshot schema and
  polling/finalization callers. Fixed internal intended-label projection into the
  strict result schema, preserved notification-preparation recovery, and retained
  unknown artifacts. Stateful fixture history now models actual accepted changes;
  desired fields without history no longer count as proof of own acceptance.
- Final five focused suites passed 115 tests, including partial-update/human-edit
  recovery, with typecheck, changed-file ESLint and whitespace checks passing.
  T4 final outcome/comment/release and combined validation remain.
- T3 checkpoint: `f0726fe`. Production outcome tracing split T4 into T4a verified
  failure and T4b recoverable Backlog completion, followed by T5 combined checks.
  T4a persists original input before analysis, retains its intent across restarts,
  and turns bounded invalid/stopped-failure exhaustion into the existing verified
  Failed/comment/release protocol. Original full fields are checked before and
  after the move; human differences retain ownership instead. Unknown state and
  transient outages cannot fall through to unverified terminal failure.
- T4a self-review inspected the new input record, analysis dispatch/recovery,
  scheduler failure/release routes and production regressions. Fixed generic
  canonical errors that could otherwise call legacy `failCard`. Updated the older
  scheduler fixture to exercise the concrete field/move adapters and history;
  malformed output now correctly exercises three analyses rather than one.
  Final five focused suites passed 41 tests, plus typecheck, changed-file ESLint
  and whitespace checks, including the generic-error preservation correction.
  T4b and T5 remain; no full validation claimed.
- T4a checkpoint: `67c8ae9`. T4b persists immutable completion-comment text and
  verified acceptance; unknown comment delivery blocks release, not Backlog
  preservation. Backlog recovery uses the existing move journal and retained
  full-field snapshot without rerunning setup/analysis or requiring a cleaned
  worktree. Final release checks full list/readback/history, comment and own move.
- The new recovery regressions initially exposed earlier orphan retirement of a
  started refinement (which has no implementation projection). Started canonical
  refinement now retains its queue obligation through Backlog/Failed/manual moves;
  queued/failed recovery uses a unique retained event, not arbitrary Ready selection.
  Self-review traced those earlier callers, completion persistence, both release
  routes and tests. Fixed missing legacy snapshot fencing before completion-only
  dispatch and a late-human-edit gap in final Backlog readback. Old guidance about
  ignoring comment failures/deleting results was corrected.
- Final five focused suites passed 58 tests, plus typecheck, changed-file ESLint
  and whitespace checks, including provenance-fence/unique-event corrections.
  Only combined P9 integration/specification checks and final validation remain.
- T4b checkpoint: `5bddab4`. Combined REF-004 checking found that bounded proven
  field rejection needed safe compensation, not an unconditional partial-state
  pause. T5a now records restoration mode and the exact conclusively rejected
  mutation identity, preserving its failed dispatch/evidence history rather than
  replaying it. Current verified own fields can be restored to originals through
  the same history guards; only verified complete restoration permits Failed.
  Unknown acceptance, human edits and rejected restoration retain ownership.
- T5a self-review covered the actual reconciliation filter, adapter dispatch and
  readback, restoration-mode compatibility and terminal failure integration.
  The stateful regressions exercise accepted title/description/classification
  writes before rejection, complete restoration, human changes before/during
  compensation and repeated negative reads with unknown acceptance. Initial test
  ordering assumed classification removal preceded insertion; the failure now
  occurs at the actual last label operation so it exercises real partial labels.
  Five focused suites passed 68 tests; typecheck and changed-file ESLint passed.
  Remaining: tighten the legacy baseline exemption, final combined check/validation.
- T5a checkpoint: `1693be3`. T5b removes the legacy-result path exemption from
  both persisted restart and post-analysis inventory comparison. Legacy artifacts
  introduced after setup remain preserved and fenced; setup-created content at that
  path is protected even when Git status stays identical. Known-secret forms are
  redacted before validated output enters new recovery state/public fields, and
  unknown artifact-directory symlinks cannot redirect rotation into the source.
- Combined criteria verification reused task reviews for REF-001–005, ENV-002,
  CTX-001/003 and refinement WF/SCH integration: grounded current read-only context,
  distinct scoped templates, bounded complete results, original/intended/own writes,
  history races, restart/compensation, comment and full-field Backlog/Failed release.
  An added actual nonzero-child recovery regression exposed the OpenCode evidence
  layout mismatch: refinement now reads its exact task-scoped `process-executions`
  layout, while setup's existing direct layout is unchanged. No stopped proof is
  invented. New legacy-state, known-secret and source-symlink regressions cover the
  corrected boundaries. Six focused suites passed 69 tests; typecheck,
  changed-file ESLint, formatting and whitespace checks passed. Final full
  validation remains and no live-service qualification is claimed.

## Inherited P8 checkpoint

- **P8 implemented and locally validated, based on `b7fff4a` (integrated P7).**
  The starting index/worktree were clean.
  Authorized actions are small local task/correction commits only. No remote Git
  action, branch change, deployment or P9 work is authorized.
- **All scoped implementation tasks are checkpointed through `37174a8`.** The
  combined inspection reused task reviews and checked CI-001/002, MNT-001–004,
  GIT-001/002, PR-007/008 and the active-PR queue/session/context contributions to
  HR-006, IMP-004 and CTX-001/003. The concrete integration gaps found are corrected
  below; no known scoped implementation requirement remains unfinished.
  Integrated `yarn validate` passed repository ESLint, Prettier, TypeScript and
  **2,195 tests across 167 files**. The completion documentation is included in the
  final validated checkpoint. No live-service qualification is claimed, and
  P9/terminal-cleanup expansion remain outside this phase. No P8 work remains;
  stop before another phase.
- Local implementation/correction checkpoints: `f58cd2b`, `e0f32c8`, `e261ba3`,
  `3ab7e1d`, `3121ed7`, `f5380d7`, `576d64f`, `498685e`, `37174a8`.
- Original ordered work: T1 current-revision expected CI discovery and durable
  bounded observation; T2 verified-trigger repair episodes, configured budgets and
  advisory same-session correction publication; T3 queued additive target merges,
  provenance/preservation and interrupted/conflicted Git recovery; T4 maintenance
  quality/publication, descriptions/activity and terminal boundaries; T5 combined
  criteria/integration verification and final `yarn validate`.
- Inspection confirms existing exact-head expectation evaluation and CI reservation
  persistence, but no durable observation deadline. Maintenance execution is still
  deliberately disabled; its legacy rebase records must remain fenced. Existing
  P7 checks below describe the inherited baseline, not P8 completion.
- P8-T1 adds a persisted 30-minute per-revision CI observation window. Polls and
  store reconstruction retain its deadline; supported older records initialize it
  on first observation. Missing registration, queued checks and incomplete discovery
  remain inconclusive. Expiration ends the CI phase in Human Review using the
  existing non-success transition, without repair, push or task failure. Later
  observations can still discover actionable failures or actual success.
- T1 reuses the current exact-head checks/statuses and repository-rule/workflow
  expectation discovery; incomplete/absent contracts and stale successes never
  pass. Self-review inspected those clients/evaluator, observation readback and
  persistence, production wait/transition callers and the new tests. Added a
  production dispatch regression as well as controlled-clock restart coverage.
  Six focused CI/client/observation/dispatch suites passed **149 tests**;
  `yarn typecheck`, changed-code ESLint and Prettier passed. The earlier four-suite
  check also passed 62 tests. T2–T5 remain; visible draft/description integration
  for CI and maintenance is included in T4. Guide/roadmap scope remains accurate.
- P8-T2a implements optional `opencode.remediation.ciMaxPasses` (default two),
  persisted per episode before correction dispatch. Existing episodes without a
  recorded limit retain their historical two-pass limit; restart configuration
  cannot enlarge it. Charges survive reruns, own commits and changing heads.
  Verified substantive human correction/no-op handling renews the episode with a
  distinct human operation identity; routine observation/maintenance cannot renew
  it. Exhaustion finishes the queue operation in Human Review rather than parking
  a failed writer or terminating the task. Both arrival producers avoid requeuing
  exhausted work. No independent-external-change classifier is inferred from SHA.
- T2a self-review traced primary reservations, both observation producers, review
  cycle identity, feedback/no-op handling and legacy schemas. Fixed legacy budget
  pinning and obsolete failed-queue completion. Seven focused suites passed
  **187 tests**, with one initial obsolete attention/failed expectation corrected
  to enforce the specified Human Review/completed outcome and no subsequent commit.
  Typecheck and changed-code ESLint passed; final legacy-limit correction is
  rechecked before checkpoint. T2b still must remove production quality gates and
  implement CI no-op/early finish; T3–T5 remain. No full validation claimed.
- P8-T2b completes advisory same-session CI correction publication: negative local
  checks/review and bounded unavailable independent review publish available safe
  corrections on the same PR, preserving current failure/uncertainty evidence.
  Review allowance is source-specific and persisted, including prepared-content
  verification. Known unchanged source reuses its evidence; bounded unavailable
  commit-message advice uses a deterministic message without bypassing unknown
  execution. Exact-source no-op stops before quality reruns/commit; explicit early
  finish publishes once then stops the episode. Both arrival producers retain that
  stop until verified new human work. Original primary IDs/session recovery remain.
- T2b self-review inspected the actual CI writer, quality/review and prepared-source
  publisher, durable reservations/stops, new bounded-review source and tests. Fixed
  optional-marker parse failures, active-review state at unavailable publication
  and missing current publication evidence. A legacy fixture had implicitly relied
  on negative advice blocking publication; it now injects a real persisted-checkpoint
  interruption instead. Six focused suites passed **51 tests**; all **eight CI
  real-Git lifecycle cases** passed (22 unrelated cases filtered), including failed
  validation, unavailable review, interrupted review recovery and unknown-writer
  fencing. Typecheck and changed-code ESLint passed. T3–T5 remain; T4 owns final CI
  activity/description outcome reporting. No full validation claimed.
- P8-T3 restores automatic target maintenance (explicit opt-out retained), including
  approved open PRs. The queue preserves human/CI priority; after a merge, polling
  reobserves before another writer. New `strategy: merge` records preserve pinned
  published/target/local provenance, backup refs, expected merge trees and parents.
  Legacy records remain fenced. Ordinary pushes reconcile exact accepted heads;
  absent/changed remote refs never authorize resurrection/overwrite. Interrupted
  publication binds its verified head before strict observation on restart.
- Dirty unstaged setup/untracked output remains byte-identical and excluded from
  merge commits. Unknown local-only commits and unrelated staged output are retained
  rather than shipped. Conflict assistance uses the primary operation/session with
  refreshed card/attachments, a persisted maximum, atomic reservation and durable
  preservation baseline. No-op/exhaustion stops; unknown writers stay fenced.
  Interrupted post-staging recovery rechecks non-conflict files/index before commit.
- The complete maintenance writer also includes bounded advisory quality and safe
  same-PR draft publication, with exact-source evidence and a human-text-preserving
  current-outcome section. Missing advisory plans use current task purpose rather
  than vetoing maintenance. This necessary production integration was moved from
  T4 into T3; guide/roadmap and product guidance now describe that implementation.
  T4 retains activity transitions, final CI outcome refresh and terminal integration.
- T3 self-review covered the full new production writer, polling/recovery callers,
  new body helper, schemas/store ownership and new tests. Corrected pseudoref lookup
  (MERGE_HEAD/FETCH_HEAD are not ordinary refs), stale observation after publication,
  conflict reservation atomicity, no-op conflict staging and post-staging unrelated
  index absorption. Initial fixtures also needed the now-default comparison source
  and non-recursive acknowledgement-loss spies. Final eight maintenance/legacy/
  observation suites passed **75 tests**; earlier six config/maintenance suites
  passed **182 tests**. The real `pollProject` approved-PR target-merge scenario
  passed (30 unrelated scenarios filtered); typecheck and changed-code ESLint passed.
  No known T3 defect remains; T4–T5 remain and full validation is not yet claimed.
- P8-T4 completes top activity transitions for CI editing, target synchronization,
  conflict assistance, advisory checks and push. Verified completion/no-op/bounded
  conflict outcomes clear activity; unresolved execution retains explicit recovery
  status. Current CI results, expired observation uncertainty, episode usage and
  no-op evidence refresh independently of another writer, retaining human text.
  Known unresolved quality remains draft even after green CI. Controlled external
  diagnostic markers cannot create managed description/activity sections.
- T4 integration corrected two queue edge cases: verified same-head human retry
  needs a distinct episode queue identity; a temporarily pending evaluation must
  retain a nondispatchable queued observation rather than permanently complete its
  identity or monopolize maintenance. Producer/recovery/dispatch callers now share
  those identities and eligibility, preserving legacy episode identity. Reporting
  failure releases only writer execution ownership for recovery; it never repeats
  the primary correction just to present a result.
- T4 self-review inspected new files and actual polling/repair/merge/reporting
  callers, P4 body preconditions, quality dispositions, terminal status clearing,
  queue recovery and compatibility. Corrected per-pass CI activity refresh after
  lifecycle assertions exposed the second pass's stale publication status. An
  error-cause lint failure was fixed while preserving both original/status errors.
  Ten focused suites passed **179 tests**; all **31 real-Git lifecycle scenarios**
  passed, including CI advice failures, approved-PR maintenance, concurrent human
  body notes, terminal races and unknown writers. Typecheck and changed-code ESLint
  passed. Guide/roadmap scope remains accurate after T3's integration adjustment.
  Only T5 combined integration/specification checking and final `yarn validate`
  remain; no full validation or live-service qualification is yet claimed.
- Combined P8 criteria inspection found a concrete CI-001 discovery gap, corrected
  in T5a: expected workflow documents now come from the exact PR revision through
  the non-paid GitHub contents API, not stale source-checkout files. Runtime jobs
  resolve only their verified workflow path/head/PR/trigger, leaving another
  never-started workflow uncertain. Latest applicable runs supersede older runs;
  observed additional checks cannot be ignored, and newest same-head commit
  statuses supersede historical success/failure without renewing episode budgets.
- T5a self-review inspected the changed clients, pure document parser/evaluator and
  production observation callers, including malformed/absent discovery, skipped
  conditional jobs and reruns. Seven focused suites passed **165 tests** after the
  production dispatch fixture gained its explicit contents-discovery response.
  Previously that missing response correctly made its expected set uncertain,
  rather than fabricating green CI. Typecheck passed; a formatting-only lint issue
  in the new contents fixture was corrected and the final checks are rerun before
  checkpoint. Permanent CI guidance now describes the actual discovery policy.
  Remaining: refresh context on nested CI quality-repair dispatch, then final
  combined checks/documentation and `yarn validate`. No full pass claimed yet.
- T5b completes the CI contribution to CTX-001/IMP-004: nested validation and
  review corrections refresh the current card/attachments at dispatch, including
  reserved-operation recovery. Review prompt preparation can await that context
  before reservation; validation refresh happens after observing failure and
  immediately before its writer, not before a potentially long command. Existing
  reserved prompts/operation IDs remain immutable and the primary session is reused.
- T5b self-review inspected both quality-repair coordinators, all changed CI callers
  and the actual prompt/recovery paths. A production lifecycle regression changes
  attachment URLs during review and validation and requires those latest URLs in
  the next primary prompt. It initially exposed too-early validation refresh;
  refresh was moved to dispatch. Wrong-task/unavailable context prevents reservation
  and dispatch without charging a new improvement pass. Four focused suites passed
  **70 tests** and all **eight CI lifecycle scenarios** passed (23 unrelated cases
  filtered). Typecheck and changed-code ESLint passed. Guide/roadmap and permanent
  context guidance remain accurate. Only final integrated verification/validation
  and its completion checkpoint remain.
- T5c corrects canonical CI budget projection: the authoritative attempt now
  receives the episode's pinned limit, trigger, ID and actual charges in the same
  fenced write as the task checkpoint, preserving legacy initial episodes and
  refusing a same-episode charge regression. Previously a configured third CI pass
  could exceed the canonical record's old two-pass limit despite a valid task record.
  The real `pollProject` regression now executes three CI corrections on the same
  PR and verifies authoritative limit/usage/episode identity. It passed (31 unrelated
  lifecycle cases filtered), plus **15 tests in four focused authority/CI suites**,
  typecheck, changed-code ESLint and whitespace checks. Self-review traced initial
  authority creation, projection writes, episode renewal and the production third
  dispatch. No known T5c defect remains. Final integrated validation is next.
- T5d closes the maintenance recovery edges found in the combined check. Initial
  dirty/staged-state refusal retains its queue recovery identity, so verified safe
  unstaging can resume on the same PR/head rather than being blocked by a completed
  descriptor. Pre-dispatch merge file/index baselines and target-changed paths now
  fence unrelated changes even if interruption precedes the conflict checkpoint.
  A conflict baseline is retained before assistance eligibility is evaluated, so
  manually resolving a zero-budget/no-op merge does not permit unrelated staging.
  Active merge preparation without the necessary baseline stays explicitly fenced.
- T5d self-review inspected the new baseline fields/artifact readers, preparation
  order, dirty-state queue release/reclaim, manual conflict recovery and actual
  additive publication caller. Recovery guidance's stale globally-disabled claim
  was corrected while retaining the legacy rewrite fence. Three focused suites
  passed **52 tests**, including recovery after safe unstaging and refusal of
  unrelated changes before/after conflict checkpoints; the production target-merge
  lifecycle scenario passed again (31 unrelated cases filtered). Typecheck,
  changed-code ESLint and whitespace checks passed. No known scoped implementation
  defect remains. Only the final combined validation/completion checkpoint remains.

## Inherited P7 checkpoint

- **P7 implemented and locally validated on the current branch, based on `7fafed1` (integrated P6).**
  The starting index and working tree were clean. This session authorizes small
  local P7 task/correction commits only; no push, PR, branch change or P8 work.
- P7-T1 implements current eligible Ready ordering rather than historical queue
  timestamps, across feature/improvement/bug/refinement cards. Canonical creation
  rereads order before claim. Dispatch rechecks order, type and start date before
  setup or card movement; an unstarted ineligible claim is requeued, while missing
  cards retain verified orphan retirement and interrupted writers retain recovery.
- T1 checks: `yarn test tests/task-session-dispatch.test.ts tests/task-session-refinement-scheduling.test.ts tests/task-session-terminal-pr.test.ts tests/preparing-attempt-resume.integration.test.ts`
  passed **28 tests in four files**; `yarn typecheck` and changed-file ESLint passed.
  Prettier formatted the changed files. An initial extra pre-claim read invalidated
  the existing after-claim disappearance fixture; the redundant read was removed,
  preserving the real post-claim retirement regression. Self-review inspected both
  production claim routes, queue recovery, mixed types and final eligibility checks.
  `yarn test tests/run-orchestrator.test.ts tests/card-start-eligibility.test.ts`
  also passed **49 tests**; changed-file/guide Prettier and `git diff --check` passed.
  P7 guide and roadmap scope/dependencies remain accurate and unchanged.
- P7-T2a implements the production side observer during a long `pollProject` writer.
  It retains content-deduplicated PR/feedback/CI snapshots in artifact-backed,
  owner-generation-checked attempt storage without updating the writer's task
  checkpoint or acquiring its mutation queue. It serializes its own reads, backs
  off after failures, and drains its last read before returning ownership. Missing
  prior inbox state is compatible. Mixed remote-head/terminal snapshots are rejected.
  This is observation retention, **not yet scheduling/consumption of arrivals**.
- T2a checks: `yarn test tests/active-pr-observation.test.ts tests/task-session-dispatch.test.ts tests/observe-task-session-review-cards.test.ts`
  passed **38 tests in three files**; `yarn typecheck` and changed-file ESLint passed.
  Self-review inspected the new source/tests, `pollProject` wiring, authority writes,
  timer lifetime and read races. Added final PR/head verification and insulated
  diagnostics from writer completion. No known observer-task defect remains.
- P7-T4 implements current semantic feedback refresh before T2b dispatch. Production
  observation includes standalone inline/review discussion without requiring a
  current-head changes-requested verdict, preserves inline context and API actor
  identity, and excludes automation. A read-only OpenCode classification is checked
  against exact complete source identities/revisions. Substantive changes renew a
  request; incidental edits/head/timestamp changes do not renew attempted work.
  Deleted/superseded items become inactive, prior handling is append-only, and
  supported older ledgers retain their handling state. Reserved rounds with explicit
  IDs retain their original inputs; legacy rounds still verify their operation hash.
  No-op primary correction records unresolved attempted feedback so later heads
  cannot silently restart it. Refresh now precedes contextual replies.
- T4 checks: nine focused feedback/GitHub/dispatch suites passed **135 tests**;
  `yarn test tests/task-lifecycle.integration.test.ts` passed **20 tests**;
  `yarn typecheck` and changed-file ESLint passed. The broad `yarn test` initially
  found seven lifecycle fixture failures (2,090 passed): the new semantic operation
  was incorrectly treated as implementation review by the fixture. Its explicit
  classification response fixed those failures. A later focused run caught a legacy
  reservation without feedback IDs and no-op outstanding-count compatibility; both
  were corrected without guessing identities or claiming unresolved feedback fixed.
  Self-review covered clients, current/historical ledger writes, original-operation
  recovery, selection and reply ordering. Queue/quality/terminal obligations below
  remain unfinished, not implied complete by this task.
- P7-T2b persists feedback/failed-CI/maintenance descriptors while execution holds
  the project, with unclassified feedback explicitly nondispatchable. An interruption
  between retained snapshot and descriptor is reconciled on the next observation.
  Scheduler refresh consumes current feedback, retires only verified never-started
  superseded descriptors and prioritizes human corrections before CI before routine
  maintenance. The same policy applies to specific-event claim callers, while an
  active/failed writer retains recovery priority. Persisted explicit prerequisites
  can run first and invalid/missing/cyclic prerequisites are refused. Legacy queue
  records default to dispatchable without losing order/owners. A new task event
  permits human work during failed/pending CI without falsely recording CI passed.
  Maintenance execution remains disabled for P8; only descriptors are retained here.
- T2b checks: seven focused observation/queue/dispatch/transition suites passed
  **95 tests**; lifecycle/authority/attachment checks passed **26 tests in three files**.
  Typecheck and changed-file ESLint passed. Production regression now demonstrates
  human correction superseding obsolete failed CI before a CI writer starts; it
  retains later CI-budget, late-feedback and uncertain-reply coverage. Self-review
  inspected producer/scheduler/recovery callers, queued retirement, prerequisite
  validation, schema defaults and the interrupted snapshot-to-queue handoff.
- P7-T3 implements optional `workflow.maxConcurrentAiProjects` (unlimited when
  omitted), plus the optional 15-second polling default. FCFS tickets and dispatch
  evidence live in the authoritative attempts. Production workers share the limiter;
  primary session creation/operation accounting waits before reservation, and direct
  OpenCode dispatches also acquire capacity. Nested activities reuse a live token;
  a competing same-project caller cannot steal it. Busy projects requeue, shutdown
  preserves unserved order, deliberate cancellation does not dispatch, and dormant
  dependency/Human Review ownership consumes no slot. Unknown execution retains
  capacity across restart until verified stopped; missing PID is not used as proof.
- T3 checks: `yarn test tests/ai-execution-capacity.test.ts tests/config.test.ts tests/opencode-client.test.ts tests/run-primary-operation.test.ts tests/primary-task-session.test.ts`
  passed **203 tests in five files**, including production worker dispatch, restart
  FCFS, cancellation, nested/same-project exclusion and primary accounting. Typecheck,
  changed-file ESLint and `git diff --check` passed. Self-review traced worker scope,
  primary creation/reservation, all OpenCode callers, persisted ticket compatibility,
  shutdown and stopped-evidence release. Fixed live-slot stealing, detached nested
  token reuse, pre-dispatch cancellation accounting and recovery-wait eligibility.
- P7-T5 completes advisory same-PR correction publication and verified Working/Review
  transitions. Failed local checks and bounded unavailable review still publish
  available additive corrections with current failure/uncertainty disclosure and
  draft status. Review attempts persist per source without a lifetime human-round
  cap. Semantic request revisions distinguish same-body changed requests while
  legacy operation hashes remain supported. Primary session, attachment refresh,
  separate independent review and genuine-primary-failure handling remain intact.
  Explicit expected card location and pending move identity replace phase-based
  assumptions for new transitions; old published corrections retain their old Review
  expectation until verified migration. Both normal and recovered publication callers
  persist return intent before the move and confirm readback afterward. Known stopped
  exhausted primary correction returns to Review with retained PR/work/ownership;
  unknown writers remain fenced in Working.
- T5 checks: nine focused suites (including all **22 real-Git lifecycle scenarios**)
  passed **152 tests**. New scenarios publish failed validation and unavailable review
  to the same descendant PR head, and recover an accepted Working move without a
  duplicate write. Initial failures exposed missing stateful move/body fixtures and
  a fixture PATH-restoration defect; these were corrected, retaining real crash and
  unknown-writer assertions. Self-review traced original-session and generic recovery,
  both publication callers, terminal expected-list precedence, move identity/manual
  interference and current quality evidence. Corrected same-body request identity,
  nullable unavailable review recovery and truthful failed-quality persistence.
  After two lint-only corrections (retained error cause and unused initializer),
  the eight non-lifecycle suites passed **130 tests**, and both new quality lifecycle
  scenarios passed again (20 unrelated scenarios filtered out). Typecheck,
  changed-file ESLint, documentation Prettier and `git diff --check` passed. The
  selected guide/roadmap scope and dependencies remain accurate.
- P7-T6 publishes verified/unresolved/uncertain contextual replies on the observed
  published head without requiring green CI. CI status is reported truthfully,
  review summaries can receive attributed PR replies, and no conversation is
  automatically resolved. Immutable accepted reply outcomes survive substantive
  edits/deletions; unknown sends reconcile rather than resend. Reply operation and
  marker identity retain request revisions and interrupted batches keep their owner.
  Outstanding requests remain draft, including no-op/failed corrections. Managed
  activity is wired through editing/validation/publication and appears at the top;
  verified completion clears it, while unknown execution reports attention.
  No-op outcome reporting is durable and independently resumable without another
  primary execution or fabricated commit/check. Managed body writes retain current
  human content through observed-body preconditions; only never-dispatched conflicts
  cancel, while dispatched uncertainty retains P4 reconciliation. Repeated field
  drift does not reuse a historical completed body intent as current proof.
- T6 checks: seven focused reply/status/verification/client/dispatch/mutation suites
  passed **153 tests**; all three quality/no-op lifecycle scenarios passed, including
  activity visible during the primary writer, human-body preservation and an
  unresolved no-op reply without another correction. Broad `yarn test` then passed
  **2,129 tests across 166 files** (not a full `yarn validate`). Self-review traced
  current/head/revision evidence, edited/deleted uncertain replies, queue recovery,
  no-op completion, description/status callers and the original P4 dispatch boundary.
  Corrected cached body-success reuse after drift and preserved the original error
  cause in status-reconciliation failures. Final affected checks are recorded below.
  The final eight affected suites passed **196 tests**, including a new dual-failure
  recovery regression. Typecheck, changed-file ESLint, docs Prettier and
  `git diff --check` passed. No known T6 defect remains; terminal-race handling below
  is still unfinished. No live-service qualification or full validation is claimed.
- P7-T7 implements terminal precedence (REQ-HR-006, REQ-PR-008, with PR-007,
  SCH-001/002 and WF-003 integration). Durable terminal observation fences stale
  execution/transport callbacks, cancels active process trees and capacity waits,
  and remains active behind future dependency rechecks. Existing-PR publication
  checks the authoritative outcome before push/Review and after rejected push.
  Initial creation interrupted by human closure binds/reconciles the original PR,
  including a deleted branch, without replacement publication. Dispatched initial
  Review/comment effects retain immutable readback reconciliation rather than replay.
  Terminal consistency requires verified stopped writers and conclusive dispatched
  effects. Unknown execution retains ownership; unshipped changes and diagnostics
  are preserved. Cancelled primary operations do not consume genuine-crash budget;
  superseded queue descriptors retire explicitly. Terminal activity clearing retains
  human content, and live capacity/cancellation/observer keys include storage/project.
- T7 checks: six observer/capacity/GitHub/terminal/mutation suites passed **71 tests**;
  seven lifecycle/publication/publisher/location/primary/process suites initially
  passed **221 tests** with six lifecycle expectation failures. Those failures
  reflected earlier terminal discovery and explicit retirement; the destination-read
  outage fixture now fails only after the intended move. The next lifecycle/capacity
  run passed **37 tests** with one remaining race-timing expectation failure; its
  third-read deferred case was corrected, then all **four validation lifecycle cases**
  passed (24 other scenarios filtered). The new identical-local-attempt-ID capacity
  isolation regression passed in that capacity run. Typecheck, all changed-code
  ESLint and formatting passed. Final
  `yarn test tests/task-lifecycle.integration.test.ts tests/ai-execution-capacity.test.ts`
  passed **38 tests**, including all 28 lifecycle scenarios; typecheck, changed-code
  ESLint, documentation/code Prettier and `git diff --check` passed again.
  Self-review inspected actual production observer/worker/publish/recovery paths,
  terminal stop proof, journal/transport guards, queue ownership, primary counters,
  artifact preservation, new files and real-process regressions. Corrected scoped
  in-memory identities and preserved uncertainty across late initial Trello effects.
  No known T7 defect remains; full integrated validation is not yet claimed.
- T7 checkpoint: `3a04855`. T8 combined integration inspection reused the completed
  task reviews and checked all P7 criteria: current Ready eligibility/order; durable
  arrivals and serialized prioritized dispatch; current semantic feedback/history;
  original-session additive correction with refreshed attachments; truthful partial
  replies/draft/activity; fair optional AI capacity; expected-list/manual-move recovery;
  and human terminal precedence with pending-effect/unknown-writer preservation.
  Existing production regressions cover these paths. P8 CI episode/maintenance
  execution and P10 fresh-attempt/cleanup expansion remain out of scope. Product
  guidance's stale separate-session/approval-gate and missing-PR outcome claims were
  corrected to match the integrated behavior. No new implementation gap was found.
- T8 integrated `yarn validate` passed ESLint, full Prettier checking, TypeScript
  and **2,142 tests across 166 files**. All P7 contributions are implemented with no
  known unresolved scoped defect. The final documentation/results checkpoint is
  revalidated before commit. No live Trello/GitHub/OpenCode qualification is claimed.
  No P7 implementation work remains; stop before P8.

## Inherited P6 checkpoint

- **P6 implementation complete; distinguish local checks from PR CI.** The original
  local `yarn validate` passed lint, formatting, typecheck and **2,076 tests across
  160 files**. PR #219's first CI run (`42883831283`) instead failed one command-crash
  regression: Bash implicitly execs its last command, while CI's Dash preserves the
  shell and reports the killed child as exit `143`. This test now explicitly execs
  when requiring a supervisor signal; a separate retained-shell regression requires
  numeric `143` with no fabricated signal. Production classification is unchanged.
  Focused checks passed all 42 adapter tests locally and all seven command/shell
  cases in a disposable Debian Node 24/Dash container, plus typecheck, ESLint and
  Prettier. Final local and current-head CI results are reported in the PR/session;
  a local pass alone does not establish CI success. P6 is now integrated at `7fafed1`.
- Resume-session checkpoints: `faf726f` current-evidence same-PR promotion,
  `33e325f` isolation startup integration, `24c1d76` notification disclosure and
  product guidance, `cb9d511` integrated recovery/draft fixture coverage.
- Phase base: `92a8276` (P5 integrated).
- P6-T1 (`d441859`), T2 (`9e9b6a4`), T3 (`ca63a51`) and T4 (`0da3bb7`) are
  committed; temporary-guide cleanup is `2940ea1`.
- T5 is implemented: distinct bounded review
  remediation, no-op/early finish, and original operation/prompt recovery through
  initial, feedback and CI callers. CI review budgets retain their episode and usage.
- Production regressions cover reservation, durable primary completion, validation
  and completed-review interruptions, plus unknown-execution fencing. Feedback
  recovery retains its original round when newer feedback is observed. Final
  validation results are reported in the task handoff.
- The implementation baseline passed `yarn validate`: lint, formatting, typecheck
  and 1,956 tests across 156 files. Validate the final changed candidate before handoff.
- Delivery follows the [whole-phase workflow](phase-execution.md): prepare once,
  implement and review small complete tasks sequentially, then check final integration
  and validate once. No evidence reports or full-suite runs per task.
- Preserve existing working changes and staging when resuming.
- Local reviewed-task commits require explicit session authorization. The current
  P6 session authorized publishing PR #219 and correcting its failed CI. That
  historical authorization does not authorize new remote Git actions here.

## P6 publication checkpoints and remaining work

Use the behavior contracts in the [P6 checklist](p6-execution.md), with relevant
requirements/specification sections and meaningful regression tests:

- T6 isolation is committed in `f69ccc6`; scoped commit/setup and uncertain-commit
  recovery regressions remain intact. Startup now probes actual Bubblewrap namespace
  capabilities before task processing and documents local/container installation
  and least-privilege policy. The real child regression verifies read-only context,
  writable session/scratch state and blocked source/metadata/runtime writes.
- T7–T8 complete observed descriptions/fallbacks and notification disclosure are
  committed in `04de54d`; T9 verified no-output failure is `b3f7be3`.
- The targeted recovery check inspected all three commits in `8c46b7c..b3f7be3`
  and the unfinished T10 working changes, without reopening T1–T5.
- T10 (`faf726f`) carries current readiness evidence through normal and trusted-commit
  publishers, refreshes the same PR while preserving human text, and verifies its
  head/body/open state before promotion. Material/unresolved human requests and
  failed/skipped/uncertain/stale checks prevent promotion. Lost acknowledgments
  reconcile through the existing durable mutation journal rather than resending.
  Explicitly cleared current review disclosures no longer restore old findings.
- Checks: `yarn test tests/initial-publication.integration.test.ts tests/publish-card.test.ts tests/publish-task-session-card.test.ts`
  passed 133 tests; `yarn typecheck` and ESLint on all changed code/tests passed.
  The real isolation integration test also passed.
- Isolation follow-up (`33e325f`) checks: `yarn test tests/validate-toolchain.test.ts tests/opencode-isolation.integration.test.ts tests/run-startup.test.ts`
  passed 32 tests; `yarn typecheck`, changed-file ESLint and Prettier passed.
- Combined P6 inspection covered advisory planning, separate persisted improvement
  budgets, primary failure/unknown-writer fences, setup-aware single initial commit
  and uncertain-write recovery, draft/normal descriptions and notifications,
  clarification/no-output failure reconciliation and current-evidence promotion.
  Existing production regressions cover these paths; completed T1–T5 work was not
  restarted. P7 feedback/observation and P8 CI/maintenance changes remain out of scope.
- Final integration correction: shared publisher notifications now include observed
  failed/skipped/uncertain check facts even when AI review passed. Product workflow
  and fallback-description guidance no longer describes initial checks as approval
  gates. `yarn test tests/publish-card.test.ts tests/notification-outbox.test.ts`
  passed 63 tests; `yarn typecheck`, changed-file ESLint and Prettier passed.
- Integrated validation initially passed lint/format/typecheck but exposed six
  fixture-contract failures. Corrections retain actual Bubblewrap exit `137` for
  an inner SIGKILL (not a fabricated outer signal), exercise real namespace startup
  probing with the isolated fixture PATH, and model required draft-state mutations
  in the existing dispatch adapters. Three verified crash failures, preserved PR
  ownership/work and recovery assertions remain enforced.
  `yarn test tests/task-session-dispatch.test.ts tests/process-adapter-matrix.integration.test.ts tests/task-lifecycle.integration.test.ts`
  passed all 70 tests; typecheck, changed-file ESLint and Prettier passed. The
  corrected integrated tree then passed full `yarn validate` as recorded above.

No P6–P8 implementation work remains. P9–P10 have not started. P11 covers
remaining integration/regression gaps, with broader qualification only if requested.

## Known carryovers

- **Unknown process liveness:** supervisor loss with escaped descendants has no
  established stopped-execution proof. Keep the unknown-state fence; never redispatch
  a writer on an assumption that the previous execution stopped. Investigate when
  changing dependent cancellation/recovery paths.
- **Recovery accounting:** [P6 decisions](p6-decisions.md) approve three verified
  genuine failures with outage/reconstruction accounting separate. Apply and test
  that policy when touching budgets; do not reopen the approval.
- **Source protection:** writable dispatch uses Bubblewrap and startup verifies its
  required capabilities; deployment policies must permit those namespaces. Focused
  shell behavior was checked in a disposable container; full container workflow or
  live-service qualification has not been performed.

Do not reopen P5 or reconstruct deleted audit/evidence records. Current source,
tests and specification govern implementation. Keep useful new task guidance in
the existing selected guide and update this progress summary at meaningful checkpoints.
