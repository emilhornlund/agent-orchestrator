import { describe, expect, it } from "vitest";

import { buildValidationPromptLines } from "../src/opencode/build-validation-prompt.js";

describe("buildValidationPromptLines", () => {
  it("instructs the agent to run the configured command exactly", () => {
    expect(buildValidationPromptLines("yarn build && yarn validate")).toEqual([
      "Run the configured repository validation command: `yarn build && yarn validate` before finishing.",
      "Leave the repository validation passing before finishing.",
    ]);
  });

  it("instructs the agent to use appropriate repository checks without a command", () => {
    expect(buildValidationPromptLines()).toEqual([
      "Run the repository's appropriate validation checks.",
      "Leave the repository validation passing before finishing.",
    ]);
  });
});
