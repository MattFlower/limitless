import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const privatePaths = new Map<string, number>();

/** Protect a private file in both its configured and canonical spellings. */
export function protectPrivateFile(path: string, sidecars = false): () => void {
  const paths = [...new Set([resolve(path), realpathSync(path)])].flatMap((p) =>
    sidecars ? [p, `${p}-wal`, `${p}-shm`] : [p],
  );
  for (const p of paths) privatePaths.set(p, (privatePaths.get(p) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const p of paths) {
      const count = (privatePaths.get(p) ?? 1) - 1;
      if (count) privatePaths.set(p, count);
      else privatePaths.delete(p);
    }
  };
}

/** Protect SQLite and its sidecars, including non-default data directories. */
export const protectDatabase = (path: string): (() => void) =>
  path === ":memory:" ? () => {} : protectPrivateFile(path, true);

export const privateReadPaths = (): string[] => [...privatePaths.keys()];
