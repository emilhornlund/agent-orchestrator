import {
  runRoute,
  type CrashRoute,
} from "../support/p4-route-crash-fixture.js";
const [root, route, barrier] = process.argv.slice(2);
if (!root || !route || !barrier) throw new Error("Missing route/barrier");
await runRoute(root, route as CrashRoute, (boundary) => {
  if (boundary !== barrier) return;
  process.send?.({ boundary });
  process.kill(process.pid, "SIGSTOP");
});
throw new Error("Crash boundary not reached");
