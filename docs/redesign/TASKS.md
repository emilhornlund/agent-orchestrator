# Agent Orchestrator — Ordered Local Redesign Tasks

This is the **authoritative execution backlog** for
[REQUIREMENTS.md](REQUIREMENTS.md). The `redesign-executor` OpenCode agent
implements each task in a dedicated local commit. Every task is verifiable
with existing local tooling, fixtures and mocks — **no live service is a prerequisite**.

## Checklist semantics

- **Select:** Normally the first top-level unchecked task in ascending ID
  order. A confirmed defect in completed work, a missing prerequisite, or an
  explicit maintainer correction takes precedence; add/reopen a focused task
  and complete it before dependent remaining tasks.
- **Plan:** Inspect the actual code and write an implementation plan in the OpenCode session.
- **Implement:** Change only what the selected task or an authorized corrective
  task requires, with deterministic tests.
- **Validate:** Run focused tests and `yarn validate`; fix and rerun on failure.
- **Complete:** Mark a task `[x]` only after its acceptance evidence passes;
  reopen it if later evidence invalidates completion. Then rerun `yarn validate`.
- **Commit:** Keep implementation/correction commits focused and local. Preserve
  unrelated in-progress work unstaged; never rewrite existing history.
- **Continue:** Re-read both documents, then continue with the next required
  task, including any corrective task that precedes it.

The executor must **not** check a task before it is genuinely done, skip a
requirement, batch unrelated work into one commit, or silently weaken acceptance
criteria. The maintainer authorizes narrow backlog updates, reopening tasks, and
corrective tasks when implementation evidence reveals a defect or missing
integration. Preserve all existing work and Git history. Stop only for a genuine
unresolvable blocker; an earlier-task defect is to be corrected autonomously.

## Global acceptance rules

For **every** task: (1) preserve the legacy workflow unless explicitly
requested; (2) use deterministic local tests and mocked external services;
(3) do not introduce real network/service requirements; (4) run the full
`yarn validate` after source edits **and** after checking the task; (5) keep
commits focused, preserving unrelated uncommitted work; (6) no push, PR, merge
or deploy. Corrective tasks may be completed before the next numbered task when
required for correctness.

Planned tasks rely only on their declared completed dependencies, never on
assumed future implementations. A confirmed defect or missing dependency must
be recorded and corrected before dependent work; source paths and method names
are examples to inspect, not permission to invent unimplemented helpers.

## Phase A — Non-invasive foundation

- [x] **T01 — Lock down legacy workflow behavior**
  - **Depends on:** None.
  - **Implement:** Extend existing workflow-characterization tests for implementation, requested-change remediation, publication, and interrupted recovery. Use only mocks and existing test helpers.
  - **Verify locally:** The tests pass on unchanged legacy production code and assert observable transitions, not internal function call order.
  - **Out of scope:** Do not refactor runtime logic or alter existing behavior.

- [x] **T02 — Introduce opt-in execution mode configuration**
  - **Depends on:** T01.
  - **Implement:** Add optional `projects[].executionMode` with exactly `legacy` and `task-session` as valid values. Default to `legacy`. Until T43, fail startup clearly if `task-session` is configured.
  - **Verify locally:** Config parsing tests cover omitted, valid, and invalid modes; legacy project startup behavior remains unchanged.
  - **Out of scope:** Do not route production tasks to a partially built workflow.

- [x] **T03 — Define the task execution record schema**
  - **Depends on:** T02.
  - **Implement:** Add a versioned runtime-validated type for task ownership, phase, card/project IDs, primary session ID, branch, PR/head, operation key, record revision, retry counters, and timestamps. All future-optional IDs must be explicit optional fields.
  - **Verify locally:** Unit tests round-trip valid JSON and reject malformed IDs, unknown versions, invalid phase values, and impossible field combinations.
  - **Out of scope:** No filesystem operations or calls to outside services.

- [x] **T04 — Add atomic task-record storage**
  - **Depends on:** T03.
  - **Implement:** Create a file-backed task execution store rooted outside repositories/worktrees, using existing safe path resolution patterns. Implement create/read/compare-and-swap update with atomic temporary-file replacement and size limits.
  - **Verify locally:** Local temporary-directory tests prove successful round-trips, stale revision rejection, malformed-file preservation, path traversal protection, and write-failure safety.
  - **Out of scope:** Do not replace legacy persisted recovery artifacts.

- [x] **T05 — Add pure task-session state transitions**
  - **Depends on:** T03–T04.
  - **Implement:** Define a discriminated set of phase/event transitions for planning, implementation, validation, review, publication, CI, human feedback, done, and attention-required. Validate ownership and event identity on transition.
  - **Verify locally:** Table-driven tests prove allowed transitions, duplicate-event idempotency, impossible-transition rejection, and terminal-state safety.
  - **Out of scope:** No Trello/ GitHub side effects, subprocesses, or retries.

- [x] **T06 — Add task-session ownership guard**
  - **Depends on:** T04–T05.
  - **Implement:** Introduce a small coordinator helper that loads the owned card record and refuses to operate if its project/card/branch association conflicts with the requested task. Reuse existing per-project exclusivity assumptions for now.
  - **Verify locally:** Tests cover matching owner, other-card record, stale operation identity, missing record, and safe refusal without mutations.
  - **Out of scope:** Do not replace poll scheduling or enable task-session mode.

## Phase B — Session continuity and planning

- [x] **T07 — Allow explicit OpenCode session continuation**
  - **Depends on:** T06.
  - **Implement:** Add optional `sessionId` to `OpenCodeRunOptions` and pass `--session <id>` to the OpenCode CLI only when provided. Use the existing process boundary and timeout/abort behavior.
  - **Verify locally:** Mock process-launcher tests assert exact arguments, unchanged legacy calls, rejected invalid IDs, and no `--continue` fallback.
  - **Out of scope:** Do not persist session IDs or create sessions yet.

- [x] **T08 — Capture a newly created OpenCode session ID**
  - **Depends on:** T07.
  - **Implement:** Add a structured-output path for the initial OpenCode invocation to return the real created session ID. Parse supported JSON/event output or supported session API with a version-aware adapter; never parse free-form prose.
  - **Verify locally:** Fixture tests prove successful extraction, missing/ambiguous IDs fail closed, output diagnostics remain usable, and legacy text execution is unaffected.
  - **Out of scope:** Do not introduce live OpenCode integration tests.

- [x] **T09 — Bind the primary OpenCode session to a task record**
  - **Depends on:** T04, T07–T08.
  - **Implement:** Create-or-resume logic that stores the actual session ID under the owning task and always resumes that ID. Persist successful binding before later stages. Treat unclear creation after an interruption as an ambiguous state.
  - **Verify locally:** Mocked tests prove same-task reuse, cross-task isolation, restarted process reuse, duplicate-initialization safety, and no silent replacement.
  - **Out of scope:** Do not execute implementation or invent missing session IDs.

- [x] **T10 — Define structured plan and acceptance-criteria schemas**
  - **Depends on:** T03.
  - **Implement:** Create validated plan types with task/card identity, original requirement IDs, implementation steps, proposed verification, assumptions, and blockers. Require nonempty IDs and traceable requirements.
  - **Verify locally:** Parsing tests reject missing requirements, duplicate IDs, malformed steps, and unknown mandatory fields.
  - **Out of scope:** Do not call a planning model or persist plans.

- [x] **T11 — Persist versioned plans locally and safely**
  - **Depends on:** T04, T10.
  - **Implement:** Add atomic per-task plan storage outside Git worktrees, with the same path, size, identity, and corrupted-record protections as task state. Store plan revision and task-record association.
  - **Verify locally:** Tests verify read/write/revision conflict, corrupted data protection, and wrong-task rejection.
  - **Out of scope:** Do not generate or approve plans.

- [x] **T12 — Build and parse the planning operation**
  - **Depends on:** T09–T11.
  - **Implement:** Add a prompt that asks the primary task session to inspect source/repository instructions and produce only the T10 plan artifact. Include original task and relevant attachment metadata. Parse, validate, then save it.
  - **Verify locally:** Tests assert plan prompt contract, mocked structured response handling, rejection of malformed plans, and preservation of unchanged repository files.
  - **Out of scope:** Do not implement code or run an independent reviewer.

- [x] **T13 — Add independent plan verification**
  - **Depends on:** T10–T12.
  - **Implement:** Add a read-only independent OpenCode review call comparing the original card and acceptance criteria to the persisted plan. Return structured `pass` or concrete missing/unsupported requirement findings; persist outcome.
  - **Verify locally:** Unit tests cover accepted plan, omitted task criterion, invented scope, malformed reviewer response, and no implementation transition on failure.
  - **Out of scope:** Do not rewrite the plan automatically or share the primary conversation as reviewer.

- [x] **T14 — Require native repository skill discovery in prompts**
  - **Depends on:** T12–T13.
  - **Implement:** Amend task-session planning and implementation prompts to direct OpenCode to follow `AGENTS.md` and load relevant existing native OpenCode skills from the repository when available.
  - **Verify locally:** Prompt-contract tests verify the guidance and a no-skill fallback; no tests require installed external skills or internet.
  - **Out of scope:** Do not implement a skill downloader, registry, or new provider framework.

## Phase C — Local implementation and mandatory checks

- [x] **T15 — Add internal task-session implementation runner**
  - **Depends on:** T05, T09, T13–T14.
  - **Implement:** Compose verified-plan lookup, owned worktree, original task context, and primary-session continuation into an internal `task-session` implementation operation. Persist phase/outcome. Keep it unreachable from production polling until T43.
  - **Verify locally:** Mock orchestration tests show correct session reuse, verified-plan prerequisite, abort/error preservation, and no agent-side Git/PR actions.
  - **Out of scope:** No validation, commit, publication, or legacy workflow modifications.

- [x] **T16 — Create the orchestrator-owned validation runner**
  - **Depends on:** T15.
  - **Implement:** Use existing `CommandRunner` to execute `repository.validationCommand` in the owned worktree for task-session runs. Require a nonempty command for that mode. Capture exact command, exit code, timestamps, bounded/redacted diagnostics, and timeout result.
  - **Verify locally:** Mock-command tests prove zero passes, nonzero fails, timeout/abort fail, and absent command rejects before implementation.
  - **Out of scope:** Do not change legacy delegated-validation behavior or introduce coverage yet.

- [x] **T17 — Implement deterministic source snapshot identity**
  - **Depends on:** T16.
  - **Implement:** Build a stable content identity for the current implementation including tracked, staged, deleted, renamed, and untracked file contents. Bind each quality result to this identity or to an exact committed SHA.
  - **Verify locally:** Local temporary-Git-repository tests prove that an edit, deletion, added untracked file, or rebase invalidates earlier evidence while unchanged content preserves identity.
  - **Out of scope:** Do not treat `git status` text alone as a sufficient fingerprint.

- [x] **T18 — Add bounded local validation repairs**
  - **Depends on:** T09, T15–T17.
  - **Implement:** On a failed validation, resume the primary session with command, exit code, and relevant diagnostics; after each edit rerun validation. Persist an attempt counter and cap at two corrections per validation cycle.
  - **Verify locally:** Tests cover fail→fix→pass, repeated failure exhaustion, session mismatch, interrupted resume, and rejection of stale passing evidence.
  - **Out of scope:** Do not run GitHub CI or continue after exhausted repair.

- [x] **T19 — Add optional repository coverage command gate**
  - **Depends on:** T16–T17.
  - **Implement:** Add optional `repository.coverageCommand` for task-session mode. Run it with `CommandRunner`; its exit code is authoritative and thresholds remain repository-owned. Bind results to source snapshot.
  - **Verify locally:** Configuration and mocked-command tests cover absent command, pass, threshold failure, timeout, and stale evidence.
  - **Out of scope:** Do not introduce universal percentages or parse heterogeneous coverage reports.

- [x] **T20 — Integrate coverage failures into the bounded repair loop**
  - **Depends on:** T18–T19.
  - **Implement:** Reuse the same primary-session repair flow for configured coverage failures, naming the failing coverage command and diagnostics explicitly. Rerun local validation and coverage after repairs.
  - **Verify locally:** Tests prove coverage failure causes repair, previously passed validation is rechecked after edits, and bounded exhaustion prevents review.
  - **Out of scope:** Do not create a second unlimited retry mechanism.

- [x] **T21 — Define structured implementation review results**
  - **Depends on:** T10, T17.
  - **Implement:** Add a validated schema with overall verdict, per-requirement assessment, concrete blocking findings, source location when known, and reviewed content identity.
  - **Verify locally:** Parser tests reject missing requirement assessments, invalid verdicts, stale content identities, and malformed findings.
  - **Out of scope:** Do not invoke OpenCode in this task.

- [x] **T22 — Implement independent completion and correctness review**
  - **Depends on:** T15, T20–T21.
  - **Implement:** Add a read-only reviewer invocation using a separate OpenCode session, the original card, approved plan, current diff, and evidence. Verify the structured response against the content identity and mandatory requirement IDs.
  - **Verify locally:** Mocked tests show passing complete work, blocking omitted requirements/serious defects, reviewer write protection, and malformed output failure.
  - **Out of scope:** Do not publish or remediate findings in this task.

- [x] **T23 — Implement final-review-after-remediation loop**
  - **Depends on:** T18, T20–T22.
  - **Implement:** On blocking review findings, resume the primary session for corrections, rerun validation/coverage, and repeat the independent review. Persist a finite review-remediation attempt count, and always run a final review even after the last allowed repair.
  - **Verify locally:** Tests prove latest review must pass, final allowed fix is reviewed, stale evidence is rejected, and exhaustion blocks progression.
  - **Out of scope:** Do not alter legacy `maxPasses` semantics.

- [x] **T24 — Create a pure verified-publication decision**
  - **Depends on:** T17, T19, T21–T23.
  - **Implement:** Define a deterministic gate that requires current-snapshot successful validation, configured coverage, and current-snapshot passing final review before a publish operation can begin.
  - **Verify locally:** Table-driven tests cover missing, stale, failed, and passing evidence; changing source after success denies publication.
  - **Out of scope:** Do not push, create commits, or call GitHub here.

## Phase D — Publication and GitHub CI repair

- [x] **T25 — Connect verified task-session commits and publication**
  - **Depends on:** T15, T24.
  - **Implement:** Reuse existing local commit, signing, safe fetch/rebase, trusted-state, push, and PR-reuse code behind the T24 gate in task-session mode. Invalidate gates if publication preparation changes content; require fresh verification before push.
  - **Verify locally:** Mocked Git/GitHub tests prove exactly one trusted commit, no unverified push, no force push, same-PR reuse, and preserved failure state.
  - **Out of scope:** No actual GitHub calls or live PRs in tests; legacy publishing is untouched.

- [x] **T26 — Collect current-head required GitHub checks**
  - **Depends on:** T25.
  - **Implement:** Add `projects[].repository.requiredChecks` as a nonempty, unique list of check names required when `executionMode` is `task-session`. Extend `GitHubClient` to read exact-head statuses for these names; distinguish missing, queued/in-progress, succeeded, failed, cancelled, and incomplete responses.
  - **Verify locally:** Config and mocked API tests cover missing/duplicate check configuration, all conclusions, pagination, exact head matching, and unknown/temporary GitHub responses.
  - **Out of scope:** Do not assume PR mergeability `BLOCKED` or `UNSTABLE` alone identifies a failed check.

- [x] **T27 — Collect bounded diagnostics for failing CI checks**
  - **Depends on:** T26.
  - **Implement:** Retrieve available workflow/job/step diagnostics for failed required checks, preserving check name, job identity, exact SHA and log URL; redact secrets and bound output size.
  - **Verify locally:** Mocked fixture tests cover successful logs, missing permissions/logs, malformed payload, secret redaction, and changed-head rejection.
  - **Out of scope:** Do not modify PRs or invoke the coding agent.

- [x] **T28 — Implement bounded CI repair rounds**
  - **Depends on:** T18, T22–T27.
  - **Implement:** For failed required current-head CI, resume the original task session with T27 diagnostics; rerun local validation, coverage, and independent final review; update the same PR through T25, then poll checks for the new head. Persist at most two repair attempts per CI failure cycle.
  - **Verify locally:** Mock lifecycle tests prove fail→fix→green, stale-head rejection, missing/pending checks do not trigger blind fixes, and exhaustion preserves the PR for attention.
  - **Out of scope:** Do not open another PR or use real GitHub Actions.

- [x] **T29 — Enforce CI-aware auto-merge readiness**
  - **Depends on:** T24–T28.
  - **Implement:** Add a deterministic merge-readiness gate for task-session mode: all configured required checks must have succeeded on the expected PR head, and required local evidence must still be valid. Route through existing `autoMerge` safety behavior.
  - **Verify locally:** Tests prove stale, pending, missing, cancelled, and failed checks block auto-merge, while fully verified results allow the existing merge path.
  - **Out of scope:** Do not approve PRs, bypass GitHub protections, or live-test merges.

## Phase E — Human feedback as a durable lifecycle

- [x] **T30 — Normalize submitted reviews and inline feedback**
  - **Depends on:** T26.
  - **Implement:** Extend existing GitHub review parsing into typed feedback records preserving review ID, thread/comment IDs, author, submitted time, file/line/diff context, isResolved/isOutdated, and originating commit SHA. Keep carried-forward still-applicable unresolved comments.
  - **Verify locally:** Mocked payload tests cover review-body-only, inline-only, mixed, old-head unresolved threads, and malformed/paginated responses.
  - **Out of scope:** Do not remove current-head safeguards or change remediation yet.

- [x] **T31 — Collect top-level PR conversation comments**
  - **Depends on:** T30.
  - **Implement:** Add paginated collection of PR issue/conversation comments with stable IDs, author, timestamp, body, and commit/head observation where known. Preserve distinction between discussion and submitted review decisions.
  - **Verify locally:** Mocked API tests cover pagination, author identity, edited comments, empty replies, and GitHub-generated comments.
  - **Out of scope:** Do not automatically classify any general comment as a code-change request.

- [x] **T32 — Implement persistent feedback ledger**
  - **Depends on:** T04, T30–T31.
  - **Implement:** Persist normalized feedback outside Git in a task-scoped, revisioned ledger keyed by stable GitHub IDs. Store actionability, state, latest head, verification evidence, remediation commit, and published reply ID.
  - **Verify locally:** Local-file tests cover deduplication, new feedback, earlier unresolved carry-forward, stale writes, restart reload, and wrong-task rejection.
  - **Out of scope:** Do not invoke OpenCode or automatically resolve discussion threads.

- [x] **T33 — Define actionable-feedback selection rules**
  - **Depends on:** T30–T32.
  - **Implement:** Build a pure selector that treats current-head `CHANGES_REQUESTED` and still-applicable unresolved inline requests as actionable while retaining general comments for explicit classification. Ignore the bot’s own replies as new work; unresolved ambiguity becomes attention-needed rather than a silent assumption.
  - **Verify locally:** Table-driven tests cover old-head reviews, reviewer follow-ups, bot comments, unresolved threads, and non-actionable discussion.
  - **Out of scope:** Do not auto-dismiss human feedback or react to every comment with source edits.

- [x] **T34 — Resume the primary agent for actionable feedback**
  - **Depends on:** T09, T25, T32–T33.
  - **Implement:** Build the feedback remediation prompt from the original task, approved plan, current code, current PR head, and all unaddressed actionable ledger items; resume the exact original session ID. Record the remediation operation identity.
  - **Verify locally:** Mock tests prove every pending item appears with correct locations, new items are not lost, wrong-session resume is rejected, and no-op does not count as addressed.
  - **Out of scope:** Do not push changes, verify feedback, or publish replies here.

- [x] **T35 — Independently verify feedback dispositions**
  - **Depends on:** T22–T24, T32, T34.
  - **Implement:** Add a read-only verifier returning one structured disposition per actionable feedback ID: verified fixed with code/test evidence, or unresolved with reason. Require local validation, coverage, and review again after edits.
  - **Verify locally:** Tests fail verification when an item is omitted, a change is unverified, a disposition is invented, or prior evidence belongs to an earlier head.
  - **Out of scope:** Do not mark GitHub threads resolved or claim reviewer approval.

- [x] **T36 — Add GitHub contextual reply operations**
  - **Depends on:** T30–T31.
  - **Implement:** Add typed GitHub client methods to reply to an inline review thread or top-level PR conversation comment using its exact known ID. Return the created reply ID and validate mismatched PR ownership.
  - **Verify locally:** Mock CLI/API tests verify correct endpoint/thread, malformed ID rejection, permission errors, and response parsing.
  - **Out of scope:** Do not let the agent call GitHub directly or publish replies yet.

- [x] **T37 — Publish verified feedback responses idempotently**
  - **Depends on:** T25, T28, T32, T35–T36.
  - **Implement:** Only after the correcting commit is published and required current-head CI passes, compose factual replies from verified per-item evidence and publish via T36. Record reply IDs before considering the cycle complete; reconcile uncertain outcomes to avoid duplicate replies.
  - **Verify locally:** Mock tests cover exact thread routing, no premature success claim, reply persistence, interrupted response recovery, and duplicate-event idempotency.
  - **Out of scope:** Do not automatically resolve threads, approve PRs, or rewrite review decisions.

- [x] **T38 — Handle multiple and late feedback rounds**
  - **Depends on:** T32–T37.
  - **Implement:** Re-read authoritative PR head and feedback identities after each remediation/publish cycle. Keep earlier still-applicable unresolved items, enqueue newly arrived feedback, and invalidate outdated local evidence if the head or feedback set changes.
  - **Verify locally:** Mock scenarios cover two sequential requested-change rounds, a late inline comment during repair, and no duplicate correction when no new actionable feedback exists.
  - **Out of scope:** Do not process a second task concurrently or drop old unresolved items.

## Phase F — Recovery, scheduling, and activation

- [x] **T39 — Reconcile interrupted task-session operations**
  - **Depends on:** T04–T06, T09, T24–T25, T28, T32–T38.
  - **Implement:** On startup, reconstruct task-session state from the durable record plus owned Git worktree, branch/HEAD, Trello card, PR/head, CI and feedback snapshots obtained through injectable clients. Resume only verified transitions; fail closed on ambiguous session identity or partially published side effects.
  - **Verify locally:** Mock restart tests cover interruption before/after local commit, PR publication, CI repair, feedback reply, and malformed persisted state.
  - **Out of scope:** Do not reset unknown changes or replace legacy reconciliation.

- [x] **T40 — Allow read-only monitoring of multiple waiting PRs**
  - **Depends on:** T26, T32, T39.
  - **Implement:** Separate enumeration and observation of all owned Human Review PRs from the legacy assumption that there can be only one active review card, but only in task-session mode. Record their independent observed head/check/feedback state.
  - **Verify locally:** Tests confirm two waiting PRs can be observed independently with no source writes or cross-card state confusion.
  - **Out of scope:** Do not allow parallel repository mutation or alter legacy scheduler.

- [x] **T41 — Queue repairs behind a single project mutation owner**
  - **Depends on:** T06, T39–T40.
  - **Implement:** Implement deterministic queuing for eligible implementation, CI repair, and feedback events so at most one repository-changing operation runs per project. Persist event identity and task ownership; never run two mutators concurrently.
  - **Verify locally:** Mock scheduler tests cover duplicate poll events, two waiting PRs, queued CI+feedback for separate tasks, restart recovery, and fair deterministic selection.
  - **Out of scope:** Do not implement multi-writer concurrency or parallel commits.

- [x] **T42 — Add full mocked lifecycle scenario coverage**
  - **Depends on:** T15–T41.
  - **Implement:** Add end-to-end-style tests using in-memory/mocked Trello, GitHub, OpenCode, commands and temporary Git repositories for initial success, validation failure, coverage repair, review remediation, PR CI failure/repair, two human-review rounds, late comments, interruption recovery, and multiple waiting PRs.
  - **Verify locally:** All scenarios pass offline and assert no unverified publication, preserved task ownership, correct session continuity, and bounded failure outcomes.
  - **Out of scope:** Do not call real services or AI models; do not enable mode yet.

- [x] **T43 — Enable task-session dispatch without auto-migration**
  - **Depends on:** T02, T15–T42.
  - **Implement:** Remove the temporary startup rejection for `executionMode: task-session` and route eligible new tasks to the completed task-session coordinator. Legacy remains the default. Reject attempts to attach new mode to an existing active legacy task without explicit migration.
  - **Verify locally:** Startup and mocked workflow tests verify mode routing, default legacy behavior, safe refusal to migrate, and correct local-only end-to-end completion.
  - **Out of scope:** Do not deploy, run live integrations, or change defaults.

  **Correction status:** The prior T43 commit enabled initial task-session dispatch but did not connect failed-CI repair or the human-feedback lifecycle to production polling. T43 remains incomplete until T43A–T43C pass and its original acceptance criteria are reverified.

- [x] **T43A — Integrate bounded CI remediation into production task-session polling**
  - **Depends on:** T28, T39, T41–T43.
  - **Implement:** Connect the existing T28 CI remediation implementation to the actual task-session runtime. When a required check fails on the current PR head, enqueue or resume the appropriate repair operation using the original primary OpenCode session. Preserve current-head verification, idempotent event handling, retry limits, validation, coverage, independent review, safe publication, and persisted repair state.
  - **Verify locally:** Production-polling tests prove failed current-head CI triggers bounded repair on the original session, stale/pending checks do not trigger repair, the same PR advances to a new head, and exhaustion/ambiguity preserves state for attention.
  - **Out of scope:** Do not call real GitHub Actions or create a new PR.

- [x] **T43B — Integrate human feedback remediation into production task-session polling**
  - **Depends on:** T30–T38, T41–T43A.
  - **Implement:** Connect the existing T30–T38 feedback collection, actionability classification, primary-session remediation, independent verification, and contextual reply functionality to production polling. Preserve unresolved feedback, support subsequent rounds, and publish replies only after verified corrections and required successful checks.
  - **Verify locally:** Production-polling tests cover current requested changes, inline and conversation feedback, multiple rounds, late feedback, same-session continuation, verification gates, and idempotent contextual replies.
  - **Out of scope:** Do not auto-dismiss reviews, resolve threads, or invoke live GitHub services.

- [x] **T43C — Verify recovery and complete lifecycle integration**
  - **Depends on:** T39–T43B.
  - **Implement:** Complete any necessary task-session recovery wiring and add mocked end-to-end tests through the actual production polling entry point. Cover CI repair, repeated human feedback, session continuity, commit/publication safety, retry exhaustion, restart recovery, idempotency, and multiple waiting PRs under the single mutation-owner constraint. Keep legacy execution unaffected.
  - **Verify locally:** All scenarios pass offline and assert no unverified publication, preserved task ownership, no duplicate commits/replies, and human attention for exhausted or ambiguous states.
  - **Out of scope:** Do not use real services or models, and do not deploy.

- [x] **T44 — Document operation, configuration, and pilot boundaries**
  - **Depends on:** T43, T45.
  - **Implement:** Update README, configuration reference, workflow/recovery/operations docs, and `config.example.yaml` with opt-in mode, required validation, optional coverage, session ownership, CI/feedback behavior, bounded retries, and operator recovery instructions. Distinguish local mocked verification from an unperformed real-world pilot.
  - **Verify locally:** Docs examples match actual validated config; existing `yarn validate` passes; no claim of live integration testing is made.
  - **Out of scope:** Do not enable the new mode by default or modify code unrelated to docs.

- [x] **T45 — Resume interrupted task-session claims and Working cards**
  - **Depends on:** T39, T43C.
  - **Corrective rationale:** Production polling left owned task-session `Working` cards untouched after restart, and `reconcileTaskSession` had no production caller. A restart between queue claim, worktree preparation, Trello claim, and task-record creation could also leave a `Ready for Agent` event permanently owning the queue.
  - **Implement:** Integrate the existing `reconcileTaskSession` component into production polling. Resume a `Ready for Agent` claim only from its matching persisted mutation event and validated owned worktree state; resume owned `Working` cards only from the persisted phase and authoritative Trello/worktree/branch/HEAD/trusted-commit/session/publication evidence. Continue the exact persisted primary session and safely resume a verified trusted publication without making another commit. Preserve queue ownership and event identity, and prevent concurrent polling workers from claiming the same mutation. Fail closed with durable attention state on ownership/session/worktree/setup ambiguity or uncertain external effects; never create duplicate commits, pushes, PRs, feedback replies, or start a second task.
  - **Verify locally:** `pollProject` restart tests cover interruption after claim/worktree preparation before `Working` record creation and during an active `Working` operation; prove matching event/worktree reuse despite a later poll timestamp, original-session continuation, trusted publication without a duplicate commit, and no active-mutation theft by a competing poller. Cover ambiguous/malformed ownership, session, setup, worktree, commit, and publication state with mocked clients/local fixtures only. Keep legacy execution unaffected.
  - **Out of scope:** Do not use live services or models, migrate legacy tasks, discard preserved changes, or introduce a competing recovery mechanism.

## Phase G — Preserve essential workflow behavior

- [x] **T45A — Restore executor instruction formatting validation**
  - **Depends on:** None.
  - **Corrective rationale:** The committed executor instruction fails the repository's required Prettier check, preventing `yarn validate` from running.
  - **Implement:** Apply the repository formatter to `.opencode/agents/redesign-executor.md` without changing its instructions.
  - **Verify locally:** The instruction file passes `prettier --check` and full `yarn validate` passes.
  - **Out of scope:** Do not change executor behavior or other documentation.

- [x] **T46 — Extract the existing refinement workflow**
  - **Depends on:** T43–T45.
  - **Implement:** Extract the existing refinement operation from the legacy polling implementation into a reusable, independently callable component. Preserve the existing Trello refinement result contract, classification changes, description updates, Backlog transition, notifications, worktree safety, and failure handling.
  - **Verify locally:** Existing refinement characterization tests pass against the extracted implementation. Add tests for successful refinement, malformed output, failed execution, and interrupted cleanup.
  - **Out of scope:** Do not change refinement behavior, integrate scheduling, or remove the legacy implementation pipeline yet.

- [x] **T47 — Integrate refinement into unified task scheduling**
  - **Depends on:** T46.
  - **Implement:** Route eligible Refinement-labelled Ready cards through the extracted refinement component using the unified project scheduler. Preserve Ready-list order, label precedence, exclusive mutation ownership, and restart safety. Refinement must return cards to Backlog without creating implementation PRs.
  - **Verify locally:** Production-polling tests cover refinement and implementation cards in both Ready-list orders, successful refinement, failures, interrupted operations, and absence of concurrent project mutations.
  - **Out of scope:** Do not modify implementation planning or the PR lifecycle.

- [x] **T48 — Observe merged and closed task-session PRs**
  - **Depends on:** T43C, T45.
  - **Implement:** Extend task-session PR observation to explicitly recognize authoritative MERGED and CLOSED states instead of rejecting every non-OPEN PR. Verify PR identity, ownership, and relevant terminal metadata. Distinguish merged PRs from deliberately closed, unmerged PRs.
  - **Verify locally:** Mock GitHub tests cover OPEN, MERGED, CLOSED, missing PRs, incorrect ownership, stale identities, and temporary GitHub errors. Terminal observations must not depend on successful CI checks.
  - **Out of scope:** Do not move Trello cards or clean up branches yet.

- [x] **T49 — Reconcile terminal PRs in the unified workflow**
  - **Depends on:** T48.
  - **Implement:** Connect terminal PR observations to production polling. Move merged PR cards to Done and deliberately closed, unmerged PR cards to Backlog, preserving existing completion metadata, notifications, and safe cleanup behavior. Persist enough state to recover interrupted transitions without duplicate side effects.
  - **Verify locally:** Production-polling tests cover merge-to-Done, close-to-Backlog, repeated polling, restart between external operations, already-deleted branches, and cleanup failures. Uncertain states must preserve recovery information.
  - **Out of scope:** Do not change human feedback, CI remediation, or automatic merge policies.

## Phase H — Consolidate execution architecture

- [x] **T50A — Retire direct tests for removed legacy polling dispatch**
  - **Depends on:** None; required to validate the T50 dispatch cutover.
  - **Corrective rationale:** Direct legacy polling characterization tests exercise a retired implementation path and now fail against the unified production route; task-session production scenarios remain covered by task-session dispatch and lifecycle tests.
  - **Implement:** Remove only the obsolete direct legacy polling test files; retain tests for shared Git, publication, recovery, refinement, and task-session production behavior.
  - **Verify locally:** Full `yarn validate` passes and task-session production integration tests still exercise `pollProject`.
  - **Out of scope:** Do not remove production modules or weaken task-session lifecycle coverage.

- [x] **T50 — Make task-session the only execution mode**
  - **Depends on:** T47, T49.
  - **Implement:** Remove `projects[].executionMode` from the configuration schema and eliminate the legacy/task-session dispatch selection. Route all eligible implementation work through the unified task-session coordinator. Preserve the integrated refinement operation and existing external safety boundaries.
  - **Verify locally:** Configuration and production-polling tests prove omitted executionMode works, obsolete executionMode values are rejected, implementation uses the persistent primary session, and refinement remains functional.
  - **Out of scope:** Do not delete unused legacy modules or change CI configuration yet.

- [x] **T51 — Remove obsolete legacy orchestration**
  - **Depends on:** T50.
  - **Implement:** Identify and delete implementation/review/remediation orchestration functions reachable only from the retired legacy execution path. Remove obsolete dispatch branches and corresponding legacy-only characterization tests. Preserve shared publication, reconciliation, refinement, and recovery components still used by the unified workflow.
  - **Verify locally:** The production call graph contains one implementation pipeline. Tests prove no obsolete dispatch is reachable, and the unified implementation, refinement, and PR lifecycle remain operational.
  - **Out of scope:** Do not delete shared utilities or unrelated compatibility code.

- [x] **T52 — Remove unused legacy prompts and state artifacts**
  - **Depends on:** T51.
  - **Implement:** Audit prompts, configuration fields, persisted-state helpers, imports, and tests associated exclusively with the removed legacy implementation. Delete code that has no remaining legitimate runtime caller. Retain shared commit, publication, conflict, notification, and safety functionality where required.
  - **Verify locally:** No dangling imports, references, or orphaned production helpers remain. Tests and production build pass. Existing shared safety behavior remains covered.
  - **Out of scope:** Do not redesign the unified task state or remove safety mechanisms merely because they originated in the legacy architecture.

- [x] **T52A — Remove obsolete Human Review maintenance conflict state**
  - **Depends on:** T52.
  - **Corrective rationale:** After T51 removed automatic Human Review branch maintenance, prepared-conflict recovery still accepted a `human-review-maintenance` origin and retained its dedicated maintenance-state store, temporary cleanup path, and force-with-lease branch.
  - **Implement:** Restrict prepared-conflict handoffs to the unified initial-publication lifecycle, remove the unused maintenance-state flow and store, and retain initial publication conflict remediation and its trusted-commit/worktree safety checks.
  - **Verify locally:** Prepared-conflict tests prove initial-publication recovery remains safe and unsupported legacy origins fail closed; no production import or temporary-file cleanup path references review-maintenance state.
  - **Out of scope:** Do not remove prepared-conflict safety, trusted commits, exact lease checks used by other supported operations, or the task-session conflict recovery path.

## Phase I — Automatic CI check management

- [x] **T53 — Define authoritative CI check expectations**
  - **Depends on:** T29, T50.
  - **Implement:** Replace the manual requiredChecks contract with a deterministic policy for establishing expected CI checks. Prefer available authoritative GitHub repository rules and reliable repository-owned CI workflow expectations. Define how dynamically generated, conditional, and external checks are handled. Distinguish a complete expected set from an unknown or incomplete set.
  - **Verify locally:** Pure policy tests cover authoritative expectations, missing information, duplicate check names, dynamic check uncertainty, empty expectations, and unsupported sources. Unknown expectations must never produce a passing result.
  - **Out of scope:** Do not fetch GitHub data or change polling yet. Do not introduce paid-feature requirements.

- [x] **T54 — Collect all applicable GitHub check results**
  - **Depends on:** T53.
  - **Implement:** Extend GitHubClient to gather relevant current-head check runs and commit statuses with pagination and exact commit identity. Collect available authoritative expectation information needed by T53. Normalize observations into one structured result, preserving check identity, status, conclusion, and diagnostic references.
  - **Verify locally:** Mock API tests cover multiple check suites, commit statuses, pagination, queued and in-progress checks, terminal failures, cancellation, skipped and neutral conclusions, duplicates, missing checks, and stale commit responses.
  - **Out of scope:** Do not trigger repairs or make merge decisions.

- [x] **T55 — Implement complete CI-result evaluation**
  - **Depends on:** T53–T54.
  - **Implement:** Create a deterministic gate that evaluates the complete expected check set against the current PR head. Return distinct outcomes for waiting, passed, failed, and uncertain. A failed result requires that the expected check set is complete and every expected check has reached a terminal state. Collect all failures together. Treat missing expected checks as waiting or uncertain, never successful.
  - **Verify locally:** Table-driven tests cover delayed check creation, one passing check while another has not started, mixed pending and failed checks, several simultaneous failures, cancellations, skipped or neutral results, changed heads, and empty expectations. No incomplete set may pass or trigger premature remediation.
  - **Out of scope:** Do not invoke OpenCode or alter PRs.

- [x] **T56 — Integrate complete CI evaluation into production**
  - **Depends on:** T55.
  - **Implement:** Replace existing requiredChecks-based decisions in production polling, CI remediation, feedback reply publication, and auto-merge readiness with the complete CI-result evaluation. Remove mandatory requiredChecks configuration. Pending or uncertain results must retain a waiting state without consuming repair attempts. Complete failing results must produce one bounded repair operation containing all relevant failures.
  - **Verify locally:** Production-polling tests show waiting while checks are pending, repair after complete failure, same-session corrections, successful rechecking after publication, correct feedback reply gating, and no auto-merge before full success.
  - **Out of scope:** Do not remove validationCommand, coverageCommand, retry limits, or current-head ownership checks.

- [x] **T56A — Defer task-session auto-merge until complete CI passes**
  - **Depends on:** T56.
  - **Corrective rationale:** The shared publication helper still auto-merged immediately for `autoMerge: true`, before the task-session workflow had collected complete current-head CI evidence.
  - **Implement:** Defer task-session publication's auto-merge; move the card to the monitoring state without completion claims, then let the unified evaluator authorize the merge only after complete current-head CI and local evidence pass.
  - **Verify locally:** Publication tests prove no early merge, and production task-session polling continues to block auto-merge for waiting, failed, or uncertain CI evidence.
  - **Out of scope:** Do not change legacy behavior or bypass the complete CI evaluator.

- [x] **T56B — Clear transient CI observations on task completion**
  - **Depends on:** T56.
  - **Corrective rationale:** The production auto-merge path persisted a `done` record with a `reviewObservation`, which the task-record schema correctly rejects outside the active CI/Human Review phases.
  - **Implement:** Clear the transient review observation when recording `ci-passed-completed`; preserve the authoritative PR and quality evidence.
  - **Verify locally:** A production-polling regression proves successful complete-CI auto-merge records `done`, moves the card to Done, and does not call merge while CI is waiting.
  - **Out of scope:** Do not weaken terminal-record validation or change unrelated task transitions.

- [x] **T57 — Add comprehensive CI lifecycle regression tests**
  - **Depends on:** T56.
  - **Implement:** Extend mocked end-to-end scenarios through the actual pollProject entry point. Simulate delayed check registration, several GitHub Actions jobs, mixed check runs and commit statuses, multiple failed jobs, late results, CI repairs, head changes, and successful auto-merge.
  - **Verify locally:** Every scenario verifies complete-check semantics, preserved task ownership, no duplicate repairs, no stale-head acceptance, no premature success, and no skipped validation or review gates.
  - **Out of scope:** Do not call live GitHub APIs or change production architecture.

## Phase J — Final consolidation and cleanup

- [x] **T58 — Consolidate configuration and permanent documentation**
  - **Depends on:** T50–T57.
  - **Implement:** Update README, config.example.yaml, docs/configuration.md, docs/workflow.md, docs/recovery.md, and docs/operations.md to describe the single supported architecture. Remove obsolete executionMode, requiredChecks, opt-in rollout, and legacy migration instructions. Document refinement, CI expectation discovery, unknown-check behavior, terminal PR handling, and operator recovery.
  - **Verify locally:** Configuration examples parse successfully, documented defaults match code, no unsupported legacy settings remain, and yarn validate passes.
  - **Out of scope:** Do not delete the temporary redesign documents or executor agent yet.

- [ ] **T59 — Perform final unified lifecycle acceptance audit**
  - **Depends on:** T46–T58.
  - **Implement:** Audit actual production entry points and integration tests for refinement, implementation, session continuity, validation, coverage, independent review, publication, complete CI observation and repair, human feedback, contextual replies, merged/closed PR reconciliation, auto-merge, and restart recovery. Correct any confirmed blocking defect through a narrowly scoped corrective task before completing this audit.
  - **Verify locally:** Run the full yarn validate and yarn build. Verify the intended production call paths are reachable, no dead legacy execution path remains, relevant mocked lifecycle scenarios pass, and no known blocking acceptance gap remains.
  - **Out of scope:** Do not use real Trello, GitHub, OpenCode services, or deploy.

- [ ] **T60 — Remove temporary redesign execution artifacts**
  - **Depends on:** T59.
  - **Implement:** After all previous tasks and the final audit are complete, remove docs/redesign/REQUIREMENTS.md, docs/redesign/TASKS.md, and .opencode/agents/redesign-executor.md from the repository. Preserve the permanent documentation produced by T58.
  - **Verify locally:** Confirm all earlier tasks are completed before deletion. Run yarn validate and yarn build after deletion, verify that no surviving documentation references the deleted files, and create one final local cleanup commit.
  - **Special completion rule:** Because TASKS.md is deleted by this task, T60 completion is represented by the validated deletion commit rather than a committed checkbox change.
  - **Out of scope:** Do not remove AGENTS.md, unrelated OpenCode agents, permanent documentation, or any production functionality.

## Final completion checkpoint

The backlog contains T01–T60 plus T43A, T43B, and T43C.

T46–T60 implement the maintainer-approved final clean-cutover
requirements and supersede earlier legacy-compatibility decisions
where they conflict.

Before T60:

- Every preceding task must be completed and verified.
- All known blocking defects must be corrected.
- The unified production lifecycle must have passing mocked
  integration tests.
- `yarn validate` and `yarn build` must pass.
- The temporary redesign documents and executor must remain
  available until the final cleanup task begins.

T60 is the final operation. Its completion is recorded by
the validated local commit deleting the temporary execution
artifacts, not by a checkbox in a surviving task document.

After T60:

- The Git worktree must be clean.
- No obsolete dual-mode execution configuration may remain.
- No retired legacy implementation path may remain reachable.
- Permanent documentation must describe the actual architecture.
- No live pilot or deployment is claimed to have occurred.

Do not require reading deleted execution documents after T60.
Do not create additional implementation tasks after the final
cleanup commit. If a blocking defect is discovered before cleanup,
correct it before beginning T60.

Remote push, PR creation, merging, and deployment remain outside
the executor's authority.
