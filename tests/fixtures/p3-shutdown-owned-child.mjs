import fs from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { setInterval } from "node:timers";

const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);
fs.writeFileSync(
  process.argv[2],
  JSON.stringify({
    descendantPid: descendant.pid,
    processGroupId: Number(
      fs
        .readFileSync(`/proc/${process.pid}/stat`, "utf8")
        .slice(
          fs
            .readFileSync(`/proc/${process.pid}/stat`, "utf8")
            .lastIndexOf(")") + 2,
        )
        .split(" ")[2],
    ),
  }),
);
setInterval(() => {}, 1_000);
