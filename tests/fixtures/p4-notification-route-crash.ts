import {
  notificationRouteFixture,
  type NotificationRoute,
} from "../support/notification-route-fixture.js";
const [root, route] = process.argv.slice(2);
if (!root || !["publication", "refinement", "failure"].includes(route ?? ""))
  throw new Error("Invalid fixture arguments");
await notificationRouteFixture(root, route as NotificationRoute, () => {
  process.send?.("accepted");
  process.kill(process.pid, "SIGSTOP");
}).run();
throw new Error("Route acceptance barrier was not reached");
