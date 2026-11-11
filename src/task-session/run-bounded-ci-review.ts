import {
  runTaskSessionReview,
  TaskSessionReviewUnavailableError,
} from "./run-task-session-review.js";
import { getTaskSessionSourceSnapshotIdentity } from "./source-snapshot.js";

/** The persisted source-specific allowance also applies to prepared-content review. */
export async function runBoundedCiReview(
  options: Parameters<typeof runTaskSessionReview>[0],
) {
  const identity = await getTaskSessionSourceSnapshotIdentity(
    options.git,
    options.worktreePath,
  );
  for (;;) {
    const current = options.taskRecordStore.read(options.card.id);
    if (!current?.ciRepair) throw new Error("CI review lost its episode");
    const attempts = current.ciRepair.reviewSourceAttempts?.[identity] ?? 0;
    if (attempts >= 3)
      throw new TaskSessionReviewUnavailableError(
        "Independent CI review exhausted its bounded attempts for the current source",
      );
    options.taskRecordStore.compareAndSwap(current.cardId, current.revision, {
      ...current,
      ciRepair: {
        ...current.ciRepair,
        reviewSourceAttempts: {
          ...current.ciRepair.reviewSourceAttempts,
          [identity]: attempts + 1,
        },
      },
      revision: current.revision + 1,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
      ).toISOString(),
    });
    try {
      return await runTaskSessionReview(options);
    } catch (error) {
      if (
        !(error instanceof TaskSessionReviewUnavailableError) ||
        options.runOptions.signal.aborted
      )
        throw error;
      if (
        (await getTaskSessionSourceSnapshotIdentity(
          options.git,
          options.worktreePath,
        )) !== identity
      )
        throw new Error("CI source changed during advisory review", {
          cause: error,
        });
    }
  }
}
