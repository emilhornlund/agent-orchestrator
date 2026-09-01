import type { ProjectConfig } from "../config/config.js";
import type { Logger } from "../logging/logger.js";
import type {
  TrelloClient,
  TrelloListTransition,
} from "../trello/trello-client.js";

export interface WorkflowListIds {
  readyListId: string;
  workingListId: string;
  reviewListId: string;
  failedListId: string;
}

export interface RefinementWorkflowListIds {
  readyListId: string;
  workingListId: string;
  failedListId: string;
  backlogListId: string;
}

export interface AutomatedWorkflowPass {
  startTransition: TrelloListTransition;
  endTransition: TrelloListTransition;
  durationMilliseconds: number;
}

export type WorkflowDurationResult =
  | {
      pass: AutomatedWorkflowPass;
    }
  | {
      pass: null;
      reason: string;
    };

interface TimestampedTransition {
  transition: TrelloListTransition;
  timestamp: number;
}

function omitted(reason: string): WorkflowDurationResult {
  return {
    pass: null,
    reason,
  };
}

function transitionDescription(transition: TrelloListTransition): string {
  return `${transition.listBeforeId} -> ${transition.listAfterId} (${transition.id})`;
}

interface WorkflowPassSelectionOptions {
  endListId: string;
  endListDescription: string;
  allowReviewStart: boolean;
}

interface WorkflowPassListIds {
  readyListId: string;
  workingListId: string;
  reviewListId?: string;
  failedListId: string;
}

function selectWorkflowPass(
  transitions: readonly TrelloListTransition[],
  listIds: WorkflowPassListIds,
  options: WorkflowPassSelectionOptions,
): WorkflowDurationResult {
  const timestampedTransitions: TimestampedTransition[] = [];

  if (!Array.isArray(transitions)) {
    return omitted("transition history is malformed");
  }

  for (const [index, transition] of transitions.entries()) {
    if (
      typeof transition !== "object" ||
      transition === null ||
      typeof transition.id !== "string" ||
      transition.id.length === 0 ||
      typeof transition.date !== "string" ||
      typeof transition.listBeforeId !== "string" ||
      transition.listBeforeId.length === 0 ||
      typeof transition.listAfterId !== "string" ||
      transition.listAfterId.length === 0
    ) {
      return omitted(`transition at index ${index} is malformed`);
    }

    const timestamp = Date.parse(transition.date);

    if (Number.isNaN(timestamp)) {
      return omitted(
        `transition ${transition.id} has an invalid timestamp ${JSON.stringify(transition.date)}`,
      );
    }

    timestampedTransitions.push({ transition, timestamp });
  }

  timestampedTransitions.sort(
    (left, right) => left.timestamp - right.timestamp,
  );

  for (let index = 1; index < timestampedTransitions.length; index += 1) {
    const previous = timestampedTransitions[index - 1];
    const current = timestampedTransitions[index];

    if (previous !== undefined && current !== undefined) {
      if (previous.timestamp === current.timestamp) {
        return omitted(
          `transition history is ambiguous because ${previous.transition.id} and ${current.transition.id} have the same timestamp`,
        );
      }
    }
  }

  const endCandidates = timestampedTransitions.filter(
    ({ transition }) =>
      transition.listBeforeId === listIds.workingListId &&
      transition.listAfterId === options.endListId,
  );
  const end = endCandidates.at(-1);

  if (end === undefined) {
    return omitted(
      `no ${listIds.workingListId} -> ${options.endListId} transition was recorded`,
    );
  }

  const latestTransition = timestampedTransitions.at(-1);

  if (latestTransition !== end) {
    return omitted(
      `the latest list transition is ${transitionDescription(latestTransition?.transition ?? end.transition)}, not the resulting ${listIds.workingListId} -> ${options.endListId} transition`,
    );
  }

  const workingEntries = timestampedTransitions.filter(
    ({ transition, timestamp }) =>
      transition.listAfterId === listIds.workingListId &&
      timestamp < end.timestamp,
  );
  const workingEntry = workingEntries.at(-1);

  if (workingEntry === undefined) {
    return omitted(
      `no transition into ${listIds.workingListId} was recorded before the resulting ${options.endListDescription} transition`,
    );
  }

  const staleWorkingExit = timestampedTransitions.find(
    ({ transition, timestamp }) =>
      transition.listBeforeId === listIds.workingListId &&
      timestamp > workingEntry.timestamp &&
      timestamp < end.timestamp,
  );

  if (staleWorkingExit !== undefined) {
    return omitted(
      `the selected ${listIds.workingListId} entry ${workingEntry.transition.id} is followed by ${transitionDescription(staleWorkingExit.transition)} before the resulting transition`,
    );
  }

  let start = workingEntry;

  if (workingEntry.transition.listBeforeId === listIds.readyListId) {
    const workingEntryIndex = timestampedTransitions.indexOf(workingEntry);
    const previousTransition = timestampedTransitions[workingEntryIndex - 1];

    if (previousTransition?.transition.listAfterId === listIds.failedListId) {
      return omitted(
        `the current ${listIds.workingListId} entry follows a transition into ${listIds.failedListId} without a recorded transition into ${listIds.readyListId}`,
      );
    }

    if (
      previousTransition?.transition.listBeforeId === listIds.failedListId &&
      previousTransition.transition.listAfterId === listIds.readyListId
    ) {
      start = previousTransition;
    }
  } else if (
    !options.allowReviewStart ||
    workingEntry.transition.listBeforeId !== listIds.reviewListId
  ) {
    return omitted(
      `the current ${listIds.workingListId} entry came from ${workingEntry.transition.listBeforeId}, not ${listIds.readyListId}${options.allowReviewStart ? ` or ${listIds.reviewListId}` : ""}`,
    );
  }

  const durationMilliseconds = end.timestamp - start.timestamp;

  if (durationMilliseconds < 0) {
    return omitted(
      `the resulting transition ${end.transition.id} occurs before the pass start transition ${start.transition.id}`,
    );
  }

  return {
    pass: {
      startTransition: start.transition,
      endTransition: end.transition,
      durationMilliseconds,
    },
  };
}

export function selectAutomatedWorkflowPass(
  transitions: readonly TrelloListTransition[],
  listIds: WorkflowListIds,
): WorkflowDurationResult {
  return selectWorkflowPass(transitions, listIds, {
    endListId: listIds.reviewListId,
    endListDescription: "Human Review",
    allowReviewStart: true,
  });
}

export function selectRefinementWorkflowPass(
  transitions: readonly TrelloListTransition[],
  listIds: RefinementWorkflowListIds,
): WorkflowDurationResult {
  return selectWorkflowPass(
    transitions,
    {
      readyListId: listIds.readyListId,
      workingListId: listIds.workingListId,
      failedListId: listIds.failedListId,
    },
    {
      endListId: listIds.backlogListId,
      endListDescription: "Backlog",
      allowReviewStart: false,
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getElapsedWorkflowTime(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  cardLog: Logger,
): Promise<string | undefined> {
  return getElapsedWorkflowTimeForPass(trello, cardId, cardLog, (transitions) =>
    selectAutomatedWorkflowPass(transitions, {
      readyListId: project.trello.readyListId,
      workingListId: project.trello.workingListId,
      reviewListId: project.trello.reviewListId,
      failedListId: project.trello.failedListId,
    }),
  );
}

export async function getElapsedRefinementWorkflowTime(
  trello: TrelloClient,
  project: ProjectConfig,
  cardId: string,
  cardLog: Logger,
): Promise<string | undefined> {
  return getElapsedWorkflowTimeForPass(trello, cardId, cardLog, (transitions) =>
    selectRefinementWorkflowPass(transitions, {
      readyListId: project.trello.readyListId,
      workingListId: project.trello.workingListId,
      failedListId: project.trello.failedListId,
      backlogListId: project.trello.backlogListId,
    }),
  );
}

async function getElapsedWorkflowTimeForPass(
  trello: TrelloClient,
  cardId: string,
  cardLog: Logger,
  selectPass: (
    transitions: readonly TrelloListTransition[],
  ) => WorkflowDurationResult,
): Promise<string | undefined> {
  try {
    if (typeof trello.getListTransitions !== "function") {
      throw new Error("Trello client does not provide list transition history");
    }

    const transitions = await trello.getListTransitions(cardId);

    if (transitions === null) {
      throw new Error(
        "Trello action history contains an incomplete list transition",
      );
    }

    const duration = selectPass(transitions);

    if (duration.pass === null) {
      throw new Error(duration.reason);
    }

    return formatWorkflowDuration(duration.pass.durationMilliseconds);
  } catch (error) {
    cardLog.warn(`Elapsed workflow time omitted: ${getErrorMessage(error)}`);

    return undefined;
  }
}

function unit(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function formatWorkflowDuration(durationMilliseconds: number): string {
  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
    throw new Error("Workflow duration must be a finite, non-negative number");
  }

  let remainingSeconds = Math.floor(durationMilliseconds / 1000);
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(unit(days, "day", "days"));
  }

  if (hours > 0) {
    parts.push(unit(hours, "hour", "hours"));
  }

  if (minutes > 0) {
    parts.push(unit(minutes, "minute", "minutes"));
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(unit(seconds, "second", "seconds"));
  }

  return parts.join(" ");
}
