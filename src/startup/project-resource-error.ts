export class ProjectResourceError extends Error {
  constructor(
    readonly disposition: "invalid" | "unavailable",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectResourceError";
  }
}
