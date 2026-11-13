import { describe, expect, it } from "vitest";
// Repository tooling is JavaScript so it runs without a build or product runtime.
// @ts-expect-error The standalone .mjs tool intentionally has no declaration file.
import { checkCoverage, inventory } from "../scripts/spec-audit.mjs";

const requirements = "## Progress\n\n- Preserve state\n  across restart.\n";
const specification = `### REQ-WF-001 — Preserve state

**Acceptance criteria**

- Preserve task state
  across restart.
- Do not duplicate effects.
`;

describe("specification audit inventory and completion gate", () => {
  it("enumerates individual multiline criteria and unnumbered source statements", () => {
    const result = inventory(requirements, specification);
    expect(result.ids).toEqual(["REQ-WF-001"]);
    expect(result.criteria).toEqual([
      {
        key: "REQ-WF-001/AC-01",
        id: "REQ-WF-001",
        line: 5,
        text: "Preserve task state across restart.",
      },
      { key: "REQ-WF-001/AC-02", id: "REQ-WF-001", line: 7, text: "Do not duplicate effects." },
    ]);
    expect(result.statements[0].text).toBe("Preserve state across restart.");
    expect(inventory(requirements, `${specification}\n`).hashes).not.toEqual(result.hashes);
  });

  it("rejects duplicate IDs, missing criteria, and unsupported list syntax", () => {
    expect(() => inventory(requirements, specification + specification)).toThrow("Duplicate ID");
    expect(() => inventory(requirements, "### REQ-WF-001 — Empty")).toThrow(
      "No acceptance criteria",
    );
    expect(() =>
      inventory(requirements, specification.replace("- Preserve", "* Preserve")),
    ).toThrow("Unsupported criterion list");
  });

  it("keeps unverified assessments distinct from skipped, duplicate, and invalid entries", () => {
    const expected = inventory(requirements, specification);
    const matrix = expected.criteria.map((row: { key: string }) => ({
      key: row.key,
      status: "Unverified",
      rationale: "No execution evidence",
      production: "Not traced",
      tests: "Not executed",
      evidence: "Static inspection only",
      gaps: "Restart scenario not exercised",
      findings: [],
    }));
    expect(checkCoverage(expected, matrix)).toEqual({ ids: 1, criteria: 2 });
    expect(() => checkCoverage(expected, matrix.slice(1))).toThrow("Missing criteria");
    expect(() => checkCoverage(expected, [...matrix, matrix[0]])).toThrow("Duplicate criterion");
    expect(() => checkCoverage(expected, [{ ...matrix[0], key: "invented" }])).toThrow("Unknown");
    expect(() => checkCoverage(expected, [{ ...matrix[0], status: "Passed" }])).toThrow("Invalid");
    expect(() => checkCoverage(expected, [{ ...matrix[0], evidence: "" }])).toThrow(
      "Missing evidence",
    );
  });
});
