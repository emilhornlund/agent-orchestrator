# Contributing

Thank you for contributing to Agent Orchestrator. Keep changes focused on the
orchestration service and preserve its safety boundaries and existing workflow
behavior.

## Development setup

Supported tooling is:

- Node.js 24 or later;
- Yarn Classic 1.x (the repository uses Yarn 1.22.22);
- Git;
- GitHub CLI (`gh`) 2.40.0 or later when working with managed repositories; and
- OpenCode when running the orchestrator locally.

Service execution also requires Linux, Bubblewrap namespace isolation and `flock`.
See [installation](docs/operations.md#local-and-container-installation) for local
and container prerequisites; routine service-free tests do not need live credentials.

Install dependencies from the repository root:

```bash
yarn install
```

To run the service locally, create the ignored configuration files:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Add the Trello credentials to `.env`, configure the project and workflow IDs
in `config.yaml`, and choose the project's GitHub authentication mode at
`repository.githubApp`: projects without it use an authenticated `gh` session
or ambient GitHub authentication such as `GH_TOKEN` or `GITHUB_TOKEN`; projects
with it use the configured App installation. A configured App does not fall
back to ambient authentication when its credentials or token exchange fail.
Do not commit `config.yaml`, `.env`, credentials, private keys, or other
secrets.

## Validation

Run the complete required validation suite before opening a pull request:

```bash
yarn validate
```

The individual checks are:

```bash
yarn lint
yarn format:check
yarn typecheck
yarn test
```

The production build is also checked by CI and can be run locally with:

```bash
yarn build
```

Use `yarn lint:fix` for automatic lint fixes and `yarn format` to format the
repository when needed.

## Testing

Tests use the repository's Vitest-based test suite. Run them with `yarn test`
or as part of `yarn validate`. Unit tests must remain deterministic and must
not require live Trello, GitHub, or OpenCode services.

`yarn test` works without setting `TMPDIR` or running a separate setup command.
Vitest creates one private system-temporary directory for the run, directs filesystem
fixtures and child-process artifacts beneath it, and removes it at teardown even
when assertions fail. Individual fixtures should still use `try/finally` or cleanup
hooks to release subprocesses and remove their files promptly. Never retain fixture
repositories, downloaded dependency trees, or process logs by default. Capture console
output when diagnosing a failure rather than preserving entire fixture trees.

Name tests for product behavior. Integration tests may use real disposable Git repositories
when Git behavior is the assertion; ordinary decision/parser tests should stay in memory.

### Workflow verification

Use [stable specification IDs](docs/specification.md) to identify applicable criteria;
do not infer compliance from a code path or aggregate test count. Important behavior
needs production-entry-point coverage, including later writes and restart/recovery,
not just a manually constructed desired final state. Existing lifecycle integration
tests combine real Git repositories/processes with stateful Trello/GitHub/OpenCode
substitutes. Cover normal/draft delivery, adverse advice, bounded CI, feedback,
additive maintenance, refinement, terminal races and clean deliberate retries.
State/import/process suites exercise corrupt state, partial acceptance, interrupted
handoffs, shutdown, ownership and credential boundaries without live services.

Report exactly which commands ran and whether they passed, failed, were filtered or
were not executed. Simulated integrations demonstrate their modeled boundaries, not
a deployed-release migration, live provider semantics or production permissions.
Container builds and startup probes likewise do not demonstrate a complete live
workflow. A realistic live-service baseline remains separate qualification; it has
not been established by the routine suite. Do not fabricate an end-to-end result
from unit-test success. Check registered secret forms and controlled channels
explicitly without claiming arbitrary unknown-secret detection.

Useful task-judgment boundaries are qualitative, not changed-line thresholds: a
small task-fulfilling change is meaningful; terse wording alone is not grounds to
fail a card when repository/context evidence establishes intent. Essential unresolved
product choices require clarification, and an already-satisfied task must not
manufacture a commit merely to obtain a PR. Negative stylistic AI feedback alone is
not a publication veto; material unresolved issues require truthful draft status.

### Trello attachments and card context

`TrelloClient.getCardAttachments(cardId)` retrieves the metadata for a card's
attachments from Trello and returns the attachments in Trello's order. Each
`TrelloAttachment` exposes `id`, `name`, `mimeType`, `bytes`, `url`, and
`isUpload`; `mimeType` and `bytes` remain nullable when Trello does not provide
those values, and empty values are preserved. Trello returns `bytes` as a string
when available.

Card processing materializes uploaded files below the configured card context
root and writes the ordered metadata to `attachments.json`. External URL
attachments remain metadata-only and are never requested. The manifest uses
`localFilename` for a safe single filename on uploaded entries and `null` for
external entries. Unchanged regular uploads are reused. A successful
reconciliation removes regular files claimed by the previous manifest for
removed or replaced attachments; unrelated and unknown files are retained.
Per-upload and aggregate new-download limits are
documented in the card-context sections of `docs/operations.md` and
`docs/configuration.md`. Before each applicable OpenCode session starts,
materialized attachment metadata is refreshed and used to add a compact section
to refinement, implementation, automatic review, automatic remediation, and
review-feedback remediation prompts.
The section lists each name, any non-blank MIME type, and either the absolute
runtime path to an uploaded file or the external URL for a link. It is omitted
when there are no attachments. Prompt paths use the configured `contextRoot` in
the filesystem namespace visible to the running service and OpenCode process,
not the source checkout or worktree. These ordinary attachment sections are metadata
and locations, not file excerpts; ordinary commit prompts remain unchanged.
Confirmed-loss primary-session reconstruction is a separate path: it may include
bounded supported text attachment content in a sanitized, externally stored recovery
bundle. Its builder and persistence boundary sanitize before serialization/encoding.
Do not turn the ordinary metadata-only section into a rule preventing the required
reconstruction context, or infer that every attachment format has been proven usable.
Unsafe or unavailable materialized locations must fail the workflow before its
affected OpenCode session starts rather than being omitted silently. Context is
retained outside Git and worktree cleanup for successful processing, failures,
resumes, and retries. Failed refreshes preserve the last successfully published
manifest and its files, while reconciliation never removes unknown files.

### Trello card start dates

`TrelloCard.start` exposes Trello's optional card start timestamp to workflow
consumers. Cards with no `start` value, or with a `null` value, omit this field;
cards with a present value must provide a timestamp accepted by `Date.parse`,
using the same validation convention as Trello transition dates. The original
timestamp string is preserved, including its timezone information, so consumers
must use `Date.parse` for absolute-time comparisons rather than comparing strings
or local-time components. During a Ready for Agent scan, cards without a start
date or whose start instant has been reached are eligible. A future-dated card
is skipped without being claimed or modified, does not block later eligible
cards, and is reconsidered on a later normal poll. This rule only affects Ready
list claiming; it does not reorder cards or change other workflow transitions.

## Commits

Use the concise commit format used in the repository's recent history:

```text
type(scope): summary
```

For example, `docs(readme): clarify setup`. Keep the summary short and use a
scope that identifies the affected area when one is useful.

## Pull requests

Pull requests should:

- describe the change and its motivation clearly;
- reference a related issue or Trello card when applicable;
- list the validation commands run and their results; and
- be focused, reviewable, and ready for review without unrelated changes.

The pull request template provides a short checklist for these expectations.
