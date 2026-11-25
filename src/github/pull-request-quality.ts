import {
  AGENT_ORCHESTRATOR_DESCRIPTION_END,
  AGENT_ORCHESTRATOR_DESCRIPTION_START,
} from "../opencode/render-pull-request-description.js";

const START = "<!-- agent-orchestrator-outcome:start -->";
const END = "<!-- agent-orchestrator-outcome:end -->";

/** Only recognize uniquely paired ownership markers. Never guess at a malformed block. */
function managedRange(body: string, start: string, end: string) {
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (first === -1 && last === -1) return undefined;
  if (
    first === -1 ||
    last < first ||
    first !== body.lastIndexOf(start) ||
    last !== body.lastIndexOf(end)
  )
    throw new Error(
      "PR description markers are ambiguous; preserving human content for reconciliation",
    );
  return { start: first, end: last + end.length };
}

function qualitySection(facts: readonly string[], headSha?: string): string {
  return [
    START,
    ...(headSha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(headSha)
      ? [`<!-- Revision: ${headSha} -->`]
      : []),
    "## Quality checks",
    ...[...new Set(facts)].map(
      (fact) => `- ${fact.replace(/\s+/gu, " ").replaceAll("<!--", "&lt;!--").trim()}`,
    ),
    END,
  ].join("\n");
}

function replaceSection(body: string, section: string): string {
  // Migrate the original generated Validation/Outstanding issues tail. The
  // recognized Summary and Changes, task link, attribution and status stay put.
  const description = managedRange(
    body,
    AGENT_ORCHESTRATOR_DESCRIPTION_START,
    AGENT_ORCHESTRATOR_DESCRIPTION_END,
  );
  if (description) {
    const owned = body.slice(description.start, description.end);
    const legacyTail = /\r?\n(?:\r?\n)?## Validation\r?\n/u.exec(owned);
    if (
      legacyTail &&
      /^<!-- agent-orchestrator-description:start -->\r?\n## Summary\r?\n[\s\S]*?\r?\n## Changes\r?\n/u.test(
        owned.slice(0, legacyTail.index),
      )
    ) {
      body =
        body.slice(0, description.start + legacyTail.index) +
        "\n" +
        AGENT_ORCHESTRATOR_DESCRIPTION_END +
        body.slice(description.end);
    }
  }
  const range = managedRange(body, START, END);
  return range
    ? body.slice(0, range.start) + section + body.slice(range.end)
    : `${body}\n\n${section}`;
}

export function updatePullRequestQuality(
  body: string,
  facts: readonly string[],
  headSha?: string,
  retain?: { replacing: readonly string[]; fallback: readonly string[] },
): string {
  if (!retain) return replaceSection(body, qualitySection(facts, headSha));
  const range = managedRange(body, START, END);
  const previous = range && body.slice(range.start, range.end);
  const retained =
    previous &&
    headSha &&
    previous.startsWith(`${START}\n<!-- Revision: ${headSha} -->\n## Quality checks\n`)
      ? previous
          .split("\n")
          .filter((value) => value.startsWith("- "))
          .map((value) => value.slice(2))
      : retain.fallback;
  return replaceSection(
    body,
    qualitySection(
      [
        ...retained.filter((fact) => !retain.replacing.some((prefix) => fact.startsWith(prefix))),
        ...facts,
      ],
      headSha,
    ),
  );
}

/** Refresh a generated description and its quality assessment as one edit. */
export function copyPullRequestQuality(body: string, generatedBody: string): string {
  const range = managedRange(generatedBody, START, END);
  if (!range) return body;
  let section = generatedBody.slice(range.start, range.end);
  const current = managedRange(body, START, END);
  const revision = /^<!-- Revision: ([0-9a-f]+) -->$/mu.exec(section)?.[1];
  if (current && revision) {
    const previous = body.slice(current.start, current.end);
    if (previous.includes(`\n<!-- Revision: ${revision} -->\n`)) {
      const ci = /^- CI: (?!pending\.$).+$/mu.exec(previous)?.[0];
      if (ci) section = section.replace(/^- CI: pending\.$/mu, () => ci);
    }
  }
  return replaceSection(body, section);
}
