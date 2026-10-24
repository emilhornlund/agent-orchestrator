import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCardAttachmentPromptLines,
  type CardAttachmentPromptContext,
} from "../src/context/card-attachment-prompt.js";
import type { CardAttachmentManifest } from "../src/context/materialize-card-attachments.js";
import { buildRefinementPrompt } from "../src/opencode/build-refinement-prompt.js";
import { buildTaskPlanningPrompt } from "../src/opencode/build-task-planning-prompt.js";
import { buildTaskSessionImplementationPrompt } from "../src/opencode/build-task-session-implementation-prompt.js";
import type { TaskPlan } from "../src/task-session/task-plan.js";
import type { TrelloCard } from "../src/trello/trello-client.js";

let temporaryRoot: string | undefined;

function createCard(): TrelloCard {
  return {
    id: "card-123",
    name: "Attachment task",
    desc: "Implement the attachment task.",
    idList: "working",
    idLabels: [],
    url: "https://trello.example/card-123",
  };
}

function createContext(): CardAttachmentPromptContext {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-orchestrator-prompt-context-"),
  );

  const contextRoot = path.join(temporaryRoot, "custom-context-root");
  const attachmentsDirectory = path.join(
    contextRoot,
    "project-123",
    "card-123",
    "attachments",
  );
  const requirementsPath = path.join(attachmentsDirectory, "requirements.md");
  const binaryPath = path.join(attachmentsDirectory, "payload.bin");

  fs.mkdirSync(attachmentsDirectory, { recursive: true });
  fs.writeFileSync(requirementsPath, "SECRET_REQUIREMENTS_CONTENT", "utf8");
  fs.writeFileSync(binaryPath, "SECRET_BINARY_CONTENT", "utf8");

  const manifest: CardAttachmentManifest = {
    attachments: [
      {
        id: "external-1",
        name: "Design reference",
        mimeType: null,
        bytes: null,
        url: "https://example.com/design",
        isUpload: false,
        localFilename: null,
      },
      {
        id: "upload-1",
        name: "requirements.md",
        mimeType: "text/markdown",
        bytes: "26",
        url: "https://trello.example/requirements.md",
        isUpload: true,
        localFilename: "requirements.md",
      },
      {
        id: "upload-2",
        name: "payload.bin",
        mimeType: "   ",
        bytes: null,
        url: "https://trello.example/payload.bin",
        isUpload: true,
        localFilename: "payload.bin",
      },
    ],
  };

  return {
    manifest,
    contextRoot,
    projectId: "project-123",
    cardId: "card-123",
  };
}

function buildPrompts(
  card: TrelloCard,
  context: CardAttachmentPromptContext,
): string[] {
  const approvedPlan: TaskPlan = {
    version: 1,
    projectId: "project-123",
    cardId: card.id,
    requirements: [
      {
        id: "REQ-1",
        text: "Implement the attachment task.",
        verification: "Run the task tests.",
      },
    ],
    steps: [
      {
        id: "STEP-1",
        description: "Implement the task behavior.",
        requirementIds: ["REQ-1"],
        verification: "Run the task tests.",
      },
    ],
    assumptions: [],
    blockers: [],
  };
  return [
    buildTaskPlanningPrompt("project-123", card, [], context),
    buildTaskSessionImplementationPrompt({
      projectId: "project-123",
      card,
      approvedPlan,
      attachmentContext: context,
    }),
    buildRefinementPrompt(card, context),
  ];
}

afterEach(() => {
  if (temporaryRoot !== undefined) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe("card attachment prompt context", () => {
  it("omits the section for an empty materialized manifest", () => {
    const context: CardAttachmentPromptContext = {
      contextRoot: "/tmp/custom-context-root",
      projectId: "project-123",
      cardId: "card-123",
      manifest: { attachments: [] },
    };

    expect(buildCardAttachmentPromptLines(context)).toEqual([]);

    for (const prompt of buildPrompts(createCard(), context)) {
      expect(prompt).not.toContain("Trello card attachments:");
    }
  });

  it("adds ordered metadata and safe locations to all applicable prompts", () => {
    const card = createCard();
    const context = createContext();
    const requirementsPath = path.join(
      context.contextRoot,
      context.projectId,
      context.cardId,
      "attachments",
      "requirements.md",
    );
    const binaryPath = path.join(
      context.contextRoot,
      context.projectId,
      context.cardId,
      "attachments",
      "payload.bin",
    );

    for (const prompt of buildPrompts(card, context)) {
      expect(prompt).toContain("Trello card attachments:");
      expect(prompt).toContain(
        "These attachments are part of the Trello task context. Inspect them when relevant.",
      );
      expect(prompt).toContain(
        "- Design reference: external URL: https://example.com/design",
      );
      expect(prompt).toContain(
        `- requirements.md (text/markdown): local file: ${requirementsPath}`,
      );
      expect(prompt).toContain(`- payload.bin: local file: ${binaryPath}`);
      expect(prompt.indexOf("Design reference")).toBeLessThan(
        prompt.indexOf("requirements.md"),
      );
      expect(prompt.indexOf("requirements.md")).toBeLessThan(
        prompt.indexOf("payload.bin"),
      );
      expect(prompt).not.toContain("(null)");
      expect(prompt).not.toContain("SECRET_REQUIREMENTS_CONTENT");
      expect(prompt).not.toContain("SECRET_BINARY_CONTENT");
    }

    expect(path.isAbsolute(requirementsPath)).toBe(true);
    expect(path.isAbsolute(binaryPath)).toBe(true);
  });

  it("fails instead of advertising a missing uploaded file", () => {
    const context = createContext();
    const uploadedAttachment = context.manifest.attachments[1];

    if (uploadedAttachment === undefined) {
      throw new Error("Expected uploaded attachment fixture");
    }

    context.manifest.attachments[1] = {
      ...uploadedAttachment,
      localFilename: "missing.md",
    };

    expect(() =>
      buildTaskPlanningPrompt("project-123", createCard(), [], context),
    ).toThrow("materialized file");
    expect(() =>
      buildTaskSessionImplementationPrompt({
        projectId: "project-123",
        card: createCard(),
        approvedPlan: {
          version: 1,
          projectId: "project-123",
          cardId: "card-123",
          requirements: [
            { id: "REQ-1", text: "Do it", verification: "Test it" },
          ],
          steps: [
            {
              id: "STEP-1",
              description: "Do it",
              requirementIds: ["REQ-1"],
              verification: "Test it",
            },
          ],
          assumptions: [],
          blockers: [],
        },
        attachmentContext: context,
      }),
    ).toThrow("materialized file");
  });
});
