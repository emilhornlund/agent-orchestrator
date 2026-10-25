import { ZodError } from "zod";

import type { ProjectConfig } from "../config/config.js";
import { getSessionLogPath } from "../logging/session-log.js";
import type { OpenCodeClient } from "../opencode/opencode-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import {
  parseImplementationReviewResult,
  type ImplementationReviewResult,
} from "./implementation-review-result.js";
import type { TaskSessionValidationResult } from "./run-task-session-validation.js";

export interface RunPrMaintenanceReviewOptions {
  openCode: Pick<OpenCodeClient, "run">;
  project: ProjectConfig;
  card: TrelloCard;
  worktreePath: string;
  changedFiles: string;
  approvedRequirements: readonly {
    id: string;
    text: string;
    verification: string;
  }[];
  requirementIds: readonly string[];
  preparedHead: string;
  contentIdentity: string;
  validation: TaskSessionValidationResult;
  coverage: TaskSessionValidationResult | null;
  signal: AbortSignal;
}

export async function runPrMaintenanceReview(
  options: RunPrMaintenanceReviewOptions,
): Promise<ImplementationReviewResult> {
  if (
    options.validation.status !== "passed" ||
    options.validation.exitCode !== 0 ||
    options.validation.contentIdentity !== options.contentIdentity ||
    (options.coverage !== null &&
      (options.coverage.status !== "passed" ||
        options.coverage.exitCode !== 0 ||
        options.coverage.contentIdentity !== options.contentIdentity))
  )
    throw new Error(
      "Independent maintenance review requires passing exact-source quality evidence",
    );

  const identity = {
    version: 1,
    projectId: options.project.id,
    cardId: options.card.id,
    reviewedContentIdentity: options.contentIdentity,
  };
  const prompt = [
    "Independently review the prepared rebased implementation against each approved requirement. This is a READ-ONLY review: never run commands, edit files, or perform Git/GitHub actions.",
    "Inspect current repository source and tests, not .git internal paths.",
    `Task: ${JSON.stringify({ name: options.card.name, description: options.card.desc })}`,
    `Prepared commit: ${options.preparedHead}`,
    `Approved requirements: ${JSON.stringify(options.approvedRequirements)}`,
    `Committed file paths changed between pinned base and prepared head: ${JSON.stringify(options.changedFiles.split("\n").filter(Boolean))}`,
    `Required assessment IDs: ${JSON.stringify(options.requirementIds)}`,
    `Orchestrator-owned validation and coverage results for this exact source snapshot: ${JSON.stringify({ validation: options.validation, coverage: options.coverage })}`,
    "The orchestrator already ran these commands and verified their exact-source identities. Do NOT mark tests or validation unverified merely because your read-only session cannot execute commands. Assess actual code coverage and correctness independently; successful tests do not automatically imply the requirements are satisfied.",
    "Return ONLY one JSON object with exactly: version, projectId, cardId, verdict ('pass'|'fail'), requirementAssessments, blockingFindings, reviewedContentIdentity.",
    "Every requirementAssessments item has requirementId, status ('satisfied'|'unsatisfied'), details (nonblank string), evidence (array of nonblank strings). Include each requested ID exactly once.",
    "Every blockingFindings entry MUST be an object, NEVER a string: {kind: 'defect'|'incomplete'|'contract-violation', summary: nonblank string, detail: nonblank string, location?: {filePath: repository-relative string, line?: positive integer}}.",
    "Verdict 'pass' requires all requirements satisfied and no blocking findings. A valid 'fail' requires an unsatisfied requirement or a structured blocking finding. Never change a genuine finding just to pass.",
    `Example structured failure: ${JSON.stringify({
      ...identity,
      verdict: "fail",
      requirementAssessments: options.requirementIds.map(
        (requirementId, index) => ({
          requirementId,
          status: index === 0 ? "unsatisfied" : "satisfied",
          details: index === 0 ? "Missing required behavior" : "Implemented",
          evidence: index === 0 ? [] : ["src/example.ts"],
        }),
      ),
      blockingFindings: [
        {
          kind: "incomplete",
          summary: "Missing behavior",
          detail: "The required case is not covered.",
        },
      ],
    })}`,
  ].join("\n\n");

  let previousOutput = "";
  let previousError = "";
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const result = await options.openCode.run({
      cwd: options.worktreePath,
      model: options.project.opencode.review.model,
      variant: options.project.opencode.review.variant,
      timeoutMilliseconds: options.project.opencode.timeoutMinutes * 60_000,
      signal: options.signal,
      readOnly: true,
      sessionLogPath: getSessionLogPath(options.project.id, options.card.id),
      sessionLabel:
        attempt === 0
          ? "PR maintenance independent review"
          : "PR maintenance review format correction",
      prompt:
        attempt === 0
          ? prompt
          : [
              prompt,
              "FORMAT-ONLY CORRECTION: The previous response violated the JSON format. Correct its structure without changing the verdict, findings, assessments or evidence. Do not rerun checks or re-review content.",
              `Contract error: ${previousError}`,
              "Previous response:",
              previousOutput,
            ].join("\n\n"),
    });
    if (result.exitCode !== 0)
      throw new Error(`Maintenance review exited with code ${result.exitCode}`);
    try {
      return parseImplementationReviewResult(
        JSON.parse(result.output) as unknown,
        {
          projectId: options.project.id,
          cardId: options.card.id,
          requirementIds: options.requirementIds,
          contentIdentity: options.contentIdentity,
        },
      );
    } catch (error) {
      if (
        attempt === 1 ||
        !(error instanceof SyntaxError || error instanceof ZodError)
      )
        throw new Error(
          "Independent maintenance review returned invalid, stale, or out-of-scope evidence",
          { cause: error },
        );
      previousOutput = result.output;
      previousError =
        error instanceof Error ? error.message : "Invalid review format";
    }
  }
  throw new Error("PR maintenance review format correction was exhausted");
}
