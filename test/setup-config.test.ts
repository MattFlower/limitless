import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSetupConfig } from "../src/cli/setup-config.ts";
import { loadConfig, repoSettings } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { gateExecutorFor } from "../src/gates/executor.ts";

function operatorConfig(toml: string) {
  const root = mkdtempSync(join(tmpdir(), "actions-authorization-"));
  try {
    writeFileSync(join(root, "config.toml"), toml);
    return loadConfig({ home: join(root, "data"), configDir: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  ["", false, false],
  ["github_actions = true", true, false],
  ["github_actions_paid_minutes = true", false, true],
  ["github_actions = true\ngithub_actions_paid_minutes = true", true, true],
])("Actions repository authorization parses without warnings: %s", (settings, enabled, paid) => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const cfg = operatorConfig(`[repos."Owner/Repo"]\n${settings}`);
    expect(repoSettings(cfg, "OWNER/REPO")).toMatchObject({
      githubActions: enabled,
      githubActionsPaidMinutes: paid,
    });
    expect(repoSettings(cfg, "other/repo")).toMatchObject({
      githubActions: false,
      githubActionsPaidMinutes: false,
    });
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

for (const key of ["github_actions", "github_actions_paid_minutes"])
  test.each(['"true"', "1"])(`${key} rejects non-boolean %s`, (value) => {
    expect(() => operatorConfig(`[repos."owner/repo"]\n${key} = ${value}`)).toThrow(
      `repos.${key} must be a boolean`,
    );
  });

test("Actions permissions preserve repository normalization and executor routing", () => {
  const settings = '[repos."Owner/Repo"]\ngithub_actions = true\ngithub_actions_paid_minutes = true';
  expect(() => operatorConfig(`${settings}\n[repos."owner/repo"]`)).toThrow("Duplicate repository keys");
  expect(() => operatorConfig(`${settings}\n[gates]\nexecutor = "github-actions"`)).toThrow("gates.executor");
  const store = new Store(":memory:");
  try {
    for (const kind of ["local", "lan"] as const) {
      const cfg = operatorConfig(`${settings}\n[gates]\nexecutor = "${kind}"`);
      expect(gateExecutorFor(cfg.gateExecutor, new WorkerStore(store, undefined), ["owner/repo"]).kind).toBe(
        kind,
      );
    }
  } finally {
    store.close();
  }
});

for (const original of [
  '[repos."acme/app"]\nland_requires_approval = true\ndiscreet = false\n',
  'repos = { "acme/app" = { land_requires_approval = true, discreet = false }, "acme/other" = { discreet = false } }\n',
  'repos = { "acme/other" = { discreet = false } }\n',
  "repos = {}\n",
  '[repos]\n"acme/app" = { land_requires_approval = true, discreet = false }\n',
])
  test(`setup enables discreet mode while preserving repository settings: ${original.trim()}`, () => {
    const text = patchSetupConfig(original, { repos: ["acme/app"], merge: "pr" }, [], [], false, undefined, {
      "acme/app": { land_requires_approval: true, discreet: true },
    });
    expect(Bun.TOML.parse(text)).toMatchObject({
      repos: { "acme/app": { land_requires_approval: true, discreet: true } },
    });
    if (original.includes("acme/other"))
      expect(Bun.TOML.parse(text)).toMatchObject({ repos: { "acme/other": { discreet: false } } });
  });

test("provider conversion preserves literal dotted table and assignment names", () => {
  const unrelated = String.raw`"providers.root-note" = "keep root value"
["providers.notes"]
custom = "keep basic table"
['providers.other']
custom = "keep literal table"
["providers\".notes"]
custom = "keep escaped quote"
`;
  const original = `${unrelated}${String.raw`[ "provi\u0064ers" . 'claude' ]
max_concurrent = 2
[github]
repos = []
merge = "none"
`}`;
  const entries = [{ id: "claude", max_concurrent: 2 }];
  const text = patchSetupConfig(original, { repos: [], merge: "none" }, entries, [], true);
  expect(text).toStartWith(unrelated);
  expect(Bun.TOML.parse(text)).toMatchObject({
    "providers.root-note": "keep root value",
    "providers.notes": { custom: "keep basic table" },
    "providers.other": { custom: "keep literal table" },
    'providers".notes': { custom: "keep escaped quote" },
    providers: entries,
  });
});

for (const prefix of ['"github"', "'github'", String.raw`"git\u0068ub"`])
  test(`quoted dotted GitHub keys retain their spelling: ${prefix}`, () => {
    const repoKey = `${prefix} . "repos"`,
      merge = `${prefix}.'merge' = "none" # keep merge\n`,
      unrelated = '"github.repos" = "unrelated literal key"\n';
    const text = patchSetupConfig(
      `${unrelated}${repoKey} = [] # keep repo\n${merge}`,
      { repos: ["acme/app"], merge: "none" },
      [],
      [],
      false,
    );
    expect(text).toBe(`${unrelated}${repoKey} = ["acme/app"] # keep repo\n${merge}`);
    expect(Bun.TOML.parse(text)).toEqual({
      "github.repos": "unrelated literal key",
      github: { repos: ["acme/app"], merge: "none" },
    });
  });

test("missing GitHub keys extend quoted dotted assignments without redefining their table", () => {
  const original = '"github"."repos" = [] # keep repos\n';
  const text = patchSetupConfig(original, { repos: [], merge: "pr" }, [], [], false);
  expect(text).toEndWith(original);
  expect(Bun.TOML.parse(text)).toEqual({ github: { repos: [], merge: "pr" } });
});

test("quoted escaped table and assignment keys are decoded without changing their spelling", () => {
  const header = String.raw`[ "git\u0068ub" ]`;
  const repoKey = String.raw`"re\u0070os"`;
  const unrelated = '["github.notes"]\ncustom = "keep me"\n';
  const text = patchSetupConfig(
    `${unrelated}${header}\n${repoKey} = []\n'merge' = "none"\n`,
    { repos: ["acme/app"], merge: "none" },
    [],
    [],
    false,
  );
  expect(text).toBe(`${unrelated}${header}\n${repoKey} = ["acme/app"]\n'merge' = "none"\n`);
  expect(Bun.TOML.parse(text)).toMatchObject({ github: { repos: ["acme/app"], merge: "none" } });
});

test("inline GitHub patches only required values across quoted keys, nested values and string delimiters", () => {
  const original =
    String.raw`'github'  = { token_env = "X", notes = { text = '} , # \\"', list = ["a,b", { x = "}" }] }, "re\u0070os"  = [ 'acme/app' ], 'merge' = 'none', "github.repos" = "unrelated" } # note` +
    "\r\n";
  const github = { repos: ["acme/app", "acme/lib"], merge: "pr" };
  const text = patchSetupConfig(original, github, [], [], false);
  expect(text).toBe(original.replace("[ 'acme/app' ]", '["acme/app", "acme/lib"]').replace("'none'", '"pr"'));
  expect(Bun.TOML.parse(text)).toMatchObject({ github });
});

for (const members of ["", 'token_env = "X", poll = 60'])
  test(`inline GitHub missing keys are inserted without rewriting existing bytes: ${members || "empty"}`, () => {
    const original = `github\t= { ${members}\t } # note\n`;
    const github = { repos: ["acme/app"], merge: "pr" };
    const text = patchSetupConfig(original, github, [], [], false);
    expect(text).toBe(
      `github\t= { ${members}${members ? ", " : ""}"repos" = ["acme/app"], "merge" = "pr"${members ? "" : " "}\t } # note\n`,
    );
    expect(Bun.TOML.parse(text)).toMatchObject({ github });
  });

test("unchanged inline GitHub assignment survives adding providers byte for byte", () => {
  const github = { repos: ["acme/app"], merge: "none" };
  const original = 'github = { token_env = "X", repos = [ "acme/app" ], merge = \'none\' } # note\n';
  const text = patchSetupConfig(original, github, [{ preset: "claude" }], ["claude"], false);
  expect(text).toStartWith(original);
  expect(Bun.TOML.parse(text)).toMatchObject({ github, providers: [{ preset: "claude" }] });
});

for (const quotes of [4, 5])
  test(`inline GitHub edits preserve multiline comments, trailing commas and ${quotes}-quote string endings`, () => {
    const original = `github = {\n # keep leading comment\n notes = """quoted } , #${'"'.repeat(quotes)},\n repos = [] # keep value comment\n ,\n} # note\n`;
    const github = { repos: ["acme/app"], merge: "pr" };
    const text = patchSetupConfig(original, github, [], [], false);
    expect(text).toBe(original.replace("[]", '["acme/app"], "merge" = "pr"'));
    expect(Bun.TOML.parse(text)).toMatchObject({ github });
  });

for (const owners of [
  '[owners]\ndiscord = "keep" # comment\n',
  '"owners"."discord" = "keep" # comment\n',
  'owners = { discord = "keep", notes = { text = "},#" } } # comment\n',
  '[owners]\ngithub = ""\ndiscord = "keep" # comment\n',
])
  test(`setup patches a missing owner without changing Discord or unrelated settings: ${owners.trim()}`, () => {
    const settings = 'github = { repos = [], merge = "pr" }\n';
    const original = settings + owners;
    const text = patchSetupConfig(original, { repos: [], merge: "pr" }, [], [], false, "chosen-owner");
    expect(Bun.TOML.parse(text)).toMatchObject({
      github: { repos: [], merge: "pr" },
      owners: { github: "chosen-owner", discord: "keep" },
    });
    expect(text).toContain(
      owners.startsWith('"owners"') ? '"owners"."discord" = "keep"' : 'discord = "keep"',
    );
    if (owners.includes("notes")) expect(text).toContain('notes = { text = "},#" }');
    expect(text).toContain("# comment");
    expect(patchSetupConfig(text, { repos: [], merge: "pr" }, [], [], false)).toBe(text);
  });
