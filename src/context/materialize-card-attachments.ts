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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function validateAttachment(attachment: TrelloAttachment, index: number): void {
  if (
    typeof attachment.id !== "string" ||
    typeof attachment.name !== "string" ||
    (typeof attachment.mimeType !== "string" && attachment.mimeType !== null) ||
    (typeof attachment.bytes !== "string" && attachment.bytes !== null) ||
    typeof attachment.url !== "string" ||
    typeof attachment.isUpload !== "boolean"
  ) {
    throw new Error(`Trello attachment ${index} has invalid metadata`);
  }
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
  const stem = extension.length > 0 ? leaf.slice(0, -extension.length) : leaf;
  const availableStemLength = Math.max(
    1,
    maximumFilenameLength - extension.length,
  );

  return `${stem.slice(0, availableStemLength)}${extension}`;
}

function addFilenameSuffix(filename: string, suffix: number): string {
  const extension = path.extname(filename);
  const stem =
    extension.length > 0 ? filename.slice(0, -extension.length) : filename;

  return `${stem}-${suffix}${extension}`;
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

  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (typeof value.mimeType !== "string" && value.mimeType !== null) ||
    (typeof value.bytes !== "string" && value.bytes !== null) ||
    typeof value.url !== "string" ||
    typeof value.isUpload !== "boolean"
  ) {
    throw new Error(
      `Existing attachments manifest entry ${index} has invalid metadata`,
    );
  }

  const localFilename = value.localFilename;

  if (typeof localFilename !== "string" && localFilename !== null) {
    throw new Error(
      `Existing attachments manifest entry ${index} has an invalid localFilename`,
    );
  }

  if (value.isUpload && localFilename === null) {
    throw new Error(
      `Existing attachments manifest entry ${index} is an upload without a localFilename`,
    );
  }

  if (!value.isUpload && localFilename !== null) {
    throw new Error(
      `Existing attachments manifest entry ${index} assigns a localFilename to an external attachment`,
    );
  }

  const attachment: TrelloAttachment = {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    bytes: value.bytes,
    url: value.url,
    isUpload: value.isUpload,
  };

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

    if (contentLength !== undefined && receivedBytes !== contentLength) {
      throw new Error(
        `Trello attachment "${attachment.name}" (${attachment.id}) response Content-Length was ${contentLength} bytes but ${receivedBytes} bytes were received`,
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
    attachments = await source.getCardAttachments(cardId);
  } catch (error) {
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
  let downloadedBytes = 0;

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

    const manifest = { attachments: manifestEntries };
    await publishManifest(paths, manifest);
    return manifest;
  } catch (error) {
    for (const attachmentPath of createdAttachmentPaths) {
      try {
        await removeFile(attachmentPath);
      } catch {
        // Preserve the primary failure and never claim these files in a manifest.
      }
    }

    throw error;
  }
}
