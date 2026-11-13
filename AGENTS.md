# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Intent

This repository implements a deterministic orchestration service around Trello, Git, OpenCode, and
GitHub.

The orchestrator owns workflow and execution mechanics.

OpenCode owns software-engineering reasoning.

Do not move engineering judgment into the orchestrator unless the behavior can be expressed as an
explicit deterministic rule.

## Architecture

Prefer concrete components over speculative abstractions.

Expected components include:

- `TrelloClient`
- `GitRepository`
- `WorktreeManager`
- `OpenCodeRunner`
- `RunStore`
- `Orchestrator`

Do not introduce generic provider abstractions such as:

- `AgentProvider`
- `TaskProvider`
- `SCMProvider`
- `WorkflowPlugin`
- `ExecutionEngine`

unless multiple real implementations require them.

## Safety Invariants

The following are architectural invariants:

- Only one task may be active per project.
- Independent projects may process tasks concurrently.
- Never modify the configured source checkout.
- Never start a task unless its Trello card is in `Ready for Agent`.
- Never merge a pull request.
- Never force-push.
- Never delete an unknown worktree.
- Never automatically discard agent changes after failure.
- Never start another task for a project while that project's current task has ambiguous state.
- A failed external operation must not silently advance workflow state.

Changes that weaken these invariants require explicit justification.

## Development Rules

### Specification compliance

- `docs/requirements.md` is authoritative; `docs/specification.md` defines verifiable criteria.
- For specification-governed implementation, review, or refactoring, load the shared
  `spec-compliance` skill in `.agents/skills/spec-compliance/SKILL.md` before changing behavior.
- Identify applicable requirement IDs and acceptance criteria, trace production paths, and report
  verification gaps or document conflicts explicitly. Never silently change requirements to fit
  code.
- For requested full, scoped, or Git-diff audits, load `.agents/skills/spec-audit/SKILL.md`. Audits
  are read-only except retained reports in `.local/spec-audits/`; findings need separate
  implementation authorization. See `docs/specification-auditing.md` for invocation and recovery.

- Keep changes scoped to the requested task.
- Prefer simple deterministic code over framework-heavy abstractions.
- Avoid adding configuration for functionality that does not yet exist.
- Never implement Trello or GitHub functionality that requires a paid plan, subscription, or paid
  tier. Tasks depending on paid-only functionality must not be implemented under this repository's
  guidance; ordinary non-paid integrations remain permitted.
- Keep secrets out of configuration files and source control.
- Add tests for deterministic behavior and boundary conditions.
- Preserve useful failure state instead of aggressively cleaning it up.
- Do not introduce automatic retry loops without explicit bounded behavior.

## TypeScript

- Use strict TypeScript.
- Prefer explicit domain types at external boundaries.
- Do not use `any` unless unavoidable and justified.
- Validate untrusted external input.
- Keep parsing and validation testable independently from filesystem or network access where
  practical.

## Validation

Before finishing a change, run:

```bash
yarn validate
```

The repository is not considered valid unless this command succeeds.

Run focused checks during development and full validation on the final integrated change. Report the
command and result briefly. Reuse a successful full run for the same tree; rerun after changes,
failures, or a concrete unresolved concern. Never claim an unexecuted check passed.

For automatically fixable linting or formatting issues:

```bash
yarn lint:fix
```

## Tests

Use Vitest.

Tests should cover:

- successful behavior;
- validation failures;
- malformed external input;
- state-transition edge cases;
- failure behavior around external tools.

Do not rely on live Trello, GitHub, or OpenCode services in unit tests.

Run ordinary `yarn test`; do not require caller-supplied temporary-directory variables or add
task-specific test commands/scripts. Vitest owns a private run directory and removes it on teardown.
Release owned child processes in fixture cleanup and do not retain test repositories/artifact trees
by default. Name and maintain regression tests by product behavior.

## Git

Do not commit, push, create pull requests, merge, force-push, or rewrite history unless the task
explicitly authorizes it.

Generated worktrees must never reuse the user's normal source checkout.
