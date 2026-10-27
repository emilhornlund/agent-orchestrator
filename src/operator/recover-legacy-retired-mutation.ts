import "dotenv/config";

import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/config.js";
import { parseEnvironment } from "../config/environment.js";
import { TaskExecutionStore } from "../task-session/task-execution-store.js";
import { TaskMutationQueue } from "../task-session/task-mutation-queue.js";
import { TrelloClient } from "../trello/trello-client.js";

const usage =
  "Usage: yarn recover:legacy-mutation --project ID --event EVENT_ID --confirm-never-started";

function parseArguments(args: readonly string[]): {
  projectId: string;
  eventId: string;
} {
  if (
    args.length !== 5 ||
    args[0] !== "--project" ||
    args[2] !== "--event" ||
    args[4] !== "--confirm-never-started" ||
    args[1] === undefined ||
    args[3] === undefined
  )
    throw new Error(usage);
  return { projectId: args[1], eventId: args[3] };
}

export async function recoverLegacyRetiredMutation(
  args: readonly string[],
): Promise<void> {
  const { projectId, eventId } = parseArguments(args);
  const config = loadConfig();
  const configured = config.projects.find(
    (project) => project.id === projectId,
  );
  if (configured === undefined)
    throw new Error(`Unknown project: ${projectId}`);
  const project = { ...configured, contextRoot: config.workflow.contextRoot };
  const event = new TaskMutationQueue(config.workflow.contextRoot, project)
    .list()
    .find((candidate) => candidate.eventId === eventId);
  if (
    event === undefined ||
    event.projectId !== project.id ||
    !["implementation", "refinement"].includes(event.kind) ||
    event.status !== "completed"
  )
    throw new Error(
      "The specified event is not a legacy completed Ready mutation",
    );

  const taskStore = new TaskExecutionStore(
    config.workflow.contextRoot,
    project,
  );
  if (taskStore.read(event.cardId) !== null)
    throw new Error(
      `Task execution ownership exists for ${event.cardId}; preserving the completed mutation`,
    );

  const environment = parseEnvironment(process.env);
  const trello = new TrelloClient({
    apiKey: environment.TRELLO_API_KEY,
    token: environment.TRELLO_TOKEN,
    signal: new AbortController().signal,
    timeoutMilliseconds: 30_000,
  });
  const [readyCards, workingCards] = await Promise.all([
    trello.getCards(project.trello.readyListId),
    trello.getCards(project.trello.workingListId),
  ]);
  if (
    !readyCards.some((card) => card.id === event.cardId) ||
    workingCards.some((card) => card.id === event.cardId)
  )
    throw new Error(
      `Card ${event.cardId} must be verified in Ready for Agent and absent from Working before recovery`,
    );

  const queue = new TaskMutationQueue(config.workflow.contextRoot, project);
  const recovered = queue.retireLegacyCompletedEvent(eventId, true);
  process.stdout.write(
    `Recorded operator-confirmed retirement for ${recovered.eventId}; the next workflow poll may schedule it as a fresh attempt.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  recoverLegacyRetiredMutation(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
