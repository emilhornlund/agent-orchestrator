# Agent Orchestrator — Task-Session Architecture Redesign

## 1. Purpose

Build an opt-in, restart-safe task-session execution mode for Agent Orchestrator that
keeps one primary OpenCode conversation attached to each engineering task across
implementation, local repairs, pull-request CI repairs, and human review feedback.
The orchestrator remains the authority for workflow transitions, Git/GitHub/Trello
side effects, and quality evidence.

This document describes the **target architecture**, not the current implementation.
`TASKS.md` is the authoritative, ordered implementation backlog. The custom
`redesign-executor` agent implements one backlog item at a time.

## 2. User problem and desired outcome

The existing workflow invokes separate OpenCode sessions for implementation,
review, remediation, commit messages, and pull-request descriptions. It asks
coding agents to run configured validation but does not independently execute
and verify that command. Human-review remediation often loses continuity with
the original task, and failing pull-request checks are not an independent
repair event in the current lifecycle.

The target system must:

1. Preserve the original task, implementation plan, and acceptance criteria.
2. Reuse one **primary** OpenCode session for engineering work on a task.
3. Use **independent** review sessions to evaluate completeness and correctness.
4. Enforce local validation, optional coverage, and independent review as gates.
5. Detect required GitHub CI failures against the _current_ PR head and repair
   them through the primary session.
6. Capture and track all relevant human PR feedback, verify corrections, and
   reply in the correct conversation context.
7. Resume safely across process restarts without guessing external state.
8. Allow several waiting PRs while serializing repository-changing work.

## 3. Non-negotiable design principles

### 3.1 Deterministic orchestration; agent-owned engineering reasoning

- OpenCode decides _how_ to change source code and tests.
- The orchestrator decides _when_ an operation may run, which task/session it
  belongs to, whether observable checks passed, and whether Git, GitHub, or
  Trello may be updated.
- A successful agent process exit is not evidence of passing tests, coverage,
  addressed feedback, or completed requirements.
- Do not build a generic provider framework, replace existing clients, or add
  speculative abstraction layers. Reuse current components.

### 3.2 Existing safety constraints remain in force

- Never modify the configured source checkout as an agent worktree.
- Keep task work in owned, isolated worktrees and branches.
- Retain the existing safe Git identity, commit, signing, publishing, and
  reconciliation controls.
- Never force-push, delete unknown worktrees, or silently discard changes.
- Preserve recoverable state on ambiguity and stop unsafe transitions.
- Do not merge automatically unless `autoMerge` is explicitly enabled, and
  never bypass required gates for that mode.
- Default to the **legacy** workflow until the new mode is complete and enabled.
- Existing active tasks are never automatically migrated to the new mode.
- No new dependency may require a paid Trello or GitHub plan.

### 3.3 One primary task session, not one endless process

- Persist the _explicit_ OpenCode session ID for each project/card pair.
- Later engineering prompts resume that exact session; never infer it from
  `--continue`, a log filename, or whichever session happened to run last.
- The process may stop between prompts or during a long human-review wait.
- A missing or inaccessible session requires an explicit recovery decision;
  never silently substitute another task's session.
- Independent reviewers **must not** use the primary implementation session.
- Persist essential facts outside the conversation so context compaction or
  loss does not become loss of workflow state.

### 3.4 Evidence-based completion

- Plan: each explicit task requirement has a stable identifier and proposed
  verification method.
- Implementation: each requirement is associated with code/test evidence or
  an explicit unresolved disposition.
- Validation: the orchestrator runs the configured command, captures an exit
  code and bounded diagnostic, and ties results to exact source content.
- Coverage: the optional repository-owned coverage command enforces its own
  thresholds; the orchestrator does not invent global metrics.
- Review: an independent session evaluates _task completeness_ as well as
  serious correctness problems and produces a validated structured result.
- Publication: no push or PR update based on changes until required local
  checks and the final review pass on the exact relevant content.
- CI: required checks must succeed on the current PR head; pending, missing,
  inconclusive, or stale checks cannot be interpreted as passing.
- Human feedback: each actionable item remains tracked until addressed and
  independently verified, or explicitly escalated to a human.

### 3.5 Bounded repairs and truthful reporting

- All automated repair loops have persisted, finite attempt limits.
- After the last repair, the system **re-runs** the relevant checks/review.
- Never publish a claim that a requested change was fixed before the relevant
  commit has been published and its required checks passed.
- Do not automatically approve PRs, dismiss a review, or resolve someone else's
  GitHub discussion thread.
- Present missing evidence, unknown states, and exhaustion as attention needed.

## 4. Expected lifecycle

```text
Trello Ready
  -> claim + owned worktree
  -> create or resume primary task session
  -> structured plan -> independent plan verification
  -> implementation
  -> local validation + optional coverage -> bounded repairs
  -> independent completeness/correctness review -> bounded repairs
  -> final local gates -> trusted commit + PR publication
  -> collect exact-head required GitHub CI results
       -> failed: diagnostics -> same primary session -> local gates ->
          independent review -> update same PR -> recheck CI
  -> Human Review (when autoMerge is off)
       -> new actionable feedback: durable ledger -> same primary session ->
          verification -> local gates -> update same PR -> CI -> contextual reply
  -> merged PR -> Done

Any ambiguity or exhausted bounded repair -> Attention Required (preserve state).
```

This is a conceptual flow, not permission to modify an existing state machine
outside the individual implementation task.

## 5. Target components and contracts

### Task record

A versioned per-task record persisted outside source repositories/worktrees.
Minimum fields: project/card IDs; phase; primary session ID; expected branch;
PR identity/current head where known; record revision; operation identity;
retry counters; timestamps. Mutations must be atomic and reject stale writes.

### Plan and requirement ledger

Structured, validated requirements and implementation steps with stable IDs.
The plan must be traceable to the Trello task (including any attachment context)
and reviewed separately before implementation begins. No plan means no code stage.

### Local quality evidence

For `task-session` mode, `repository.validationCommand` is mandatory.
The validation runner captures execution state, exact worktree content identity,
exit code, timestamps, and bounded/redacted output. Evidence is invalidated by
any relevant implementation change, amend, rebase, or feedback remediation.
Coverage is optional only when unconfigured; a configured coverage command
becomes mandatory.

### Structured review result

A schema-validated independent review that reports one result for each required
acceptance criterion and concrete blocking findings. Review is advisory on
minor style matters but blocking on unsatisfied requested requirements,
reproducible serious defects, and violated repository contracts. Never
claim the review passed because the review agent exited zero.

### CI check observation

For `task-session` mode, require an explicitly configured, nonempty list of
unique GitHub required check names (`repository.requiredChecks`). Collect their
conclusions, diagnostics, and observed commit SHA. Treat pending/missing/
incomplete responses as _not ready_, not failures that the coding agent can
necessarily fix. Failed checks launch a bounded repair cycle. A new PR head
invalidates the earlier result.

### Human feedback ledger

Keep stable GitHub review, thread, and comment IDs with author, timestamp,
location/diff context, PR head, actionable status, verification evidence,
remediation commit, and reply identity. Treat general conversation comments as
potential discussion, not automatically as code-change requests. New feedback
never makes earlier still-applicable feedback disappear. Do not claim reviewer
approval or resolve threads on their behalf.

### Scheduling and recovery

Separate read-only monitoring of all owned waiting PRs from exclusive
repository-mutating execution per project. Check authoritative Git, GitHub,
Trello, persisted records, and session ownership on recovery. Fail closed on
ambiguous identity or unexpected external state; do not guess or erase work.

## 6. Repository-local development constraint

**Every backlog task must be completable in a normal local clone using the
existing source code and development dependencies.** The implementation may
add code that calls Trello or GitHub in production, but its verification must
use local fixtures, mocked clients, and existing Vitest infrastructure.

Allowed for implementing tasks:

- Local reading/editing of repository source, tests, configuration examples,
  and documentation.
- Local unit tests and mocked integration tests.
- `yarn validate`, focused local test commands, `yarn build`, Git status/diff,
  and local commits.
- Native project-local OpenCode skills already present in the checkout.

Not prerequisites for completing any backlog task:

- Trello access, real PRs or reviews, GitHub Actions runs, network/API calls,
  GitHub tokens or GitHub CLI authentication.
- A deployed orchestrator, running Docker services, Redis, MongoDB, SMTP,
  external databases, or a live OpenCode server _inside tests_.
- New subscriptions or infrastructure.
- Pushing branches, opening/merging pull requests, or deploying code.

Do **not** add local tests that depend on actual AI model output. Mock the
OpenCode process boundary and verify commands, prompts, parsed output, and
lifecycle effects deterministically. A later, separate real-world pilot may
be conducted manually after the full backlog is finished.

## 7. Scope and implementation strategy

- Execute `TASKS.md` strictly in task ID order.
- One focused production concern per item; write tests for that concern.
- All new behavior remains dormant behind `executionMode: task-session` until
  the final enablement task. Legacy behavior remains the default throughout.
- Do not silently widen a task to fix unrelated technical debt.
- When current code differs from the examples here, preserve the contract and
  follow actual existing repository conventions; do not pretend that a named
  helper exists if it does not.
- Any needed prerequisite outside the current task is a blocker: stop and
  report it instead of skipping ahead or inventing an undocumented design.

## 8. Completion definition

The redesign is complete only when:

- Every task in `TASKS.md` is checked and committed individually.
- Each task commit was made after a passing `yarn validate` run.
- Legacy configuration and tests remain compatible.
- The new mode is configurable, locally testable, and disabled by default.
- Full mocked lifecycle tests cover implementation, failed validation,
  coverage failures, independent reviews, failed CI, repeated human feedback,
  process restarts, and multiple waiting PRs.
- The project documents activation, limitations, recovery, and the distinction
  between **locally verified implementation** and **unperformed live pilot**.

## 9. Agent handoff and commit rules

The project's `.opencode/agents/redesign-executor.md` is the canonical local
executor instruction. The task list records completion with a single `[x]`
checkbox per task. Commit the checkbox change **with the implementation**.
The executor must never mark a task complete after failing validation or before
its implementation and acceptance criteria are actually satisfied. Do not
retroactively check tasks that were not verified.

Local commits are explicitly authorized for this migration task series.
Remote pushes, PR creation, merging, and deployments are **not** authorized.
Use the repository's Conventional Commit format; do not add AI attribution.
