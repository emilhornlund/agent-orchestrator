import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../context/card-attachment-prompt.js";
import type { GitClient } from "../git/git-client.js";
import type { TrelloCard } from "../trello/trello-client.js";
import { resolveCardAttachmentPath } from "../context/card-context-storage.js";
import type { PrimarySessionContextBundle } from "./primary-task-session.js";
import type { TaskExecutionRecord } from "./task-execution-record.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import { redactSecrets } from "../security/redact-secrets.js";

const INLINE_ATTACHMENT_MAX_BYTES = 128 * 1024;
const INLINE_ATTACHMENT_TOTAL_MAX_BYTES = 512 * 1024;

export async function buildPrimarySessionContext(input: {
  git: Pick<
    GitClient,
    | "getHeadSha"
    | "getStatus"
    | "getDiff"
    | "getIndexEntries"
    | "getUntrackedFiles"
    | "getHeadTrackedFiles"
  >;
  projectId: string;
  card: TrelloCard;
  attemptId: string;
  worktreePath: string;
  record: TaskExecutionRecord;
  plan: unknown | null;
  attachments?: CardAttachmentPromptContext;
  feedbackContent?: string;
}): Promise<PrimarySessionContextBundle> {
  const [head, sourceIdentity, status, staged, unstaged, index, untracked] =
    await Promise.all([
      input.git.getHeadSha(input.worktreePath),
      getTaskSessionSourceSnapshotIdentity(input.git, input.worktreePath),
      input.git.getStatus(input.worktreePath),
      input.git.getDiff(input.worktreePath, true),
      input.git.getDiff(input.worktreePath),
      input.git.getIndexEntries(input.worktreePath),
      input.git.getUntrackedFiles(input.worktreePath),
    ]);
  let totalUntrackedBytes = 0;
  const files = untracked.map((relativePath) => {
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath))
      throw new Error(
        "Git returned an absolute untracked path for reconstruction context",
      );
    const absolute = path.resolve(input.worktreePath, relativePath);
    const relative = path.relative(path.resolve(input.worktreePath), absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Untracked reconstruction path escapes task worktree");
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        `Untracked reconstruction path is not a regular file: ${relativePath}`,
      );
    if (stat.size > 4 * 1024 * 1024)
      throw new Error(
        `Untracked reconstruction file exceeds bundle limit: ${relativePath}`,
      );
    totalUntrackedBytes += stat.size;
    if (totalUntrackedBytes > 4 * 1024 * 1024)
      throw new Error(
        "Untracked reconstruction inventory exceeds bundle limit",
      );
    const bytes = fs.readFileSync(absolute);
    return {
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      hashBytes: bytes.byteLength,
      contentBase64: bytes.toString("base64"),
    };
  });
  if (
    input.attachments !== undefined &&
    (input.attachments.projectId !== input.projectId ||
      input.attachments.cardId !== input.card.id)
  )
    throw new Error(
      "Primary-session attachment context identity does not match task",
    );
  const attachmentLines = buildCardAttachmentPromptLines(input.attachments);
  let totalAttachmentBytes = 0;
  let totalInlineTextBytes = 0;
  const attachmentInventory =
    input.attachments?.manifest.attachments.map((entry) => {
      if (!entry.isUpload)
        return { ...entry, availability: "external-url" as const };
      const filePath = resolveCardAttachmentPath(
        input.attachments!.contextRoot,
        input.projectId,
        input.card.id,
        entry.localFilename!,
      );
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Materialized attachment is not a regular file");
      if (
        stat.size > 20 * 1024 * 1024 ||
        totalAttachmentBytes + stat.size > 64 * 1024 * 1024
      )
        throw new Error(
          "Materialized attachments exceed the primary reconstruction limit",
        );
      const bytes = fs.readFileSync(filePath);
      totalAttachmentBytes += bytes.byteLength;
      const mimeType = entry.mimeType?.toLowerCase() ?? "";
      const textLike =
        mimeType.startsWith("text/") ||
        ["application/json", "application/xml", "application/yaml"].includes(
          mimeType,
        );
      const inlineContent =
        textLike &&
        bytes.byteLength <= INLINE_ATTACHMENT_MAX_BYTES &&
        totalInlineTextBytes + bytes.byteLength <=
          INLINE_ATTACHMENT_TOTAL_MAX_BYTES
          ? redactSecrets(
              bytes.toString("utf8"),
              getProcessRuntime().secretValues,
            )
          : undefined;
      if (inlineContent !== undefined) totalInlineTextBytes += bytes.byteLength;
      return {
        ...entry,
        absolutePath: filePath,
        availability: "materialized" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        ...(inlineContent === undefined
          ? {}
          : { readableContent: inlineContent }),
      };
    }) ?? [];
  const attachmentContext =
    input.attachments === undefined
      ? { status: "absent" as const }
      : {
          status: "available" as const,
          content: JSON.stringify({
            manifest: attachmentInventory,
            usableLocations: attachmentLines,
          }),
        };
  const feedbackIds = input.record.reviewObservation?.feedbackIds ?? [];
  const feedbackContent = input.feedbackContent;
  if (feedbackIds.length > 0) {
    if (feedbackContent === undefined)
      throw new Error(
        "Primary-session recovery requires the current feedback ledger",
      );
    const ledger = JSON.parse(feedbackContent) as {
      entries?: Array<{ id?: string }>;
    };
    const ids = new Set(
      (ledger.entries ?? []).flatMap((entry) =>
        typeof entry.id === "string" ? [entry.id] : [],
      ),
    );
    if (feedbackIds.some((id) => !ids.has(id)))
      throw new Error(
        "Primary-session feedback references are not resolvable in the current ledger",
      );
  }
  return {
    version: 1,
    projectId: input.projectId,
    cardId: input.card.id,
    attemptId: input.attemptId,
    repositoryPath: input.worktreePath,
    repositoryHead: head,
    card: {
      title: input.card.name,
      description: input.card.desc,
      current: true,
    },
    plan:
      input.plan === null
        ? { status: "absent" }
        : { status: "available", content: JSON.stringify(input.plan) },
    attachmentManifest: attachmentContext,
    currentDiff: JSON.stringify({
      status: status.trim().length === 0 ? "clean" : "changed",
      sourceIdentity,
      staged,
      unstaged,
      index,
      untracked: files,
    }),
    history: JSON.stringify({
      attemptId: input.attemptId,
      operationKey: input.record.operationKey,
      phase: input.record.phase,
      revision: input.record.revision,
      retryCounters: input.record.retryCounters,
      lastEvent: input.record.lastEvent ?? null,
      taskRecord: input.record,
      feedbackLedger: feedbackContent ?? null,
      recovery: input.record.sessionRecovery ?? null,
    }),
    feedback:
      feedbackIds.length === 0
        ? { status: "absent", references: [] }
        : {
            status: "available",
            references: feedbackIds,
            content: feedbackContent!,
          },
  };
}
