import fs from "node:fs";

/** Resolve a fixture PID through the host's namespace mapping, scoped by its
 * unique owned working directory. A namespace PID alone is not a host identity. */
export function hostPidForFixture(namespacePid: number, directory: string): number | undefined {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      if (fs.readlinkSync(`/proc/${entry}/cwd`) !== fs.realpathSync(directory)) continue;
      const mapping = fs
        .readFileSync(`/proc/${entry}/status`, "utf8")
        .split("\n")
        .find((line) => line.startsWith("NSpid:"))
        ?.trim()
        .split(/\s+/u);
      if (Number(mapping?.at(-1)) === namespacePid) return Number(entry);
    } catch {
      /* Processes can exit during enumeration. */
    }
  }
  return undefined;
}
