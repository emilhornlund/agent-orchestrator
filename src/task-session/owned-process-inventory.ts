import fs from "node:fs";
import path from "node:path";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { ProjectRunAuthority } from "./project-run-authority.js";

export function journalProvesGitHubProcessNeverStarted(
  authority: ProjectRunAuthority,
  metadata: Record<string, unknown>,
): boolean {
  if (
    typeof metadata.executionId !== "string" ||
    typeof metadata.command !== "string" ||
    !metadata.command.startsWith("gh ") ||
    metadata.pid !== undefined ||
    metadata.dispatchState !== "dispatch-pending"
  )
    return false;
  const run = authority.store.assertCurrentLease(authority.ownerGeneration);
  return run.pendingOperations.some(
    (entry) =>
      entry.mutation?.dispatches.some((dispatch) => {
        const response = dispatch.response;
        if (
          response?.outcome !== "not-delivered" ||
          response.evidence.nonDeliveryProof !== "transport-proven-not-sent" ||
          !run.artifacts.some((artifact) => artifact.id === response.evidence.artifactId)
        )
          return false;
        const proof: unknown = JSON.parse(
          authority.store.readArtifact(response.evidence.artifactId, 64 * 1024).toString("utf8"),
        );
        return (
          !!proof &&
          typeof proof === "object" &&
          "processExecutionId" in proof &&
          proof.processExecutionId === metadata.executionId
        );
      }) === true,
  );
}

/** The historical setup layout is direct, whereas managed children normally
 * live under process-executions. Inspect both; an unreadable tree is not empty. */
export function readOwnedProcessInventory(store: TaskExecutionStore, cardId: string) {
  const root = store.processExecutionDirectory(cardId);
  if (!root) throw new Error("No owned process evidence directory");
  const result = new Map<string, { metadata: Record<string, unknown>; file: string }>();
  for (const layout of ["direct", "process-executions"] as const) {
    const directory = layout === "direct" ? root : path.join(root, layout);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
      throw new Error("Unsafe owned process evidence directory");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (layout === "direct" && entry.name === "process-executions") continue;
      if (layout === "direct" && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name, "execution.json");
      const metadata = store.readProcessExecution(cardId, entry.name, layout);
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        !("executionId" in metadata) ||
        metadata.executionId !== entry.name ||
        result.has(entry.name)
      )
        throw new Error(
          `Missing, duplicate or invalid process evidence: ${layout}/${entry.name}/execution.json`,
        );
      result.set(entry.name, { file, metadata: metadata as Record<string, unknown> });
    }
  }
  return result;
}

export function processInventoryEntryStopped(evidence: Record<string, unknown>): boolean {
  return (
    (evidence.status === "not-dispatched" &&
      evidence.dispatchState === "not-dispatched" &&
      evidence.pid === undefined) ||
    (evidence.treeStopped === true &&
      [
        "success",
        "nonzero",
        "timeout",
        "interrupted",
        "evidence-failure",
        "spawn-failure",
      ].includes(String(evidence.status))) ||
    (evidence.status === "spawn-failure" &&
      evidence.dispatchState === "not-dispatched" &&
      evidence.pid === undefined)
  );
}
