/** Positive semantic fixture; classification validation is tested separately. */
export function actionableFeedbackResponse(prompt: string): string {
  const blocks = prompt.split("\n\n");
  const template = blocks.find((block) =>
    block.startsWith("Return only JSON: "),
  );
  if (!template) throw new Error("Expected feedback classification prompt");
  const identity = JSON.parse(template.slice("Return only JSON: ".length)) as {
    version: 1;
    projectId: string;
    cardId: string;
  };
  const candidates = JSON.parse(blocks.at(-1)!) as {
    feedbackId: string;
    sourceRevision: string;
    current: { body: string };
    previous: { body: string } | null;
  }[];
  return JSON.stringify({
    ...identity,
    assessments: candidates.map(
      ({ feedbackId, sourceRevision, current, previous }) => ({
        feedbackId,
        sourceRevision,
        actionability: "actionable",
        substantiveChange: previous === null || previous.body !== current.body,
      }),
    ),
  });
}
