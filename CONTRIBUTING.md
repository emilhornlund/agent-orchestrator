# Contributing

Thank you for contributing to Agent Orchestrator. Keep changes focused on the
orchestration service and preserve its safety boundaries and existing workflow
behavior.

## Development setup

Supported tooling is:

- Node.js 24 or later;
- Yarn Classic 1.x (the repository uses Yarn 1.22.22);
- Git;
- GitHub CLI (`gh`) when working with managed repositories; and
- OpenCode when running the orchestrator locally.

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
in `config.yaml`, and authenticate the GitHub CLI for the repositories the
orchestrator manages. Do not commit `config.yaml`, `.env`, credentials, or
other secrets.

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
not the source checkout or worktree. Attachment contents and excerpts must never
be added to prompts; commit prompts remain unchanged.
Unsafe or unavailable materialized locations must fail the workflow before its
affected OpenCode session starts rather than being omitted silently. Context is
retained outside Git and worktree cleanup for successful processing, failures,
resumes, and retries. Failed refreshes preserve the last successfully published
manifest and its files, while reconciliation never removes unknown files.

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
