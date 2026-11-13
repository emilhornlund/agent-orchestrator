# Specification audit — 2026-11-13

Permanent record of the completed full audit of Agent Orchestrator at Git commit
**`2aa7561743add264eb8eb00c29993721630cbedf`**
(`feat: add shared specification compliance and auditing`). This revision applies to every report in
this directory, including every row of the compliance matrix. Publishing this record does not
re-audit a later revision or authorize implementing findings.

## Reports

| Report                                                | Contents                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| [Summary](summary.md)                                 | Conclusions, scope, verification limits, and remediation order          |
| [Compliance matrix](matrix.json)                      | All 305 individual criterion assessments across 82 IDs                  |
| [Requirements inventory](inventory.json)              | Complete IDs, verbatim criteria/source bullets, and document hashes     |
| [Requirements-to-criteria map](requirements-map.json) | Source mappings, qualifications, omissions, and conflicts               |
| [Coverage statistics](coverage-statistics.json)       | Classification, domain, finding, and severity totals                    |
| [Prioritized findings](findings.md)                   | Expected/observed behavior, evidence, severity, uncertainty, and action |

**Audit completion is not proof of product compliance.** The retained conclusions are unchanged: 228
criteria Compliant within cited verification scope, 61 Partially compliant, 6 Noncompliant, 10
Unverified, and 0 Needs clarification. All 305 criteria were assessed; no criteria were excluded.

The findings distinguish six confirmed static implementation discrepancies (AUD-001–006), three
verification-gap groups (AUD-007, AUD-008, AUD-010), and one specification criterion omission
(AUD-009). Static counterexamples are not claims of observed production incidents. In particular,
the Critical coordination finding is deployment-conditional; the credential-isolation finding does
not claim observed remote disclosure. Partial compliance and missing evidence must not be counted as
demonstrated compliance.

## Reading source references and evidence

`docs/requirements.md` is authoritative; `docs/specification.md` supplies verifiable criteria.
Production, test, and document paths with line numbers refer to files **at the audited commit**,
relative to the repository root. `REQ-…/AC-01` keys are one-based criterion ordinals at the recorded
specification hash, not new permanent specification IDs. `requirements:L…` keys identify source
statements at the recorded requirements hash.

The JSON report data and classifications are preserved from the completed local audit; inventory and
source-map metadata additionally identify the audited commit. Markdown formatting and this
publication guide provide durable navigation without changing conclusions.

References beginning `.local/spec-audits/` are historical, repository-root-relative evidence
locators, **not committed attachments or portable links**. The original supporting scripts, raw
verification logs, execution transcripts, checkpoint history, and detailed review artifacts remain
in the ignored `.local/spec-audits/full-2026-11-13/` and `.local/spec-audits/integration/`
directories on the audit machine. They are not available from a fresh clone. The committed matrix
retains production/test references, assessment rationale, evidence qualifications, gaps, and finding
IDs independently of those local files. Recorded successful checks are historical results, not
claims of a new run on a later tree.

The published record contains repository-source observations and report metadata, not raw runtime
records, credential values, operator-specific absolute paths, session identifiers, or service
payloads. Generic credential-file paths in findings describe the audited code boundary.
