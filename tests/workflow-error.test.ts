import { describe, expect, it } from "vitest";

import { WorkflowError } from "../src/orchestrator/workflow-error.js";

describe("WorkflowError", () => {
  it("preserves its failure category and message", () => {
    const error = new WorkflowError(
      "Validation",
      "Repository validation exited with code 1",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WorkflowError");
    expect(error.category).toBe("Validation");
    expect(error.message).toBe("Repository validation exited with code 1");
  });

  it("preserves an underlying cause", () => {
    const cause = new Error("push failed");

    const error = new WorkflowError("Git/GitHub", cause.message, {
      cause,
    });

    expect(error.category).toBe("Git/GitHub");
    expect(error.cause).toBe(cause);
  });
});
