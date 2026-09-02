const activeCardContexts = new Map<string, number>();
const activeProjectContexts = new Map<string, number>();

function getActiveCardKey(projectId: string, cardId: string): string {
  return `${projectId}\u0000${cardId}`;
}

function incrementActiveContext(
  contexts: Map<string, number>,
  key: string,
): () => void {
  contexts.set(key, (contexts.get(key) ?? 0) + 1);
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    const count = contexts.get(key);

    if (count === undefined || count <= 1) {
      contexts.delete(key);
    } else {
      contexts.set(key, count - 1);
    }
  };
}

export function beginActiveCardContext(
  projectId: string,
  cardId: string,
): () => void {
  return incrementActiveContext(
    activeCardContexts,
    getActiveCardKey(projectId, cardId),
  );
}

export function beginActiveProjectContext(projectId: string): () => void {
  return incrementActiveContext(activeProjectContexts, projectId);
}

export async function withActiveCardContext<T>(
  projectId: string,
  cardId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = beginActiveCardContext(projectId, cardId);

  try {
    return await operation();
  } finally {
    release();
  }
}

export async function withActiveProjectContext<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = beginActiveProjectContext(projectId);

  try {
    return await operation();
  } finally {
    release();
  }
}

export function isActiveCardContext(
  projectId: string,
  cardId: string,
): boolean {
  return (
    activeProjectContexts.has(projectId) ||
    activeCardContexts.has(getActiveCardKey(projectId, cardId))
  );
}
