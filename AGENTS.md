# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Intent

This repository implements a deterministic orchestration service around Trello, Git, OpenCode, and GitHub.

The orchestrator owns workflow and execution mechanics.

OpenCode owns software-engineering reasoning.

Do not move engineering judgment into the orchestrator unless the behavior can be expressed as an explicit deterministic rule.

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

- Only one task may be active.
- Never modify the configured source checkout.
- Never start a task unless its Trello card is in `Ready for Agent`.
- Never merge a pull request.
- Never force-push.
- Never delete an unknown worktree.
- Never automatically discard agent changes after failure.
- Never start the next task while the current task has ambiguous state.
- A failed external operation must not silently advance workflow state.

Changes that weaken these invariants require explicit justification.

## Development Rules

- Keep changes scoped to the requested task.
- Prefer simple deterministic code over framework-heavy abstractions.
- Avoid adding configuration for functionality that does not yet exist.
- Keep secrets out of configuration files and source control.
- Add tests for deterministic behavior and boundary conditions.
- Preserve useful failure state instead of aggressively cleaning it up.
- Do not introduce automatic retry loops without explicit bounded behavior.

## TypeScript

- Use strict TypeScript.
- Prefer explicit domain types at external boundaries.
- Do not use `any` unless unavoidable and justified.
- Validate untrusted external input.
- Keep parsing and validation testable independently from filesystem or network access where practical.

## Validation

Before finishing a change, run:

```bash
yarn validate
```

The repository is not considered valid unless this command succeeds.

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

## Git

Do not commit, push, create pull requests, merge, force-push, or rewrite history unless the task explicitly authorizes it.

Generated worktrees must never reuse the user's normal source checkout.
