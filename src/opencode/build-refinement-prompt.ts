import type { TrelloCard } from "../trello/trello-client.js";
import {
  buildRefinementResultContractPromptLines,
  refinementResultContract,
  refinementResultRelativePath,
} from "../refinement/refinement-result.js";
import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";

const featureTemplate = `# <Feature Title>

## Description

Implement <feature or capability> so that <user, developer, or system benefit>.

The feature should <briefly describe its scope, behavior, and how it fits into the existing project>.

This task includes <important included work>. It does not include <explicitly excluded or deferred work>.

## Goals

- Provide <primary capability or outcome>.
- Support <important use case or workflow>.
- Integrate with <relevant existing module, system, or contract>.
- Keep <important architectural or usability quality>.
- Document <new behavior, contract, or workflow>.

## Requirements

- <Required behavior or supported scenario>.
- <Required data, API, asset, or runtime contract>.
- Preserve <relevant compatibility or architectural boundary>.
- Handle <important edge cases and failure conditions>.
- Provide clear and actionable diagnostics for <failure cases>.
- Add or update tests covering <core behavior and edge cases>.
- Update the relevant documentation.
- Run the repository's appropriate validation checks successfully before considering the task complete.`;

const improvementTemplate = `# <Improvement Title>

## Description

Improve <existing component, workflow, or behavior> by <briefly describe the desired improvement>.

Focus on <maintainability, performance, usability, diagnostics, consistency, or another quality>. The existing
<public behavior, data format, workflow, or compatibility guarantee> should remain unchanged unless explicitly stated.

This is a focused improvement task. Do not introduce <unrelated features, broad refactors, or speculative changes>.

## Goals

- Improve <specific quality or behavior>.
- Simplify or clarify <relevant code, workflow, or contract>.
- Remove <known inefficiency, inconsistency, duplication, or maintenance burden>.
- Keep the solution easy to understand, test, and maintain.
- Update documentation where the improvement affects documented behavior or guidance.

## Requirements

- Preserve existing functionality and compatibility.
- Keep changes limited to <intended scope>.
- Follow the project's existing architecture and conventions.
- Avoid unnecessary abstractions or premature optimization.
- Retain or improve diagnostics and failure handling.
- Add or update tests for any affected behavior.
- Verify that existing tests continue to pass.
- Run the repository's appropriate validation checks successfully before considering the task complete.`;

const bugTemplate = `# <Bug Title>

## Description

Fix an issue where <describe the incorrect behavior>.

When <trigger or conditions>, <actual behavior> occurs instead of <expected behavior>. This affects <users, systems,
platforms, data, or workflows>.

## Reproduction

1. <First step or precondition>.
2. <Action that triggers the issue>.
3. <Observed result>.

## Expected Behavior

<Describe the correct observable behavior.>

## Goals

- Identify and fix the root cause of <issue>.
- Restore <expected behavior>.
- Prevent the issue from recurring through automated test coverage.
- Preserve unaffected behavior and compatibility.

## Requirements

- Fix the root cause rather than only suppressing the symptom.
- Keep the change focused on the reported issue.
- Handle <relevant edge cases, malformed input, concurrency, platform differences, or failure paths>.
- Preserve existing behavior outside the affected scenario.
- Add a regression test that fails without the fix and passes with it.
- Keep diagnostics clear and actionable where applicable.
- Update documentation if the fix changes documented behavior or constraints.
- Run the repository's appropriate validation checks successfully before considering the task complete.`;

export function buildRefinementPrompt(
  card: TrelloCard,
  attachmentContext?: CardAttachmentPromptContext,
): string {
  const description = card.desc.trim();

  return [
    "Refine the following Trello task into an implementation-ready engineering task.",
    "",
    `Original title: ${card.name}`,
    "",
    description.length > 0
      ? `Original description:\n${description}`
      : "No original task description was provided.",
    ...buildCardAttachmentPromptLines(attachmentContext),
    "",
    "Inspect the repository as needed to understand the existing implementation, architecture, tests, documentation, and conventions.",
    "Use repository evidence together with the original Trello task to clarify the intended work.",
    "Preserve the original intent and keep the task focused.",
    "Do not expand the task into unrelated work or speculative improvements.",
    "Do not invent requirements that are unsupported by either the original task or repository evidence.",
    "",
    "Classify the task as exactly one of:",
    ...refinementResultContract.type.values.map((type) => `- ${type}`),
    "",
    "Use the corresponding task template provided below for the refined description.",
    "Replace placeholder text with concrete task-specific content.",
    "Remove sections or bullets that genuinely do not apply.",
    "Preserve sections that are relevant.",
    "Describe desired outcomes, observable behavior, constraints, edge cases, tests, and documentation expectations.",
    "Do not prescribe a specific implementation unless the original task or repository requires that approach.",
    "",
    "The validation instructions inside the templates describe requirements for the eventual implementation task.",
    "They do not authorize you to implement the task during this refinement session.",
    "",
    "You may improve the Trello card title when the existing title is vague, inaccurate, or insufficiently specific.",
    "",
    "Do not modify repository implementation files.",
    "Do not modify tests, documentation, configuration, or other repository files.",
    "Do not create commits.",
    "Do not create branches.",
    "Do not push anything.",
    "Do not create or modify pull requests.",
    "",
    "Your only permitted repository write is the refinement result file:",
    refinementResultRelativePath,
    "",
    "Create any parent directory required for that result file.",
    "",
    ...buildRefinementResultContractPromptLines(),
    "",
    "Write exactly one JSON object to that file with this shape:",
    "",
    "{",
    '  "title": "<refined Trello card title>",',
    '  "description": "<complete Markdown task description using the selected template>",',
    `  "type": "${refinementResultContract.type.values.join(" | ")}"`,
    "}",
    "",
    "Do not add additional JSON fields.",
    "The file must contain valid JSON, not a Markdown code fence.",
    "The description value must contain the complete selected Markdown task template after refinement.",
    "Do not use the agent response text as the refinement result.",
    `The refinement is complete only when ${refinementResultRelativePath} has been written successfully.`,
    "",
    "Feature template:",
    "",
    featureTemplate,
    "",
    "Improvement template:",
    "",
    improvementTemplate,
    "",
    "Bug template:",
    "",
    bugTemplate,
  ].join("\n");
}
