import { reopenPublicationFixture } from "../support/initial-publication-fixture.js";
import { pollProject } from "../../src/orchestrator/poll-project.js";
import { acquireProjectOwnership } from "../../src/coordination/project-ownership.js";
import path from "node:path";

const [root, barrier, clock, effect = "pr"] = process.argv.slice(2);
if (!root || !barrier || !clock)
  throw new Error("Missing publication crash arguments");
let time = Number(clock);
globalThis.Date = new Proxy(Date, {
  construct(target, args) {
    return Reflect.construct(target, args.length ? args : [time]) as Date;
  },
  get(target, property) {
    return property === "now" ? () => time : Reflect.get(target, property);
  },
});
const realLease =
  process.argv[6] === "real-lease"
    ? await acquireProjectOwnership(
        path.join(root, "coordination"),
        { trelloBoardId: "board", githubRepository: "owner/repo" },
        "p4-evidence",
      )
    : undefined;
const f = reopenPublicationFixture(
  root,
  realLease?.token,
  realLease
    ? {
        integrationId: JSON.stringify(realLease.identity),
        instanceId: realLease.instanceId,
        token: realLease.token,
        assertHeld: () => realLease.assertHeld(),
      }
    : undefined,
);
const stop = () => {
  process.send?.("barrier");
  process.kill(process.pid, "SIGSTOP");
};
const persist = f.store.persistMutationIntent.bind(f.store);
f.store.persistMutationIntent = (...args) => {
  const result = persist(...args);
  if (args[2] === `initial:${effect}` && barrier === "intent") stop();
  return result;
};
const record = f.store.recordMutationEvent.bind(f.store);
f.store.recordMutationEvent = (...args) => {
  const event = args[4] as { type: string; outcome?: string };
  if (
    args[2] === `initial:${effect}` &&
    barrier === "response" &&
    event.type === "response"
  )
    stop();
  const result = record(...args);
  if (
    args[2] === `initial:${effect}` &&
    ((barrier === "dispatch" && event.type === "dispatch") ||
      (barrier === "completion" &&
        event.type === "observe" &&
        event.outcome === "verified"))
  )
    stop();
  return result;
};
const create = f.services.github.createPullRequest.bind(f.services.github);
f.services.github.createPullRequest = async (options) => {
  const result = await create(options);
  if (barrier === "acceptance" && effect === "pr") stop();
  return result;
};
const commit = f.git.commit.bind(f.git);
f.git.commit = async (...args) => {
  await commit(...args);
  if (effect === "commit" && barrier === "acceptance") stop();
};
const push = f.git.push.bind(f.git);
f.git.push = async (...args) => {
  await push(...args);
  if (effect === "push" && barrier === "acceptance") stop();
};
const move = f.services.trello.moveCard.bind(f.services.trello);
f.services.trello.moveCard = async (...args) => {
  const result = await move(...args);
  if (effect === "move" && barrier === "acceptance") stop();
  return result;
};
const comment = f.services.trello.addComment.bind(f.services.trello);
f.services.trello.addComment = async (...args) => {
  const result = await comment(...args);
  if (effect === "comment" && barrier === "acceptance") stop();
  return result;
};
const mutate = f.authority.mutateTaskExecution.bind(f.authority);
f.authority.mutateTaskExecution = (...args) => {
  const result = mutate(...args);
  if (barrier === "projection" && f.store.read()!.lifecycle === "ci") stop();
  return result;
};
for (let pass = 0; pass < 8; pass++) {
  await pollProject(
    f.services.trello,
    f.git,
    f.services.github,
    {} as never,
    {} as never,
    f.project,
    new AbortController().signal,
    { send: async () => {} },
    undefined,
    undefined,
    f.authority,
  );
  time += 15_001;
}
throw new Error("Publication barrier was not reached");
