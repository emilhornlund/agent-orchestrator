# Complete full read-only specification audit

**Audit execution complete; product is not fully compliant.**

This permanent record preserves the completed audit's conclusions. See
[the publication guide](README.md) for the report index, revision-bound source references, and the
distinction between committed reports and ignored local supporting evidence. All paths below
beginning `.local/` are historical evidence locators relative to the repository root and are not
included in this record.

- Audit: full-2026-11-13 (Task 5). Revision: `2aa7561743add264eb8eb00c29993721630cbedf`.
- Scope: all production implementation, authoritative requirements, specification criteria, tests
  and CI; no exclusions.
- Baseline/final Git status: clean. Tracked product inputs and document hashes unchanged. No live
  mutations or commits.
- Coverage: **82 IDs, 305 individual criteria, 19 completed domains, zero pending keys**.
- Source: **241 bullets plus 3 unbulleted statements**, all mapped to individual criterion keys or
  explicitly qualified; every criterion has reverse source coverage.

## Criterion assessment totals

| Classification      | Criteria |
| ------------------- | -------: |
| Compliant           |      228 |
| Partially compliant |       61 |
| Noncompliant        |        6 |
| Unverified          |       10 |
| Needs clarification |        0 |
| **Total assessed**  |  **305** |

Compliant means demonstrated within the explicitly cited fixture/assertion scope, supported by
traced production paths—not live provider/deployment qualification. Partial/unverified rows preserve
concrete gaps. Six criteria have decisive contradictory production paths. Assessment completion is
not compliance certification.

## Prioritized findings

**10 findings:** 1 Critical, 1 High, 7 Medium, 1 Low. Six confirmed static implementation
contradictions, three grouped verification gaps, one specification criterion omission.

1. **AUD-004 — Critical, deployment-conditional:** independently provisioned/mis-mounted
   coordination roots can both admit ownership. Same-root flock and ambiguity safeguards work in
   tests; the incompatible-namespace fail-safe requirement is stronger than the documented
   operator-only mount contract. Not a live contention incident claim.
2. **AUD-006 — High:** shared OpenCode auth/config mounts expose unrelated provider credentials
   despite environment filtering. Least-privilege input exposure, not demonstrated remote
   exfiltration.
3. **AUD-001 — Medium:** genuine human feedback quoting a managed marker is excluded before
   actionability classification.
4. **AUD-002 — Medium:** 10,000 retained queue events impose a finite lifetime limit on otherwise
   unlimited human rounds.
5. **AUD-003 — Medium:** a never-finishing expected check can prevent repair of another already
   failed check, including after the bounded observation deadline. PR delivery itself is not blocked
   by this finding.
6. **AUD-005 — Medium:** dirty cleanup status stdout is copied into orchestrator logs. Known-secret
   redaction is not a substitute for raw-channel separation.
7. **AUD-007/008/010 — Medium evidence gaps:** semantic/model behavior; container/live-service
   baseline; residual full-path recovery/config/setup/selection/content assertions. Not confirmed
   defects inferred merely from missing evidence.
8. **AUD-009 — Low:** outside-Git storage is normative in both documents, but CFG-005 individual
   acceptance bullets do not explicitly express separation. Implementation has traced path
   safeguards.

Remediation order: resolve/authorize the shared-namespace safety contract first; isolate filesystem
credentials; then address dropped feedback, queue lifetime, mixed CI failures and raw cleanup
diagnostics. Add focused production-path regression evidence for each. Qualify remaining
semantic/deployment/recovery boundaries separately. **This audit authorizes no implementation or
governing-document changes.**

## Verification and limits

- Reused successful `yarn validate`: **173 files / 2,273 tests**, lint/format/typecheck successful;
  `.local/spec-audits/integration/validate.log:2616-2621`.
- Reused successful `yarn build`: `.local/spec-audits/integration/build.log:1-3`. Neither rerun.
  Logs do not embed a Git SHA; exact-tree provenance comes from the explicit audit request and
  retained integration context.
- Executed `node scripts/spec-audit.mjs check .local/spec-audits/full-2026-11-13/matrix.json`: exit
  0, `{"ids":82,"criteria":305}`. Coverage checking does not certify evidence quality.
- Independent enumeration matched every ID/key/source-bullet line; every matrix source text/id/line
  matched inventory. All references exist/in range; finding links reconcile both directions; no
  incomplete domains.
- A second reasoning pass reviewed evidence/classifications and Critical findings; original matrix
  and explicit corrections retained. This was the same primary auditor, not an independently
  recruited human/model.
- Real local Git, supervised processes/descendants, persistence/restart, locks and SMTP protocol
  fixtures provide substantial modeled workflow evidence. No live Trello/GitHub/OpenCode or
  container lifecycle was run. Actual semantic judgment, live protocols, deployed permissions/mounts
  and arbitrary unknown/transformed secret absence remain unverified.

## Permanent reports and local supporting evidence

- [Requirements inventory](inventory.json)
- [Complete criterion matrix](matrix.json)
- [Authoritative requirements-to-criteria map](requirements-map.json)
- [Prioritized findings register](findings.md)
- [Coverage statistics and per-domain counts](coverage-statistics.json)
- [This summary](summary.md)

Supporting evidence remains ignored under `.local/spec-audits/full-2026-11-13/`, with original
validation/build logs under `.local/spec-audits/integration/`. It includes domain traces, input
hashes, reference and completeness reviews, first-pass assessments, execution transcripts,
checkpoint history, and report-generation/review helpers. None of those temporary or runtime
artifacts is committed.

The delivery-time review confirmed the exact 82/305 sets, 241 bullet lines plus unbulleted reverse
mappings, all 411 tracked input hashes, status totals, and clean Git state. The execution-deadline
interruption was recovered from domain checkpoints; all domains subsequently completed.

No pending audit criteria. This snapshot assesses the recorded revision only; never silently carry
these assessments across changed inputs.
