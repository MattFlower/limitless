import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fixture repository built once per test process. Tests copy it (`cpSync`, recursive) instead of
 * re-running its git commands; each copy is an independent repository with the same commits.
 */
export function gitSeed<T = void>(
  build: (dir: string) => Promise<T>,
): () => Promise<{ dir: string; value: T }> {
  let seed: Promise<{ dir: string; value: T }> | undefined;
  return () => {
    seed ??= (async () => {
      const dir = mkdtempSync(join(tmpdir(), "limitless-seed-"));
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      return { dir, value: await build(dir) };
    })();
    return seed;
  };
}
