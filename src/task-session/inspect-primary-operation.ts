import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TaskExecutionStore } from "./task-execution-store.js";
import type { PendingPrimaryInspection, PrimaryOperationEntry } from "./run-primary-operation.js";

const unknown: PendingPrimaryInspection = { status: "unknown" };
/** Inspect only durable process evidence rooted in the trusted task artifact tree. */
export async function inspectPrimaryOperationEvidence(
  store: TaskExecutionStore,
  cardID: string,
  operationID: string,
  identity: { trustedRoot: string; cwd: string },
): Promise<PendingPrimaryInspection> {
  try {
    const entry = store.read(cardID)?.primaryOperations?.[operationID] as
      PrimaryOperationEntry | undefined;
    if (!entry || entry.id !== operationID) return unknown;
    if (entry.status === "intent" && entry.executions === 0) return { status: "never-dispatched" };
    const metadataPath = entry.processMetadataPath;
    if (!metadataPath || !entry.processArtifactRoot || !entry.processExecutionId) return unknown;
    const trusted = fs.realpathSync(identity.trustedRoot);
    const cwd = fs.realpathSync(identity.cwd);
    const root = fs.realpathSync(entry.processArtifactRoot);
    const file = path.resolve(metadataPath);
    if (
      root !== entry.processArtifactRoot ||
      !within(trusted, root) ||
      !within(root, file) ||
      file !== metadataPath ||
      !within(cwd, identity.cwd)
    )
      return unknown;
    assertNoSymlinks(trusted, file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return unknown;
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return unknown;
    const metadata = data as Record<string, unknown>;
    if (metadata.executionId !== entry.processExecutionId || metadata.cwd !== cwd) return unknown;
    if (
      metadata.status === "not-dispatched" ||
      (metadata.status === "spawn-failure" &&
        metadata.dispatchState === "not-dispatched" &&
        metadata.pid === undefined)
    )
      return { status: "never-dispatched" };
    if (
      metadata.status === "success" &&
      typeof metadata.exitCode === "number" &&
      metadata.exitCode === 0 &&
      ["completed", "dispatched", "ambiguous", "failed"].includes(entry.status) &&
      typeof metadata.sessionId === "string" &&
      (entry.lastSessionId === undefined || metadata.sessionId === entry.lastSessionId) &&
      typeof metadata.resultArtifact === "object" &&
      metadata.resultArtifact !== null
    ) {
      const ref = metadata.resultArtifact as Record<string, unknown>;
      if (
        ref.path !== "result.json" ||
        typeof ref.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(ref.sha256)
      )
        return unknown;
      const resultFile = path.join(path.dirname(file), "result.json");
      assertNoSymlinks(trusted, resultFile);
      const resultStat = fs.lstatSync(resultFile);
      if (!resultStat.isFile() || resultStat.size > 700 * 1024) return unknown;
      const bytes = fs.readFileSync(resultFile);
      if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) return unknown;
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
      const payload = value as Record<string, unknown>;
      if (
        payload.exitCode !== 0 ||
        payload.processExecutionId !== entry.processExecutionId ||
        payload.sessionId !== metadata.sessionId ||
        typeof payload.output !== "string" ||
        typeof payload.errorOutput !== "string"
      )
        return unknown;
      return {
        status: "completed",
        result: {
          exitCode: 0,
          output: payload.output,
          errorOutput: payload.errorOutput,
          processExecutionId: entry.processExecutionId,
          sessionId: metadata.sessionId,
        },
      };
    }
    if (
      ["nonzero", "timeout", "interrupted", "spawn-failure"].includes(String(metadata.status)) &&
      metadata.treeStopped === true &&
      Number.isSafeInteger(metadata.exitCode) &&
      (metadata.exitCode !== 0 ||
        metadata.status === "interrupted" ||
        metadata.status === "timeout") &&
      ["failed", "dispatched", "ambiguous"].includes(entry.status)
    ) {
      let failureClassification: "dependency-outage" | "cancelled" | undefined =
        metadata.status === "interrupted" ? "cancelled" : undefined;
      const metadataHasClassification = metadata.failureClassification !== undefined;
      let payload: Record<string, unknown> | undefined;
      if (metadata.resultArtifact !== undefined) {
        if (typeof metadata.resultArtifact !== "object" || metadata.resultArtifact === null)
          return unknown;
        const ref = metadata.resultArtifact as Record<string, unknown>;
        if (
          ref.path !== "result.json" ||
          typeof ref.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(ref.sha256)
        )
          return unknown;
        const resultFile = path.join(path.dirname(file), "result.json");
        assertNoSymlinks(trusted, resultFile);
        const resultStat = fs.lstatSync(resultFile);
        if (!resultStat.isFile() || resultStat.size > 700 * 1024) return unknown;
        const bytes = fs.readFileSync(resultFile);
        if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) return unknown;
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
        payload = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(payload.exitCode) ||
          payload.exitCode !== metadata.exitCode ||
          (payload.exitCode === 0 &&
            metadata.status !== "interrupted" &&
            metadata.status !== "timeout") ||
          payload.processExecutionId !== entry.processExecutionId ||
          payload.sessionId !== metadata.sessionId ||
          typeof payload.output !== "string" ||
          typeof payload.errorOutput !== "string"
        )
          return unknown;
      }
      const payloadHasClassification = payload?.failureClassification !== undefined;
      if (metadataHasClassification || payloadHasClassification) {
        if (
          metadata.failureClassification !== "dependency-outage" ||
          payload?.failureClassification !== "dependency-outage" ||
          entry.lastSessionId === undefined ||
          typeof metadata.sessionId !== "string" ||
          metadata.sessionId !== entry.lastSessionId ||
          payload?.sessionId !== entry.lastSessionId
        )
          return unknown;
        failureClassification = "dependency-outage";
      }
      return {
        status: "stopped-after-dispatch",
        operationId: operationID,
        execution: entry.executions,
        ...(failureClassification === undefined ? {} : { failureClassification }),
        ...(entry.lastSessionId === undefined ? {} : { sessionId: entry.lastSessionId }),
      };
    }
    return unknown;
  } catch {
    return unknown;
  }
}
function within(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function assertNoSymlinks(root: string, file: string): void {
  const rel = path.relative(root, file);
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink component");
  }
}
