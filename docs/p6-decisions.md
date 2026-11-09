# Approved P6 readiness decisions

## Approval and scope

The user approved all four recommendations presented immediately before this record:
primary recovery accounting, the P6 semantic rubric, the upgrade-support boundary,
and bounded isolated live verification. Approval text: **“Ok I approve everything.”**
This resolves these policy/authorization questions; it is not evidence that their
engineering checks passed or permission to start unrelated phases, merge PRs,
deploy, purchase services, or modify production resources.

The [readiness register](phase-readiness.md) tracks remaining execution work.
Other A2/A5 choices explicitly assigned to P7–P9 remain with those phases.

## D6-RECOVERY — counted unit and limit

| Activity / evidence                             | Approved treatment                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary operation genuine failure               | Maximum **three verified genuine failures per semantic primary operation**. The initial execution consumes one failure allowance only if it genuinely fails and its outcome is authoritatively established.              |
| Actual process dispatch                         | Record every actual execution truthfully, including outage attempts. Do not erase history to fit the failure allowance.                                                                                                  |
| Temporary provider/service outage               | Record separately; bounded immediate attempts followed by paced rechecks. Outage duration or repeated recognized outage responses do not exhaust the genuine-failure allowance.                                          |
| Unknown/running process or uncertain acceptance | No safe retry until the exact execution/operation outcome is established. Unknown is neither genuine failure proof nor outage proof.                                                                                     |
| Never-dispatched reservation                    | Reconcile/refund according to authoritative non-dispatch evidence; do not count it as an actual execution or genuine failure.                                                                                            |
| Reconstruction acknowledgement                  | Separate operation/role accounting, using the same existing three-genuine-failure recovery limit. It does not consume primary implementation attempts. Preserve replacement identity and read-only context verification. |
| Service-request retry                           | Separate from primary work, reconstruction, and improvement-pass budgets; retain bounded immediate retry and existing controlled waits.                                                                                  |
| Validation/review improvement                   | Distinct configured maxima; no-op/early finish may end earlier. Test failure or negative AI findings are not primary crashes.                                                                                            |

Persist classification and exact execution/session identity before completion is
exposed; restart reconciliation must be idempotent. A new SHA or poll does not reset
a semantic operation's allowance. No new crash-retry setting and no task-wide
deadline are introduced. The pre-/post-publication failure distinction remains:
verified genuine unrecoverability may fail an unpublished task; an open PR keeps
ownership and an explicit operational blockage.

The historical “three total actual executions” wording is superseded by this
approved counted-unit definition. It remains historical evidence, not a second policy.

## D6-RUBRIC — representative P6 acceptance judgments

| Situation                                                                                      | Approved outcome / fixture oracle                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terse task whose intent is established by current repository/card/attachment evidence          | Proceed. Terse wording alone is not grounds for clarification or failure.                                                                                                              |
| An essential product choice still cannot be inferred after examining available evidence        | Ask actionable questions identifying the missing choice; use the documented verified clarification failure outcome and preserve work/evidence. Do not invent requirements.             |
| A small change actually fulfils the requested work, including necessary tests or documentation | Meaningful. There is no minimum changed-line/file threshold.                                                                                                                           |
| Task already satisfied, or appropriate attempts produce no meaningful task-related change      | Explain the outcome; do not manufacture a commit or PR. Preserve diagnostics and use the documented failure/deliberate-requeue behavior.                                               |
| Failed configured checks, skipped/uncertain results, or known material unresolved issues       | Publish available safe meaningful work as draft with accurate disclosure; quality alone cannot veto publication.                                                                       |
| AI disapproval of a stylistic choice without an established material unresolved issue          | That verdict alone neither blocks publication nor forces draft status. The agent supplies the substantive disposition; the orchestrator records/enforces evidence and reporting rules. |

These are representative approved oracles, not a claim that every semantic edge has
an exhaustive deterministic classification. Create concrete executable fixtures
from them and retain independent assessment at the required realistic level.
Source/scope/credential safety, no artificial output, and truthful reporting remain
mandatory. Existing A3 advisory/readiness policy is not reopened.

## D6-UPGRADE — supported cohort

Target upgrade compatibility from:

1. The currently deployed release, identified during engineering preflight.
2. P5 state represented by [PR #218](https://github.com/emilhornlund/agent-orchestrator/pull/218),
   whose published source head is `f8ac2eaa3991a3c2b6b8b4b98945e06076140050` at
   the approval-record inspection.

Every intermediate experimental/WIP commit is not a required compatibility target.
Unknown or unsupported state must still be preserved and reported safely, not
deleted, silently reinterpreted, or treated as an absent task. Actual writer artifacts,
schema/layout versions and interrupted-migration cases remain engineering deliverables.
The deployed version has not been established merely by inspecting this checkout.

## D6-LIVE — authorized isolated P6 verification

Authorized: preparing and executing a **bounded, recorded P6 test plan** using
existing accounts/models and disposable resources:

- Trello Free test boards/cards/attachments.
- GitHub test repositories/PRs.
- Real OpenCode test sessions with synthetic task context.
- A controlled test inbox when notification verification needs it.
- Local and Podman fixtures with owned temporary paths and evidence.

Not authorized: production cards/repositories or deployment changes, new subscriptions,
paid infrastructure, arbitrary account changes, unrelated projects, automatic application
merge, or assuming permission to merge the current project PR. Existing authentication
may be used for the approved isolated plan without printing or storing credentials in
the record. Missing resource access is a capability/provisioning result, not withdrawal
of this approval.

Before live mutations/model calls, record an initial finite manifest: resource ownership
and names, allowed operations, maximum calls/effects, selected existing model/account,
timeouts, observer assertions, cleanup of proved-owned test artifacts and evidence
destinations. No unbounded probe/retry loop. A materially expanded or paid plan needs
new authorization. Authorization does not itself pass the required live scenarios.

Initial readiness inspection may check local tool versions, account/credential
availability without exposing values, and temporary local/container capabilities.
No production workflow data is needed merely to check test authorization.
