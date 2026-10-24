import { z } from "zod";

const stableId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Must be a nonempty stable ID");

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank",
});

const requirementSchema = z.strictObject({
  id: stableId,
  text: nonEmptyText,
  verification: nonEmptyText,
});

const implementationStepSchema = z.strictObject({
  id: stableId,
  description: nonEmptyText,
  requirementIds: z.array(stableId).min(1),
  verification: nonEmptyText,
});

const taskPlanSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: stableId,
    cardId: stableId,
    requirements: z.array(requirementSchema).min(1),
    steps: z.array(implementationStepSchema).min(1),
    assumptions: z.array(nonEmptyText),
    blockers: z.array(nonEmptyText),
  })
  .superRefine((plan, ctx) => {
    const requirementIds = new Set<string>();

    for (const [index, requirement] of plan.requirements.entries()) {
      if (requirementIds.has(requirement.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: `Duplicate requirement ID: ${requirement.id}`,
        });
      }

      requirementIds.add(requirement.id);
    }

    const stepIds = new Set<string>();
    const coveredRequirementIds = new Set<string>();

    for (const [index, step] of plan.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Duplicate implementation step ID: ${step.id}`,
        });
      }

      stepIds.add(step.id);

      const stepRequirementIds = new Set<string>();

      for (const [
        requirementIndex,
        requirementId,
      ] of step.requirementIds.entries()) {
        if (stepRequirementIds.has(requirementId)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "requirementIds", requirementIndex],
            message: `Duplicate requirement reference: ${requirementId}`,
          });
        }

        stepRequirementIds.add(requirementId);

        if (!requirementIds.has(requirementId)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "requirementIds", requirementIndex],
            message: `Unknown requirement reference: ${requirementId}`,
          });
        } else {
          coveredRequirementIds.add(requirementId);
        }
      }
    }

    for (const [index, requirement] of plan.requirements.entries()) {
      if (!coveredRequirementIds.has(requirement.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: `Requirement is not covered by an implementation step: ${requirement.id}`,
        });
      }
    }
  });

export type TaskPlan = z.infer<typeof taskPlanSchema>;

export function parseTaskPlan(value: unknown): TaskPlan {
  return taskPlanSchema.parse(value);
}
