# Refinement label reconciliation

## Provider contract

Trello does not return `addLabelToCard` or `removeLabelFromCard` from nested REST action resources,
including `/cards/{id}/actions`, even when those types are explicitly requested. They are
[excluded action types](https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/).
Polling those events cannot verify a label write. Webhooks are not required for this workflow.

Content verification still uses available `updateCard:name` and `updateCard:desc` history. Label
verification instead binds the full card readback to the exact single-label request already recorded
and dispatched by the durable mutation journal. The saved pending fields must equal that one label
change applied to the previously verified fields. The entire title, description and label set must
match; merely seeing the requested classification label is insufficient. The pinned board/card and
current ownership checks remain in place.

A positive matching readback resolves the journaled desired-state operation, including after a lost
acknowledgement. It is not proof that no human ever toggled the same label between reads: Trello's
polling API does not expose that history, and these checks do not provide atomic compare-and-write.
Detectable content changes, unexpected labels, missing content history, conflicting attribution and
existing conflict records remain protected. No missing or negative readback authorizes replay of an
ambiguously dispatched write.

## Recovering an existing stuck card

The faulty verifier could rewrite the description and add the classification label, then leave the
card in Working with an ambiguous `trello-labels` operation and pending refinement fields. It waited
indefinitely for an event the provider never returns. A successful label removal could leave a
similar checkpoint.

After deploying the correction, retain the existing configuration, runtime/coordination state,
repository and worktree mounts. Leave the card where it is. Do not remove its labels, reset its
fields, delete state, or move it to Ready to work around this defect. Back up persistent state
before redeployment.

The ordinary recovery poll observes the already-dispatched label operation after its stored recheck
deadline. When the full card still matches its saved intended fields, the operation is verified
without resending it. The same attempt then finishes remaining label changes and the verified
Backlog transition. Completed refinement analysis is not rerun. No state migration or special
recovery command is required for this pending-label condition.

A genuine persisted conflict, different current fields, missing checkpoint or unavailable Trello
response is not cleared by this fix. Such evidence remains pending for explicit reconciliation; a
matching classification label alone must never force completion.

## Verification

`tests/refinement-label-reconciliation.integration.test.ts` covers the REST history filter,
successful completion without label events, pre-correction accepted label checkpoints, lost
acknowledgements, real lease release/takeover with the same attempt, paced polling, late visibility,
concurrent content/label changes, missing content history, and a label present before dispatch. The
shared refinement fixtures exclude label events from polling responses, matching the provider
contract instead of inventing evidence unavailable in production.

This implements `REQ-REF-004` criteria 3–6 and `REQ-REF-005` criteria 1–4 without changing their
requirements or the journal's uncertain-write replay policy.
