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
import {
  parsePlanVerificationResult,
  type PlanVerificationResult,
} from "./plan-verification.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";
import { getProcessRuntime } from "../process/process-runtime.js";
import { redactSecrets } from "../security/redact-secrets.js";

const INLINE_ATTACHMENT_MAX_BYTES = 128 * 1024;
const INLINE_ATTACHMENT_TOTAL_MAX_BYTES = 512 * 1024;

function sanitizeContextValue(value: unknown): unknown {
  const secrets = getProcessRuntime().secretValues;
  const sanitize = (item: unknown): unknown => {
    if (typeof item === "string") return redactSecrets(item, secrets);
    if (Array.isArray(item)) return item.map(sanitize);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          redactSecrets(key, secrets),
          sanitize(child),
        ]),
      );
    return item;
  };
  return sanitize(value);
}

function stringifySanitized(value: unknown): string {
  return JSON.stringify(sanitizeContextValue(value));
}

/** Sanitize the complete bundle at its persistence boundary, before encoding or hashing. */
export function sanitizePrimarySessionContextBundle(
  bundle: PrimarySessionContextBundle,
): PrimarySessionContextBundle {
  const secrets = getProcessRuntime().secretValues;
  const sanitize = sanitizeContextValue;
  const sanitizeOpaque = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    try {
      return JSON.stringify(sanitize(JSON.parse(text) as unknown));
    } catch {
      return redactSecrets(text, secrets);
    }
  };
  const prepared: PrimarySessionContextBundle = {
    ...bundle,
    plan: {
      ...bundle.plan,
      ...(bundle.plan.content === undefined ? {} : { content: "" }),
    },
    attachmentManifest: {
      ...bundle.attachmentManifest,
      ...(bundle.attachmentManifest.content === undefined
        ? {}
        : {
            content: "",
          }),
    },
    feedback: {
      ...bundle.feedback,
      references: bundle.feedback.references.map((item) =>
        redactSecrets(item, secrets),
      ),
      ...(bundle.feedback.content === undefined ? {} : { content: "" }),
    },
    currentDiff: "",
    history: "",
  };
  const sanitized = sanitize(prepared) as PrimarySessionContextBundle;
  if (bundle.plan.content !== undefined)
    sanitized.plan.content = sanitizeOpaque(bundle.plan.content) ?? "";
  if (bundle.attachmentManifest.content !== undefined)
    sanitized.attachmentManifest.content =
      sanitizeOpaque(bundle.attachmentManifest.content) ?? "";
  if (bundle.feedback.content !== undefined)
    sanitized.feedback.content = sanitizeOpaque(bundle.feedback.content) ?? "";
  sanitized.currentDiff = sanitizeOpaque(bundle.currentDiff) ?? "";
  sanitized.history = sanitizeOpaque(bundle.history) ?? "";
  return sanitized;
}

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
  planRevision?: number;
  planReviewAdvice?: PlanVerificationResult;
  attachments?: CardAttachmentPromptContext;
  feedbackContent?: string;
}): Promise<PrimarySessionContextBundle> {
  const planReviewAdvice =
    input.planReviewAdvice === undefined
      ? undefined
      : parsePlanVerificationResult(input.planReviewAdvice);
  if (
    planReviewAdvice !== undefined &&
    (input.plan === null ||
      input.planRevision !== planReviewAdvice.planRevision ||
      input.projectId !== planReviewAdvice.projectId ||
      input.card.id !== planReviewAdvice.cardId)
  )
    throw new Error(
      "Primary-session plan-review advice does not match the task and plan revision",
    );
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
    const sourceBytes = fs.readFileSync(absolute);
    let contentBase64: string | undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        sourceBytes,
      );
      const safeText = redactSecrets(text, getProcessRuntime().secretValues);
      contentBase64 = Buffer.from(safeText, "utf8").toString("base64");
    } catch {
      // Do not emit raw or transformed binary bytes as reconstruction content.
    }
    const bytes =
      contentBase64 === undefined
        ? sourceBytes
        : Buffer.from(contentBase64, "base64");
    return {
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      hashBytes: bytes.byteLength,
      contentBase64: contentBase64 ?? "",
      contentStatus:
        contentBase64 === undefined ? "unsupported-binary" : "available",
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
          content: stringifySanitized({
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
      entries?: Array<{ id?: string; kind?: string }>;
    };
    const ids = new Set(
      (ledger.entries ?? []).flatMap((entry) => {
        if (typeof entry.id !== "string") return [];
        return [
          entry.id,
          ...(typeof entry.kind === "string"
            ? [`${entry.kind}:${entry.id}`]
            : []),
        ];
      }),
    );
    if (feedbackIds.some((id) => !ids.has(id)))
      throw new Error(
        "Primary-session feedback references are not resolvable in the current ledger",
      );
  }
  const sanitizedFeedbackLedger = (): string | null => {
    if (feedbackContent === undefined) return null;
    try {
      return stringifySanitized(JSON.parse(feedbackContent) as unknown);
    } catch {
      return redactSecrets(feedbackContent, getProcessRuntime().secretValues);
    }
  };
  return sanitizePrimarySessionContextBundle({
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
        : { status: "available", content: stringifySanitized(input.plan) },
    ...(planReviewAdvice === undefined
      ? {}
      : {
          planReviewAdvice: {
            status: "available" as const,
            content: stringifySanitized(planReviewAdvice),
          },
        }),
    attachmentManifest: attachmentContext,
    currentDiff: stringifySanitized({
      status: status.trim().length === 0 ? "clean" : "changed",
      sourceIdentity,
      staged,
      unstaged,
      index,
      untracked: files,
    }),
    history: stringifySanitized({
      attemptId: input.attemptId,
      operationKey: input.record.operationKey,
      phase: input.record.phase,
      revision: input.record.revision,
      retryCounters: input.record.retryCounters,
      lastEvent: input.record.lastEvent ?? null,
      taskRecord: input.record,
      feedbackLedger: sanitizedFeedbackLedger(),
      recovery: input.record.sessionRecovery ?? null,
    }),
    feedback:
      feedbackIds.length === 0
        ? { status: "absent", references: [] }
        : {
            status: "available",
            references: feedbackIds,
            content: sanitizedFeedbackLedger()!,
          },
  });
}
