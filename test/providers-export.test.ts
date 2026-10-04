import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, PROVIDERS } from "../src/router/catalog.ts";
import { exportProviders, resolveCatalog } from "../src/router/config-catalog.ts";
import { customModel, customProvider, providerFixture } from "./provider-config-support.ts";

const parse = (text: string) => Bun.TOML.parse(text) as Record<string, unknown>;

test("export round-trips ordered catalog identities, metadata, nested fields and legacy static-token fallback", () => {
  const defaults = resolveCatalog();
  for (const before of [
    defaults,
    resolveCatalog([
      customProvider,
      {
        id: "twilight",
        ssh_forward: { host: "example.com", local_port: 18080, remote_port: 8080 },
        models: [{ id: "qwen-27b", price: { input: 0.25 } }],
      },
      {
        id: "claude",
        label: 'A label with "quotes"\nnew line\\backslash',
        models: [{ ...customModel, id: "extra", efforts: [], effort: undefined }],
      },
      { id: "mtplx", api_key_env: "EXAMPLE_LOCAL_KEY" },
    ]),
  ]) {
    const output = exportProviders(before);
    expect(exportProviders(before)).toBe(output);
    expect(output).not.toContain("mtplx-local");
    expect(output).not.toContain("apiKey");
    const after = resolveCatalog(parse(output).providers);
    expect(after.providers).toEqual(before.providers);
    expect(after.models).toEqual(before.models);
    expect(after.notes).toEqual([]);
  }
  expect(defaults.providers).toEqual(PROVIDERS);
  expect(defaults.models).toEqual(MODELS);
  expect(
    resolveCatalog(parse(exportProviders(defaults)).providers).providers.find((p) => p.id === "mtplx")
      ?.apiKey,
  ).toBe("mtplx-local");
});

async function cli(root: string, args: string[], preloadExtra = "") {
  const preload = join(root, "offline.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = () => { throw new Error("NETWORK FORBIDDEN"); };\n${preloadExtra}`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      join(import.meta.dir, "../src/cli/main.ts"),
      "providers",
      "export",
      ...args,
    ],
    {
      env: { ...process.env, LIMITLESS_CONFIG_DIR: join(root, "config"), LIMITLESS_HOME: join(root, "data") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("offline export stdout and repeated writes preserve unrelated settings, original bytes and secrets", async () => {
  for (const providers of [
    undefined,
    "[providers.omlx]\nmax_concurrent = 8\n",
    '[[providers]]\npreset = "claude"\n',
  ]) {
    const fixture = providerFixture();
    try {
      const settings =
        '# Keep exact backup bytes\n[server]\nport=7412\n[review]\ntrusted_reviewers=["a", "b"]\n[review.rosters]\nquick=[{prompt="careful", family="implementer"}]\n';
      if (providers === undefined) rmSync(fixture.file);
      else writeFileSync(fixture.file, settings + providers);
      writeFileSync(join(fixture.configDir, "secrets.env"), "OMLX_API_KEY=super-secret-sentinel\n");
      const expected = fixture.load().catalog;
      if (!expected) throw new Error("missing catalog");
      const before = providers === undefined ? undefined : readFileSync(fixture.file);
      const secrets = readFileSync(join(fixture.configDir, "secrets.env"));
      const result = await cli(fixture.root, []);
      expect(result.exit).toBe(0);
      expect(result.stdout).toStartWith("[[providers]]");
      expect(result.stdout + result.stderr).not.toContain("super-secret-sentinel");
      expect(resolveCatalog(parse(result.stdout).providers).models).toEqual(expected?.models);
      if (before) expect(readFileSync(fixture.file)).toEqual(before);
      expect(readdirSync(fixture.configDir).filter((p) => p.endsWith(".bak"))).toEqual([]);
      const written = await cli(fixture.root, ["--write"]);
      expect(written.exit).toBe(0);
      expect(written.stdout).toBe("");
      const firstBackup = readdirSync(fixture.configDir).filter((p) => p.endsWith(".bak"));
      expect(firstBackup).toHaveLength(before ? 1 : 0);
      if (before && firstBackup[0])
        expect(readFileSync(join(fixture.configDir, firstBackup[0]))).toEqual(before);
      expect(fixture.load().catalog?.providers).toEqual(expected?.providers);
      if (providers) {
        const { providers: _p, ...unrelated } = fixture.load().raw;
        expect(unrelated).toEqual(parse(settings));
      }
      const firstWrite = readFileSync(fixture.file);
      expect((await cli(fixture.root, ["--write"])).exit).toBe(0);
      const secondBackup = readdirSync(fixture.configDir).filter(
        (p) => p.endsWith(".bak") && !firstBackup.includes(p),
      );
      expect(secondBackup).toHaveLength(1);
      expect(readFileSync(join(fixture.configDir, secondBackup[0] ?? "missing"))).toEqual(firstWrite);
      expect(readFileSync(join(fixture.configDir, "secrets.env"))).toEqual(secrets);
      expect(readdirSync(fixture.configDir).filter((p) => p.endsWith(".tmp"))).toEqual([]);
    } finally {
      fixture.close();
    }
  }
});

test("failed export validation and backup creation leave original config intact", async () => {
  const fixture = providerFixture();
  try {
    const before = readFileSync(fixture.file);
    const result = await cli(
      fixture.root,
      ["--write"],
      `import { mock } from "bun:test"; import * as fs from "node:fs"; const originalWrite = fs.writeFileSync;
      mock.module("node:fs", () => ({ ...fs, writeFileSync: (path, ...args) => { if (String(path).endsWith(".bak")) throw new Error("backup denied"); return originalWrite(path, ...args); } }));`,
    );
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("backup denied");
    expect(readFileSync(fixture.file)).toEqual(before);
    expect(readdirSync(fixture.configDir).filter((p) => /\.(bak|tmp)$/.test(p))).toEqual([]);
    writeFileSync(fixture.file, '[[providers]]\nid="invalid"\napiKey="sentinel-key"\n');
    const invalid = readFileSync(fixture.file);
    const failure = await cli(fixture.root, ["--write"]);
    expect(failure.exit).toBe(1);
    expect(failure.stdout + failure.stderr).not.toContain("sentinel-key");
    expect(readFileSync(fixture.file)).toEqual(invalid);
    expect(readdirSync(fixture.configDir).filter((p) => p.endsWith(".bak"))).toEqual([]);
  } finally {
    fixture.close();
  }
});
