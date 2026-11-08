import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../../src/config/config.js";
import type { GitClient } from "../../src/git/git-client.js";
import type { GitHubClient } from "../../src/github/github-client.js";
import type { OpenCodeClient } from "../../src/opencode/opencode-client.js";
import type {
  TrelloClient,
  TrelloCard,
} from "../../src/trello/trello-client.js";
import { Logger } from "../../src/logging/logger.js";
import {
  NotificationOutbox,
  notificationTriggerObserver,
} from "../../src/notifications/notification-outbox.js";
import { publishCard } from "../../src/orchestrator/publish-card.js";
import { failCard } from "../../src/orchestrator/fail-card.js";
import { runRefinementOperation } from "../../src/refinement/refinement-operation.js";
import { getRefinementResultPath } from "../../src/refinement/refinement-result.js";

export type NotificationRoute = "publication" | "refinement" | "failure";
export function notificationRouteFixture(
  root: string,
  route: NotificationRoute,
  accepted?: () => void,
) {
  const project = {
    id: "p",
    autoMerge: false,
    trello: {
      boardId: "board",
      backlogListId: "backlog",
      reviewListId: "review",
      failedListId: "failed",
      readyListId: "ready",
      workingListId: "working",
      doneListId: "done",
      refinementLabelId: "refine",
      featureLabelId: "feature",
      improvementLabelId: "improvement",
      bugLabelId: "bug",
    },
    repository: {
      path: root,
      worktreeRoot: root,
      github: "o/r",
      defaultBranch: "main",
    },
    opencode: { refinement: {}, timeoutMinutes: 1 },
  } as ProjectConfig;
  const card: TrelloCard = {
    id: "card",
    name: "Task",
    desc: "Task description",
    url: "https://trello.com/c/card",
    idList: "working",
    idLabels: ["refine"],
  };
  const statePath = path.join(root, "external-card.json");
  if (!fs.existsSync(statePath))
    fs.writeFileSync(statePath, JSON.stringify(card));
  const read = (): TrelloCard =>
    JSON.parse(fs.readFileSync(statePath, "utf8")) as TrelloCard;
  const update = (values: Partial<TrelloCard>) =>
    fs.writeFileSync(statePath, JSON.stringify({ ...read(), ...values }));
  const trello = {
    getLists: async () =>
      ["backlog", "review", "failed"].map((id) => ({ id, name: id })),
    getCards: async (list: string) => (read().idList === list ? [read()] : []),
    getListTransitions: async () =>
      fs.existsSync(path.join(root, "transitions.json"))
        ? (JSON.parse(
            fs.readFileSync(path.join(root, "transitions.json"), "utf8"),
          ) as {
            id: string;
            date: string;
            listBeforeId: string;
            listAfterId: string;
          }[])
        : [],
    moveCard: async (_id: string, list: string) => {
      fs.appendFileSync(path.join(root, "requests.jsonl"), `${list}\n`);
      fs.writeFileSync(
        path.join(root, "transitions.json"),
        JSON.stringify([
          {
            id: "transition-1",
            date: new Date().toISOString(),
            listBeforeId: read().idList,
            listAfterId: list,
          },
        ]),
      );
      update({ idList: list });
      accepted?.();
      return read();
    },
    updateCardContent: async (_id: string, name: string, desc: string) => {
      update({ name, desc });
    },
    removeLabel: async (_id: string, label: string) => {
      update({ idLabels: read().idLabels.filter((id) => id !== label) });
    },
    addLabel: async (_id: string, label: string) => {
      update({ idLabels: [...read().idLabels, label] });
    },
    addComment: async () => ({
      id: "comment",
      type: "commentCard",
      date: new Date().toISOString(),
    }),
  } as unknown as TrelloClient;
  const git = {
    getCurrentBranch: async () => "agent/card",
    getStatus: async () => "",
    getDiff: async () => "",
    getUntrackedFiles: async () => [],
    fetch: async () => {},
    getHeadSha: async () => "sha",
    getRemoteBranchSha: async () => "sha",
    push: async () => {},
  } as unknown as GitClient;
  const github = {
    findPullRequest: async () => ({ url: "https://github.com/o/r/pull/1" }),
  } as unknown as GitHubClient;
  const notifier = {
    send: async (message: { text: string }) => {
      fs.appendFileSync(
        path.join(root, "sink.jsonl"),
        `${JSON.stringify(message)}\n`,
      );
    },
  };
  const open = () =>
    new NotificationOutbox(
      root,
      "p",
      () => {},
      Date.now,
      notificationTriggerObserver(root, "p", () => {}),
    );
  const run = () =>
    open().run(async () => {
      if (route === "publication")
        return publishCard({
          project,
          card,
          trello,
          git,
          github,
          branch: "agent/card",
          worktreePath: root,
          commitSha: "sha",
          reviewResult: "Passed",
          remediationResult: "Not required",
          emailNotifier: notifier,
        });
      if (route === "refinement") {
        const resultPath = getRefinementResultPath(root);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        const opencode = {
          run: async () => {
            fs.writeFileSync(
              resultPath,
              JSON.stringify({
                title: "Refined task",
                description: "Refined description",
                type: "feature",
              }),
            );
            return { exitCode: 0, output: "", errorOutput: "" };
          },
        } as unknown as OpenCodeClient;
        return runRefinementOperation({
          project,
          card,
          trello,
          git,
          opencode,
          signal: new AbortController().signal,
          worktreePath: root,
          cardLog: new Logger({ projectId: "p", cardId: "card" }),
          emailNotifier: notifier,
        });
      }
      const failure = new Error("Primary failed");
      try {
        await failCard(trello, project, card.id, failure, notifier, card);
      } catch (error) {
        if (error !== failure) throw error;
      }
    });
  return {
    run,
    open,
    read,
    notifier,
    observer: notificationTriggerObserver(root, "p", () => {}),
  };
}
