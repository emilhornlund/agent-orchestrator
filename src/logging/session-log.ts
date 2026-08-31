import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { withActiveLogFile } from "./active-log-files.js";

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, (character) => {
    return `_${character.codePointAt(0)!.toString(16)}_`;
  });
}

export function getSessionLogPath(projectId: string, cardId: string): string {
  return path.join(
    process.cwd(),
    "logs",
    "sessions",
    sanitizePathPart(projectId),
    `${sanitizePathPart(cardId)}.log`,
  );
}

export function removeSessionLog(projectId: string, cardId: string): void {
  rmSync(getSessionLogPath(projectId, cardId), {
    force: true,
  });
}

export function appendSessionLog(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  withActiveLogFile(filePath, () => {
    appendFileSync(filePath, content, "utf8");
  });
}

export function appendSessionSection(filePath: string, label: string): void {
  appendSessionLog(
    filePath,
    [
      "",
      "============================================================",
      `${new Date().toISOString()} ${label}`,
      "============================================================",
      "",
    ].join("\n"),
  );
}
