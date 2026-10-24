import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config/config.js";
import {
  parseFeedbackLedger,
  type FeedbackLedger,
  type FeedbackLedgerEntry,
} from "./feedback-ledger.js";

export const MAX_FEEDBACK_LEDGER_BYTES = 2 * 1024 * 1024;

export class FeedbackLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackLedgerConflictError";
  }
}

function safeId(value: string, label: string): void {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
  if (
    !value ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter
  ) {
    throw new Error(`Invalid ${label} for feedback ledger: ${value}`);
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function ensureDirectory(directory: string, create: boolean): boolean {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of path
    .relative(parsed.root, directory)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (!create) return false;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe feedback ledger directory: ${current}`);
  }
  return true;
}

export class FeedbackLedgerStore {
  private readonly directory: string;
  private readonly projectId: string;

  constructor(rootDirectory: string, project: ProjectConfig) {
    if (!path.isAbsolute(rootDirectory))
      throw new Error("Feedback ledger root must be absolute");
    safeId(project.id, "project ID");
    const root = path.resolve(rootDirectory);
    if (
      within(path.resolve(project.repository.path), root) ||
      within(root, path.resolve(project.repository.path)) ||
      within(path.resolve(project.repository.worktreeRoot), root) ||
      within(root, path.resolve(project.repository.worktreeRoot))
    ) {
      throw new Error(
        "Feedback ledger root must not overlap repository or worktree root",
      );
    }
    this.projectId = project.id;
    this.directory = path.join(root, "feedback-ledgers", project.id);
  }

  private file(cardId: string): string {
    safeId(cardId, "card ID");
    return path.join(this.directory, `${cardId}.json`);
  }

  read(cardId: string): FeedbackLedger | null {
    const file = this.file(cardId);
    if (!ensureDirectory(this.directory, false)) return null;
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Unsafe feedback ledger file: ${file}`);
    if (stat.size > MAX_FEEDBACK_LEDGER_BYTES)
      throw new Error(
        `Feedback ledger exceeds ${MAX_FEEDBACK_LEDGER_BYTES} bytes`,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Could not parse feedback ledger: ${file}`, {
        cause: error,
      });
    }
    const ledger = parseFeedbackLedger(raw);
    if (ledger.projectId !== this.projectId || ledger.cardId !== cardId)
      throw new Error("Feedback ledger ownership mismatch");
    return ledger;
  }

  create(
    cardId: string,
    entries: readonly FeedbackLedgerEntry[] = [],
  ): FeedbackLedger {
    const initial = parseFeedbackLedger({
      version: 1,
      projectId: this.projectId,
      cardId,
      revision: 1,
      updatedAt: new Date().toISOString(),
      entries,
    });
    const file = this.file(cardId);
    ensureDirectory(this.directory, true);
    return this.withLock(file, () => {
      if (this.read(cardId) !== null)
        throw new FeedbackLedgerConflictError("Feedback ledger already exists");
      this.write(file, initial, true);
      return initial;
    });
  }

  compareAndSwap(
    cardId: string,
    expectedRevision: number,
    nextValue: FeedbackLedger,
  ): FeedbackLedger {
    const next = parseFeedbackLedger(nextValue);
    const file = this.file(cardId);
    if (
      next.projectId !== this.projectId ||
      next.cardId !== cardId ||
      next.revision !== expectedRevision + 1
    ) {
      throw new Error(
        "Updated feedback ledger must preserve owner and increment revision once",
      );
    }
    return this.withLock(file, () => {
      const current = this.read(cardId);
      if (current === null || current.revision !== expectedRevision) {
        throw new FeedbackLedgerConflictError(
          `Feedback ledger revision conflict: expected ${expectedRevision}, found ${current?.revision ?? "missing"}`,
        );
      }
      this.write(file, next, false);
      return next;
    });
  }

  mergeIncoming(
    cardId: string,
    entries: readonly FeedbackLedgerEntry[],
  ): FeedbackLedger {
    const current = this.read(cardId);
    if (current === null) return this.create(cardId, entries);
    const byKey = new Map(
      current.entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]),
    );
    for (const incoming of entries) {
      const key = `${incoming.kind}:${incoming.id}`;
      const previous = byKey.get(key);
      byKey.set(
        key,
        previous === undefined
          ? incoming
          : {
              ...incoming,
              actionability: previous.actionability,
              status: previous.status,
              verificationEvidence: previous.verificationEvidence,
              ...(previous.remediationCommitSha === undefined
                ? {}
                : { remediationCommitSha: previous.remediationCommitSha }),
              ...(previous.replyId === undefined
                ? {}
                : { replyId: previous.replyId }),
            },
      );
    }
    return this.compareAndSwap(cardId, current.revision, {
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString(),
      entries: [...byKey.values()],
    });
  }

  private write(
    file: string,
    ledger: FeedbackLedger,
    exclusive: boolean,
  ): void {
    const text = `${JSON.stringify(parseFeedbackLedger(ledger), null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_FEEDBACK_LEDGER_BYTES)
      throw new Error("Feedback ledger exceeds size limit");
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(temporary);
      throw error;
    } finally {
      if (fs.existsSync(temporary)) fs.closeSync(fd);
    }
    try {
      if (exclusive) fs.linkSync(temporary, file);
      else fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private withLock<T>(file: string, operation: () => T): T {
    const lock = `${file}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new FeedbackLedgerConflictError(
          `Feedback ledger is locked: ${file}`,
        );
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}
