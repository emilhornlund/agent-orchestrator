import { describe, expect, it } from "vitest";

import {
  EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER,
  MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
  presentExternalDiagnostic,
} from "../src/security/bounded-diagnostic.js";
import { formatFailureDiagnostic } from "../src/orchestrator/failure-diagnostic.js";
import { WorkflowError } from "../src/orchestrator/workflow-error.js";

describe("bounded external diagnostics", () => {
  it("leaves under-limit and boundary values unchanged", () => {
    const underLimit = "diagnostic";
    const boundary = "x".repeat(MAX_EXTERNAL_DIAGNOSTIC_LENGTH);

    expect(presentExternalDiagnostic(underLimit)).toBe(underLimit);
    expect(presentExternalDiagnostic(boundary)).toBe(boundary);
  });

  it("truncates oversized values deterministically within the limit", () => {
    const value = "x".repeat(MAX_EXTERNAL_DIAGNOSTIC_LENGTH + 100);
    const expected = `${"x".repeat(
      MAX_EXTERNAL_DIAGNOSTIC_LENGTH -
        EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER.length,
    )}${EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER}`;

    expect(presentExternalDiagnostic(value)).toBe(expected);
    expect(presentExternalDiagnostic(value)).toHaveLength(
      MAX_EXTERNAL_DIAGNOSTIC_LENGTH,
    );
  });

  it("redacts before truncating so oversized secrets are not exposed", () => {
    const secret = "original-secret-value";
    const value = `${"x".repeat(MAX_EXTERNAL_DIAGNOSTIC_LENGTH)} ${secret}`;

    const presented = presentExternalDiagnostic(value, [secret]);

    expect(presented).not.toContain(secret);
    expect(presented).toContain(EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER);
    expect(presented).toHaveLength(MAX_EXTERNAL_DIAGNOSTIC_LENGTH);
  });

  it("keeps project diagnostic context around bounded values", () => {
    const failure = new WorkflowError(
      "Setup",
      `authorization=private-token ${"validation output ".repeat(300)}`,
    );
    const diagnostic = formatFailureDiagnostic(failure, {
      sessionLogPath: "logs/sessions/project/card.log",
      handlingOutcome: "recovery guidance ".repeat(300),
    });

    expect(diagnostic).toContain("Category: Setup");
    expect(diagnostic).toContain("Session log: logs/sessions/project/card.log");
    expect(diagnostic).toContain("Failure handling: ");
    expect(diagnostic).toContain(EXTERNAL_DIAGNOSTIC_TRUNCATION_MARKER);
    expect(diagnostic).not.toContain("private-token");
  });
});
