import { z } from "zod";

const checkNameSchema = z.string().trim().min(1);
const expectationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("repository-rules"),
    sourceId: z.string().trim().min(1),
    complete: z.boolean(),
    checkNames: z.array(checkNameSchema),
    uncertainty: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("workflow-contract"),
    sourceId: z.string().trim().min(1),
    complete: z.boolean(),
    checkNames: z.array(checkNameSchema),
    uncertainty: z.string().trim().min(1).optional(),
  }),
]);

export type CiCheckExpectationSource = z.infer<typeof expectationSourceSchema>;

export type CiCheckExpectationDecision =
  | {
      status: "complete";
      expectedCheckNames: string[];
      sources: string[];
    }
  | {
      status: "uncertain";
      expectedCheckNames: string[];
      diagnostic: string;
    };

function uncertain(
  diagnostic: string,
  expectedCheckNames: string[] = [],
): CiCheckExpectationDecision {
  return {
    status: "uncertain",
    expectedCheckNames,
    diagnostic,
  };
}

/** Establishes CI expectations only from explicit, complete repository contracts. */
export function establishCiCheckExpectations(
  input: unknown,
): CiCheckExpectationDecision {
  if (!Array.isArray(input) || input.length === 0) {
    return uncertain(
      "No authoritative CI check expectation source is available; refusing to treat an empty check set as complete",
    );
  }

  const parsedSources: CiCheckExpectationSource[] = [];
  for (const [index, value] of input.entries()) {
    const parsed = expectationSourceSchema.safeParse(value);
    if (!parsed.success) {
      return uncertain(
        `CI expectation source at index ${index} is malformed or unsupported`,
      );
    }
    parsedSources.push(parsed.data);
  }

  const sourceIds = parsedSources.map(({ sourceId }) => sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    return uncertain("CI expectation source identities are duplicated");
  }

  const expectedCheckNames = new Set<string>();
  for (const source of parsedSources) {
    if (new Set(source.checkNames).size !== source.checkNames.length) {
      return uncertain(
        `CI expectation source ${source.sourceId} contains duplicate check names`,
        [...expectedCheckNames, ...source.checkNames],
      );
    }
    for (const name of source.checkNames) expectedCheckNames.add(name);
  }

  const candidates = [...expectedCheckNames].sort((left, right) =>
    left.localeCompare(right),
  );
  if (candidates.length === 0) {
    return uncertain(
      "Authoritative CI expectation sources produced an empty check set",
    );
  }

  const incomplete = parsedSources.filter((source) => !source.complete);
  if (incomplete.length > 0) {
    const details = incomplete.map(
      (source) =>
        `${source.sourceId}: ${source.uncertainty ?? "expected checks are incomplete"}`,
    );
    return uncertain(
      `Expected CI check set is incomplete (${details.join("; ")})`,
      candidates,
    );
  }

  return {
    status: "complete",
    expectedCheckNames: candidates,
    sources: sourceIds.sort((left, right) => left.localeCompare(right)),
  };
}
