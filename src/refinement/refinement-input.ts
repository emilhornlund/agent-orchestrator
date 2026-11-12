import { z } from "zod";
import type { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { refinementFieldsSchema } from "./refinement-mutation-snapshot.js";

export const refinementInputKey = "refinement-card-input-v1";
export const refinementInputSchema = z.strictObject({
  cardId: z.string(),
  original: refinementFieldsSchema,
  failure: z.string().optional(),
});
export function refinementInput(authority: ProjectRunAuthority, card: TrelloCard) {
  const previous = authority.read(refinementInputKey, refinementInputSchema.parse);
  if (previous) {
    if (previous.cardId !== card.id) throw new Error("Refinement input card differs from attempt");
    return previous;
  }
  const value = {
    cardId: card.id,
    original: {
      title: sanitizeControlledText(card.name),
      description: sanitizeControlledText(card.desc),
      labels: card.idLabels,
    },
  };
  authority.mutate(
    refinementInputKey,
    value,
    () => ({ value, result: undefined }),
    refinementInputSchema.parse,
  );
  return value;
}
export function refinementAnalysisFailure(authority: ProjectRunAuthority): string | undefined {
  return authority.read(refinementInputKey, refinementInputSchema.parse)?.failure;
}
export function recordRefinementAnalysisFailure(
  authority: ProjectRunAuthority,
  reason: string,
): void {
  const previous = authority.read(refinementInputKey, refinementInputSchema.parse);
  if (!previous) throw new Error("Cannot fail refinement without original card fields");
  const value = { ...previous, failure: sanitizeControlledText(reason) };
  authority.mutate(
    refinementInputKey,
    value,
    () => ({ value, result: undefined }),
    refinementInputSchema.parse,
  );
}
