import { describe, expect, it } from "vitest";

import {
  buildPullRequestDescriptionPrompt,
  type PullRequestDescriptionPromptContext,
} from "../src/opencode/build-pull-request-description-prompt.js";
import {
  MAX_PULL_REQUEST_DESCRIPTION_CHANGES,
  MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH,
  MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH,
  MAX_PULL_REQUEST_DESCRIPTION_VALIDATION,
  parsePullRequestDescription,
} from "../src/opencode/pull-request-description.js";
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
    expect(prompt).toContain("Return exactly one JSON object.");
    expect(prompt).toContain(
      "Do not include an introduction, explanation, Markdown, code fences, or any text before or after the JSON object.",
    );
    expect(prompt).toContain("The response must start with { and end with }.");
    expect(prompt).toContain(
      "The summary must be at most 1000 characters; changes and validation may each contain at most 20 and 20 items respectively, and every item must be at most 500 characters.",
    );
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

  it("parses valid JSON wrapped in one JSON Markdown fence", () => {
    expect(
      parsePullRequestDescription(
        [
          "```json",
          JSON.stringify({
            summary: "Added structured pull request descriptions.",
            changes: ["Added the generation stage."],
            validation: ["yarn validate passed."],
          }),
          "```",
        ].join("\n"),
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

  it("accepts empty changes and validation arrays", () => {
    expect(
      parsePullRequestDescription(
        JSON.stringify({
          summary: "No generated details are available.",
          changes: [],
          validation: [],
        }),
      ),
    ).toEqual({
      summary: "No generated details are available.",
      changes: [],
      validation: [],
    });
  });

  it("accepts values exactly at every configured boundary", () => {
    expect(
      parsePullRequestDescription(
        JSON.stringify({
          summary: "s".repeat(MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH),
          changes: Array.from(
            { length: MAX_PULL_REQUEST_DESCRIPTION_CHANGES },
            () => "c".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH),
          ),
          validation: Array.from(
            { length: MAX_PULL_REQUEST_DESCRIPTION_VALIDATION },
            () => "v".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH),
          ),
        }),
      ),
    ).toEqual({
      summary: "s".repeat(MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH),
      changes: Array.from(
        { length: MAX_PULL_REQUEST_DESCRIPTION_CHANGES },
        () => "c".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH),
      ),
      validation: Array.from(
        { length: MAX_PULL_REQUEST_DESCRIPTION_VALIDATION },
        () => "v".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH),
      ),
    });
  });

  it.each([
    ["plain text", "not JSON", "not valid JSON"],
    [
      "conversational prose containing JSON",
      'I\'ll inspect this first... {"summary":"A summary","changes":[],"validation":[]}',
      "not valid JSON",
    ],
    ["malformed fenced JSON", '```json\n{"summary":\n```', "not valid JSON"],
    [
      "fenced JSON with missing fields",
      "```json\n{}\n```",
      "missing required field",
    ],
    ["missing fields", '{"summary":"A summary"}', "missing required field"],
    [
      "missing validation information",
      '{"summary":"A summary","changes":[]}',
      'missing required field "validation"',
    ],
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
    [
      "oversized summary",
      JSON.stringify({
        summary: "s".repeat(MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH + 1),
        changes: [],
        validation: [],
      }),
      `summary must not exceed ${MAX_PULL_REQUEST_DESCRIPTION_SUMMARY_LENGTH} characters`,
    ],
    [
      "too many changes",
      JSON.stringify({
        summary: "A summary",
        changes: Array.from(
          { length: MAX_PULL_REQUEST_DESCRIPTION_CHANGES + 1 },
          () => "A change",
        ),
        validation: [],
      }),
      `changes must not contain more than ${MAX_PULL_REQUEST_DESCRIPTION_CHANGES} items`,
    ],
    [
      "too many validation entries",
      JSON.stringify({
        summary: "A summary",
        changes: [],
        validation: Array.from(
          { length: MAX_PULL_REQUEST_DESCRIPTION_VALIDATION + 1 },
          () => "A result",
        ),
      }),
      `validation must not contain more than ${MAX_PULL_REQUEST_DESCRIPTION_VALIDATION} items`,
    ],
    [
      "oversized change item",
      JSON.stringify({
        summary: "A summary",
        changes: ["c".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH + 1)],
        validation: [],
      }),
      `changes[0] must not exceed ${MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH} characters`,
    ],
    [
      "oversized validation item",
      JSON.stringify({
        summary: "A summary",
        changes: [],
        validation: ["v".repeat(MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH + 1)],
      }),
      `validation[0] must not exceed ${MAX_PULL_REQUEST_DESCRIPTION_ITEM_LENGTH} characters`,
    ],
  ])("rejects %s", (_name, output, diagnostic) => {
    expect(() => parsePullRequestDescription(output)).toThrow(diagnostic);
  });
});
