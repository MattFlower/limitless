import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const databases = new Map<string, number>();

/** Protect SQLite and its sidecars for every factory, including non-default data directories. */
export function protectDatabase(path: string): () => void {
  if (path === ":memory:") return () => {};
  const paths = [...new Set([resolve(path), realpathSync(path)])];
  for (const p of paths) databases.set(p, (databases.get(p) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const p of paths) {
      const count = (databases.get(p) ?? 1) - 1;
      if (count) databases.set(p, count);
      else databases.delete(p);
    }
  };
}

export const privateReadPaths = (): string[] =>
  [...databases.keys()].flatMap((p) => [p, `${p}-wal`, `${p}-shm`]);
