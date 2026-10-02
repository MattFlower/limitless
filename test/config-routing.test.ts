import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_ROSTERS } from "../src/pipeline/review-system.ts";
import { PROVIDERS } from "../src/router/catalog.ts";

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
      "review.implementer-report: unknown key (allowed: implementer_report, mode, rosters)",
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
    expect(loadConfig({ home: join(root, "data"), configDir }).secrets.OMLX_API_KEY).toBe(
      process.env.OMLX_API_KEY || "file-key",
    );
    const defaults = new Factory(loadConfig({ home: join(root, "defaults"), configDir }));
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
      review: 180,
      verify: 180,
      spec: 180,
      holdout: 180,
      implement: 300,
    };
    expect(config().waitBudgetS).toEqual(defaults);
    writeFileSync(file, "[routing.wait_budget_s]\ntriage = 0\nimplement = 2\nplan = 4\nplan_review = 5\n");
    expect(config().waitBudgetS).toEqual({ ...defaults, triage: 0, implement: 2, plan: 4, plan_review: 5 });
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
