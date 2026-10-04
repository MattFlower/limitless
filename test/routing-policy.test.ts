import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Role } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS } from "../src/router/catalog.ts";
import { exportProviders, resolveCatalog } from "../src/router/config-catalog.ts";
import { loadPolicy, validatePolicy } from "../src/router/policy.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { type RouteConstraints, Router } from "../src/router/router.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evidence, local, subscription } from "./evals-policy-support.ts";
import { evalFixture } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("policy files: absent, empty, partial, pipe groups, complexity preservation and immutable defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  const path = join(dir, "policy.json");
  const defaults = structuredClone(DEFAULT_POLICY);
  try {
    expect(loadPolicy(path, MODELS)).toEqual(DEFAULT_POLICY);
    writeFileSync(path, "{}");
    expect(loadPolicy(path, MODELS)).toEqual(DEFAULT_POLICY);
    writeFileSync(
      path,
      JSON.stringify({ triage: { default: [`${local}|${subscription}`] }, review: { default: [local] } }),
    );
    const policy = loadPolicy(path, MODELS);
    expect(policy.triage.default).toEqual([`${local}|${subscription}`]);
    expect(policy.review.large).toEqual(DEFAULT_POLICY.review.large);
    policy.review.large?.push("mutation");
    expect(DEFAULT_POLICY).toEqual(defaults);
    for (const invalid of [
      "{",
      "null",
      "[]",
      '{"bogus":{}}',
      '{"triage":{"bogus":["codex/luna"]}}',
      '{"triage":{"default":[]}}',
      '{"triage":{"default":[""]}}',
      '{"triage":{"default":["no/model"]}}',
      '{"triage":{"default":["codex/luna|"]}}',
      '{"triage":{"default":["codex/luna||mtplx/qwen-27b"]}}',
      '{"triage":{"default":[" codex/luna"]}}',
      '{"triage":{"default":"codex/luna"}}',
    ]) {
      writeFileSync(path, invalid);
      expect(() => loadPolicy(path, MODELS)).toThrow(path);
    }
    writeFileSync(path, '{"triage":{"default":["codex/luna|no/model"]}}');
    expect(() => loadPolicy(path, MODELS)).toThrow('unknown model ID \\"no/model\\"');
    writeFileSync(path, '{"triage":{"default":["codex/luna||mtplx/qwen-27b"]}}');
    expect(() => loadPolicy(path, MODELS)).toThrow("empty model ID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval config rejects malformed supplied settings, accepts inclusive endpoints and nonnegative weights", () => {
  for (const key of Object.keys(evalSettings({}).floors))
    for (const value of [-1, 1.1, Infinity, NaN, "0.5", null])
      expect(() => evalSettings({ evals: { floors: { [key]: value } } })).toThrow();
  for (const value of [-0.1, 1.1, Infinity, NaN, "0.1", null])
    expect(() => evalSettings({ evals: { delta: value } })).toThrow();
  for (const value of [-1, Infinity, NaN, "0.25", null])
    expect(() => evalSettings({ evals: { subscription_weight: value } })).toThrow();
  for (const raw of [
    { evals: null },
    { evals: "bad" },
    { evals: { floors: null } },
    { evals: { floors: [] } },
    { routing: { exclude_origins: "CN" } },
  ])
    expect(() => evalSettings(raw)).toThrow();
  expect(
    evalSettings({
      evals: {
        delta: 0,
        subscription_weight: 0,
        floors: { triage_pass_rate: 0, verify_false_accept_rate: 1 },
      },
    }).delta,
  ).toBe(0);
  expect(evalSettings({ evals: { delta: 1, subscription_weight: 2 } }).subscription_weight).toBe(2);
});

test("explicit application overlays do not affect default or custom-catalog test factories", async () => {
  const fixture = await evalFixture();
  const path = join(fixture.home, "routing/policy.json");
  const factories: Factory[] = [];
  try {
    mkdirSync(join(fixture.home, "routing"));
    writeFileSync(path, JSON.stringify({ triage: { default: [subscription] } }));
    const application = new Factory(fixture.cfg, { policyPath: path, store: fixture.factory.store });
    factories.push(application);
    expect(application.policy.triage.default).toEqual([subscription]);

    const isolated = new Factory(fixture.cfg, { store: fixture.factory.store });
    factories.push(isolated);
    expect(isolated.policy).toBe(DEFAULT_POLICY);
    expect(fixture.factory.policy).toBe(DEFAULT_POLICY);
    const custom = new Factory(fixture.cfg, {
      models: fixture.factory.models,
      store: fixture.factory.store,
    });
    factories.push(custom);
    expect(custom.policy).toBe(DEFAULT_POLICY);
    // The real catalog overlay is invalid for the eval fixture's synthetic catalog.
    expect(() => loadPolicy(path, custom.models)).toThrow(path);
    expect((await fixture.run()).run.status).toBe("completed");
  } finally {
    for (const factory of factories) await factory.stop();
    await fixture.close();
  }
});

test("factory/API share the startup policy and current eligibility settings; injected policy bypasses file", async () => {
  const home = mkdtempSync(join(tmpdir(), "policy-factory-"));
  const path = join(home, "policy.json");
  let factory: Factory | undefined;
  try {
    mkdirSync(join(home, "config"));
    writeFileSync(
      join(home, "config/config.toml"),
      "[evals]\ndelta = 0.2\n[evals.floors]\ntriage_pass_rate = 0.7\n",
    );
    const cfg = loadConfig({ home, configDir: join(home, "config") });
    writeFileSync(path, JSON.stringify({ triage: { default: [subscription] } }));
    factory = new Factory(cfg, { policyPath: path });
    const routes = createHttpRoutes(factory);
    const call = (route: string, suffix = "") =>
      (routes[route] as Route)(requestWithParams(`http://localhost${route}${suffix}`, {}, {}), localServer);
    expect(await (await call("/api/models")).json()).toEqual({ models: MODELS, policy: factory.policy });
    expect(factory.router.route("triage", "small").candidates.map((c) => c.targetId ?? c.modelId)).toEqual([
      subscription,
    ]);
    expect(factory.policy.triage.default).toEqual([subscription]);
    const fixture = evidence();
    const run = factory.store.createEvalRun(fixture.run, fixture.trials);
    factory.store.updateEvalRun(run.id, "completed");
    const result = await (await call("/api/evals/policy")).json();
    expect(result).toEqual(factory.evalPolicy());
    expect(factory.evalPolicy().evaluation.settings.delta).toBe(0.2);
    expect((await call("/api/evals/policy", "?evals=missing")).status).toBe(400);
    expect((await call("/api/evals/policy", "?evals=")).status).toBe(400);
    writeFileSync(path, "bad JSON");
    expect(() => new Factory(cfg, { policyPath: path })).toThrow(path);
    const injected = new Factory(cfg, { policyPath: path, policy: DEFAULT_POLICY, store: factory.store });
    expect(injected.policy).toBe(DEFAULT_POLICY);
    await injected.stop();
    writeFileSync(join(home, "config/config.toml"), '[evals]\ndelta = "invalid"\n');
    expect(() => loadConfig({ home, configDir: join(home, "config") })).toThrow();
  } finally {
    await factory?.stop();
    factory?.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("policy target references share strict resolution and preserve group ordering", async () => {
  const { resolveTarget } = await import("../src/router/targets.ts");
  const lookup = (id: string) => MODELS.find((m) => m.id === id);
  for (const [reference, effort] of [
    ["codex/luna", "medium"],
    ["codex/luna@low", "low"],
    ["codex/luna@none", "none"],
    ["claude/opus@high", "high"],
  ] as const) {
    expect(resolveTarget(reference, lookup).effort).toBe(effort);
    expect(validatePolicy({ triage: { default: [reference] } }, MODELS).triage?.default).toEqual([reference]);
  }
  for (const reference of [
    "",
    "@low",
    "codex/luna@",
    "codex/luna@low@high",
    " codex/luna",
    "codex/luna@low ",
    "codex/luna @low",
    "unknown@low",
    "codex/luna@bogus",
    "claude/haiku@high",
  ]) {
    expect(() => resolveTarget(reference, lookup)).toThrow();
    expect(() => validatePolicy({ triage: { default: [reference] } }, MODELS)).toThrow();
  }
  const group = "codex/luna@low|claude/opus@high";
  expect(validatePolicy({ review: { large: [group] } }, MODELS).review?.large).toEqual([group]);
  const model = lookup("codex/luna");
  if (!model) throw new Error("missing");
  expect(() => resolveTarget(model.id, () => ({ ...model, supportedEfforts: [] }))).toThrow("default");
});

test("policy rejects efforts the role's harness cannot deliver", () => {
  for (const [role, reference] of [
    ["review", "openrouter/gpt-6-luna@low"],
    ["implement", "mtplx/qwen-27b@none"],
    ["implement", "omlx/qwen-27b@none"],
    ["review", "omlx/qwen-27b@high"],
    ["verify", "twilight/qwen-27b@high|claude/opus"],
  ] as const)
    expect(() => validatePolicy({ [role]: { default: [reference] } }, MODELS)).toThrow("cannot carry effort");
  // Tool-less roles use the HTTP harness, which maps effort; bare IDs work everywhere.
  for (const [role, reference] of [
    ["triage", "openrouter/gpt-6-luna@low"],
    ["chat", "mtplx/qwen-27b@none"],
    ["chat", "omlx/qwen-27b@none"],
    ["triage", "omlx/qwen-27b@high"],
    ["implement", "omlx/qwen-27b"],
    ["summarize", "twilight/qwen-27b@high"],
    ["review", "openrouter/gpt-6-luna"],
  ] as const)
    expect(validatePolicy({ [role]: { default: [reference] } }, MODELS)[role]?.default).toEqual([reference]);
});

test("built-in local defaults preserve fallback order", () => {
  for (const role of ["triage", "summarize", "chat"] as const)
    expect(DEFAULT_POLICY[role].default).toEqual([
      "omlx/qwen-flash",
      "claude/haiku|codex/luna",
      ...(role === "chat" ? [] : ["openrouter/glm-5.3-flash"]),
    ]);
  expect(() => validatePolicy({ triage: { default: ["omlx/qwen-27b@low"] } }, MODELS)).toThrow(
    "Unsupported effort",
  );
});

test("the default local model comes first among free oMLX models", () => {
  // Free models are tried in catalog order (smoke checks, free-first routing, local finders).
  expect(MODELS.filter((m) => m.provider === "omlx").map((m) => m.id)).toEqual([
    "omlx/qwen-flash",
    "omlx/qwen-27b",
  ]);
});

test("export preserves complete routing decisions for all roles, complexities and constraint dimensions", () => {
  const exported = resolveCatalog(
    (Bun.TOML.parse(exportProviders(resolveCatalog())) as Record<string, unknown>).providers,
  );
  const stores = [new Store(":memory:"), new Store(":memory:")];
  const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };
  const secrets = {
    OPENROUTER_API_KEY: "router-key",
    OMLX_API_KEY: "omlx-key",
    TWILIGHT_API_KEY: "twilight-key",
    TYPESAFE_API_KEY: "typesafe-key",
  };
  const catalogs = [{ providers: PROVIDERS, models: MODELS }, exported];
  const constraints: RouteConstraints[] = [
    {},
    { billing: "free_only" },
    { billing: "free_first" },
    { minTier: 1 },
    { minTier: 4 },
    { minTier: 5 },
    { avoidVendor: "anthropic" },
    { avoidVendor: ["anthropic", "openai"] },
    { excludeModels: ["mtplx/qwen-27b@none"], excludedBecause: "already reviewed checkpoint" },
    { exclude: ["codex/sol@medium", { modelId: "omlx/qwen-flash", effort: "none" }] },
    { prefer: "codex/sol@low" },
    { prefer: { modelId: "claude/opus", effort: null } },
    { only: "omlx/qwen-flash@none" },
    { only: { modelId: "codex/sol", effort: "high" } },
    { preferVendor: "qwen" },
    { preferNotVendor: ["anthropic"] },
    { preferNotModels: ["codex/sol", "claude/opus"] },
    { billing: "free_first", independenceFirst: true, avoidVendor: "qwen", minTier: 2 },
    { billing: "free_first", independenceFirst: false, avoidVendor: ["qwen", "openai"], minTier: 3 },
    { prefer: "codex/sol", exclude: ["codex/sol"], excludeModels: ["claude/opus"], minTier: 4 },
    {
      preferVendor: "openai",
      preferNotVendor: ["anthropic"],
      preferNotModels: ["codex/sol"],
      avoidVendor: "openai",
    },
  ];
  try {
    const trackers = catalogs.map((catalog, i) => {
      const store = stores[i];
      if (!store) throw new Error("missing store");
      const tracker = new ProviderTracker(
        catalog.providers,
        store,
        reserves,
        secrets,
        { openrouter: 50 },
        () => 1000,
      );
      for (const provider of catalog.providers) tracker.setHealthy(provider.id, true);
      tracker.observeWindows("claude", { five_hour: { utilization: 0.2, resetsAt: 100_000 } });
      tracker.observeWindows("codex", { seven_day: { utilization: 0.5, resetsAt: 100_000 } });
      return tracker;
    });
    const routers = trackers.map(
      (tracker, i) => new Router(tracker, DEFAULT_POLICY, catalogs[i]?.models, ["codex"]),
    );
    for (const state of ["healthy", "disabled", "exhausted", "unavailable"]) {
      for (const tracker of trackers) {
        if (state === "disabled") tracker.setEnabled("claude", false);
        if (state === "exhausted") tracker.record("codex", "quota", { exhaustedUntil: 100_000 });
        if (state === "unavailable") {
          tracker.setHealthy("omlx", false);
          tracker.blockModel("openrouter/glm-5.3", "unavailable");
        }
      }
      for (const role of Object.keys(DEFAULT_POLICY) as Role[])
        for (const complexity of ["trivial", "small", "medium", "large"] as const)
          for (const constraint of constraints)
            expect(routers[1]?.route(role, complexity, constraint, false)).toEqual(
              routers[0]?.route(role, complexity, constraint, false),
            );
    }
    for (const model of MODELS)
      expect(routers[1]?.checkpointIdentity(model.id)).toEqual(routers[0]?.checkpointIdentity(model.id));
  } finally {
    for (const store of stores) store.close();
  }
});
