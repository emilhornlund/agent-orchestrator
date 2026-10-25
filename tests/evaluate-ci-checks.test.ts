import { describe, expect, it } from "vitest";

import type { CiCheckExpectationDecision } from "../src/github/ci-check-expectations.js";
import type { CiCheckObservation } from "../src/github/github-client.js";
import { evaluateCiChecks } from "../src/github/evaluate-ci-checks.js";

const headSha = "a".repeat(40);

function expectations(names: string[]): CiCheckExpectationDecision {
  return {
    status: "complete",
    expectedCheckNames: names,
    sources: ["fixture"],
  };
}

function checkRun(
  name: string,
  status: string,
  conclusion: string | null = null,
  observedHeadSha = headSha,
  id = 1,
): CiCheckObservation {
  return {
    source: "check-run",
    id,
    name,
    status,
    conclusion,
    headSha: observedHeadSha,
    url: null,
  };
}

function commitStatus(
  context: string,
  state: string,
  observedHeadSha = headSha,
  id = 1,
): CiCheckObservation {
  return {
    source: "commit-status",
    id,
    context,
    state,
    headSha: observedHeadSha,
    createdAt: "2026-10-24T10:00:00Z",
    updatedAt: "2026-10-24T10:00:00Z",
    url: null,
    description: null,
  };
}

function evaluate(
  names: string[],
  checks: readonly CiCheckObservation[],
  expectation: CiCheckExpectationDecision = expectations(names),
  observedHead = headSha,
) {
  return evaluateCiChecks({
    expectedHeadSha: headSha,
    observedHeadSha: observedHead,
    expectations: expectation,
    checks,
  });
}

describe("evaluateCiChecks", () => {
  it("passes only when every expected check succeeds on the current head", () => {
    expect(
      evaluate(
        ["Build", "Tests"],
        [
          checkRun("Build", "completed", "success"),
          commitStatus("Tests", "success"),
        ],
      ),
    ).toMatchObject({ status: "passed", expectedHeadSha: headSha });
  });

  it("ignores an authoritatively skipped conditional job absent from the expected set", () => {
    expect(
      evaluate(
        ["Build"],
        [
          checkRun("Build", "completed", "success"),
          checkRun("Optional deployment", "completed", "skipped"),
        ],
      ),
    ).toMatchObject({ status: "passed" });
  });

  it("waits for delayed check registration even when visible checks pass", () => {
    expect(
      evaluate(["Build", "Tests"], [checkRun("Build", "completed", "success")]),
    ).toMatchObject({
      status: "waiting",
      missingChecks: ["Tests"],
    });
  });

  it.each([
    ["queued", null],
    ["in_progress", null],
  ])("waits for a %s expected check", (status, conclusion) => {
    expect(
      evaluate(["Build"], [checkRun("Build", status, conclusion)]),
    ).toMatchObject({ status: "waiting", pendingChecks: ["Build"] });
  });

  it("waits instead of repairing when failures coexist with pending expected checks", () => {
    const result = evaluate(
      ["Build", "Tests"],
      [checkRun("Build", "completed", "failure"), checkRun("Tests", "queued")],
    );
    expect(result).toMatchObject({
      status: "waiting",
      pendingChecks: ["Tests"],
    });
    expect(result).not.toHaveProperty("failures");
  });

  it("collects every failure after the complete expected set becomes terminal", () => {
    expect(
      evaluate(
        ["Build", "Tests"],
        [
          checkRun("Build", "completed", "failure", headSha, 7),
          commitStatus("Tests", "error", headSha, 12),
        ],
      ),
    ).toMatchObject({
      status: "failed",
      failures: [
        expect.objectContaining({ name: "Build", id: 7 }),
        expect.objectContaining({ source: "commit-status", id: 12 }),
      ],
    });
  });

  it.each(["cancelled", "skipped", "neutral"])(
    "marks a %s conclusion uncertain rather than successful or repairable",
    (conclusion) => {
      expect(
        evaluate(["Build"], [checkRun("Build", "completed", conclusion)]),
      ).toMatchObject({ status: "uncertain" });
    },
  );

  it.each(["failure", "error"])(
    "treats commit status %s as a terminal failure",
    (state) => {
      expect(evaluate(["Tests"], [commitStatus("Tests", state)])).toMatchObject(
        {
          status: "failed",
          failures: [
            expect.objectContaining({ source: "commit-status", state }),
          ],
        },
      );
    },
  );

  it("does not pass empty or incomplete expectations", () => {
    expect(evaluate([], [])).toMatchObject({ status: "uncertain" });
    expect(
      evaluate(["Build"], [checkRun("Build", "completed", "success")], {
        status: "uncertain",
        expectedCheckNames: ["Build"],
        diagnostic: "Workflow expectations are dynamic",
      }),
    ).toMatchObject({
      status: "uncertain",
      diagnostic: "Workflow expectations are dynamic",
    });
  });

  it("rejects changed PR heads and stale individual check observations", () => {
    expect(
      evaluate(
        ["Build"],
        [checkRun("Build", "completed", "success")],
        expectations(["Build"]),
        "b".repeat(40),
      ),
    ).toMatchObject({ status: "uncertain" });
    expect(
      evaluate(
        ["Build"],
        [checkRun("Build", "completed", "success", "b".repeat(40))],
      ),
    ).toMatchObject({ status: "uncertain" });
  });
});
