import { z } from "zod";

function requiredEnvironmentVariable(name: string) {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? `${name} is required`
          : `${name} must be a string`,
    })
    .min(1, {
      error: `${name} is required`,
    });
}

const environmentSchema = z.object({
  TRELLO_API_KEY: requiredEnvironmentVariable("TRELLO_API_KEY"),
  TRELLO_TOKEN: requiredEnvironmentVariable("TRELLO_TOKEN"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(environment: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const location = issue.path.join(".");
      return `${location}: ${issue.message}`;
    });

    throw new Error(`Invalid environment:\n${messages.join("\n")}`);
  }

  return result.data;
}
