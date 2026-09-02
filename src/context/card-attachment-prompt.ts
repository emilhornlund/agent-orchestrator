import fs from "node:fs";

import { resolveCardAttachmentPath } from "./card-context-storage.js";
import type {
  CardAttachmentManifest,
  CardAttachmentManifestEntry,
} from "./materialize-card-attachments.js";

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

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);

    return (
      code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    );
  });
}

function isUsableExternalUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  description: string,
): void {
  const allowedKeys = new Set(keys);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));

  if (unexpectedKey !== undefined) {
    throw new Error(
      `${description} contains unsupported field "${unexpectedKey}"`,
    );
  }
}

function validateManifestEntry(
  value: unknown,
  index: number,
): asserts value is CardAttachmentManifestEntry {
  const description = `Cannot expose Trello attachment ${index}`;

  if (!isRecord(value)) {
    throw new Error(
      `${description}: materialized manifest entry is not an object`,
    );
  }

  assertExactKeys(
    value,
    ["id", "name", "mimeType", "bytes", "url", "isUpload", "localFilename"],
    description,
  );

  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (typeof value.mimeType !== "string" && value.mimeType !== null) ||
    (typeof value.bytes !== "string" && value.bytes !== null) ||
    typeof value.url !== "string" ||
    typeof value.isUpload !== "boolean" ||
    (typeof value.localFilename !== "string" && value.localFilename !== null) ||
    value.id.trim().length === 0 ||
    value.url.trim().length === 0 ||
    (!value.isUpload && !isUsableExternalUrl(value.url)) ||
    hasControlCharacter(value.id) ||
    hasControlCharacter(value.name) ||
    hasControlCharacter(value.url) ||
    (typeof value.mimeType === "string" &&
      hasControlCharacter(value.mimeType)) ||
    (typeof value.bytes === "string" && hasControlCharacter(value.bytes))
  ) {
    throw new Error(
      `${description}: materialized manifest entry has invalid metadata`,
    );
  }

  if (value.isUpload && value.localFilename === null) {
    throw new Error(
      `${description}: uploaded attachment has no local filename`,
    );
  }

  if (!value.isUpload && value.localFilename !== null) {
    throw new Error(`${description}: external attachment has a local filename`);
  }
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

  assertExactKeys(
    manifest,
    ["attachments"],
    "Cannot expose Trello card attachments manifest",
  );

  const ids = new Set<string>();
  const localFilenames = new Set<string>();

  for (const [index, attachment] of manifest.attachments.entries()) {
    validateManifestEntry(attachment, index);

    if (ids.has(attachment.id)) {
      throw new Error(
        `Cannot expose Trello attachment ${index}: duplicate attachment ID "${attachment.id}"`,
      );
    }

    ids.add(attachment.id);

    if (attachment.localFilename !== null) {
      if (localFilenames.has(attachment.localFilename)) {
        throw new Error(
          `Cannot expose Trello attachment ${index}: duplicate local filename "${attachment.localFilename}"`,
        );
      }

      localFilenames.add(attachment.localFilename);
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
