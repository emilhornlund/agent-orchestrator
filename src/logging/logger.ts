import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { withActiveLogFile } from "./active-log-files.js";
import { sanitizeControlledText } from "../security/redact-secrets.js";
import { ProjectRunAuthority } from "../task-session/project-run-authority.js";

let logRoot = path.join(process.cwd(), "logs");
let configuredRuntimeRoot = false;

/** Set before startup housekeeping; managed diagnostics live outside the checkout. */
export function configureLoggerRuntime(root: string): void {
  logRoot = path.resolve(root, "orchestrator-logs");
  configuredRuntimeRoot = true;
}

export function getLoggerRuntimeRoot(): string {
  return process.env.VITEST === "true" || !configuredRuntimeRoot
    ? process.cwd()
    : path.dirname(logRoot);
}

export interface LogContext {
  projectId?: string;
  cardId?: string;
}

function formatContext(context: LogContext): string {
  const parts: string[] = [];

  if (context.projectId) {
    parts.push(`[${context.projectId}]`);
  }

  if (context.cardId) {
    parts.push(`[card:${context.cardId}]`);
  }

  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

function classifySummary(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("retry") || text.includes("attempt")) return "retry";
  if (text.includes("recover") || text.includes("reconcil")) return "recovery";
  if (text.includes("validation") || text.includes("coverage"))
    return "quality";
  if (text.includes("review")) return "review";
  if (text.includes("transition") || text.includes("completed"))
    return "workflow-progress";
  return "diagnostic";
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  const prefix = process.env.VITEST === "true" ? "test-" : "";

  const root =
    process.env.VITEST === "true" ? path.join(process.cwd(), "logs") : logRoot;
  return path.join(root, `${prefix}orchestrator-${date}.log`);
}

function writeToFile(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  context: LogContext,
  message: string,
): void {
  message = sanitizeControlledText(message);
  const filePath = getLogFilePath();

  mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  const timestamp = new Date().toISOString();
  const contextText = formatContext(context);

  // Append-only, attempt-scoped timeline. RunRecord remains the sole workflow
  // authority; this is diagnostic evidence only.
  const authority = context.projectId
    ? ProjectRunAuthority.current(context.projectId)
    : undefined;
  if (authority && context.cardId) {
    const record = authority.store.read();
    if (record?.cardId === context.cardId) {
      const historyPath = path.join(
        record.pinned.storageRoot,
        "history",
        encodeURIComponent(context.projectId!),
        encodeURIComponent(context.cardId),
        encodeURIComponent(record.attemptId),
        "events.jsonl",
      );
      mkdirSync(path.dirname(historyPath), { recursive: true, mode: 0o700 });
      appendFileSync(
        historyPath,
        `${JSON.stringify({
          timestamp,
          type: "workflow-diagnostic",
          level,
          summary: { category: classifySummary(message) },
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }

  withActiveLogFile(filePath, () => {
    appendFileSync(
      filePath,
      `${timestamp} ${level.padEnd(5)} ${contextText}${message}\n`,
      "utf8",
    );
  });
}

function formatConsole(context: LogContext, message: string): string {
  message = sanitizeControlledText(message);
  const prefix = `${new Date().toISOString()} ${formatContext(context)}`;

  return `${prefix}${message.replace(/\r\n|\r|\n/g, (lineBreak) => {
    return `${lineBreak}${prefix}`;
  })}`;
}

export function shouldWriteConsole(): boolean {
  return process.env.VITEST !== "true" || process.env.TEST_LOGS === "true";
}

export class Logger {
  constructor(private readonly context: LogContext = {}) {}

  child(context: LogContext): Logger {
    return new Logger({
      ...this.context,
      ...context,
    });
  }

  debug(message: string): void {
    writeToFile("DEBUG", this.context, message);
  }

  info(message: string): void {
    writeToFile("INFO", this.context, message);
  }

  event(message: string): void {
    writeToFile("INFO", this.context, message);

    if (shouldWriteConsole()) {
      console.log(formatConsole(this.context, message));
    }
  }

  warn(message: string): void {
    writeToFile("WARN", this.context, message);

    if (shouldWriteConsole()) {
      console.warn(formatConsole(this.context, message));
    }
  }

  error(message: string): void {
    writeToFile("ERROR", this.context, message);

    if (shouldWriteConsole()) {
      console.error(formatConsole(this.context, message));
    }
  }
}

export const logger = new Logger();
