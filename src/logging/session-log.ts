import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
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

export function appendSessionLog(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  appendFileSync(filePath, content, "utf8");
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
