import fs from "node:fs";
import path from "node:path";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
const [root, barrier] = process.argv.slice(2);
if (!root || !barrier) throw new Error("Missing crash fixture arguments");
const outbox = new NotificationOutbox(
  root,
  "p",
  () => {},
  () => 0,
);
const stop = async () => {
  process.send?.("barrier");
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
outbox.enqueue("attempt:humanReview:sha", {
  subject: "PR ready",
  text: "Task c",
});
if (barrier === "intent") await stop();
await outbox.drain(
  {
    send: async (message) => {
      if (barrier === "dispatch") await stop();
      fs.appendFileSync(
        path.join(root, "sink.jsonl"),
        `${JSON.stringify(message)}\n`,
      );
      if (barrier === "acceptance" || barrier === "response") await stop();
    },
  },
  () => {},
);
await stop();
