export function buildValidationPromptLines(
  validationCommand?: string,
): string[] {
  return [
    validationCommand
      ? `Run the configured repository validation command: \`${validationCommand}\` before finishing.`
      : "Run the repository's appropriate validation checks.",
    "Leave the repository validation passing before finishing.",
  ];
}
