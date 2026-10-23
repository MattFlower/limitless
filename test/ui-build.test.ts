import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, validateMetafile } from "../scripts/build-binary.ts";
import { buildUi } from "../src/server/ui.ts";
import { UI_RESOURCE } from "../src/server/ui-build.ts";
import { uiBuildFixture } from "./ui-build-support.ts";

const uiMaps = uiBuildFixture();

test("release defines remove the source UI compiler from the bundled server", async () => {
  const { define } = buildConfig({ version: "1.0.0", sha: "a".repeat(40) }, tmpdir(), tmpdir());
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/server/ui.ts")],
    target: "bun",
    metafile: true,
    define,
  });
  const { metafile } = result;
  if (!result.success || !metafile) throw new AggregateError(result.logs, "UI server bundle failed");
  expect(Object.keys(metafile.inputs).filter((path) => path.includes("solid-plugin"))).toEqual([]);
  expect(() => validateMetafile(metafile)).not.toThrow();
});

test("shared UI options emit root-relative script and stylesheet URLs", async () => {
  const { directory } = await uiMaps();
  const html = await Bun.file(join(directory, "index.html")).text();
  expect(html).toMatch(/src="\/[^"/]+\.js"/);
  expect(html).toMatch(/href="\/[^"/]+\.css"/);
});

test("packaged map preserves every source filename, byte and content type", async () => {
  const { source, packaged } = await uiMaps();
  expect(Object.keys(packaged).sort()).toEqual(Object.keys(source).sort());
  for (const [name, blob] of Object.entries(source)) {
    const embedded = packaged[name];
    if (!embedded) throw new Error(`Missing embedded UI file ${name}`);
    expect(embedded.type).toBe(blob.type);
    expect(await embedded.arrayBuffer()).toEqual(await blob.arrayBuffer());
  }
});

const missingRoot = mkdtempSync(join(tmpdir(), "limitless-ui-missing-"));
afterAll(() => rmSync(missingRoot, { recursive: true, force: true }));

test.each([false, true])("packaged UI refuses missing index.html (directory exists=%p)", async (exists) => {
  const root = join(missingRoot, String(exists));
  if (exists) mkdirSync(join(root, UI_RESOURCE), { recursive: true });
  await expect(
    buildUi({ kind: "packaged", root, version: "test", sha: "a".repeat(40), bun: Bun.version }),
  ).rejects.toThrow("missing its embedded UI or index.html");
});
