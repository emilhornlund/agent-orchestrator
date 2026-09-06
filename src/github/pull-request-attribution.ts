export function buildPullRequestAttributionFooter(
  gitIdentityName: string,
): string {
  return `Implemented automatically by ${gitIdentityName}.`;
}
