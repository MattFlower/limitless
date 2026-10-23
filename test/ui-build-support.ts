import { afterAll, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageUi } from "../scripts/build-binary.ts";
import type { Release } from "../src/release.ts";
import { buildUi } from "../src/server/ui.ts";

export function uiBuildFixture() {
  let root: string | undefined;
  let cached: ReturnType<typeof createMaps> | undefined;

  async function createMaps() {
    root = mkdtempSync(join(tmpdir(), "limitless-ui-test-"));
    const { directory } = await stageUi(root);
    const info: Release = { kind: "packaged", root, version: "test", sha: "a".repeat(40), bun: Bun.version };
    const source = await buildUi();
    const builder = spyOn(Bun, "build").mockImplementation(() => {
      throw new Error("Packaged UI must not compile from source");
    });
    try {
      const packaged = await buildUi(info);
      expect(builder).not.toHaveBeenCalled();
      return { source, packaged, directory, info };
    } finally {
      builder.mockRestore();
    }
  }

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return () => {
    cached ??= createMaps();
    return cached;
  };
}
