import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { seatbeltBackend } from "../src/harness/sandbox.ts";
import { DEFAULT_ROSTERS } from "../src/pipeline/review-system.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS, REMOVED_MODELS } from "../src/router/catalog.ts";
import { exportProviders, resolveCatalog, tomlValue } from "../src/router/config-catalog.ts";
import { validatePolicy, validateRunModels } from "../src/router/policy.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { answer, evalFixture } from "./evals-support.ts";
import { customModel, customProvider, providerFixture } from "./provider-config-support.ts";

test("provider quota modes validate both config shapes and survive export", () => {
  for (const array of [false, true]) {
    const fixture = providerFixture();
    try {
      for (const mode of [undefined, "windows", "unlimited"] as const) {
        writeFileSync(
          fixture.file,
          `${array ? '[[providers]]\npreset = "claude"' : "[providers.claude]"}\n${mode ? `quota = "${mode}"\n` : ""}`,
        );
        const catalog = fixture.load().catalog;
        expect(catalog?.providers.find((p) => p.id === "claude")?.quota).toBe(mode ?? "windows");
        if (!catalog) throw new Error("missing catalog");
        writeFileSync(fixture.file, exportProviders(catalog));
        expect(fixture.load().catalog?.providers).toEqual(catalog.providers);
      }
      for (const value of ['"lots"', "42", "false", '""']) {
        writeFileSync(
          fixture.file,
          `${array ? '[[providers]]\nid = "work"\npreset = "claude"' : "[providers.claude]"}\nquota = ${value}\n`,
        );
        expect(fixture.load).toThrow(`${array ? "providers[0].work" : "providers.claude"}.quota`);
        expect(fixture.load).toThrow(value);
      }
    } finally {
      fixture.close();
    }
  }
});

test("run model chains share policy validation and only accept run roles", () => {
  const validate = (value: unknown) => validateRunModels(value, MODELS, PROVIDERS);
  const good = { triage: ["omlx/qwen-flash@high|codex/sol"], implement: ["codex/sol", "claude/opus"] };
  expect(validate(good)).toEqual(good);
  expect(validate({})).toEqual({});
  for (const [value, message] of [
    [{ implement: ["missing/id"] }, 'unknown model ID "missing/id"'],
    [{ implement: ["claude/fable"] }, REMOVED_MODELS.get("claude/fable")],
    [{ implement: ["omlx/qwen-flash@high"] }, "cannot carry effort in the implement role"],
    [{ review: ["codex/sol@max"] }, 'Unsupported effort "max"'],
    [{ chat: ["codex/sol"] }, "unknown run role"],
    [{ implement: [] }, "Too small"],
    [{ implement: [""] }, "empty model ID"],
    [{ implement: ["codex/sol|"] }, "empty model ID"],
    [{ implement: ["codex/sol@@high"] }, "Invalid model reference"],
    [{ implement: "codex/sol" }, "expected array"],
    [null, "expected a role-to-chain map"],
  ] as const)
    expect(() => validate(value)).toThrow(message);
  const configured = resolveCatalog([customProvider]);
  expect(() =>
    validateRunModels({ implement: ["mac-mlx/flash"] }, configured.models, configured.providers),
  ).toThrow("openai-compatible transport cannot serve the implement role");
});

test("Dependabot routing defaults to free-first and accepts either configured mode", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-routing-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config().dependabotRouting).toBe("free_first");
    for (const value of ["free_first", "policy"] as const) {
      writeFileSync(join(configDir, "config.toml"), `[routing]\ndependabot = "${value}"\n`);
      expect(config().dependabotRouting).toBe(value);
    }
    writeFileSync(join(configDir, "config.toml"), '[routing]\ndependabot = "other"\n');
    expect(config).toThrow('routing.dependabot must be "free_first" or "policy"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[routing] prefer takes provider IDs and fails on model, retired, unknown or malformed entries", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-prefer-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const file = join(configDir, "config.toml");
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  const set = (prefer: string) => writeFileSync(file, `[routing]\nprefer = ${prefer}\n`);
  try {
    expect(config().preferProviders).toEqual([]);
    set("[]");
    expect(config().preferProviders).toEqual([]);
    set('["codex"]');
    expect(config().preferProviders).toEqual(["codex"]);
    // A retired model names its removal reason; an active model is named as a model, not a provider.
    set('["codex/astra"]');
    expect(config).toThrow(
      `routing.prefer: "codex/astra" is a retired model ID: ${REMOVED_MODELS.get("codex/astra")}`,
    );
    set('["claude/fable"]');
    expect(config).toThrow(
      `routing.prefer: "claude/fable" is a retired model ID: ${REMOVED_MODELS.get("claude/fable")}`,
    );
    set('["claude/opus"]');
    expect(config).toThrow('routing.prefer: "claude/opus" is a model ID, not a provider');
    set('["nonexistent"]');
    expect(config).toThrow('routing.prefer: "nonexistent" is not a known provider ID');
    // A valid provider stays valid; the offending entry in the list is the one named.
    set('["codex", "claude/opus"]');
    expect(config).toThrow('routing.prefer: "claude/opus" is a model ID');
    // Malformed values point at routing.prefer instead of being ignored.
    set('"codex"');
    expect(config).toThrow("routing.prefer must be an array of provider IDs");
    set('["codex", 3]');
    expect(config).toThrow("routing.prefer[1] must be a provider ID string");
    expect(() =>
      loadConfig({ home: join(root, "data"), configDir, raw: { routing: { prefer: null } } }),
    ).toThrow("routing.prefer must be an array of provider IDs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefer keeps the requested order and accepts configured provider IDs", () => {
  const fixture = providerFixture();
  try {
    const providers = `providers = ${tomlValue([customProvider])}`;
    writeFileSync(fixture.file, `${providers}\n[routing]\nprefer = ["mac-mlx", "codex"]\n`);
    expect(fixture.load().preferProviders).toEqual(["mac-mlx", "codex"]);
    // The entry is only routable through the configured provider, so the effective catalog is used.
    writeFileSync(fixture.file, `${providers}\n[routing]\nprefer = ["mac-mlx/flash"]\n`);
    expect(fixture.load).toThrow('routing.prefer: "mac-mlx/flash" is a model ID, not a provider');
  } finally {
    fixture.close();
  }
});

test("the baseline cache kill switch defaults on and accepts only booleans", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-gates-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config().baselineCache).toBe(true);
    for (const value of [true, false]) {
      writeFileSync(join(configDir, "config.toml"), `[gates]\nbaseline_cache = ${value}\n`);
      expect(config().baselineCache).toBe(value);
    }
    writeFileSync(join(configDir, "config.toml"), '[gates]\nbaseline_cache = "no"\n');
    expect(config).toThrow("gates.baseline_cache must be true or false");
    rmSync(join(configDir, "config.toml"));
    expect(config().baselineEnv).toEqual([]);
    writeFileSync(join(configDir, "config.toml"), '[gates]\nbaseline_env = ["MY_GATE_FLAG"]\n');
    expect(config().baselineEnv).toEqual(["MY_GATE_FLAG"]);
    writeFileSync(join(configDir, "config.toml"), '[gates]\nbaseline_env = "MY_GATE_FLAG"\n');
    expect(config).toThrow("gates.baseline_env must be an array");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review implementer report defaults to include and accepts only include or omit", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-review-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config().reviewImplementerReport).toBe("include");
    writeFileSync(join(configDir, "config.toml"), "[review]\n");
    expect(config().reviewImplementerReport).toBe("include");
    for (const value of ["include", "omit"] as const) {
      writeFileSync(join(configDir, "config.toml"), `[review]\nimplementer_report = "${value}"\n`);
      expect(config().reviewImplementerReport).toBe(value);
    }
    for (const value of ['"Omit"', '"none"', '""', "false"]) {
      writeFileSync(join(configDir, "config.toml"), `[review]\nimplementer_report = ${value}\n`);
      expect(config).toThrow('review.implementer_report must be "include" or "omit"');
    }
    // A misspelt key would otherwise silently keep the default.
    writeFileSync(join(configDir, "config.toml"), '[review]\nimplementer-report = "omit"\n');
    expect(config).toThrow(
      "review.implementer-report: unknown key (allowed: implementer_report, mode, rosters, shadow, shadow_grace_seconds, trusted_reviewers)",
    );
    writeFileSync(join(configDir, "config.toml"), 'review = "omit"\n');
    expect(config).toThrow("review must be a table");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider concurrency overrides reach the tracker without changing catalog defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-provider-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  try {
    writeFileSync(join(configDir, "secrets.env"), "OMLX_API_KEY=file-key\n");
    expect(loadConfig({ home: join(root, "data"), configDir }).secrets.OMLX_API_KEY).toBe("file-key");
    const defaults = new Factory(loadConfig({ home: join(root, "defaults"), configDir }));
    expect(defaults.deps.confinement).toBe(seatbeltBackend);
    expect(defaults.tracker.status("omlx")?.maxConcurrent).toBe(4);
    defaults.store.close();
    writeFileSync(
      join(configDir, "config.toml"),
      "[providers.claude]\nmax_concurrent = 5\n[providers.omlx]\nmax_concurrent = 8\n",
    );
    const cfg = loadConfig({ home: join(root, "data"), configDir });
    const factory = new Factory(cfg);
    try {
      expect(factory.tracker.status("claude")?.maxConcurrent).toBe(5);
      expect(factory.tracker.status("omlx")?.maxConcurrent).toBe(8);
      expect(PROVIDERS.find((provider) => provider.id === "omlx")?.maxConcurrent).toBe(4);
      expect(factory.tracker.status("codex")?.maxConcurrent).toBe(3);
      expect(PROVIDERS.find((provider) => provider.id === "claude")?.maxConcurrent).toBe(3);
    } finally {
      factory.store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid provider concurrency and unknown providers fail config loading", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-provider-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    for (const id of ["claude", "omlx"])
      for (const value of ["0", "-1", "1.5", '"2"', "1e20"]) {
        writeFileSync(join(configDir, "config.toml"), `[providers.${id}]\nmax_concurrent = ${value}\n`);
        expect(config).toThrow(`providers.${id}.max_concurrent must be a positive safe integer`);
      }
    writeFileSync(join(configDir, "config.toml"), "[providers.unknown]\nmax_concurrent = 2\n");
    expect(config).toThrow("providers.unknown: unknown provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review mode defaults to single; rosters default per profile and are validated", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-review-rosters-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config()).toMatchObject({ reviewMode: "single", reviewRosters: DEFAULT_ROSTERS });
    writeFileSync(
      join(configDir, "config.toml"),
      '[review]\nmode = "panel"\n[review.rosters]\nquick = [{ prompt = "careful", family = "implementer" }]\n',
    );
    expect(config()).toMatchObject({
      reviewMode: "panel",
      reviewRosters: { ...DEFAULT_ROSTERS, quick: [{ prompt: "careful", family: "implementer" }] },
    });
    for (const [toml, message] of [
      ['mode = "triple"', 'review.mode must be "single" or "panel"'],
      ["rosters = { quick = [] }", "a roster needs at least one finder"],
      [
        'rosters = { deep = [{ prompt = "adversarial", lens = { name = "a", focus = "b" } }] }',
        "lens finder",
      ],
    ]) {
      writeFileSync(join(configDir, "config.toml"), `[review]\n${toml}\n`);
      expect(config).toThrow(message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review shadow is opt-in, takes an explicit off switch, and cannot shadow a blocking panel", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-review-shadow-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect(config().reviewShadow).toBe("off");
    for (const [toml, shadow] of [
      ['shadow = "off"', "off"],
      ['shadow = "panel"', "panel"],
      ['mode = "single"\nshadow = "panel"', "panel"],
      ['mode = "panel"\nshadow = "off"', "off"],
    ] as const) {
      writeFileSync(join(configDir, "config.toml"), `[review]\n${toml}\n`);
      expect(config().reviewShadow).toBe(shadow);
    }
    for (const [toml, message] of [
      ['shadow = "on"', 'review.shadow must be "off" or "panel"'],
      ["shadow = true", 'review.shadow must be "off" or "panel"'],
      ['shadow = "single"', 'review.shadow must be "off" or "panel"'],
      ['mode = "panel"\nshadow = "panel"', 'review.shadow = "panel" needs review.mode = "single"'],
    ]) {
      writeFileSync(join(configDir, "config.toml"), `[review]\n${toml}\n`);
      expect(config).toThrow(message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shadow grace defaults to 300 s and accepts zero; trusted reviewers default to none", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-review-grace-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  try {
    expect([config().reviewShadowGraceSeconds, config().reviewTrustedReviewers]).toEqual([300, []]);
    writeFileSync(
      join(configDir, "config.toml"),
      '[review]\nshadow_grace_seconds = 0\ntrusted_reviewers = ["alice", "bob-bot"]\n',
    );
    expect([config().reviewShadowGraceSeconds, config().reviewTrustedReviewers]).toEqual([
      0,
      ["alice", "bob-bot"],
    ]);
    writeFileSync(join(configDir, "config.toml"), "[review]\nshadow_grace_seconds = 12.5\n");
    expect(config().reviewShadowGraceSeconds).toBe(12.5);
    for (const [toml, message] of [
      ["shadow_grace_seconds = -1", "review.shadow_grace_seconds must be a nonnegative number"],
      ['shadow_grace_seconds = "300"', "review.shadow_grace_seconds must be a nonnegative number"],
      ["shadow_grace_seconds = inf", "review.shadow_grace_seconds must be a nonnegative number"],
      ['trusted_reviewers = "alice"', "review.trusted_reviewers must be a list of GitHub logins"],
      ['trusted_reviewers = ["alice", 1]', "review.trusted_reviewers must be a list of GitHub logins"],
      ['trusted_reviewers = [""]', "review.trusted_reviewers must be a list of GitHub logins"],
    ]) {
      writeFileSync(join(configDir, "config.toml"), `[review]\n${toml}\n`);
      expect(config).toThrow(message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("roster targets are checked against the catalog at startup; single mode only warns", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-roster-targets-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const start = (roster: string, mode = "panel") => {
    const toml = `[review]\nmode = "${mode}"\n[review.rosters]\nstandard = [${roster}]\n`;
    writeFileSync(join(configDir, "config.toml"), toml);
    new Factory(loadConfig({ home: join(root, "data"), configDir })).store.close();
  };
  try {
    start(
      '{ prompt = "adversarial", target = "codex/sol" }, { prompt = "standard", local = true, target = "omlx/qwen-27b" }',
    );
    expect(() => start('{ prompt = "adversarial", target = "claude/opsu" }')).toThrow(
      'review.rosters.standard[0].target claude/opsu: unknown model ID "claude/opsu"',
    );
    expect(() => start('{ prompt = "adversarial", target = "claude/fable" }')).toThrow(
      'claude/fable: unknown model ID "claude/fable": Claude Fable 5.1 was removed from routing on 2026-10-04',
    );
    expect(() =>
      start('{ prompt = "careful" }, { prompt = "standard", local = true, target = "claude/opus" }'),
    ).toThrow("review.rosters.standard[1].target claude/opus: a local finder needs a free model");
    // Single mode uses no roster: a pin a later release dropped must not stop the daemon.
    expect(warn).not.toHaveBeenCalled();
    start('{ prompt = "adversarial", target = "claude/opsu" }', "single");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claude/opsu: unknown model ID"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(ignored: [review] mode is single)"));
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale pinned shadow roster target turns the shadow off with a warning; startup and production go on", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-shadow-roster-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const start = (roster: string, mode = "single") => {
    const toml = `[review]\nmode = "${mode}"\n${mode === "single" ? 'shadow = "panel"\n' : ""}[review.rosters]\nstandard = [${roster}]\n`;
    writeFileSync(join(configDir, "config.toml"), toml);
    const factory = new Factory(loadConfig({ home: join(root, "data"), configDir }));
    factory.store.close();
    return factory;
  };
  try {
    const stale = start('{ prompt = "adversarial", target = "claude/opsu" }');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claude/opsu: unknown model ID"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("shadow review disabled until fixed"));
    // The configured value stays visible; the engine never runs the shadow.
    expect(stale.cfg.reviewShadow).toBe("panel");
    expect(stale.deps.cfg.reviewShadow).toBe("off");
    expect(stale.deps.cfg.reviewMode).toBe("single");
    warn.mockClear();
    // A valid shadow roster stays on, without a warning.
    expect(start('{ prompt = "adversarial", target = "codex/sol" }').deps.cfg.reviewShadow).toBe("panel");
    expect(warn).not.toHaveBeenCalled();
    // A blocking panel's stale pin still fails startup.
    expect(() => start('{ prompt = "adversarial", target = "claude/opsu" }', "panel")).toThrow(
      'review.rosters.standard[0].target claude/opsu: unknown model ID "claude/opsu"',
    );
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing wait budgets default by role and validate overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "limitless-waits-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(root, "data"), configDir });
  const file = join(configDir, "config.toml");
  try {
    const defaults = {
      triage: 20,
      summarize: 20,
      chat: 20,
    };
    expect(config().waitBudgetS).toEqual(defaults);
    writeFileSync(file, "[routing.wait_budget_s]\ntriage = 0\nimplement = 2\nplan = 4\nplan_review = 5\n");
    expect(config().waitBudgetS).toEqual({ ...defaults, triage: 0, implement: 2, plan: 4, plan_review: 5 });
    writeFileSync(file, '[routing.wait_budget_s]\ntriage = "unbounded"\nreview = "unbounded"\n');
    expect(config().waitBudgetS).toEqual({ summarize: 20, chat: 20 });
    for (const value of ["-1", "1.5", '"20"', "true", "[]", "{}", "1e20"]) {
      writeFileSync(file, `[routing.wait_budget_s]\nreview = ${value}\n`);
      expect(config).toThrow("routing.wait_budget_s.review must be nonnegative integer seconds");
    }
    for (const value of ['"20"', "20", "[]"]) {
      writeFileSync(file, `[routing]\nwait_budget_s = ${value}\n`);
      expect(config).toThrow("routing.wait_budget_s must be a table");
    }
    writeFileSync(file, "[routing.wait_budget_s]\nunknown = 1\n");
    expect(config).toThrow("unknown role");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider schema rejects each malformed field without echoing its value", () => {
  const invalid: [string, unknown][] = [
    ["id", ""],
    ["id", "a/b"],
    ["id", "a@b"],
    ["id", "a|b"],
    ["id", "a b"],
    ["kind", "secret-sentinel"],
    ["preset", "secret-sentinel"],
    ["label", ""],
    ["billing", "secret-sentinel"],
    ["max_concurrent", 0],
    ["max_concurrent", 1.5],
    ["max_concurrent", Number.MAX_SAFE_INTEGER + 1],
    ["max_concurrent", Infinity],
    ["base_url", "secret-sentinel"],
    ["base_url", "ftp://example.com"],
    ["base_url", "https://example.com/a b"],
    ["openai_base_url", "http://user:secret-sentinel@example.com"],
    ["decisions_base_url", "secret-sentinel"],
    ["health_url", "secret-sentinel"],
    ["api_key_env", "secret-sentinel"],
    ["apiKey", "secret-sentinel"],
    ["api_key", "secret-sentinel"],
    ["models", []],
    ["models", "secret-sentinel"],
    ["ssh_forward", { host: "-oProxyCommand=bad" }],
    ["ssh_forward", { host: "example.com", local_port: 65536, remote_port: 80 }],
    ["ssh_forward", { host: "example.com", local_port: 80, remote_port: 0 }],
    ["ssh_forward", { host: "example.com", local_port: 80 }],
    ["ssh_forward", { host: "example.com", local_port: 80, remote_port: 80, token: "secret-sentinel" }],
    ["unknown", "secret-sentinel"],
  ];
  for (const [field, value] of invalid) {
    let message = "";
    try {
      resolveCatalog([{ ...customProvider, [field]: value }]);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(field);
    expect(message).not.toContain("secret-sentinel");
  }
  for (const [field, value] of [
    ["id", ""],
    ["id", "a/b"],
    ["id", "a@b"],
    ["id", "a|b"],
    ["id", "a b"],
    ["model", ""],
    ["model", 1],
    ["vendor", "bad"],
    ["origin", "USA"],
    ["origin", "ZZ"],
    ["origin", "cn"],
    ["base_origin", "USA"],
    ["tier", 0],
    ["tier", 6],
    ["tier", 1.5],
    ["price", { input: -1, output: 0 }],
    ["price", { input: 0, output: Infinity }],
    ["price", { input: 0, output: 0, cache_read: -1 }],
    ["price", { input: 0 }],
    ["efforts", ["bad"]],
    ["efforts", "none"],
    ["effort", "max"],
    ["checkpoint", 1],
    ["notes", 1],
    ["unknown", "secret-sentinel"],
  ] as [string, unknown][]) {
    expect(() =>
      resolveCatalog([{ ...customProvider, models: [{ ...customModel, [field]: value }] }]),
    ).toThrow(field);
  }
  for (const field of ["kind", "billing", "max_concurrent", "models", "base_url"]) {
    const value: Record<string, unknown> = { ...customProvider };
    delete value[field];
    expect(() => resolveCatalog([value])).toThrow(field);
  }
  for (const field of ["id", "model", "vendor", "origin", "base_origin", "tier", "price", "efforts"]) {
    const value: Record<string, unknown> = { ...customModel };
    delete value[field];
    expect(() => resolveCatalog([{ ...customProvider, models: [value] }])).toThrow(field);
  }
  expect(() => resolveCatalog([customProvider, customProvider])).toThrow("duplicate provider");
  expect(() => resolveCatalog([{ ...customProvider, models: [customModel, customModel] }])).toThrow(
    "duplicate model",
  );
});

test("presets, same-id definitions, partial metadata and legacy concurrency preserve stable ordering", () => {
  const defaults = resolveCatalog();
  expect(
    resolveCatalog([
      { preset: "claude" },
      { preset: "codex" },
      { preset: "openrouter" },
      { preset: "typesafe" },
    ]).providers,
  ).toEqual(defaults.providers);
  const custom = resolveCatalog([
    {
      preset: "claude",
      models: [
        { id: "opus", price: { input: 3 } },
        { ...customModel, id: "new" },
      ],
    },
    { preset: "codex", id: "work", max_concurrent: 7, models: [{ id: "sol", notes: "overridden" }] },
    { id: "twilight", ssh_forward: { host: "example.com", local_port: 18080, remote_port: 8080 } },
    { id: "omlx", max_concurrent: 8 },
    { id: "mtplx" },
  ]);
  expect(custom.providers.map((p) => p.id)).toEqual([...defaults.providers.map((p) => p.id), "work"]);
  expect(custom.models.slice(0, defaults.models.length).map((m) => m.id)).toEqual(
    defaults.models.map((m) => m.id),
  );
  expect(custom.models.find((m) => m.id === "claude/opus")?.price).toEqual({
    input: 3,
    output: 20,
    cacheRead: 0.2,
  });
  expect(custom.models.find((m) => m.id === "work/sol")).toMatchObject({
    provider: "work",
    model: "gpt-6-sol",
    notes: "overridden",
  });
  expect(custom.providers.find((p) => p.id === "work")?.maxConcurrent).toBe(7);
  expect(custom.providers.find((p) => p.id === "twilight")?.sshForward).toEqual({
    host: "example.com",
    localPort: 18080,
    remotePort: 8080,
  });
  expect(custom.notes).toEqual([]);
  expect(resolveCatalog({ omlx: { max_concurrent: 8 } }).notes).toEqual(defaults.notes);
  expect(defaults.notes.map((n) => n.split(":")[0])).toEqual(["omlx", "mtplx", "twilight"]);
});

test("credentials use arbitrary file names first, empty file values fall back to env, and missing keys cannot be enabled", () => {
  const key = "LIMITLESS_TEST_MLX_KEY";
  const saved = process.env[key];
  const fixture = providerFixture();
  const store = new Store(":memory:");
  try {
    for (const [fileValue, envValue, expected] of [
      ["file-sentinel", "env-sentinel", "file-sentinel"],
      ["", "env-sentinel", "env-sentinel"],
      ["file-sentinel", "", "file-sentinel"],
      ["", "", ""],
    ]) {
      process.env[key] = envValue;
      writeFileSync(join(fixture.configDir, "secrets.env"), `${key}=${fileValue}\n`);
      const cfg = fixture.load();
      expect(cfg.secrets[key]).toBe(expected);
      const factory = new Factory(cfg, { store });
      expect(factory.tracker.authToken("mac-mlx")).toBe(expected);
      const status = factory.tracker.setEnabled("mac-mlx", true);
      expect(status.enabled).toBe(Boolean(expected));
      expect(status.reason).toBe(expected ? null : `missing key ${key}`);
      expect(JSON.stringify(status)).not.toContain("sentinel");
    }
    const { api_key_env: _key, label: _label, ...anonymous } = customProvider;
    writeFileSync(fixture.file, `providers = ${tomlValue([anonymous])}`);
    const noKey = new Factory(fixture.load(), { store });
    expect(noKey.tracker.status("mac-mlx")).toMatchObject({ enabled: true, label: "mac-mlx" });
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
    store.close();
    fixture.close();
  }
});

test("every configured kind reaches Factory targets, with HTTP paths preserved and transport restrictions", async () => {
  for (const kind of ["claude-cli", "codex-cli", "anthropic-compatible", "openai-compatible", "decisions"]) {
    const definition = {
      ...customProvider,
      kind,
      models: [{ ...customModel, efforts: [], effort: undefined }],
    };
    const fixture = providerFixture([definition], "LIMITLESS_TEST_MLX_KEY=sentinel-key\n");
    const store = new Store(":memory:");
    try {
      const factory = new Factory(fixture.load(), {
        store,
        harnesses: {
          claude: fakeHarness(() => ({})),
          codex: fakeHarness(() => ({})),
          decisions: fakeHarness(() => ({})),
          llm: fakeHarness(() => ({})),
        },
      });
      const resolved = factory.router.resolveFor("triage", "mac-mlx/flash");
      const target = factory.router.toTarget(resolved.model);
      expect(target.model).toBe("org/backend");
      expect(target.harness).toBe(
        kind === "codex-cli" ? "codex" : kind === "decisions" ? "decisions" : "claude",
      );
      const endpoint =
        kind === "openai-compatible"
          ? target.openai
          : kind === "decisions"
            ? target.decisions
            : target.backend;
      expect(endpoint).toEqual({ baseUrl: customProvider.base_url, authToken: "sentinel-key" });
      expect(factory.models.find((m) => m.id === "mac-mlx/flash")).toEqual(resolved.model);
      expect(factory.evalPolicy().models).toContainEqual(resolved.model);
      expect(factory.tracker.status("mac-mlx")?.maxConcurrent).toBe(4);
      if (kind === "openai-compatible" || kind === "decisions") {
        expect(() => factory.router.resolveFor("implement", "mac-mlx/flash")).toThrow();
        expect(factory.router.route("implement", "small", { only: "mac-mlx/flash" }).candidates).toEqual([]);
      }
    } finally {
      store.close();
      fixture.close();
    }
  }
  const catalog = resolveCatalog([{ ...customProvider, openai_base_url: "https://example.com/exact" }]);
  expect(catalog.providers.at(-1)?.openaiBaseUrl).toBe("https://example.com/exact");
  expect(
    resolveCatalog([
      { ...customProvider, kind: "decisions", decisions_base_url: "https://example.com/typed" },
    ]).providers.at(-1)?.decisionsBaseUrl,
  ).toBe("https://example.com/typed");
});

test("configured targets validate policy groups and production pins before any provider activity", () => {
  const fixture = providerFixture();
  const store = new Store(":memory:");
  try {
    const cfg = fixture.load();
    for (const group of ["claude/opus|mac-mlx/unknown", "unknown/flash@none", "mac-mlx/flash@max"]) {
      expect(
        () => new Factory(cfg, { store, policy: { ...DEFAULT_POLICY, triage: { default: [group] } } }),
      ).toThrow();
    }
    expect(
      () =>
        new Factory(cfg, { store, policy: { ...DEFAULT_POLICY, implement: { default: ["mac-mlx/flash"] } } }),
    ).toThrow("transport");
    cfg.reviewMode = "panel";
    cfg.reviewRosters.standard = [{ prompt: "adversarial", target: "mac-mlx/flash" }];
    expect(() => new Factory(cfg, { store })).toThrow("transport");
    const catalog = cfg.catalog;
    if (!catalog) throw new Error("missing catalog");
    expect(() =>
      validatePolicy(
        { triage: { default: ["mac-mlx/flash@none|claude/opus"] } },
        catalog.models,
        catalog.providers,
      ),
    ).not.toThrow();
    expect(() => validatePolicy({ triage: { default: ["mac-mlx/flash"] } }, catalog.models, [])).toThrow(
      "unknown provider",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("GUIDE provider configuration is loadable and startup notes name migration and missing variables only", async () => {
  const guide = await Bun.file(join(import.meta.dir, "../docs/GUIDE.md")).text();
  const section = guide.split("## Providers\n")[1]?.split("\n## ")[0];
  const example = section?.match(/```toml\n([\s\S]*?)```/)?.[1];
  if (!example) throw new Error("Providers example missing");
  const fixture = providerFixture();
  const store = new Store(":memory:");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const saved = process.env.LIMITLESS_NO_SCHEDULER;
  try {
    writeFileSync(fixture.file, example);
    writeFileSync(join(fixture.configDir, "secrets.env"), "EXAMPLE_API_KEY=sentinel-key\n");
    const cfg = fixture.load();
    process.env.LIMITLESS_NO_SCHEDULER = "1";
    new Factory(cfg, { store }).start();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("omlx: deprecated implicit provider"));
    expect(log.mock.calls.flat().join(" ")).not.toContain("sentinel-key");
    const missing = providerFixture();
    try {
      const factory = new Factory(missing.load(), { store });
      factory.start();
      expect(log).toHaveBeenCalledWith("[providers] mac-mlx: missing key LIMITLESS_TEST_MLX_KEY");
    } finally {
      missing.close();
    }
  } finally {
    if (saved === undefined) delete process.env.LIMITLESS_NO_SCHEDULER;
    else process.env.LIMITLESS_NO_SCHEDULER = saved;
    log.mockRestore();
    store.close();
    fixture.close();
  }
});

test("a config-defined provider executes an eval through the injected fake HTTP harness", async () => {
  const evals = await evalFixture();
  const config = providerFixture([customProvider], "LIMITLESS_TEST_MLX_KEY=eval-secret-sentinel\n");
  const store = new Store(":memory:");
  const calls: string[] = [];
  const factory = new Factory(loadConfig({ home: evals.home, configDir: config.configDir }), {
    store,
    evalCasePath: evals.casePath,
    harnesses: {
      llm: fakeHarness((spec) => {
        expect(spec.target.openai).toEqual({
          baseUrl: customProvider.base_url,
          authToken: "eval-secret-sentinel",
        });
        expect(spec.target.model).toBe("org/backend");
        calls.push(spec.target.modelId);
        return { structured: answer };
      }),
    },
  });
  try {
    const run = factory.evals.submit({ role: "triage", models: ["mac-mlx/flash@none"], caseIds: ["a"] });
    await factory.evals.wait(run.id);
    expect(calls).toEqual(["mac-mlx/flash"]);
    expect(factory.evals.report(run.id)?.trials[0]?.pass).toBe(true);
  } finally {
    await factory.stop();
    store.close();
    config.close();
    await evals.close();
  }
});

test("credential names matching object properties resolve as data; unrelated integration precedence is unchanged", () => {
  const saved = process.env.DISCORD_APP_ID;
  const fixture = providerFixture(
    [{ ...customProvider, api_key_env: "__proto__" }],
    "__proto__=file-sentinel\nDISCORD_APP_ID=file-app\n",
  );
  try {
    process.env.DISCORD_APP_ID = "env-app";
    const cfg = fixture.load();
    expect(Object.getOwnPropertyDescriptor(cfg.secrets, "__proto__")?.value).toBe("file-sentinel");
    expect(cfg.secrets.DISCORD_APP_ID).toBe("env-app");
    rmSync(join(fixture.configDir, "secrets.env"));
    expect(Object.getOwnPropertyDescriptor(fixture.load().secrets, "__proto__")?.value).toBe("");
  } finally {
    if (saved === undefined) delete process.env.DISCORD_APP_ID;
    else process.env.DISCORD_APP_ID = saved;
    fixture.close();
  }
});

test("provider ids that match object properties remain routable with configured concurrency", () => {
  const { api_key_env: _key, ...definition } = customProvider;
  const fixture = providerFixture(
    ["__proto__", "constructor", "toString"].map((id) => ({ ...definition, id })),
  );
  const store = new Store(":memory:");
  try {
    const factory = new Factory(fixture.load(), { store });
    for (const id of ["__proto__", "constructor", "toString"]) {
      expect(factory.tracker.status(id)).toMatchObject({ maxConcurrent: 4, enabled: true, reason: null });
      expect(factory.router.route("triage", "small", { only: `${id}/flash` }).candidates[0]?.provider).toBe(
        id,
      );
    }
  } finally {
    store.close();
    fixture.close();
  }
});

test("explicit native Claude transport can use a separate tool-free endpoint", () => {
  const fixture = providerFixture([{ preset: "claude", openai_base_url: "https://example.com/v1" }]);
  const store = new Store(":memory:");
  try {
    const factory = new Factory(fixture.load(), { store });
    expect(factory.router.resolveFor("implement", "claude/opus").model.id).toBe("claude/opus");
    expect(factory.tracker.status("claude")?.kind).toBe("claude-cli");
    const target = factory.router.toTarget(factory.router.resolve("claude/opus").model);
    expect(target.openai?.baseUrl).toBe("https://example.com/v1");
    expect(target.backend).toBeUndefined();
  } finally {
    store.close();
    fixture.close();
  }
});

test("built-in kinds reject explicit and preset conflicts while same-kind overrides load", () => {
  for (const change of [
    { id: "claude", kind: "codex-cli" },
    { id: "claude", preset: "codex" },
  ]) {
    const fixture = providerFixture([change]);
    try {
      expect(fixture.load).toThrow("claude: expected kind claude-cli, received codex-cli");
    } finally {
      fixture.close();
    }
  }
  const fixture = providerFixture([{ id: "claude", kind: "claude-cli", label: "Work", max_concurrent: 7 }]);
  try {
    expect(fixture.load().catalog?.providers[0]).toMatchObject({
      id: "claude",
      label: "Work",
      maxConcurrent: 7,
    });
  } finally {
    fixture.close();
  }
});

test("native aliases inherit both reserve windows, retain identity and honor explicit overrides", () => {
  const fixture = providerFixture([
    { preset: "codex", id: "work" },
    { preset: "claude", id: "writing" },
  ]);
  const store = new Store(":memory:");
  try {
    const cfg = fixture.load();
    let now = 1000;
    const reserves = {
      claudeFiveHour: 0.8,
      claudeSevenDay: 0.85,
      codexWeekly: 0.9,
      codexFiveHour: 0.9,
      windows: {} as Record<string, Record<string, number>>,
    };
    const tracker = new ProviderTracker(cfg.catalog?.providers ?? [], store, reserves, {}, {}, () => now);
    for (const [id, window, limit] of [
      ["work", "seven_day", 0.9],
      ["work", "five_hour", 0.9],
      ["writing", "five_hour", 0.8],
      ["writing", "seven_day", 0.85],
    ] as const) {
      tracker.observeWindows(id, { [window]: { utilization: 0.95, resetsAt: now + 100 } });
      expect(tracker.unavailableReason(id)).toBe("at reserve limit");
      expect(tracker.unavailableReason(id === "work" ? "codex" : "claude")).toBeNull();
      reserves.windows[id] = { [window]: 0.99 };
      expect(tracker.unavailableReason(id)).toBeNull();
      delete reserves.windows[id];
      tracker.observeWindows(id, { [window]: { utilization: limit - 0.01, resetsAt: now + 100 } });
      expect(tracker.unavailableReason(id)).toBeNull();
      tracker.observeWindows(id, { [window]: { utilization: 0.95, resetsAt: now + 100 } });
      now += 101;
      expect(tracker.unavailableReason(id)).toBeNull();
    }
  } finally {
    store.close();
    fixture.close();
  }
});
