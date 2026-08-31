import type { TrelloListTransition } from "../trello/trello-client.js";

export interface WorkflowListIds {
  readyListId: string;
  workingListId: string;
  reviewListId: string;
  failedListId: string;
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

export function selectAutomatedWorkflowPass(
  transitions: readonly TrelloListTransition[],
  listIds: WorkflowListIds,
): WorkflowDurationResult {
  const timestampedTransitions: TimestampedTransition[] = [];

  for (const transition of transitions) {
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
      transition.listAfterId === listIds.reviewListId,
  );
  const end = endCandidates.at(-1);

  if (end === undefined) {
    return omitted(
      `no ${listIds.workingListId} -> ${listIds.reviewListId} transition was recorded`,
    );
  }

  const latestTransition = timestampedTransitions.at(-1);

  if (latestTransition !== end) {
    return omitted(
      `the latest list transition is ${transitionDescription(latestTransition?.transition ?? end.transition)}, not the resulting ${listIds.workingListId} -> ${listIds.reviewListId} transition`,
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
      `no transition into ${listIds.workingListId} was recorded before the resulting Human Review transition`,
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
  } else if (workingEntry.transition.listBeforeId !== listIds.reviewListId) {
    return omitted(
      `the current ${listIds.workingListId} entry came from ${workingEntry.transition.listBeforeId}, not ${listIds.readyListId} or ${listIds.reviewListId}`,
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
