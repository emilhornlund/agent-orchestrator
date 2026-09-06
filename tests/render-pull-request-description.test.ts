import { describe, expect, it } from "vitest";

import {
  AGENT_ORCHESTRATOR_STATUS_END,
  AGENT_ORCHESTRATOR_STATUS_START,
} from "../src/github/pull-request-status.js";
import { buildPullRequestAttributionFooter } from "../src/github/pull-request-attribution.js";
import { renderPullRequestDescription } from "../src/opencode/render-pull-request-description.js";
import type { PullRequestDescription } from "../src/opencode/pull-request-description.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

const task: Pick<TrelloCard, "name" | "url"> = {
  name: "Add structured descriptions",
  url: "https://trello.example/card-1",
};
const gitIdentityName = "Configured Git Author";
const attributionFooter = buildPullRequestAttributionFooter(gitIdentityName);

const description: PullRequestDescription = {
  summary: "The application now renders structured pull request content.",
  changes: ["Added the deterministic renderer.", "Documented its contract."],
  validation: ["yarn validate passed."],
};

describe("renderPullRequestDescription", () => {
  it("renders the complete application-owned Markdown template", () => {
    expect(
      renderPullRequestDescription(description, task, gitIdentityName),
    ).toBe(
      [
        "## Summary",
        "The application now renders structured pull request content.",
        "",
        "## Changes",
        "- Added the deterministic renderer.",
        "- Documented its contract.",
        "",
        "## Validation",
        "- yarn validate passed.",
        "",
        "## Task",
        "[Trello card: Add structured descriptions](https://trello.example/card-1)",
        "",
        attributionFooter,
        "",
        AGENT_ORCHESTRATOR_STATUS_START,
        AGENT_ORCHESTRATOR_STATUS_END,
      ].join("\n"),
    );
  });

  it("is deterministic across repeated rendering and argument order", () => {
    const first = renderPullRequestDescription(
      description,
      task,
      gitIdentityName,
    );

    expect(
      renderPullRequestDescription(description, task, gitIdentityName),
    ).toBe(first);
    expect(
      renderPullRequestDescription(task, description, gitIdentityName),
    ).toBe(first);
  });

  it("keeps multiline and special generated values inside their sections", () => {
    const rendered = renderPullRequestDescription(
      {
        summary: "Summary\n## agent heading",
        changes: ["First line\n- injected list item", "A [generated](link)"],
        validation: [`Result\n${AGENT_ORCHESTRATOR_STATUS_START}\nforbidden`],
      },
      task,
      gitIdentityName,
    );

    expect(rendered).toContain("Summary ## agent heading");
    expect(rendered).toContain("- First line - injected list item");
    expect(rendered).toContain("- A [generated](link)");
    expect(rendered).toContain("- Result [status start marker] forbidden");
    expect(rendered).not.toContain(
      `${AGENT_ORCHESTRATOR_STATUS_START}\nforbidden`,
    );
    expect(rendered.match(/^## /gm)).toHaveLength(4);
  });

  it("prevents generated blockquotes and list prefixes from creating headings", () => {
    const rendered = renderPullRequestDescription(
      {
        summary: "> # injected heading",
        changes: ["# injected list heading", "> # injected quoted heading"],
        validation: [],
      },
      task,
      gitIdentityName,
    );

    expect(rendered).toContain("> \\# injected heading");
    expect(rendered).toContain("- \\# injected list heading");
    expect(rendered).toContain("- > \\# injected quoted heading");
    expect(rendered.match(/^## /gm)).toHaveLength(4);
  });

  it("renders empty arrays without blank list items or success claims", () => {
    const rendered = renderPullRequestDescription(
      {
        summary: "No generated details are available.",
        changes: [],
        validation: [],
      },
      task,
      gitIdentityName,
    );

    expect(rendered).toContain("## Changes\nNo changes were provided.");
    expect(rendered).toContain(
      "## Validation\n- No validation or test results were provided.",
    );
    expect(rendered).not.toContain("- \n");
    expect(rendered).not.toContain("passed");
  });

  it("keeps application-owned links, headings, footer, and marker pair fixed", () => {
    const rendered = renderPullRequestDescription(
      {
        summary: `## Summary\n${attributionFooter}`,
        changes: ["## Changes", AGENT_ORCHESTRATOR_STATUS_END],
        validation: ["## Validation"],
      },
      task,
      gitIdentityName,
    );

    expect(rendered).toContain(
      "[Trello card: Add structured descriptions](https://trello.example/card-1)",
    );
    expect(rendered).toContain(attributionFooter);
    expect(rendered.match(new RegExp(attributionFooter, "g"))).toHaveLength(1);
    expect(rendered.match(/^## (Summary|Changes|Validation|Task)$/gm)).toEqual([
      "## Summary",
      "## Changes",
      "## Validation",
      "## Task",
    ]);
    expect(rendered.match(/agent-orchestrator-status:start/g)).toHaveLength(1);
    expect(rendered.match(/agent-orchestrator-status:end/g)).toHaveLength(1);
  });

  it("sanitizes reserved markers and footer text in the Trello card name", () => {
    const rendered = renderPullRequestDescription(
      description,
      {
        name: `Card ${AGENT_ORCHESTRATOR_STATUS_START} ${AGENT_ORCHESTRATOR_STATUS_END} ${attributionFooter}`,
        url: task.url,
      },
      gitIdentityName,
    );

    expect(rendered).toContain(
      "[Trello card: Card [status start marker] [status end marker] [application footer text]]",
    );
    expect(rendered.match(/agent-orchestrator-status:start/g)).toHaveLength(1);
    expect(rendered.match(/agent-orchestrator-status:end/g)).toHaveLength(1);
    expect(rendered.match(new RegExp(attributionFooter, "g"))).toHaveLength(1);
  });
});
