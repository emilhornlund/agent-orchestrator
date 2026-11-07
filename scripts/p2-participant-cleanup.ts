import type { ChildProcess } from "node:child_process";
import { waitForOwnedProcess, type OwnedProcess } from "./bounded-process.js";

type ConfirmOwnedProcessStopped = typeof waitForOwnedProcess;

/**
 * Confirm every tracked process group is gone, including groups whose direct
 * wrapper already exited. Tracking is removed only after group confirmation.
 */
export async function disposeP2Participants(
  participants: Set<ChildProcess>,
  ownedProcesses: Map<ChildProcess, OwnedProcess>,
  options: {
    timeoutMs: number;
    confirmStopped?: ConfirmOwnedProcessStopped;
  },
): Promise<void> {
  const failures: Error[] = [];
  const confirmStopped = options.confirmStopped ?? waitForOwnedProcess;
  for (const participant of participants) {
    const owned = ownedProcesses.get(participant);
    if (!owned) {
      failures.push(new Error("Participant is missing owned process tracking"));
      continue;
    }
    try {
      await confirmStopped(owned, { timeoutMs: options.timeoutMs });
      participants.delete(participant);
      ownedProcesses.delete(participant);
    } catch (error) {
      failures.push(
        new Error(
          `Could not confirm participant process group ${String(owned.pid)} stopped`,
          { cause: error },
        ),
      );
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "P2 participant cleanup was not confirmed",
    );
}

/** Never discard harness evidence when process or cleanup state is uncertain. */
export function removeP2EvidenceIfClean(
  participants: ReadonlySet<ChildProcess>,
  hasCleanupError: boolean,
  removeEvidence: () => void,
): boolean {
  if (participants.size > 0 || hasCleanupError) return false;
  removeEvidence();
  return true;
}
