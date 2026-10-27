import { describe, expect, it, vi } from "vitest";

import { runPrMaintenanceReview } from "../src/task-session/run-pr-maintenance-review.js";
import type { ProjectConfig } from "../src/config/config.js";
import type { ImplementationReviewResult } from "../src/task-session/implementation-review-result.js";
import { getSessionLogPath } from "../src/logging/session-log.js";

const identity = "sha256:" + "a".repeat(64);
function fixture(outputs: string[]) {
  const run = vi.fn().mockImplementation(async () => ({
    exitCode: 0,
    output: outputs.shift() ?? "",
    errorOutput: "",
  }));
  const project = {
    id: "project",
    opencode: {
      review: { model: "model", variant: "high" },
      timeoutMinutes: 1,
    },
  } as ProjectConfig;
  const quality = {
    command: "yarn validate",
    startedAt: "2026-10-25T10:00:00.000Z",
    completedAt: "2026-10-25T10:01:00.000Z",
    exitCode: 0,
    status: "passed" as const,
    timedOut: false,
    aborted: false,
    diagnostic: "1163 tests passed",
    contentIdentity: identity,
  };
  const options = {
    openCode: { run } as never,
    project,
    card: { id: "card", name: "Test task", desc: "Test-only" } as never,
    worktreePath: "/repo/trees/card",
    approvedRequirements: [
      { id: "REQ-1", text: "Verify test", verification: "Check test" },
    ],
    changedFiles: "tests/card-start-eligibility.test.ts",
    requirementIds: ["REQ-1"],
    preparedHead: "b".repeat(40),
    contentIdentity: identity,
    validation: quality,
    coverage: null,
    signal: new AbortController().signal,
  };
  return { options, run };
}
function review(verdict: "pass" | "fail", blockingFindings: unknown[]) {
  return JSON.stringify({
    version: 1,
    projectId: "project",
    cardId: "card",
    verdict,
    requirementAssessments: [
      {
        requirementId: "REQ-1",
        status: verdict === "pass" ? "satisfied" : "unsatisfied",
        details: "Evidence inspected",
        evidence: verdict === "pass" ? ["tests/example.test.ts"] : [],
      },
    ],
    blockingFindings,
    reviewedContentIdentity: identity,
  });
}

describe("runPrMaintenanceReview", () => {
  it("keeps process output in the card session log and supplies exact-source validation evidence", async () => {
    const f = fixture([review("pass", [])]);
    const result: ImplementationReviewResult = await runPrMaintenanceReview(
      f.options,
    );
    expect(result.verdict).toBe("pass");
    const call = f.run.mock.calls[0]![0];
    expect(call.sessionLogPath).toBe(getSessionLogPath("project", "card"));
    expect(call.readOnly).toBe(true);
    expect(call.prompt).toContain("1163 tests passed");
    expect(call.prompt).toContain("tests/card-start-eligibility.test.ts");
    expect(call.prompt).toContain("Do NOT mark tests or validation unverified");
    expect(call.prompt).toContain(
      "A blocking finding must be a material issue: an unsatisfied approved requirement, a demonstrable correctness defect, a violation of an applicable repository contract, or a regression introduced by this implementation.",
    );
    expect(call.prompt).toContain(
      "Do not report unrelated refactoring opportunities, stylistic preferences without an applicable contract, optional enhancements beyond approved scope, unsupported hypothetical problems, or requests to redesign an otherwise correct implementation as blocking findings.",
    );
    expect(call.prompt).toContain("Return ONLY one JSON object with exactly");
    expect(call.prompt).toContain(
      "explain concrete evidence demonstrating why it is material and blocks",
    );
    expect(call.prompt).toContain(
      "Serious demonstrable defects remain blocking",
    );
  });

  it("retries a malformed blockingFindings array once without silently discarding findings", async () => {
    const structuredFinding = {
      kind: "incomplete",
      summary: "Missing behavior",
      detail:
        "Defect: the requested behavior is absent. Requirement: REQ-1 requires it. Evidence: src/example.ts returns without applying the behavior. Expected behavior: apply it for the required input.",
    };
    const f = fixture([
      review("fail", ["The required behavior is missing"]),
      review("fail", [structuredFinding]),
    ]);
    const result = await runPrMaintenanceReview(f.options);
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings).toEqual([structuredFinding]);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]![0].prompt).toContain("FORMAT-ONLY CORRECTION");
    expect(f.run.mock.calls[1]![0].sessionLogPath).toBe(
      getSessionLogPath("project", "card"),
    );
  });

  it("rejects malformed review after one format retry, without falsely passing", async () => {
    const f = fixture([review("fail", ["bad"]), review("fail", ["still bad"])]);
    await expect(runPrMaintenanceReview(f.options)).rejects.toThrow(
      /invalid, stale, or out-of-scope evidence/,
    );
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("refuses review when orchestrator quality evidence is stale", async () => {
    const f = fixture([review("pass", [])]);
    f.options.validation.contentIdentity = "sha256:" + "f".repeat(64);
    await expect(runPrMaintenanceReview(f.options)).rejects.toThrow(
      /exact-source quality evidence/,
    );
    expect(f.run).not.toHaveBeenCalled();
  });
});
