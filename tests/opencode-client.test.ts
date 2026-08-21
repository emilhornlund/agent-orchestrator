import { describe, expect, it, vi } from "vitest";

import {
  OpenCodeClient,
  type RunOpenCode,
} from "../src/opencode/opencode-client.js";

describe("OpenCodeClient", () => {
  it("runs OpenCode with the provided options", async () => {
    const runOpenCode = vi.fn<RunOpenCode>().mockResolvedValue({
      exitCode: 0,
    });

    const client = new OpenCodeClient(runOpenCode);

    const result = await client.run({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      prompt: "Implement the task",
    });

    expect(runOpenCode).toHaveBeenCalledWith({
      cwd: "/worktree",
      model: "openai/gpt-5.6-luna",
      variant: "xhigh",
      prompt: "Implement the task",
    });

    expect(result).toEqual({
      exitCode: 0,
    });
  });
});
