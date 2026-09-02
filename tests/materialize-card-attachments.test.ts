import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeCardAttachments,
  type TrelloAttachmentSource,
} from "../src/context/materialize-card-attachments.js";
import type { TrelloAttachment } from "../src/trello/trello-client.js";

const temporaryDirectories: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-attachments-"),
  );
  temporaryDirectories.push(root);
  return path.join(root, "context");
}

function upload(
  id: string,
  name: string,
  bytes: string | null = null,
): TrelloAttachment {
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    bytes,
    url: `https://trello.com/1/cards/card-1/attachments/${id}/download/${name}`,
    isUpload: true,
  };
}

function external(id: string, name: string): TrelloAttachment {
  return {
    id,
    name,
    mimeType: null,
    bytes: null,
    url: `https://example.com/${id}`,
    isUpload: false,
  };
}

function source(
  attachments: TrelloAttachment[],
  responses: Record<string, Response | Error> = {},
): TrelloAttachmentSource & {
  getCardAttachments: ReturnType<typeof vi.fn>;
  downloadCardAttachment: ReturnType<typeof vi.fn>;
} {
  const getCardAttachments = vi.fn().mockResolvedValue(attachments);
  const downloadCardAttachment = vi.fn(async (attachment: TrelloAttachment) => {
    const response = responses[attachment.id];

    if (response instanceof Error) {
      throw response;
    }

    return response ?? new Response(`contents:${attachment.id}`);
  });

  return {
    getCardAttachments,
    downloadCardAttachment,
  } as TrelloAttachmentSource & {
    getCardAttachments: ReturnType<typeof vi.fn>;
    downloadCardAttachment: ReturnType<typeof vi.fn>;
  };
}

function contextPaths(root: string): {
  directory: string;
  attachments: string;
  manifest: string;
} {
  const directory = path.join(root, "project-one", "card-1");

  return {
    directory,
    attachments: path.join(directory, "attachments"),
    manifest: path.join(directory, "attachments.json"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("materializeCardAttachments", () => {
  it("downloads uploads and writes ordered metadata with external links", async () => {
    const root = makeTemporaryRoot();
    const file = upload("file-1", "design.bin", "4");
    const link = external("link-1", "Design reference");
    const attachments = source([file, link], {
      "file-1": new Response(new Uint8Array([1, 2, 3, 4])),
    });

    const manifest = await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );
    const paths = contextPaths(root);

    expect(manifest).toEqual({
      attachments: [
        { ...file, localFilename: "design.bin" },
        { ...link, localFilename: null },
      ],
    });
    expect(fs.readFileSync(path.join(paths.attachments, "design.bin"))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(JSON.parse(fs.readFileSync(paths.manifest, "utf8"))).toEqual(
      manifest,
    );
    expect(attachments.downloadCardAttachment).toHaveBeenCalledOnce();
  });

  it("writes an empty manifest without requesting a download", async () => {
    const root = makeTemporaryRoot();
    const attachments = source([]);

    await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );

    const paths = contextPaths(root);
    expect(JSON.parse(fs.readFileSync(paths.manifest, "utf8"))).toEqual({
      attachments: [],
    });
    expect(attachments.downloadCardAttachment).not.toHaveBeenCalled();
  });

  it("reuses unchanged regular uploads and reconciles changed and new uploads", async () => {
    const root = makeTemporaryRoot();
    const first = upload("file-1", "same.txt", "5");
    const attachments = source([first], { "file-1": new Response("first") });

    await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );
    attachments.downloadCardAttachment.mockClear();

    const changed = { ...first, bytes: "6" };
    const newFile = upload("file-2", "same.txt", "4");
    attachments.getCardAttachments.mockResolvedValue([changed, newFile]);
    attachments.downloadCardAttachment.mockImplementation(
      async (attachment: TrelloAttachment) =>
        new Response(attachment.id === "file-1" ? "changed" : "new!"),
    );

    await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );

    expect(attachments.downloadCardAttachment).toHaveBeenCalledTimes(2);
    const paths = contextPaths(root);
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8")) as {
      attachments: Array<{ localFilename: string }>;
    };
    expect(manifest.attachments.map((entry) => entry.localFilename)).toEqual([
      "same-2.txt",
      "same-3.txt",
    ]);
    expect(
      fs.readFileSync(path.join(paths.attachments, "same.txt"), "utf8"),
    ).toBe("first");
  });

  it("does not request external URLs and allocates safe stable duplicate names", async () => {
    const root = makeTemporaryRoot();
    const first = upload("file-1", "../../unsafe/report.txt");
    const second = upload("file-2", "../../unsafe/report.txt");
    const link = external("link-1", "https://never-fetch.example");
    const attachments = source([first, second, link]);

    await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );

    const paths = contextPaths(root);
    const firstManifest = fs.readFileSync(paths.manifest, "utf8");
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8")) as {
      attachments: Array<{ localFilename: string | null }>;
    };
    expect(manifest.attachments.map((entry) => entry.localFilename)).toEqual([
      "report.txt",
      "report-2.txt",
      null,
    ]);
    expect(attachments.downloadCardAttachment).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(paths.attachments).sort()).toEqual([
      "report-2.txt",
      "report.txt",
    ]);

    const secondRun = source([first, second, link]);
    await materializeCardAttachments(secondRun, root, "project-one", "card-1");
    expect(secondRun.downloadCardAttachment).not.toHaveBeenCalled();
    expect(fs.readFileSync(contextPaths(root).manifest, "utf8")).toBe(
      firstManifest,
    );
  });

  it.each(["../outside.txt", "/absolute.txt", "C:\\outside.txt", ".."])(
    "rejects unsafe existing manifest filename %s",
    async (filename) => {
      const root = makeTemporaryRoot();
      const paths = contextPaths(root);
      fs.mkdirSync(paths.attachments, { recursive: true });
      fs.writeFileSync(
        paths.manifest,
        JSON.stringify({
          attachments: [
            { ...upload("file-1", "file.txt"), localFilename: filename },
          ],
        }),
      );
      const attachments = source([upload("file-1", "file.txt")]);

      await expect(
        materializeCardAttachments(attachments, root, "project-one", "card-1"),
      ).rejects.toThrow("unsafe localFilename");
      expect(attachments.downloadCardAttachment).not.toHaveBeenCalled();
    },
  );

  it("refuses symlinked managed files and preserves the old manifest on failure", async () => {
    const root = makeTemporaryRoot();
    const paths = contextPaths(root);
    const outside = path.join(path.dirname(root), "outside.txt");
    fs.mkdirSync(paths.attachments, { recursive: true });
    fs.writeFileSync(outside, "outside");
    fs.writeFileSync(
      paths.manifest,
      JSON.stringify({
        attachments: [
          { ...upload("file-1", "file.txt"), localFilename: "file.txt" },
        ],
      }),
    );
    fs.symlinkSync(outside, path.join(paths.attachments, "file.txt"));
    const attachments = source([upload("file-1", "file.txt")]);

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1"),
    ).rejects.toThrow("symbolic-link");
    expect(
      JSON.parse(fs.readFileSync(paths.manifest, "utf8")).attachments,
    ).toHaveLength(1);
  });

  it.each([
    ["declared individual", [upload("file-1", "large.bin", "5")], 4, 100],
    ["runtime individual", [upload("file-1", "large.bin", null)], 4, 100],
    [
      "aggregate",
      [upload("file-1", "one.bin", null), upload("file-2", "two.bin", null)],
      4,
      6,
    ],
  ])("enforces %s limits", async (_label, files, individual, aggregate) => {
    const root = makeTemporaryRoot();
    const attachments = source(
      files,
      Object.fromEntries(files.map((file) => [file.id, new Response("12345")])),
    );

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1", {
        maxAttachmentBytes: individual,
        maxTotalAttachmentBytes: aggregate,
      }),
    ).rejects.toThrow(/limit/);
    expect(fs.existsSync(contextPaths(root).manifest)).toBe(false);
  });

  it("does not publish a file or manifest entry after a failed later download", async () => {
    const root = makeTemporaryRoot();
    const first = upload("file-1", "first.txt");
    const second = upload("file-2", "second.txt");
    const attachments = source([first, second], {
      "file-1": new Response("first"),
      "file-2": new Error("connection reset"),
    });

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1"),
    ).rejects.toThrow("connection reset");

    const paths = contextPaths(root);
    expect(fs.readdirSync(paths.attachments)).toEqual([]);
    expect(fs.existsSync(paths.manifest)).toBe(false);
  });

  it("removes a partial streamed file when the response body fails", async () => {
    const root = makeTemporaryRoot();
    const file = upload("file-1", "partial.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("stream interrupted"));
      },
    });
    const attachments = source([file], { "file-1": new Response(stream) });

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1"),
    ).rejects.toThrow("Failed while materializing");

    const paths = contextPaths(root);
    expect(fs.readdirSync(paths.attachments)).toEqual([]);
    expect(fs.existsSync(paths.manifest)).toBe(false);
  });

  it("does not count reused files against the new-download aggregate limit", async () => {
    const root = makeTemporaryRoot();
    const reused = upload("file-1", "reused.bin", "4");
    const attachments = source([reused], { "file-1": new Response("1234") });

    await materializeCardAttachments(
      attachments,
      root,
      "project-one",
      "card-1",
    );
    attachments.downloadCardAttachment.mockClear();

    const newFile = upload("file-2", "new.bin", "4");
    attachments.getCardAttachments.mockResolvedValue([reused, newFile]);
    attachments.downloadCardAttachment.mockResolvedValue(new Response("5678"));

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1", {
        maxAttachmentBytes: 4,
        maxTotalAttachmentBytes: 4,
      }),
    ).resolves.toMatchObject({ attachments: expect.any(Array) });
    expect(attachments.downloadCardAttachment).toHaveBeenCalledOnce();
  });

  it("rejects malformed manifests instead of silently replacing them", async () => {
    const root = makeTemporaryRoot();
    const paths = contextPaths(root);
    fs.mkdirSync(paths.attachments, { recursive: true });
    fs.writeFileSync(paths.manifest, "not-json");
    const attachments = source([]);

    await expect(
      materializeCardAttachments(attachments, root, "project-one", "card-1"),
    ).rejects.toThrow("not valid JSON");
  });
});
