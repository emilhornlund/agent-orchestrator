import fs from "node:fs";
import path from "node:path";

import {
  resolveCardAttachmentPath,
  createCardContextDirectories,
  type CardContextPaths,
} from "./card-context-storage.js";
import {
  TrelloRequestAbortedError,
  type TrelloAttachment,
  type TrelloClient,
} from "../trello/trello-client.js";

export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;

const maximumFilenameLength = 180;

export interface CardAttachmentManifestEntry extends TrelloAttachment {
  localFilename: string | null;
}

export interface CardAttachmentManifest {
  attachments: CardAttachmentManifestEntry[];
}

export interface MaterializeCardAttachmentsOptions {
  signal?: AbortSignal;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
}

export type TrelloAttachmentSource = Pick<
  TrelloClient,
  "getCardAttachments" | "downloadCardAttachment"
>;

interface PlannedAttachment {
  attachment: TrelloAttachment;
  localFilename: string;
  reuse: boolean;
}

interface TemporaryFile {
  path: string;
  handle: fs.promises.FileHandle;
}

interface StaleFileBackup {
  filename: string;
  path: string;
}

interface StaleCleanupTransaction {
  attachmentsDirectory: string;
  stagedDirectory: string;
  temporaryDirectory: string;
  backups: StaleFileBackup[];
}

class AttachmentsNotRestoredError extends Error {
  readonly attachmentsRestored = false;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function assertValidLimit(value: number | undefined, name: string): number {
  const limit =
    value ??
    (name === "maxAttachmentBytes"
      ? DEFAULT_MAX_ATTACHMENT_BYTES
      : DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES);

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return limit;
}

function parseUsableByteCount(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

function validateAttachmentMetadata(
  attachment: unknown,
  description: string,
): asserts attachment is TrelloAttachment {
  if (
    !isRecord(attachment) ||
    typeof attachment.id !== "string" ||
    typeof attachment.name !== "string" ||
    (typeof attachment.mimeType !== "string" && attachment.mimeType !== null) ||
    (typeof attachment.bytes !== "string" && attachment.bytes !== null) ||
    typeof attachment.url !== "string" ||
    typeof attachment.isUpload !== "boolean" ||
    attachment.id.trim().length === 0 ||
    attachment.url.trim().length === 0 ||
    (!attachment.isUpload && !isUsableExternalUrl(attachment.url)) ||
    hasControlCharacter(attachment.id) ||
    hasControlCharacter(attachment.name) ||
    hasControlCharacter(attachment.url) ||
    (typeof attachment.mimeType === "string" &&
      hasControlCharacter(attachment.mimeType)) ||
    (typeof attachment.bytes === "string" &&
      hasControlCharacter(attachment.bytes))
  ) {
    throw new Error(`${description} has invalid metadata`);
  }
}

function validateAttachment(
  attachment: unknown,
  index: number,
): asserts attachment is TrelloAttachment {
  validateAttachmentMetadata(attachment, `Trello attachment ${index}`);
}

function validateMetadata(
  left: TrelloAttachment,
  right: TrelloAttachment,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.bytes === right.bytes &&
    left.url === right.url &&
    left.isUpload === right.isUpload
  );
}

function normalizeFilename(name: string): string {
  const components = name.replaceAll("\\", "/").split("/");
  let leaf = "";

  for (const component of components) {
    if (component !== "" && component !== "." && component !== "..") {
      leaf = component;
    }
  }

  leaf = Array.from(leaf, (character) => {
    const code = character.charCodeAt(0);

    return code <= 0x1f || code === 0x7f ? "_" : character;
  })
    .join("")
    .trim();

  if (leaf === "" || leaf === "." || leaf === "..") {
    return "attachment";
  }

  if (leaf.length <= maximumFilenameLength) {
    return leaf;
  }

  const extension = path.extname(leaf);

  if (extension.length >= maximumFilenameLength) {
    return leaf.slice(0, maximumFilenameLength);
  }

  const stem = extension.length > 0 ? leaf.slice(0, -extension.length) : leaf;
  const availableStemLength = Math.max(
    1,
    maximumFilenameLength - extension.length,
  );

  return `${stem.slice(0, availableStemLength)}${extension}`;
}

function addFilenameSuffix(filename: string, suffix: number): string {
  const suffixText = `-${suffix}`;
  const extension = path.extname(filename);
  const boundedExtension =
    extension.length + suffixText.length < maximumFilenameLength
      ? extension
      : "";
  const stem =
    boundedExtension.length > 0
      ? filename.slice(0, -boundedExtension.length)
      : filename;
  const availableStemLength = Math.max(
    1,
    maximumFilenameLength - boundedExtension.length - suffixText.length,
  );

  if (suffixText.length >= maximumFilenameLength) {
    return suffixText.slice(-maximumFilenameLength);
  }

  return `${stem.slice(0, availableStemLength)}${suffixText}${boundedExtension}`;
}

function allocateFilename(
  name: string,
  occupiedFilenames: Set<string>,
): string {
  const baseFilename = normalizeFilename(name);
  let filename = baseFilename;
  let suffix = 2;

  while (occupiedFilenames.has(filename)) {
    filename = addFilenameSuffix(baseFilename, suffix);
    suffix += 1;
  }

  occupiedFilenames.add(filename);
  return filename;
}

function parseManifestEntry(
  value: unknown,
  index: number,
): CardAttachmentManifestEntry {
  if (!isRecord(value)) {
    throw new Error(
      `Existing attachments manifest entry ${index} is not an object`,
    );
  }

  assertExactKeys(
    value,
    ["id", "name", "mimeType", "bytes", "url", "isUpload", "localFilename"],
    `Existing attachments manifest entry ${index}`,
  );

  const attachment = {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    bytes: value.bytes,
    url: value.url,
    isUpload: value.isUpload,
  };

  validateAttachmentMetadata(
    attachment,
    `Existing attachments manifest entry ${index}`,
  );

  const localFilename = value.localFilename;

  if (typeof localFilename !== "string" && localFilename !== null) {
    throw new Error(
      `Existing attachments manifest entry ${index} has an invalid localFilename`,
    );
  }

  if (attachment.isUpload && localFilename === null) {
    throw new Error(
      `Existing attachments manifest entry ${index} is an upload without a localFilename`,
    );
  }

  if (!attachment.isUpload && localFilename !== null) {
    throw new Error(
      `Existing attachments manifest entry ${index} assigns a localFilename to an external attachment`,
    );
  }

  return {
    ...attachment,
    localFilename,
  };
}

function parseManifest(value: unknown): CardAttachmentManifest {
  if (!isRecord(value) || !Array.isArray(value.attachments)) {
    throw new Error(
      "Existing attachments manifest must contain an attachments array",
    );
  }

  assertExactKeys(value, ["attachments"], "Existing attachments manifest");

  const attachments = value.attachments.map(parseManifestEntry);
  const ids = new Set<string>();

  for (const attachment of attachments) {
    if (ids.has(attachment.id)) {
      throw new Error(
        `Existing attachments manifest contains duplicate attachment ID "${attachment.id}"`,
      );
    }

    ids.add(attachment.id);
  }

  return { attachments };
}

async function readExistingManifest(
  paths: CardContextPaths,
  contextRoot: string,
  projectId: string,
  cardId: string,
): Promise<CardAttachmentManifest | undefined> {
  let stat: fs.Stats | undefined;

  try {
    stat = await fs.promises.lstat(paths.manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw new Error(
      `Unable to inspect existing attachments manifest "${paths.manifestPath}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing symbolic-link attachments manifest "${paths.manifestPath}"`,
    );
  }

  if (!stat.isFile()) {
    throw new Error(
      `Refusing non-file attachments manifest "${paths.manifestPath}"`,
    );
  }

  let raw: string;

  try {
    raw = await fs.promises.readFile(paths.manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read attachments manifest for card "${cardId}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Existing attachments manifest for card "${cardId}" is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const manifest = parseManifest(parsed);

  for (const [index, attachment] of manifest.attachments.entries()) {
    if (attachment.localFilename === null) {
      continue;
    }

    try {
      resolveCardAttachmentPath(
        contextRoot,
        projectId,
        cardId,
        attachment.localFilename,
      );
    } catch (error) {
      throw new Error(
        `Existing attachments manifest entry ${index} has an unsafe localFilename: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  const localFilenames = new Set<string>();

  for (const attachment of manifest.attachments) {
    if (attachment.localFilename !== null) {
      if (localFilenames.has(attachment.localFilename)) {
        throw new Error(
          `Existing attachments manifest contains duplicate localFilename "${attachment.localFilename}"`,
        );
      }

      localFilenames.add(attachment.localFilename);
    }
  }

  return manifest;
}

async function existingFileIsRegular(
  contextRoot: string,
  projectId: string,
  cardId: string,
  filename: string,
): Promise<boolean> {
  const attachmentPath = resolveCardAttachmentPath(
    contextRoot,
    projectId,
    cardId,
    filename,
  );

  try {
    const stat = await fs.promises.lstat(attachmentPath);

    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link attachment "${attachmentPath}"`);
    }

    if (!stat.isFile()) {
      throw new Error(`Refusing non-file attachment "${attachmentPath}"`);
    }

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function getOccupiedFilenames(
  attachmentsDirectory: string,
): Promise<Set<string>> {
  let filenames: string[];

  try {
    filenames = await fs.promises.readdir(attachmentsDirectory);
  } catch (error) {
    throw new Error(
      `Unable to inspect attachment directory "${attachmentsDirectory}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return new Set(filenames);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TrelloRequestAbortedError();
  }
}

async function openTemporaryFile(
  targetPath: string,
  suffix: string,
): Promise<TemporaryFile> {
  for (let index = 0; ; index += 1) {
    const temporaryPath = `${targetPath}.${suffix}.${index}`;

    try {
      const handle = await fs.promises.open(temporaryPath, "wx", 0o600);
      return { path: temporaryPath, handle };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        continue;
      }

      throw error;
    }
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

async function writeChunk(
  handle: fs.promises.FileHandle,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);

    if (result.bytesWritten === 0) {
      throw new Error("Attachment download wrote zero bytes unexpectedly");
    }

    offset += result.bytesWritten;
  }
}

async function publishDownloadedFile(
  temporaryPath: string,
  targetPath: string,
): Promise<void> {
  await fs.promises.link(temporaryPath, targetPath);

  try {
    await removeFile(temporaryPath);
  } catch (error) {
    try {
      await removeFile(targetPath);
    } catch {
      // Preserve the original cleanup failure.
    }

    throw error;
  }
}

async function downloadAttachmentToFile(
  source: TrelloAttachmentSource,
  attachment: TrelloAttachment,
  finalPath: string,
  maxAttachmentBytes: number,
  maxTotalAttachmentBytes: number,
  downloadedBytes: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);

  const declaredBytes = parseUsableByteCount(attachment.bytes);

  if (declaredBytes !== undefined && declaredBytes > maxAttachmentBytes) {
    throw new Error(
      `Trello attachment "${attachment.name}" (${attachment.id}) declared size ${declaredBytes} exceeds the individual limit of ${maxAttachmentBytes} bytes`,
    );
  }

  if (
    declaredBytes !== undefined &&
    declaredBytes > maxTotalAttachmentBytes - downloadedBytes
  ) {
    throw new Error(
      `Trello attachment "${attachment.name}" (${attachment.id}) declared size ${declaredBytes} exceeds the remaining aggregate download limit of ${maxTotalAttachmentBytes - downloadedBytes} bytes`,
    );
  }

  let response: Response;

  try {
    response =
      signal === undefined
        ? await source.downloadCardAttachment(attachment)
        : await source.downloadCardAttachment(attachment, signal);
  } catch (error) {
    if (signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    throw new Error(
      `Failed to download Trello attachment "${attachment.name}" (${attachment.id}): ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download Trello attachment "${attachment.name}" (${attachment.id}): Trello request failed: ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = parseUsableByteCount(
    response.headers.get("content-length"),
  );

  if (contentLength !== undefined && contentLength > maxAttachmentBytes) {
    throw new Error(
      `Trello attachment "${attachment.name}" (${attachment.id}) response size ${contentLength} exceeds the individual limit of ${maxAttachmentBytes} bytes`,
    );
  }

  if (
    contentLength !== undefined &&
    contentLength > maxTotalAttachmentBytes - downloadedBytes
  ) {
    throw new Error(
      `Trello attachment "${attachment.name}" (${attachment.id}) response size ${contentLength} exceeds the remaining aggregate download limit of ${maxTotalAttachmentBytes - downloadedBytes} bytes`,
    );
  }

  let temporaryFile: TemporaryFile | undefined;
  let receivedBytes = 0;

  try {
    temporaryFile = await openTemporaryFile(finalPath, "download");

    if (response.body !== null) {
      const reader = response.body.getReader();

      try {
        while (true) {
          throwIfAborted(signal);
          const result = await reader.read();

          if (result.done) {
            break;
          }

          const chunk = result.value;
          const nextReceivedBytes = receivedBytes + chunk.byteLength;

          if (nextReceivedBytes > maxAttachmentBytes) {
            throw new Error(
              `Trello attachment "${attachment.name}" (${attachment.id}) exceeds the individual limit of ${maxAttachmentBytes} bytes`,
            );
          }

          if (downloadedBytes + nextReceivedBytes > maxTotalAttachmentBytes) {
            throw new Error(
              `Trello attachment "${attachment.name}" (${attachment.id}) exceeds the aggregate download limit of ${maxTotalAttachmentBytes} bytes`,
            );
          }

          await writeChunk(temporaryFile.handle, chunk);
          receivedBytes = nextReceivedBytes;
        }
      } catch (error) {
        if (signal?.aborted) {
          throw new TrelloRequestAbortedError();
        }

        try {
          await reader.cancel(error);
        } catch {
          // Preserve the original download failure.
        }

        throw error;
      } finally {
        reader.releaseLock();
      }
    }

    const declaredSizeMismatch =
      declaredBytes !== undefined && receivedBytes < declaredBytes;
    const contentLengthMismatch =
      contentLength !== undefined && receivedBytes !== contentLength;

    if (declaredSizeMismatch || contentLengthMismatch) {
      const expectedDescription = contentLengthMismatch
        ? `response Content-Length was ${contentLength}`
        : `declared size was ${declaredBytes}`;

      throw new Error(
        `Trello attachment "${attachment.name}" (${attachment.id}) ${expectedDescription} bytes but ${receivedBytes} bytes were received`,
      );
    }

    const downloadedTemporaryPath = temporaryFile.path;

    await temporaryFile.handle.sync();
    await temporaryFile.handle.close();
    temporaryFile = undefined;

    await publishDownloadedFile(downloadedTemporaryPath, finalPath);

    return receivedBytes;
  } catch (error) {
    throw new Error(
      `Failed while materializing Trello attachment "${attachment.name}" (${attachment.id}): ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.handle.close();
      } catch {
        // Preserve the download failure; cleanup below is still attempted.
      }

      try {
        await removeFile(temporaryFile.path);
      } catch {
        // Preserve the download failure and never publish the manifest entry.
      }
    }
  }
}

async function publishManifest(
  paths: CardContextPaths,
  manifest: CardAttachmentManifest,
): Promise<void> {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  let temporaryPath: string | undefined;

  try {
    const temporaryFile = await openTemporaryFile(
      paths.manifestPath,
      "manifest",
    );
    temporaryPath = temporaryFile.path;

    try {
      await writeChunk(temporaryFile.handle, Buffer.from(serialized, "utf8"));
      await temporaryFile.handle.sync();
    } finally {
      await temporaryFile.handle.close();
    }

    const existingManifest = await fs.promises
      .lstat(paths.manifestPath)
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }

        throw error;
      });

    if (existingManifest !== undefined && !existingManifest.isFile()) {
      throw new Error(
        `Refusing to replace unsafe attachments manifest "${paths.manifestPath}"`,
      );
    }

    await fs.promises.rename(temporaryPath, paths.manifestPath);
    temporaryPath = undefined;
  } catch (error) {
    throw new Error(
      `Unable to publish attachments manifest "${paths.manifestPath}": ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (temporaryPath !== undefined) {
      try {
        await removeFile(temporaryPath);
      } catch {
        // Preserve the manifest publication failure.
      }
    }
  }
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.rm(directory, { force: true, recursive: true });
  } catch {
    // The directory contains only private reconciliation backups.
  }
}

async function detachAttachmentsDirectory(paths: CardContextPaths): Promise<{
  attachmentsDirectory: string;
  stagedDirectory: string;
  temporaryDirectory: string;
}> {
  let temporaryDirectory: string;

  try {
    temporaryDirectory = await fs.promises.mkdtemp(
      path.join(paths.contextDirectory, ".attachments-reconcile-"),
    );
  } catch (error) {
    throw new Error(
      `Unable to create temporary attachment reconciliation directory: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const stagedDirectory = path.join(temporaryDirectory, "attachments");
  let detached = false;
  let stagedDirectoryVerified = false;

  try {
    const stat = await fs.promises.lstat(paths.attachmentsDirectory);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link attachments directory "${paths.attachmentsDirectory}"`,
      );
    }

    if (!stat.isDirectory()) {
      throw new Error(
        `Refusing non-directory attachments directory "${paths.attachmentsDirectory}"`,
      );
    }

    await fs.promises.rename(paths.attachmentsDirectory, stagedDirectory);
    detached = true;

    const stagedStat = await fs.promises.lstat(stagedDirectory);

    if (stagedStat.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic-link staged attachments directory "${stagedDirectory}"`,
      );
    }

    if (!stagedStat.isDirectory()) {
      throw new Error(
        `Refusing unsafe staged attachments directory "${stagedDirectory}"`,
      );
    }

    stagedDirectoryVerified = true;
  } catch (error) {
    if (detached && stagedDirectoryVerified) {
      try {
        await fs.promises.rename(stagedDirectory, paths.attachmentsDirectory);
      } catch (restoreError) {
        throw new AttachmentsNotRestoredError(
          `Unable to restore attachments directory after staging failure: ${errorMessage(restoreError)}`,
          restoreError,
        );
      }

      await removeTemporaryDirectory(temporaryDirectory);
    } else if (detached) {
      throw new Error(
        `${errorMessage(error)}; temporary attachment reconciliation directory retained at "${temporaryDirectory}"`,
        { cause: error },
      );
    }

    if (!detached) {
      await removeTemporaryDirectory(temporaryDirectory);
    }

    throw error;
  }

  return {
    attachmentsDirectory: paths.attachmentsDirectory,
    stagedDirectory,
    temporaryDirectory,
  };
}

async function restoreStaleFileBackups(
  transaction: StaleCleanupTransaction,
): Promise<void> {
  for (const backup of transaction.backups) {
    const originalPath = path.join(
      transaction.stagedDirectory,
      backup.filename,
    );

    try {
      await fs.promises.copyFile(
        backup.path,
        originalPath,
        fs.constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        continue;
      }

      throw new Error(
        `Unable to restore stale attachment file "${originalPath}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

async function rollbackStaleCleanup(
  transaction: StaleCleanupTransaction,
): Promise<void> {
  await restoreStaleFileBackups(transaction);
  await fs.promises.rename(
    transaction.stagedDirectory,
    transaction.attachmentsDirectory,
  );
  await removeTemporaryDirectory(transaction.temporaryDirectory);
}

async function removeCreatedAttachmentFiles(
  paths: CardContextPaths,
  createdAttachmentPaths: string[],
): Promise<void> {
  if (createdAttachmentPaths.length === 0) {
    return;
  }

  let detached: Awaited<ReturnType<typeof detachAttachmentsDirectory>>;

  try {
    detached = await detachAttachmentsDirectory(paths);
  } catch {
    return;
  }

  let restored = false;

  try {
    for (const createdAttachmentPath of createdAttachmentPaths) {
      await removeFile(
        path.join(
          detached.stagedDirectory,
          path.basename(createdAttachmentPath),
        ),
      );
    }

    await fs.promises.rename(
      detached.stagedDirectory,
      detached.attachmentsDirectory,
    );
    restored = true;
  } catch {
    // Preserve the staged tree when it cannot be safely restored.
  }

  if (restored) {
    await removeTemporaryDirectory(detached.temporaryDirectory);
  }
}

async function stageStaleManagedFiles(
  paths: CardContextPaths,
  previousManifest: CardAttachmentManifest | undefined,
  finalManifest: CardAttachmentManifest,
): Promise<StaleCleanupTransaction | undefined> {
  if (previousManifest === undefined) {
    return undefined;
  }

  const finalFilenames = new Set(
    finalManifest.attachments.flatMap((attachment) =>
      attachment.isUpload && attachment.localFilename !== null
        ? [attachment.localFilename]
        : [],
    ),
  );
  const staleFilenames = new Set(
    previousManifest.attachments.flatMap((attachment) =>
      attachment.isUpload && attachment.localFilename !== null
        ? [attachment.localFilename]
        : [],
    ),
  );

  for (const filename of finalFilenames) {
    staleFilenames.delete(filename);
  }

  if (staleFilenames.size === 0) {
    return undefined;
  }

  const detached = await detachAttachmentsDirectory(paths);
  const transaction: StaleCleanupTransaction = {
    ...detached,
    backups: [],
  };

  try {
    for (const filename of staleFilenames) {
      const attachmentPath = path.join(detached.stagedDirectory, filename);
      let stat: fs.Stats;

      try {
        stat = await fs.promises.lstat(attachmentPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }

        throw new Error(
          `Unable to inspect stale attachment file "${attachmentPath}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }

      const backupPath = path.join(
        detached.temporaryDirectory,
        `stale-${transaction.backups.length}`,
      );

      try {
        await fs.promises.copyFile(
          attachmentPath,
          backupPath,
          fs.constants.COPYFILE_EXCL,
        );
      } catch (error) {
        throw new Error(
          `Unable to back up stale attachment file "${attachmentPath}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      transaction.backups.push({ filename, path: backupPath });
    }

    for (const backup of transaction.backups) {
      const attachmentPath = path.join(
        detached.stagedDirectory,
        backup.filename,
      );

      try {
        await fs.promises.unlink(attachmentPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }

        throw new Error(
          `Unable to remove stale attachment file "${attachmentPath}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  } catch (error) {
    try {
      await rollbackStaleCleanup(transaction);
    } catch (rollbackError) {
      throw new AttachmentsNotRestoredError(
        `Unable to preserve attachments after stale-file cleanup failed: ${errorMessage(rollbackError)}`,
        rollbackError,
      );
    }

    throw error;
  }

  return transaction;
}

async function commitStaleCleanup(
  transaction: StaleCleanupTransaction,
): Promise<void> {
  await fs.promises.rename(
    transaction.stagedDirectory,
    transaction.attachmentsDirectory,
  );

  // A failure here cannot affect the published attachment state. Keep the
  // private backup directory for diagnosis rather than failing the refresh.
  await removeTemporaryDirectory(transaction.temporaryDirectory);
}

async function restoreManifestAfterFailure(
  paths: CardContextPaths,
  previousManifest: CardAttachmentManifest | undefined,
): Promise<void> {
  if (previousManifest === undefined) {
    await removeFile(paths.manifestPath);
    return;
  }

  await publishManifest(paths, previousManifest);
}

export async function materializeCardAttachments(
  source: TrelloAttachmentSource,
  contextRoot: string,
  projectId: string,
  cardId: string,
  options: MaterializeCardAttachmentsOptions = {},
): Promise<CardAttachmentManifest> {
  const maxAttachmentBytes = assertValidLimit(
    options.maxAttachmentBytes,
    "maxAttachmentBytes",
  );
  const maxTotalAttachmentBytes = assertValidLimit(
    options.maxTotalAttachmentBytes,
    "maxTotalAttachmentBytes",
  );
  const paths = createCardContextDirectories(contextRoot, projectId, cardId);
  const existingManifest = await readExistingManifest(
    paths,
    contextRoot,
    projectId,
    cardId,
  );

  throwIfAborted(options.signal);

  let attachments: TrelloAttachment[];

  try {
    const response =
      options.signal === undefined
        ? await source.getCardAttachments(cardId)
        : await source.getCardAttachments(cardId, options.signal);

    if (!Array.isArray(response)) {
      throw new Error("Trello attachment response must be an array");
    }

    attachments = response;
  } catch (error) {
    if (options.signal?.aborted) {
      throw new TrelloRequestAbortedError();
    }

    throw new Error(
      `Unable to retrieve Trello attachments for card "${cardId}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const attachmentIds = new Set<string>();

  for (const [index, attachment] of attachments.entries()) {
    validateAttachment(attachment, index);

    if (attachmentIds.has(attachment.id)) {
      throw new Error(
        `Trello attachment response contains duplicate attachment ID "${attachment.id}"`,
      );
    }

    attachmentIds.add(attachment.id);
  }

  const occupiedFilenames = await getOccupiedFilenames(
    paths.attachmentsDirectory,
  );
  const existingById = new Map(
    existingManifest?.attachments.map((attachment) => [
      attachment.id,
      attachment,
    ]) ?? [],
  );
  const plannedAttachments: PlannedAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment.isUpload) {
      plannedAttachments.push({
        attachment,
        localFilename: "",
        reuse: true,
      });
      continue;
    }

    const previous = existingById.get(attachment.id);
    let localFilename: string | undefined;
    let reuse = false;

    if (
      previous?.localFilename !== null &&
      previous?.localFilename !== undefined &&
      validateMetadata(previous, attachment)
    ) {
      if (
        await existingFileIsRegular(
          contextRoot,
          projectId,
          cardId,
          previous.localFilename,
        )
      ) {
        localFilename = previous.localFilename;
        reuse = true;
      } else if (!occupiedFilenames.has(previous.localFilename)) {
        localFilename = previous.localFilename;
      }
    }

    if (localFilename === undefined) {
      localFilename = allocateFilename(attachment.name, occupiedFilenames);
    } else {
      occupiedFilenames.add(localFilename);
    }

    resolveCardAttachmentPath(contextRoot, projectId, cardId, localFilename);

    plannedAttachments.push({ attachment, localFilename, reuse });
  }

  const manifestEntries: CardAttachmentManifestEntry[] = [];
  const createdAttachmentPaths: string[] = [];
  const manifest = { attachments: manifestEntries };
  let downloadedBytes = 0;
  let staleCleanup: StaleCleanupTransaction | undefined;
  let manifestPublished = false;

  try {
    for (const planned of plannedAttachments) {
      throwIfAborted(options.signal);

      if (planned.attachment.isUpload && !planned.reuse) {
        const attachmentPath = resolveCardAttachmentPath(
          contextRoot,
          projectId,
          cardId,
          planned.localFilename,
        );
        const receivedBytes = await downloadAttachmentToFile(
          source,
          planned.attachment,
          attachmentPath,
          maxAttachmentBytes,
          maxTotalAttachmentBytes,
          downloadedBytes,
          options.signal,
        );

        downloadedBytes += receivedBytes;
        createdAttachmentPaths.push(attachmentPath);
      }

      manifestEntries.push({
        ...planned.attachment,
        localFilename: planned.attachment.isUpload
          ? planned.localFilename
          : null,
      });
    }

    throwIfAborted(options.signal);

    staleCleanup = await stageStaleManagedFiles(
      paths,
      existingManifest,
      manifest,
    );
    await publishManifest(paths, manifest);
    manifestPublished = true;

    if (staleCleanup !== undefined) {
      await commitStaleCleanup(staleCleanup);
    }
  } catch (error) {
    let failure: unknown = error;
    let attachmentsRestored = !(error instanceof AttachmentsNotRestoredError);

    if (manifestPublished) {
      try {
        await restoreManifestAfterFailure(paths, existingManifest);
      } catch (restoreError) {
        failure = new Error(
          `Unable to restore attachments manifest after reconciliation failure: ${errorMessage(restoreError)}`,
          { cause: restoreError },
        );
      }
    }

    if (staleCleanup !== undefined) {
      try {
        await rollbackStaleCleanup(staleCleanup);
      } catch (rollbackError) {
        attachmentsRestored = false;
        failure = new Error(
          `Unable to preserve attachments after reconciliation failure: ${errorMessage(rollbackError)}`,
          { cause: failure },
        );
      }
    }

    if (attachmentsRestored) {
      await removeCreatedAttachmentFiles(paths, createdAttachmentPaths);
    }

    throw failure;
  }

  return manifest;
}
