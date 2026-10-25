import type { TrelloCard } from "../trello/trello-client.js";
import { buildPullRequestAttributionFooter } from "./pull-request-attribution.js";
import {
  AGENT_ORCHESTRATOR_DESCRIPTION_END,
  AGENT_ORCHESTRATOR_DESCRIPTION_START,
} from "../opencode/render-pull-request-description.js";

/** Returns a safe enrichment, or null when the current body contains unowned text. */
export function enrichPullRequestDescription(
  currentBody: string,
  generatedBody: string,
  card: TrelloCard,
  gitIdentityName: string,
): string | null {
  const starts = [
    ...currentBody.matchAll(/<!-- agent-orchestrator-description:start -->/gu),
  ];
  const ends = [
    ...currentBody.matchAll(/<!-- agent-orchestrator-description:end -->/gu),
  ];

  if (starts.length === 1 && ends.length === 1) {
    const start = starts[0]?.index;
    const endMarker = ends[0]?.index;
    if (start === undefined || endMarker === undefined || endMarker < start) {
      return null;
    }
    const end = endMarker + AGENT_ORCHESTRATOR_DESCRIPTION_END.length;
    const generatedStart = generatedBody.indexOf(
      AGENT_ORCHESTRATOR_DESCRIPTION_START,
    );
    const generatedEnd = generatedBody.indexOf(
      AGENT_ORCHESTRATOR_DESCRIPTION_END,
    );
    if (generatedStart < 0 || generatedEnd < generatedStart) return null;
    return `${currentBody.slice(0, start)}${generatedBody.slice(generatedStart, generatedEnd + AGENT_ORCHESTRATOR_DESCRIPTION_END.length)}${currentBody.slice(end)}`;
  }

  if (starts.length !== 0 || ends.length !== 0) return null;

  const recognizedFallback = [
    `Trello: ${card.url}`,
    "",
    buildPullRequestAttributionFooter(gitIdentityName),
  ].join("\n");
  return currentBody === recognizedFallback ? generatedBody : null;
}
