import { describe, expect, it } from "vitest";

import {
  buildPullRequestDescriptionPrompt,
  type PullRequestDescriptionPromptContext,
} from "../src/opencode/build-pull-request-description-prompt.js";
import { parsePullRequestDescription } from "../src/opencode/pull-request-description.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const card: TrelloCard = {
  id: "card-1",
  name: "Add structured descriptions",
  desc: "Describe the final implementation accurately.",
  idList: "working",
  idLabels: [],
  url: "https://trello.example/card-1",
};

const context: PullRequestDescriptionPromptContext = {
  changedFiles: "src/description.ts\ntests/description.test.ts",
  commitSha: "abc123",
  commitMessage: "feat(workflow): describe completed changes",
  validationResults: ["yarn validate: passed", "Automated review: passed"],
};

describe("buildPullRequestDescriptionPrompt", () => {
  it("includes Trello, Git, commit, and validation context", () => {
    const prompt = buildPullRequestDescriptionPrompt(card, context);

    expect(prompt).toContain("Trello card title: Add structured descriptions");
    expect(prompt).toContain(
      "Trello card description:\nDescribe the final implementation accurately.",
    );
    expect(prompt).toContain("Trello card URL: https://trello.example/card-1");
    expect(prompt).toContain("src/description.ts\ntests/description.test.ts");
    expect(prompt).toContain("Resulting commit SHA: abc123");
    expect(prompt).toContain(
      "Commit message:\nfeat(workflow): describe completed changes",
    );
    expect(prompt).toContain("- yarn validate: passed");
    expect(prompt).toContain("Return exactly one JSON object");
  });

  it("makes unavailable validation information explicit", () => {
    const prompt = buildPullRequestDescriptionPrompt(card, {
      ...context,
      validationResults: [],
    });

    expect(prompt).toContain(
      "No validation or test results are available; do not infer or claim success.",
    );
  });
});

describe("parsePullRequestDescription", () => {
  it("parses the exact structured contract", () => {
    expect(
      parsePullRequestDescription(
        JSON.stringify({
          summary: "Added structured pull request descriptions.",
          changes: ["Added the generation stage."],
          validation: ["yarn validate passed."],
        }),
      ),
    ).toEqual({
      summary: "Added structured pull request descriptions.",
      changes: ["Added the generation stage."],
      validation: ["yarn validate passed."],
    });
  });

  it("accepts an empty validation array", () => {
    expect(
      parsePullRequestDescription(
        JSON.stringify({
          summary: "Added the contract.",
          changes: ["Added strict parsing."],
          validation: [],
        }),
      ).validation,
    ).toEqual([]);
  });

  it.each([
    ["plain text", "not JSON", "not valid JSON"],
    ["Markdown-wrapped JSON", "```json\n{}\n```", "not valid JSON"],
    ["missing fields", '{"summary":"A summary"}', "missing required field"],
    [
      "blank summary",
      '{"summary":" ","changes":[],"validation":[]}',
      "summary must not be blank",
    ],
    [
      "wrong array item type",
      '{"summary":"A summary","changes":[1],"validation":[]}',
      "changes[0] must be a string",
    ],
    [
      "unexpected fields",
      '{"summary":"A summary","changes":[],"validation":[],"extra":true}',
      "unexpected field(s): extra",
    ],
  ])("rejects %s", (_name, output, diagnostic) => {
    expect(() => parsePullRequestDescription(output)).toThrow(diagnostic);
  });
});
