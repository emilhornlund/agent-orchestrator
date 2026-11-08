// Executed from an archived fe32760 source tree, never from the current writer.
import fs from "node:fs";
import { RunStore } from "../../src/task-session/run-store.js";
import type { RunRecord } from "../../src/task-session/run-record.js";

const input = JSON.parse(
  fs.readFileSync(process.argv[2]!, "utf8"),
) as RunRecord;
const store = new RunStore(
  input.pinned.storageRoot,
  input.attemptId,
  input.pinned,
  {
    integrationId: input.pinned.integrationId,
    ...input.owner,
    assertHeld() {},
  },
);
if (process.argv[3] !== "read") store.create(input);
process.stdout.write(JSON.stringify(store.read()));
