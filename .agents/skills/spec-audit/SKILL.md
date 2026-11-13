---
name: spec-audit
description:
  Use for an explicitly requested full, scoped, or Git-diff specification audit of Agent
  Orchestrator. Produce retained criterion-level evidence and findings without changing product
  code, tests, requirements, or specifications.
---

# Specification audit

All paths below are repository-root relative. Read `AGENTS.md` and `docs/specification-auditing.md`
before execution.

## Contract and scope

- `docs/requirements.md` is authoritative; `docs/specification.md` supplies verifiable criteria.
  Audit their consistency as well as implementation. Never edit either to excuse a discrepancy.
- Remain read-only for product code, tests, fixtures, configuration, requirements, and
  specification. Write only retained reports under `.local/spec-audits/<audit-id>/`. Do not fix
  findings, commit, push, mutate live services, or run auto-fix/setup commands. Existing tests may
  use their owned disposable fixtures; inspect commands before execution. Record baseline and final
  Git status.
- Full: inventory every ID and individual criterion, plus every authoritative source statement.
- Scoped: record selected domains/IDs and rationale; include affected cross-domain dependencies.
  Keep excluded inventory entries explicitly out of scope, never classified as compliant.
- Changes: record the exact Git diff command, resolved base/head SHAs and working-tree scope. Trace
  changed callers, persistence compatibility, integration and recovery effects to criteria; include
  unchanged dependencies. An empty diff is not evidence of whole-product compliance.

## Inventory and checkpoints

1. Record audit ID, mode, scope, HEAD, working-tree status/diff, tool versions, and hashes of both
   authoritative documents and audited inputs. Use `node scripts/spec-audit.mjs inventory` for a
   deterministic starting inventory. It emits JSON to stdout without modifying files. Verify its
   output independently against headings and bullet lists. Criterion keys are `REQ-…/AC-01` etc.,
   local to the recorded document hash; they are not new permanent specification IDs.
2. Create `inventory.json`, `matrix.json`, `findings.md`, `progress.md`, `summary.md`, and an
   `evidence/` directory in the audit directory. Inventory every criterion verbatim with source
   lines and every requirements bullet (use source line keys since that document has no IDs). Map
   source statements to criteria in `requirements-map.json`, flagging missing coverage. The
   specification's section mapping is a starting aid, not evidence of complete coverage.
3. Divide all in-scope criteria into bounded domain batches. Record exact assigned keys and batch
   states `pending`, `in_progress`, `completed`. Assessment state is separate from compliance: an
   assessed Unverified criterion can be completed; an unassessed criterion cannot.
4. Save matrix rows, findings, evidence, and progress after **each** batch, before marking it
   complete. Keep unfinished keys explicit. On interruption resume the same directory: compare
   recorded revisions, hashes, scope and dirty diff; recheck evidence for changed inputs and
   invalidate affected rows. Never silently carry completed status across changed inputs. Reconcile
   partial writes conservatively; missing rows remain pending. Retain previous evidence.

## Evidence for each criterion

Trace entry point → actual callers → decision → external adapter → persisted intent/result →
restart/recovery and terminal release. Examine failure, ambiguity, partial success, concurrency,
process interruption, and interactions with other components. Search reverse callers too; a helper
or a test double may not be on a production path. Inspect configuration, fixtures, CI, and execution
environment assumptions. Identify undocumented behavior conflicting with source requirements and
contradictory, ambiguous, obsolete, missing, or accidentally tightened specification provisions.

Read relevant tests and their actual assertions. Run meaningful available checks, recording exact
commands, exit codes, observed outcomes and retained output. Do not equate a passing test suite, an
ID reference, or a mocked response with a demonstrated production workflow. Distinguish:

- **Demonstrated**: executed evidence linked to the actual path and criterion, with stated limits.
- **Static inference**: traced code supports an outcome, but it was not exercised sufficiently.
- **Unverified live behavior**: external protocol, deployment, or service behavior not exercised.

Every matrix row needs key, source text/location, status, production references with line numbers,
test/assertion references, evidence kind and artifact references, rationale, remaining gaps, and
finding IDs. Explicitly record missing tests or evidence; do not invent references.

## Classification

Use exactly these statuses; do not count absence of evidence as compliance:

| Status              | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| Compliant           | Applicable observable obligations demonstrated; no known gap in the claimed scope. |
| Partially compliant | Some obligations demonstrated, with concrete unmet or unverified remainder.        |
| Noncompliant        | Reproducible evidence or a decisive production path contradicts an obligation.     |
| Unverified          | Evidence is insufficient; static inference alone does not prove compliance.        |
| Needs clarification | Conflicting or ambiguous governing statements prevent a sound assessment.          |

Record separate severities: Critical (unsafe competing ownership, data loss, secret disclosure),
High (broken delivery/recovery or material invariant), Medium (bounded functional/verification gap),
Low (minor diagnostic/documentation issue). Severity reflects supported impact, not speculation.
Every finding includes a stable audit-local ID, applicable requirement IDs/criterion keys (or an
unmapped source statement), expected versus observed behavior, source and reproducible evidence,
severity, uncertainty, and recommended action. Keep confirmed defects separate from evidence gaps.

## Completion gate

Independently re-enumerate documents and compare sets: no skipped, duplicate, invented or silently
excluded IDs/criteria; all source statements mapped or explicitly flagged; no unfinished batches.
Reconcile matrix counts, status totals and finding references in both directions. Use
`node scripts/spec-audit.mjs check <audit-directory>/matrix.json` to check criterion coverage; this
mechanical check does not establish evidence quality. Review references and classifications
independently, especially every Compliant claim and critical finding. Record this review.

Produce the complete matrix, prioritized findings register, and final summary with scope/revision,
counts, executed checks, confirmed discrepancies by severity, uncertainties, exclusions, remediation
order, and exact artifact paths. Record final status and verify product inputs were not modified. If
incomplete, label the summary **incomplete** and list pending keys and the resume command/prompt.
Retain reports after execution; do not place the only copy in temporary storage or tool output.
Completion means all criteria were assessed, not that the product is compliant.
