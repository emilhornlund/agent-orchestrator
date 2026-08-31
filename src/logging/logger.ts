import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { withActiveLogFile } from "./active-log-files.js";

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

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  const prefix = process.env.VITEST === "true" ? "test-" : "";

  return path.join(process.cwd(), "logs", `${prefix}orchestrator-${date}.log`);
}

function writeToFile(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  context: LogContext,
  message: string,
): void {
  const filePath = getLogFilePath();

  mkdirSync(path.dirname(filePath), {
    recursive: true,
  });

  const timestamp = new Date().toISOString();
  const contextText = formatContext(context);

  withActiveLogFile(filePath, () => {
    appendFileSync(
      filePath,
      `${timestamp} ${level.padEnd(5)} ${contextText}${message}\n`,
      "utf8",
    );
  });
}

function formatConsole(context: LogContext, message: string): string {
  return `${formatContext(context)}${message}`;
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
    console.log(formatConsole(this.context, message));
  }

  warn(message: string): void {
    writeToFile("WARN", this.context, message);
    console.warn(formatConsole(this.context, message));
  }

  error(message: string): void {
    writeToFile("ERROR", this.context, message);
    console.error(formatConsole(this.context, message));
  }
}

export const logger = new Logger();
