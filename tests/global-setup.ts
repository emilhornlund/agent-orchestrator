import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

/** Own all filesystem fixtures and child-process artifacts for one test run. */
export default function setup(project: TestProject): () => void {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-tests-"),
  );
  project.config.env ??= {};
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    project.config.env[key] = root;
  }
  return () => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}
