import { afterAll } from "bun:test";
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
    return { source: await buildUi(), packaged: await buildUi(info), directory, info };
  }

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return () => {
    cached ??= createMaps();
    return cached;
  };
}
