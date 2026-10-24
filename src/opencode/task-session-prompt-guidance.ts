export const taskSessionRepositoryGuidance = [
  "Before planning or changing source, read the repository-root AGENTS.md and any more-specific AGENTS.md files that apply to the task.",
  "Inspect the repository-native OpenCode skills under .opencode/skills/ and load relevant skills using OpenCode's native skill mechanism before proceeding.",
  "If no relevant repository-local skill is available, continue using repository instructions; do not download or install skills, access the network, or use external/global skills.",
] as const;
