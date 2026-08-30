[![CI](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emilhornlund/agent-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](CONTRIBUTING.md#development-setup)

# Agent Orchestrator

Agent Orchestrator is a local automation service that turns Trello cards into reviewed GitHub pull requests using
OpenCode.

It coordinates Trello, Git worktrees, OpenCode, and GitHub into a controlled software-engineering workflow while keeping
human approval at the merge boundary.

## How it works

Each configured project connects:

- a local Git repository;
- a GitHub repository;
- a Trello board;
- an OpenCode model and runtime configuration.

The orchestrator continuously polls each project and routes cards in `Ready for Agent` according to their configured
workflow labels.

Cards carrying the configured `Refinement` label enter the refinement workflow. Refinement takes precedence even when
the card also carries a `Feature`, `Improvement`, or `Bug` label.

Cards without `Refinement` enter the implementation workflow when they carry at least one configured `Feature`,
`Improvement`, or `Bug` label:

```text
Ready for Agent + Refinement
      │
      ▼
    Working
      │
      ├─ create isolated Git worktree
      ├─ run OpenCode refinement
      ├─ validate the structured refinement result
      ├─ reject unauthorized repository changes
      ├─ update the Trello card title and description
      ├─ replace Refinement with exactly one of Feature / Improvement / Bug
      ├─ clean up the refinement worktree
      │
      ▼
    Backlog
```

Successful refinement returns the card to the top of `Backlog`. It must be explicitly moved back to `Ready for Agent`
before implementation begins.

The normal implementation workflow is:

```text
Ready for Agent
      │
      ▼
    Working
      │
      ├─ create isolated Git worktree
      ├─ run optional repository setup
      ├─ run OpenCode implementation
      ├─ agents run optional repository validation
      ├─ run independent OpenCode review
      ├─ remediate review findings when necessary
      └─ commit, push, and create pull request
      │
      ▼
 Human Review
      │
      ├─ merged ───────────────► Done
      │
      ├─ changes requested ────► Working
      │                          │
      │                          └─ remediate, review, and update PR
      │
      └─ closed without merge ─► Failed
```

Failures during automated processing move the card to `Failed` rather than silently advancing the workflow.

## Key properties

### Isolated execution

Agent work runs in dedicated Git worktrees and task branches. The configured source checkout is not used as the agent's
working directory.

Branches follow the convention:

```text
agent/<trello-card-id>
```

### Human-controlled merges

The orchestrator creates and updates pull requests, but it does not merge them.

A card reaches `Done` only after the corresponding pull request has been merged on GitHub.

### Independent implementation and review

Implementation, review, remediation, and commit creation use separate OpenCode sessions.

The review phase evaluates the completed change independently before the branch is published.

### Pull request feedback loop

When GitHub reports requested changes, the orchestrator moves the Trello card back to `Working`, creates a worktree from
the existing task branch, supplies the review feedback to OpenCode, and republishes the updated branch.

### Recovery and reconciliation

The orchestrator reconciles Trello state with Git and GitHub on every polling cycle. This allows it to recover from
interrupted runs and handle already-existing branches or pull requests without blindly recreating workflow state.

When a card is moved from `Failed` back to `Ready for Agent`, the orchestrator reuses the card's existing worktree and
`agent/<trello-card-id>` branch when both are still valid. A clean branch with tracked changes relative to
`origin/<defaultBranch>` is treated as committed implementation work. The retry skips setup, implementation, review,
remediation, and commit, then resumes publication. It uses a normal non-force push when the remote branch is missing or
does not yet point at that commit, checks for an existing open pull request, and creates one only when needed.

An existing worktree or branch alone is not proof that implementation is complete. A branch at its base, a branch with no
tracked committed changes, or a dirty worktree follows the normal implementation path; uncommitted work is preserved for
OpenCode to inspect. If an open pull request already exists, the card is reconciled directly to `Human Review` without
rerunning implementation or creating a duplicate pull request. Publication or Trello failures leave the card in its
failure/reconciliation state instead of advancing it silently.

Each project also uses a Trello text custom field as its workflow ownership marker. Create the field on the project board,
then set its ID as `ownershipCustomFieldId`. The orchestrator writes this exact JSON shape when it claims a card:

```json
{
  "version": 1,
  "owner": "agent-orchestrator",
  "projectId": "my-project",
  "cardId": "trello-card-id",
  "workflow": "implementation"
}
```

The `workflow` value is either `implementation` or `refinement`. Only a card with a valid marker for the current project,
card, and workflow is considered owned in `Working` or `Human Review`. Cards in those lists without a valid marker are
corrected to `Backlog`, without inspecting or changing Git, GitHub, or pull requests, and receive a Trello explanation.
Malformed, conflicting, stale, or mismatched markers are never used to start work.

The marker is written before a claimed card moves to `Working`. For terminal or corrective transitions, the card moves to
`Backlog`, `Failed`, or `Done` before the marker is cleared, so a failed destination move leaves the active card owned and
recoverable. If the destination move succeeds but clearing the ownership marker fails, the orchestrator attempts to restore
the card to its previous active or reconcilable list rather than leaving a valid ownership marker in a terminal or neutral
state. If that rollback also fails, both failures are reported and the ambiguous Trello state requires manual inspection.
A marker write, clear, or list transition failure does not count as a successful workflow transition. If a card is left in
`Working` or `Human Review` after such a failure, inspect its existing worktree, branch, pull request, and session log before
retrying. To retry deliberately, move the card to `Ready for Agent`; cards in `Backlog`, `Failed`, and `Done` are not
automatically processed.

### Multi-project operation

Multiple projects can be configured in a single `config.yaml`. Each project is polled independently with its own
repository, Trello board, worktree root, and OpenCode configuration.

## Requirements

- Node.js 24 or later
- Yarn Classic 1.x
- Git
- GitHub CLI (`gh`)
- OpenCode
- Trello API credentials

The GitHub CLI must already be authenticated for the repositories the orchestrator manages.

## Setup

Install dependencies:

```bash
yarn install
```

Create the local configuration files:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Add your Trello credentials to `.env`:

```dotenv
TRELLO_API_KEY=
TRELLO_TOKEN=
```

Then configure one or more projects in `config.yaml`:

```yaml
projects:
  - id: "my-project"

    trello:
      boardId: "board-id"
      ownershipCustomFieldId: "agent-orchestrator-ownership-custom-field-id"
      backlogListId: "backlog-list-id"
      readyListId: "ready-list-id"
      workingListId: "working-list-id"
      reviewListId: "review-list-id"
      failedListId: "failed-list-id"
      doneListId: "done-list-id"
      refinementLabelId: "refinement-label-id"
      featureLabelId: "feature-label-id"
      improvementLabelId: "improvement-label-id"
      bugLabelId: "bug-label-id"

    repository:
      path: "/absolute/path/to/repository"
      github: "owner/repository"
      defaultBranch: "main"
      worktreeRoot: "/absolute/path/to/worktrees/repository"
      setupCommand: "yarn install"
      validationCommand: "yarn validate"
      gitIdentity:
        name: "Agent Orchestrator"
        email: "agent-orchestrator@users.noreply.github.com"
        signingKey: "/absolute/path/to/signing-key"

    opencode:
      timeoutMinutes: 360
      refinement:
        model: "your-refinement-model"
        variant: "xhigh"
      implementation:
        model: "openai/implementation-model"
        variant: "xhigh"
      review:
        model: "openai/review-model"
        variant: "high"
      remediation:
        model: "openai/remediation-model"
        variant: "xhigh"
      commit:
        model: "openai/commit-model"
        variant: "low"

workflow:
  pollIntervalSeconds: 15
```

`setupCommand` and `validationCommand` are optional. When configured, `setupCommand` runs in the card worktree before
the OpenCode implementation session. `validationCommand` is passed to OpenCode sessions that modify implementation
files, and those agents run it before finishing and fix failures caused by their changes. The orchestrator does not
execute the validation command itself.

`config.yaml` and `.env` are local files and are intentionally excluded from version control.

## Trello board

Each project requires six configured workflow lists:

| List              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `Backlog`         | Tasks that are not currently queued for automated processing  |
| `Ready for Agent` | Tasks waiting to be claimed                                   |
| `Working`         | Tasks currently under automated implementation or remediation |
| `Human Review`    | Tasks with a published pull request awaiting human review     |
| `Failed`          | Tasks that could not complete the automated workflow          |
| `Done`            | Tasks whose pull requests have been merged                    |

Each project also requires four configured workflow labels:

| Label         | Purpose                                                |
| ------------- | ------------------------------------------------------ |
| `Refinement`  | Marks a task for refinement rather than implementation |
| `Feature`     | Classifies the card as feature implementation work     |
| `Improvement` | Classifies the card as improvement implementation work |
| `Bug`         | Classifies the card as bug-fix implementation work     |

The configured list and label names themselves are not significant; the orchestrator uses their Trello IDs.

For normal implementation, a card in `Ready for Agent` must have at least one of the configured `Feature`,
`Improvement`, or `Bug` labels. Unlabelled cards are ignored.

The configured `Refinement` label takes precedence over implementation labels. A card carrying `Refinement` is routed
through the refinement workflow even if it also carries `Feature`, `Improvement`, or `Bug`.

During refinement, OpenCode may inspect repository code, tests, documentation, and architecture, but it must not modify
repository implementation files. Its only permitted write is the dedicated structured refinement result artifact.

The orchestrator validates that result, updates the Trello card title and description, removes conflicting semantic
classification labels, applies exactly one of `Feature`, `Improvement`, or `Bug`, removes `Refinement`, and moves the
card to the top of `Backlog`.

If refinement fails, produces an invalid result, or modifies unauthorized repository files, the card moves to `Failed`.

## Running

Start the orchestrator:

```bash
yarn dev
```

The process continues polling until it is stopped.

## Development

Run the complete validation suite:

```bash
yarn validate
```

Individual commands are also available:

```bash
yarn lint
yarn typecheck
yarn test
yarn format:check
```

Apply automatic lint fixes:

```bash
yarn lint:fix
```

Format the repository:

```bash
yarn format
```

## Continuous integration

GitHub Actions validates every pull request targeting `main` and every push to `main`.

CI verifies:

- formatting;
- linting;
- TypeScript type checking;
- tests;
- production build.

Run the primary validation suite locally with:

```bash
yarn validate
yarn format:check
yarn build
```

## Dependabot updates

Dependabot checks the npm and GitHub Actions ecosystems weekly from the repository root, with up to five open update
pull requests per ecosystem. Both update entries use an explicit `cooldown.default-days: 7` policy: routine version
updates wait seven days after release before Dependabot can propose them during a later scheduled check. This observation
window reduces supply-chain risk from newly published releases that may be compromised or otherwise unsafe.

The cooldown applies only to routine version updates. Dependabot security updates are not delayed by this setting and can
be proposed promptly when a vulnerability is identified.

## Configuration reference

### `projects[].id`

Non-empty identifier used to distinguish projects in configuration and logs. Project IDs must be unique.

### `projects[].trello`

Trello board, workflow list, and workflow label IDs for the project.

The configured fields are:

- `boardId` — Trello board containing the workflow.
- `ownershipCustomFieldId` — text custom field used to identify orchestrator-owned workflow cards.
- `backlogListId` — Backlog list.
- `readyListId` — list from which eligible implementation cards are claimed.
- `workingListId` — list used while automated work is in progress.
- `reviewListId` — list used while a published pull request awaits human review.
- `failedListId` — list used for failed automated work.
- `doneListId` — list used after the associated pull request is merged.
- `refinementLabelId` — label that routes a Ready card through automated refinement instead of normal implementation.
- `featureLabelId` — Feature implementation classification.
- `improvementLabelId` — Improvement implementation classification.
- `bugLabelId` — Bug implementation classification.

All configured workflow list IDs must be unique. All configured workflow label IDs must also be unique.

At startup, the orchestrator verifies that every configured workflow list exists and is open on the configured board,
that every configured workflow label exists on that board, and that `ownershipCustomFieldId` exists as a text custom field.

Each configured project must use a different Trello board.

### `projects[].repository.path`

Absolute path to the normal local checkout of the repository. Repository paths must be unique across configured
projects.

### `projects[].repository.github`

GitHub repository in `owner/repository` format. GitHub repositories must be unique across configured projects.

### `projects[].repository.defaultBranch`

Base branch used for task branches and pull requests.

### `projects[].repository.worktreeRoot`

Absolute directory under which isolated agent worktrees are created. Worktree roots must be unique across configured
projects.

### `projects[].repository.setupCommand`

Optional command executed in the card worktree before the OpenCode implementation session.

### `projects[].repository.validationCommand`

Optional repository validation command supplied to OpenCode sessions that modify implementation files. Those agents run
the command before finishing and address failures caused by their changes. The orchestrator does not execute the command
itself.

### `projects[].repository.gitIdentity`

Git identity used when the orchestrator creates commits for the project.

`gitIdentity` is required and contains:

- `name` — non-empty Git commit author and committer name.
- `email` — valid Git commit author and committer email address.
- `signingKey` — optional absolute path to the SSH signing key used for signed commits.

When `signingKey` is configured, the key must be available at that path in the environment where the orchestrator runs.

### `projects[].opencode.refinement`

Model and variant used for task refinement sessions.

### `projects[].opencode.implementation`

Model and variant used for task implementation and human review feedback implementation.

### `projects[].opencode.review`

Model and variant used for fresh code review passes.

### `projects[].opencode.remediation`

Model and variant used to address failed review findings.

### `projects[].opencode.commit`

Model and variant used for the final commit session.

### `projects[].opencode.timeoutMinutes`

Maximum runtime in minutes for an individual OpenCode execution across all workflow stages. Must be positive and
defaults to `360` when omitted.

### `workflow.pollIntervalSeconds`

Interval in seconds between project polling cycles. Must be a positive integer.

## Safety boundaries

Agent Orchestrator deliberately keeps several operations outside automated control.

It does not:

    - merge pull requests;
    - force-push task branches;
    - run agent implementation directly in the source checkout;
    - start or resume work for an unowned `Working` or `Human Review` card;
    - treat failed external operations as successful workflow transitions;

- silently discard failed agent work;
- delete arbitrary or unrecognized worktrees.

The orchestrator owns workflow coordination. OpenCode owns software-engineering execution. Humans retain final approval
through GitHub review and merge.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, validation,
testing, commit, and pull request guidance.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not through public issues.

## License

Agent Orchestrator is available under the [MIT License](LICENSE).
