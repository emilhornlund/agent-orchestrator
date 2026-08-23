import { describe, expect, it } from "vitest";

import { buildCommitPrompt } from "../src/opencode/build-commit-prompt.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

describe("buildCommitPrompt", () => {
  it("includes the task and commit rules", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Add player inventory",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-123",
    };

    const prompt = buildCommitPrompt(card);

    expect(prompt).toContain("Task: Add player inventory");
    expect(prompt).toContain("type(scope): summary");
    expect(prompt).toContain("Create exactly one commit.");
    expect(prompt).toContain("Do not push anything.");
    expect(prompt).toContain("Do not include AI attribution.");
  });

  it("requires shell-safe multiline commit messages", () => {
    const card: TrelloCard = {
      id: "card-123",
      name: "Add player inventory",
      desc: "",
      idList: "working",
      url: "https://trello.example/card-123",
    };

    const prompt = buildCommitPrompt(card);

    expect(prompt).toContain(
      "Do not encode line breaks as literal \\n sequences in git command arguments.",
    );

    expect(prompt).toContain(
      "After committing, inspect the final commit message with `git log -1 --format=%B`.",
    );

    expect(prompt).toContain("amend that same commit to correct the message");
  });
});
