import { z } from "zod";
import type { ProjectRunAuthority } from "./project-run-authority.js";

export const terminalCleanupKey = "terminal-resource-cleanup";
export const cleanupRetryLimit = 3;
export const cleanupRetryDelayMs = 60_000;
export const terminalCleanupSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["pending", "removed", "preserved", "retryable-failure"]),
  attempts: z.number().int().min(0).max(cleanupRetryLimit),
  updatedAt: z.string().datetime(),
  retryAt: z.string().datetime().nullable(),
  archiveRoot: z.string().min(1).optional(),
  reason: z.enum([
    "inspection",
    "safety",
    "interrupted-work",
    "tool-failure",
    "retry-limit",
    "removed",
  ]),
  archive: z
    .array(
      z.strictObject({
        relativePath: z.string().min(1),
        device: z.string().regex(/^\d+$/u),
        inode: z.string().regex(/^\d+$/u),
      }),
    )
    .default([]),
});
export type TerminalCleanupState = z.infer<typeof terminalCleanupSchema>;

export function readTerminalCleanup(authority: ProjectRunAuthority): TerminalCleanupState | null {
  return authority.read(terminalCleanupKey, (value) => terminalCleanupSchema.parse(value));
}

export function writeTerminalCleanup(
  authority: ProjectRunAuthority,
  state: TerminalCleanupState,
): void {
  authority.mutate(
    terminalCleanupKey,
    state,
    () => ({ value: state, result: undefined }),
    (value) => terminalCleanupSchema.parse(value),
  );
}
