import { z } from "zod";

import type { CardAttachmentPromptContext } from "../context/card-attachment-prompt.js";
import { buildCardAttachmentPromptLines } from "../context/card-attachment-prompt.js";
import type { TaskPlan } from "./task-plan.js";

const stableId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Must be a nonempty stable ID");

const verificationFindingSchema = z.strictObject({
  kind: z.enum([
    "missing-requirement",
    "unsupported-requirement",
    "invented-scope",
  ]),
  requirementId: stableId.optional(),
  detail: z.string().refine((value) => value.trim().length > 0, {
    message: "Finding detail must not be blank",
  }),
});

const planVerificationSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: stableId,
    cardId: stableId,
    planRevision: z.number().int().positive().safe(),
    verdict: z.enum(["pass", "fail"]),
    findings: z.array(verificationFindingSchema),
  })
  .superRefine((result, ctx) => {
    if (result.verdict === "pass" && result.findings.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "A passing plan verification cannot contain blocking findings",
      });
    }

    if (result.verdict === "fail" && result.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "A failed plan verification must contain concrete findings",
      });
    }
  });

export type PlanVerificationFinding = z.infer<typeof verificationFindingSchema>;
export type PlanVerificationResult = z.infer<typeof planVerificationSchema>;

export function parsePlanVerificationResult(
  value: unknown,
): PlanVerificationResult {
  return planVerificationSchema.parse(value);
}

export interface PlanVerificationPromptInput {
  projectId: string;
  cardId: string;
  cardTitle: string;
  cardDescription: string;
  planRevision: number;
  plan: TaskPlan;
  attachmentContext?: CardAttachmentPromptContext;
}

export function buildPlanVerificationPrompt(
  input: PlanVerificationPromptInput,
): string {
  if (
    input.attachmentContext !== undefined &&
    (input.attachmentContext.projectId !== input.projectId ||
      input.attachmentContext.cardId !== input.cardId)
  ) {
    throw new Error(
      "Plan verification attachment context does not match the task project and card",
    );
  }

  return [
    "Independently verify the persisted task plan against the original task. Do not implement the task or modify repository files.",
    "",
    `Task identity: ${JSON.stringify({ projectId: input.projectId, cardId: input.cardId })}`,
    `Original task title: ${JSON.stringify(input.cardTitle)}`,
    "Original task description:",
    input.cardDescription.trim().length > 0
      ? input.cardDescription
      : "No additional description was provided.",
    ...buildCardAttachmentPromptLines(input.attachmentContext),
    `Plan revision: ${input.planRevision}`,
    "Persisted plan to verify:",
    JSON.stringify(input.plan, null, 2),
    "Compare every original task requirement and relevant attachment context against the plan. Report omitted requirements, unsupported or misrepresented requirements, and invented scope. Do not approve based only on formatting or process success.",
    "Return only a JSON object with version, projectId, cardId, planRevision, verdict, and findings. Use verdict 'pass' only when the plan accurately and completely covers the task, with an empty findings array. Use verdict 'fail' with one or more concrete findings otherwise.",
    "Each finding must have kind ('missing-requirement', 'unsupported-requirement', or 'invented-scope'), optional requirementId, and a specific detail. Do not use tools or modify files.",
    JSON.stringify(
      {
        version: 1,
        projectId: input.projectId,
        cardId: input.cardId,
        planRevision: input.planRevision,
        verdict: "pass",
        findings: [],
      },
      null,
      2,
    ),
  ].join("\n");
}
