import fs from "node:fs";
import path from "node:path";
import { RunStore } from "../../src/task-session/run-store.js";
import { mutationIntentSchema } from "../../src/task-session/durable-mutation.js";

const [root, barrier, serializedIntent] = process.argv.slice(2);
if (!root || !barrier || !serializedIntent)
  throw new Error("Missing fixture arguments");
const intent = mutationIntentSchema.parse(JSON.parse(serializedIntent));
const store = RunStore.openWithPersistedIdentity(
  path.join(root, "state"),
  "attempt",
  {
    integrationId: "integration",
    instanceId: "owner",
    token: "lease",
    assertHeld() {},
  },
)!;
const at = (seconds: number) => new Date(seconds * 1000).toISOString();
let run = store.persistMutationIntent(
  store.read()!.revision,
  1,
  "effect",
  intent,
  at(0),
);
const evidence = (seconds: number) => ({
  observationId: `read-${seconds}`,
  observedAt: at(seconds),
  artifactId: intent.payloadId,
});
if (!["intent", "terminal", "cancellation"].includes(barrier))
  run = store.recordMutationEvent(
    run.revision,
    1,
    "effect",
    1,
    { type: "dispatch", nextRecheckAt: at(10) },
    at(0),
  );
if (!["intent", "dispatch", "terminal", "cancellation"].includes(barrier)) {
  // Stateful external substitute: resource state and append-only request/acceptance
  // ledger are separate from RunStore and independently inspected by the parent.
  fs.appendFileSync(
    path.join(root, "service.jsonl"),
    `${JSON.stringify({ type: "request", correlationId: intent.correlationId })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "service-resource.json"),
    JSON.stringify({ id: "resource-42", correlationId: intent.correlationId }),
  );
  fs.appendFileSync(
    path.join(root, "service.jsonl"),
    `${JSON.stringify({ type: "accept", id: "resource-42" })}\n`,
  );
}
if (["response", "completion"].includes(barrier))
  run = store.recordMutationEvent(
    run.revision,
    1,
    "effect",
    1,
    { type: "response", outcome: "accepted", evidence: evidence(1) },
    at(1),
  );
if (barrier === "completion")
  store.recordMutationEvent(
    run.revision,
    1,
    "effect",
    1,
    {
      type: "observe",
      outcome: "verified",
      resourceId: "resource-42",
      evidence: evidence(10),
      attentionRequired: false,
    },
    at(10),
  );
if (["terminal", "cancellation"].includes(barrier)) {
  run = store.transition(
    run.revision,
    1,
    null,
    "merged",
    "human-review",
    "done",
    (snapshot) => snapshot,
    {
      prOutcome: "merged",
      prObservationId: "pr-merged",
      prVerifiedAt: at(1),
      trelloListId: "done",
      trelloObservationId: "card-done",
      trelloVerifiedAt: at(1),
    },
  );
  if (barrier === "cancellation")
    store.recordMutationEvent(
      run.revision,
      1,
      "effect",
      1,
      { type: "cancel", reason: "terminal-observed", evidence: evidence(2) },
      at(2),
    );
}
process.send?.("barrier");
setInterval(() => {}, 1000);
