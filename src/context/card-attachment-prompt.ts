import fs from "node:fs";

import { resolveCardAttachmentPath } from "./card-context-storage.js";
import type { CardAttachmentManifest } from "./materialize-card-attachments.js";

export interface CardAttachmentPromptContext {
  manifest: CardAttachmentManifest;
  contextRoot: string;
  projectId: string;
  cardId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getManifestAttachments(
  context: CardAttachmentPromptContext,
): CardAttachmentManifest["attachments"] {
  const manifest: unknown = context.manifest;

  if (!isRecord(manifest) || !Array.isArray(manifest.attachments)) {
    throw new Error(
      "Cannot expose Trello card attachments: materialized manifest has no attachments array",
    );
  }

  for (const [index, attachment] of manifest.attachments.entries()) {
    if (
      !isRecord(attachment) ||
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      (typeof attachment.mimeType !== "string" &&
        attachment.mimeType !== null) ||
      (typeof attachment.bytes !== "string" && attachment.bytes !== null) ||
      typeof attachment.url !== "string" ||
      typeof attachment.isUpload !== "boolean" ||
      (typeof attachment.localFilename !== "string" &&
        attachment.localFilename !== null)
    ) {
      throw new Error(
        `Cannot expose Trello attachment ${index}: materialized manifest entry has invalid metadata`,
      );
    }
  }

  return manifest.attachments as CardAttachmentManifest["attachments"];
}

function assertMaterializedFile(
  filePath: string,
  attachmentName: string,
  index: number,
): void {
  let stat: fs.Stats | undefined;

  try {
    stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachmentName}": unable to inspect materialized file "${filePath}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (stat === undefined) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachmentName}": materialized file "${filePath}" does not exist`,
    );
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachmentName}": materialized file "${filePath}" is a symbolic link`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachmentName}": materialized path "${filePath}" is not a regular file`,
    );
  }
}

function resolveAttachmentLocation(
  context: CardAttachmentPromptContext,
  index: number,
): string {
  const attachment = context.manifest.attachments[index];

  if (attachment === undefined) {
    throw new Error(`Cannot expose missing Trello attachment ${index}`);
  }

  if (attachment.isUpload) {
    if (
      typeof attachment.localFilename !== "string" ||
      attachment.localFilename.trim().length === 0
    ) {
      throw new Error(
        `Cannot expose Trello attachment ${index} "${attachment.name}": uploaded attachment has no local filename`,
      );
    }

    let filePath: string;

    try {
      filePath = resolveCardAttachmentPath(
        context.contextRoot,
        context.projectId,
        context.cardId,
        attachment.localFilename,
      );
    } catch (error) {
      throw new Error(
        `Cannot expose Trello attachment ${index} "${attachment.name}": unable to resolve local file: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    assertMaterializedFile(filePath, attachment.name, index);
    return `local file: ${filePath}`;
  }

  if (attachment.localFilename !== null) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachment.name}": external attachment has a local filename`,
    );
  }

  const url = attachment.url.trim();

  if (url.length === 0) {
    throw new Error(
      `Cannot expose Trello attachment ${index} "${attachment.name}": external attachment has no usable URL`,
    );
  }

  return `external URL: ${url}`;
}

export function buildCardAttachmentPromptLines(
  context: CardAttachmentPromptContext | undefined,
): string[] {
  if (context === undefined) {
    return [];
  }

  const attachments = getManifestAttachments(context);

  if (attachments.length === 0) {
    return [];
  }

  const attachmentLines = attachments.map((attachment, index) => {
    const mimeType =
      typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const mimeSuffix = mimeType.length > 0 ? ` (${mimeType})` : "";

    return `- ${attachment.name}${mimeSuffix}: ${resolveAttachmentLocation(context, index)}`;
  });

  return [
    "",
    "Trello card attachments:",
    "These attachments are part of the Trello task context. Inspect them when relevant.",
    ...attachmentLines,
    "",
  ];
}
