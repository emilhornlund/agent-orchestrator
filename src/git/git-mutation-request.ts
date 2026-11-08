import { z } from "zod";
const text = z.string().min(1);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const gitMutationRequestSchema = z.discriminatedUnion("route", [
  z.strictObject({
    route: z.literal("git-worktree"),
    args: z.strictObject({
      cwd: text,
      worktree: text,
      branch: text,
      start: sha,
      createBranch: z.boolean(),
    }),
  }),
  z.strictObject({
    route: z.literal("git-commit"),
    args: z.strictObject({
      cwd: text,
      branch: text,
      parent: sha,
      tree: sha,
      message: text,
      identity: z.strictObject({
        name: text,
        email: text,
        signingKey: text.optional(),
      }),
    }),
  }),
  z.strictObject({
    route: z.literal("git-push"),
    args: z.strictObject({
      cwd: text,
      branch: text,
      destination: text,
      sha,
      fetch: text,
    }),
  }),
  z.strictObject({
    route: z.literal("git-cleanup"),
    args: z.strictObject({
      cwd: text,
      resource: text,
      kind: z.enum(["worktree", "branch", "remote-branch"]),
      sha: sha.nullable(),
      destination: text.optional(),
    }),
  }),
]);
export type GitMutationRequest = z.infer<typeof gitMutationRequestSchema>;
