import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Factory } from "../src/app.ts";
import { loadConfig, repoSettings } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { mountIntegrations } from "../src/integrations/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(defects: string, withApp = true) {
  const dir = mkdtempSync(join(tmpdir(), "config-defects-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.pem"), "fake signing key", { mode: 0o600 });
  writeFileSync(
    join(dir, "config.toml"),
    `
[github]
poll = false
${
  withApp
    ? `[github.app]
app_id = 1
installation_id = 2
private_key_path = "app.pem"
repos = ["example/factory"]`
    : ""
}
${defects}
[repos."example/other"]
shared = true
`,
  );
  return { dir, load: () => loadConfig({ home: dir, configDir: dir, readOnly: true }) };
}

test("defect settings are optional and normalize App-covered destinations with conservative defaults", () => {
  expect(fixture("").load().githubDefects).toBeNull();
  expect(fixture("[github.defects]").load().githubDefects).toEqual({
    enabled: false,
    factoryRepo: null,
    dailyCap: 10,
  });
  expect(
    fixture('[github.defects]\nenabled = true\nfactory_repo = "Example/Factory"').load().githubDefects,
  ).toEqual({ enabled: true, factoryRepo: "example/factory", dailyCap: 10 });
  expect(fixture("[github.defects]\nenabled = false\ndaily_cap = 2").load().githubDefects).toEqual({
    enabled: false,
    factoryRepo: null,
    dailyCap: 2,
  });
});

test.each([
  "enabled = true",
  'enabled = "private-enabled"',
  'factory_repo = "private-owner/elsewhere"',
  'factory_repo = "not a slug"',
  'factory_repo = "example/factory "',
  "factory_repo = 3",
  "daily_cap = 0",
  "daily_cap = -1",
  "daily_cap = 1.5",
  "daily_cap = 9007199254740992.0",
  'daily_cap = "private-cap"',
  'triage_repo = "private-owner/repo"',
])("invalid defect settings fail closed without disrupting other repositories: %s", async (settings) => {
  const f = fixture(`[github.defects]\n${settings}`);
  const cfg = f.load();
  expect(cfg.githubDefects).toEqual({ enabled: false, factoryRepo: null, dailyCap: 10, invalid: true });
  expect(repoSettings(cfg, "example/other").shared).toBe(true);
  const store = new Store(join(f.dir, "store.db"));
  try {
    store.db.exec("INSERT INTO defect_enablement_windows (start,end) VALUES (10,NULL)");
    const calls: string[] = [];
    const land = { start: () => {}, stop: async () => {}, list: () => [] };
    const mounted = await mountIntegrations({ cfg, store, land } as unknown as Factory, {
      toolVersions: async () => [],
      gh: async () => {
        calls.push("gh");
      },
      prClient: async () => {
        calls.push("pr");
        return null;
      },
      github: async () => {
        throw new Error("unexpected GitHub call");
      },
      issueClock: {
        now: () => 20,
        set: (() => {
          throw new Error("unexpected timer");
        }) as unknown as typeof setTimeout,
        clear: () => {},
      },
    });
    try {
      expect(mounted.notes.filter((n) => n.startsWith("Defect"))).toEqual([
        "Defect reporter disabled: invalid [github.defects] settings",
      ]);
      expect(store.db.query("SELECT start,end FROM defect_enablement_windows").all()).toEqual([
        { start: 10, end: 20 },
      ]);
      expect(calls).toEqual([]);
    } finally {
      await mounted.stop();
    }
  } finally {
    store.close();
  }
});

test("non-table defects and absent App coverage are invalid without throwing", () => {
  for (const raw of [false, [], 1, "private-settings", null]) {
    const f = fixture("");
    expect(
      loadConfig({ home: f.dir, configDir: f.dir, readOnly: true, raw: { github: { defects: raw } } })
        .githubDefects?.invalid,
    ).toBe(true);
  }
  const f = fixture('[github.defects]\nenabled = true\nfactory_repo = "example/factory"', false);
  expect(f.load().githubDefects?.invalid).toBe(true);
});

test("the previous release config reader accepts the optional defects sibling", async () => {
  const f = fixture('[github.defects]\nenabled = true\nfactory_repo = "example/factory"\ndaily_cap = 3');
  // Frozen from cb730d7571b726ea7b38baf72d61b0dafe819862:src/config.ts; CI checkouts are shallow.
  const source = readFileSync(new URL("./data/config-cb730d75.txt", import.meta.url), "utf8");
  const path = join(f.dir, "prior-config.ts");
  const original = new URL("../src/config.ts", import.meta.url);
  writeFileSync(
    path,
    source.replace(
      /from "(\.[^"]+)"/gu,
      (_match, relative: string) => `from ${JSON.stringify(new URL(relative, original).pathname)}`,
    ),
  );
  const prior: { loadConfig: typeof loadConfig } = await import(pathToFileURL(path).href);
  const cfg = prior.loadConfig({ home: f.dir, configDir: f.dir, readOnly: true });
  expect(cfg.githubApp?.repos).toEqual(["example/factory"]);
  expect(cfg.githubQueue).toBeNull();
  expect(repoSettings(cfg, "example/other").shared).toBe(true);
});
