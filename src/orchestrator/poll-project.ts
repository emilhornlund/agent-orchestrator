import type { ProjectConfig } from "../config/config.js";
import type { GitClient } from "../git/git-client.js";
import { prepareWorktree } from "../git/prepare-worktree.js";
import type { TrelloClient } from "../trello/trello-client.js";

import { claimNextCard } from "./claim-next-card.js";

export async function pollProject(
  trello: TrelloClient,
  git: GitClient,
  project: ProjectConfig,
): Promise<void> {
  const card = await claimNextCard(trello, project);

  if (!card) {
    console.log(`[${project.id}] No cards ready`);
    return;
  }

  console.log(`[${project.id}] Claimed card: ${card.name}`);

  const worktree = await prepareWorktree(git, project, card.id);

  console.log(`[${project.id}] Branch: ${worktree.branch}`);
  console.log(`[${project.id}] Worktree: ${worktree.path}`);
}
