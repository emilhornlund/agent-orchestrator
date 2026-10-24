import { describe, expect, it } from "vitest";

import { parseTaskPlan, type TaskPlan } from "../src/task-session/task-plan.js";

const plan: TaskPlan = {
  version: 1,
  projectId: "project-one",
  cardId: "card-one",
  requirements: [
    {
      id: "REQ-1",
      text: "Preserve the original card requirements.",
      verification: "Compare each planned requirement to its source card text.",
    },
    {
      id: "REQ-2",
      text: "Use deterministic local tests.",
      verification: "Run the focused Vitest suite with mocked dependencies.",
    },
  ],
  steps: [
    {
      id: "STEP-1",
      description: "Implement the required behavior.",
      requirementIds: ["REQ-1"],
      verification: "Review the implementation against REQ-1.",
    },
    {
      id: "STEP-2",
      description: "Add deterministic tests for the behavior.",
      requirementIds: ["REQ-1", "REQ-2"],
      verification: "Run the focused Vitest suite.",
    },
  ],
  assumptions: ["The task card remains the authoritative source."],
  blockers: [],
};

describe("parseTaskPlan", () => {
  it("round-trips a complete validated plan through JSON", () => {
    const decoded = JSON.parse(JSON.stringify(plan)) as unknown;

    expect(parseTaskPlan(decoded)).toEqual(plan);
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
  ])("rejects %s original requirements", (_description, requirements) => {
    expect(() => parseTaskPlan({ ...plan, requirements })).toThrow();
  });

  it.each([
    ["requirement", { ...plan.requirements[0]!, id: "REQ-1" }],
    ["step", { ...plan.steps[0]!, id: "STEP-1" }],
  ])("rejects duplicate %s IDs", (kind, duplicate) => {
    const candidate =
      kind === "requirement"
        ? { ...plan, requirements: [...plan.requirements, duplicate] }
        : { ...plan, steps: [...plan.steps, duplicate] };

    expect(() => parseTaskPlan(candidate)).toThrow("Duplicate");
  });

  it.each([
    ["empty step list", { ...plan, steps: [] }],
    [
      "blank step description",
      {
        ...plan,
        steps: [{ ...plan.steps[0]!, description: " " }, plan.steps[1]!],
      },
    ],
    [
      "step without verification",
      {
        ...plan,
        steps: [{ ...plan.steps[0]!, verification: "" }, plan.steps[1]!],
      },
    ],
    [
      "step without requirements",
      {
        ...plan,
        steps: [{ ...plan.steps[0]!, requirementIds: [] }, plan.steps[1]!],
      },
    ],
  ])("rejects a malformed plan: %s", (_description, candidate) => {
    expect(() => parseTaskPlan(candidate)).toThrow();
  });

  it("rejects unknown or duplicate requirement references", () => {
    expect(() =>
      parseTaskPlan({
        ...plan,
        steps: [
          { ...plan.steps[0]!, requirementIds: ["REQ-UNKNOWN"] },
          plan.steps[1],
        ],
      }),
    ).toThrow("Unknown requirement reference");

    expect(() =>
      parseTaskPlan({
        ...plan,
        steps: [
          { ...plan.steps[0]!, requirementIds: ["REQ-1", "REQ-1"] },
          plan.steps[1],
        ],
      }),
    ).toThrow("Duplicate requirement reference");
  });

  it("requires every original requirement to be covered by a step", () => {
    expect(() =>
      parseTaskPlan({
        ...plan,
        steps: [
          { ...plan.steps[0]!, requirementIds: ["REQ-1"] },
          { ...plan.steps[1]!, requirementIds: ["REQ-1"] },
        ],
      }),
    ).toThrow("not covered by an implementation step");
  });

  it.each([
    ["unknown top-level field", { ...plan, unexpected: true }],
    [
      "unknown requirement field",
      {
        ...plan,
        requirements: [
          { ...plan.requirements[0]!, optional: true },
          plan.requirements[1],
        ],
      },
    ],
  ])("rejects an %s", (_description, candidate) => {
    expect(() => parseTaskPlan(candidate)).toThrow("Unrecognized key");
  });
});
