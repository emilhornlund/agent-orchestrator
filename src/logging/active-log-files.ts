import path from "node:path";

const activeLogFiles = new Set<string>();

export function withActiveLogFile<T>(filePath: string, write: () => T): T {
  const resolvedPath = path.resolve(filePath);
  activeLogFiles.add(resolvedPath);

  try {
    return write();
  } finally {
    activeLogFiles.delete(resolvedPath);
  }
}

export function isActiveLogFile(filePath: string): boolean {
  return activeLogFiles.has(path.resolve(filePath));
}
