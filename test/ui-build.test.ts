import { afterAll, expect, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildConfig, stageUi, validateMetafile } from "../scripts/build-binary.ts";
import { BUILD_DEFINES } from "../src/release.ts";
import { buildUi } from "../src/server/ui.ts";
import { UI_RESOURCE } from "../src/server/ui-build.ts";
import { sh } from "../src/util/proc.ts";
import { uiBuildFixture } from "./ui-build-support.ts";

const uiMaps = uiBuildFixture();

test.each(["caller bunfig", "runtime globals"])(
  "source UI refuses a foreign define from %s",
  async (origin) => {
    const scratch = mkdtempSync(join(tmpdir(), "limitless-ui-define-"));
    const home = join(scratch, "home");
    const cwd = join(scratch, "caller");
    mkdirSync(home);
    mkdirSync(cwd);
    try {
      if (origin === "caller bunfig")
        writeFileSync(join(cwd, "bunfig.toml"), `[define]\n${BUILD_DEFINES.packaged} = 'true'\n`);
      const probe = `
      ${origin === "runtime globals" ? `Object.assign(globalThis, { ${BUILD_DEFINES.packaged}: true });` : ""}
      const { release } = await import(${JSON.stringify(join(import.meta.dir, "../src/release.ts"))});
      const { buildUi } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/ui.ts"))});
      try {
        await buildUi();
        throw new Error("Unexpected source build success");
      } catch (error) {
        console.log(JSON.stringify({ kind: release.kind, message: error.message }));
      }
    `;
      const result = await sh([process.execPath, "-e", probe], {
        cwd,
        env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const { kind, message } = JSON.parse(result.stdout);
      expect(kind).toBe("source");
      expect(message).toContain(`${BUILD_DEFINES.packaged}=true`);
      expect(message).toContain("caller bunfig.toml [define]");
      expect(message).toContain("runtime globals");
      expect(message).not.toContain("missing its embedded UI");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

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

test("UI staging removes stale files and nested directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-ui-staging-"));
  const directory = join(root, UI_RESOURCE);
  try {
    mkdirSync(join(directory, "stale-directory", "nested"), { recursive: true });
    writeFileSync(join(directory, "stale.js"), "stale");
    writeFileSync(join(directory, "stale-directory", "nested", "stale.css"), "stale");
    const staged = await stageUi(root);
    expect(staged.directory).toBe(directory);
    expect(readdirSync(directory, { recursive: true }).sort()).toEqual(
      staged.outputs.map((file) => relative(directory, file.path)).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("packaged UI reads every embedded file, including an independently altered asset, without compiling", async () => {
  const { directory, info, source } = await uiMaps();
  const root = mkdtempSync(join(tmpdir(), "limitless-ui-altered-"));
  const embeddedDirectory = join(root, UI_RESOURCE);
  const builder = spyOn(Bun, "build").mockImplementation(() => {
    throw new Error("Packaged UI must not compile from source");
  });
  const files = spyOn(Bun, "file");
  try {
    cpSync(directory, embeddedDirectory, { recursive: true });
    const asset = Object.keys(source).find((name) => name.endsWith(".js"));
    if (!asset) throw new Error("Missing source JS asset");
    const altered = "// independently altered embedded asset\n";
    writeFileSync(join(embeddedDirectory, asset.slice(1)), altered);
    const packaged = await buildUi({ ...info, root });
    expect(builder).not.toHaveBeenCalled();
    const names = readdirSync(embeddedDirectory).sort();
    expect(Object.keys(packaged).sort()).toEqual(names.map((name) => `/${name}`));
    expect(files.mock.calls.map(([path]) => String(path)).sort()).toEqual(
      names.map((name) => join(embeddedDirectory, name)).sort(),
    );
    for (const [name, blob] of Object.entries(packaged)) {
      const original = source[name];
      if (!original) throw new Error(`Missing source UI file ${name}`);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
        new Uint8Array(readFileSync(join(embeddedDirectory, name.slice(1)))),
      );
      expect(blob.type).toBe(original.type);
    }
    expect(await packaged[asset]?.text()).toBe(altered);
    expect(await source[asset]?.text()).not.toBe(altered);
  } finally {
    files.mockRestore();
    builder.mockRestore();
    rmSync(root, { recursive: true, force: true });
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
