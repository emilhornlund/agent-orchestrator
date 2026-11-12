import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { withActiveLogFile } from "./active-log-files.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";
import { getLoggerRuntimeRoot } from "./logger.js";

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, (character) => {
    return `_${character.codePointAt(0)!.toString(16)}_`;
  });
}

export function getSessionLogPath(projectId: string, cardId: string): string {
  const authority = ProjectRunAuthority.current(projectId);
  const record = authority?.store.read();
  const root = record?.cardId === cardId ? record.pinned.storageRoot : getLoggerRuntimeRoot();
  return path.join(
    root ? path.resolve(root) : path.join(process.cwd(), "logs"),
    "history",
    "sessions",
    sanitizePathPart(projectId),
    `${sanitizePathPart(cardId)}${record?.cardId === cardId ? `-${sanitizePathPart(record.attemptId)}` : ""}.log`,
  );
}

/** Explicit maintenance helper; terminal workflow handlers must not call it. */
export function removeSessionLog(projectId: string, cardId: string): void {
  rmSync(getSessionLogPath(projectId, cardId), { force: true });
}

export function appendSessionLog(filePath: string, content: string): void {
  content = sanitizeControlledText(content);
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
