import { expect, it } from "vitest";
import {
  publicationQualityFacts,
  ciOutcomeFacts,
  feedbackDispositionFacts,
} from "../src/orchestrator/publication-quality-summary.js";
import type { TaskSessionValidationResult } from "../src/task-session/run-task-session-validation.js";
import { registerProcessSecrets } from "../src/process/process-runtime.js";

const identity = `sha256:${"a".repeat(64)}`;
const result: TaskSessionValidationResult = {
  command: "yarn validate",
  status: "passed",
  exitCode: 0,
  startedAt: "2026-11-14T00:00:00Z",
  completedAt: "2026-11-14T00:01:00Z",
  timedOut: false,
  aborted: false,
  diagnostic: "\u001b[31mRAW_DIAGNOSTIC_CANARY\u001b[0m\n".repeat(500),
  contentIdentity: identity,
};

it("renders concise observed checks and artifact references instead of raw result JSON or terminal output", () => {
  const facts = publicationQualityFacts(
    {
      currentContentIdentity: identity,
      validationCommand: result.command,
      validation: result,
      coverage: { ...result, command: "", status: "skipped", exitCode: null },
      review: null,
    },
    { planAvailable: false, diagnosticLog: "/runtime/history/task/session.log" },
  );
  expect(facts).toContain("Validation: passed; command: yarn validate; exit code 0.");
  expect(facts.some((fact) => fact.includes("Not configured; skipped"))).toBe(true);
  expect(facts.some((fact) => fact.includes("not represented as passed"))).toBe(true);
  expect(facts.join("\n")).toContain("/runtime/history/task/session.log");
  expect(facts.join("\n")).not.toMatch(/RAW_DIAGNOSTIC_CANARY|"diagnostic"|"startedAt"/u);
  expect(facts.join("\n")).not.toContain("\u001b");
  expect(facts.every((fact) => fact.length <= 480 && !fact.includes("\n"))).toBe(true);
});

it.each(["failed", "uncertain", "timed-out", "aborted", "skipped"] as const)(
  "retains configured %s outcomes and stale evidence without claiming success",
  (status) => {
    const facts = publicationQualityFacts({
      currentContentIdentity: identity,
      validationCommand: result.command,
      validation: {
        ...result,
        status,
        exitCode: null,
        contentIdentity: `sha256:${"b".repeat(64)}`,
      },
      coverage: null,
      review: null,
    });
    expect(facts[0]).toContain(`Validation: ${status}`);
    expect(facts[0]).toContain("earlier source snapshot");
    expect(facts[0]).not.toContain("Validation: passed");
  },
);

it("does not call a configured-but-skipped command unconfigured", () => {
  const facts = publicationQualityFacts({
    currentContentIdentity: identity,
    validationCommand: "configured check",
    validation: { ...result, command: "", status: "skipped", exitCode: null },
    coverage: null,
    review: null,
  });
  expect(facts[0]).toContain("Validation: skipped");
  expect(facts[0]).not.toContain("Not configured");
});

it("reports missing and pending CI rather than turning a green subset into a pass", () => {
  const facts = ciOutcomeFacts({
    status: "waiting",
    expectedHeadSha: "a".repeat(40),
    missingChecks: ["Security"],
    pendingChecks: ["Validate"],
    diagnostic: "Waiting for complete checks",
  });
  expect(facts.join("\n")).toContain("not yet observed: Security");
  expect(facts.join("\n")).toContain("Pending checks: Validate");
  expect(facts.join("\n")).not.toContain("Expected checks passed");
});

it("bounds feedback text, redacts known credentials, and keeps unresolved counts visible", () => {
  registerProcessSecrets(["summary-secret-canary"]);
  const facts = feedbackDispositionFacts(
    Array.from({ length: 20 }, (_, index) => ({
      feedbackId: `request-${index}`,
      status: "unresolved" as const,
      reason:
        "\u001b[31msummary-secret-canary\n<!-- agent-orchestrator-status:start -->" +
        "x".repeat(1000),
    })),
  );
  expect(facts[0]).toContain("20 unresolved");
  expect(facts.at(-1)).toContain("15 further unresolved");
  expect(facts.every((fact) => fact.length <= 480)).toBe(true);
  expect(facts.join(" ")).not.toMatch(/summary-secret-canary|<!-- agent-orchestrator/u);
  expect(facts.join(" ")).not.toContain("\u001b");
});
