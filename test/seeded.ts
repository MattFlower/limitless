import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds a directory once per test process, then copies it into each caller's directory, so tests
 * that start from the same committed repositories run `git init` and `git commit` once.
 */
export function seeded<T>(build: (dir: string) => Promise<T>) {
  let seed: Promise<{ dir: string; value: T }> | undefined;
  return async (dest: string) => {
    seed ??= (async () => {
      const dir = mkdtempSync(join(tmpdir(), "limitless-seed-"));
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      return { dir, value: await build(dir) };
    })();
    const { dir, value } = await seed;
    cpSync(dir, dest, { recursive: true });
    return {
      value,
      /** Points a copied file that records the seed's absolute path (a clone's origin URL) at `dest`. */
      relocate(path: string) {
        const file = join(dest, path);
        const text = readFileSync(file, "utf8");
        if (!text.includes(dir)) throw new Error(`${path} does not mention the seed directory`);
        writeFileSync(file, text.replaceAll(dir, dest));
      },
    };
  };
}
