import type { Config } from "../config/config.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";

type Project = Config["projects"][number];

export async function pollProject(
  trello: TrelloClient,
  project: Project,
): Promise<void> {
  const card = await claimNextCard(trello, project);

  if (!card) {
    console.log(`[${project.id}] No cards ready`);
    return;
  }

  console.log(`[${project.id}] Claimed card: ${card.name}`);
}
