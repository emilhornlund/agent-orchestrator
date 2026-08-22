export type WorkflowFailureCategory =
  "OpenCode" | "Validation" | "Git/GitHub" | "Workflow";

export class WorkflowError extends Error {
  readonly category: WorkflowFailureCategory;

  constructor(
    category: WorkflowFailureCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "WorkflowError";
    this.category = category;
  }
}
