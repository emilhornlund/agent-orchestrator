import { stripVTControlCharacters } from "node:util";

/** Only GitHub-hosted Actions job links can select an Actions logs endpoint. */
export function actionsJobIdentity(
  url: string | null,
  repository: string,
): { runId: number; jobId: number } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const runId = Number(parts[5]);
    const jobId = Number(parts[7]);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parts.length !== 8 ||
      `${parts[1]}/${parts[2]}`.toLowerCase() !== repository.toLowerCase() ||
      parts[3] !== "actions" ||
      parts[4] !== "runs" ||
      parts[6] !== "job" ||
      !Number.isSafeInteger(runId) ||
      runId < 1 ||
      !Number.isSafeInteger(jobId) ||
      jobId < 1 ||
      String(runId) !== parts[5] ||
      String(jobId) !== parts[7]
    )
      return null;
    return { runId, jobId };
  } catch {
    return null;
  }
}

/** Keep failure blocks rather than losing assertions behind lengthy setup or
 * runner cleanup output. This recognizes log structure, not engineering intent. */
export function actionsFailureExcerpt(log: string): string {
  const lines = stripVTControlCharacters(log)
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/u, ""));
  const playwright = lines.flatMap((line, index) => (/^\s*\d+\)\s+\[/u.test(line) ? [index] : []));
  const markers = playwright.length
    ? playwright
    : lines.flatMap((line, index) =>
        /^\s*(?:FAIL\b|FAILED\b|Error:|AssertionError|.*\berror TS\d+|##\[error\]|::error)/u.test(
          line,
        )
          ? [index]
          : [],
      );
  if (!markers.length) return lines.slice(-80).join("\n").slice(-12_000);
  const selected = new Set<number>();
  for (const index of markers.slice(-3))
    for (
      let offset = Math.max(0, index - 2);
      offset < Math.min(lines.length, index + 30);
      offset += 1
    )
      selected.add(offset);
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join("\n")
    .slice(0, 12_000);
}
