import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import { exportProviders, resolveCatalog, runtimeModel } from "../src/router/config-catalog.ts";
import { loadPolicy, validatePolicy } from "../src/router/policy.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evidence, local, subscription } from "./evals-policy-support.ts";
import { evalFixture } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { customModel, providerFixture } from "./provider-config-support.ts";
import { identitySnapshot } from "./routing-identity-support.ts";

test("startup prefers built-in Haiku 5.5 over a retained runtime entry; other collisions fail", async () => {
  const fixture = providerFixture([]);
  const store = new Store(":memory:");
  const cfg = fixture.load();
  const catalog = cfg.catalog ?? resolveCatalog(cfg.raw.providers);
  const builtIn = catalog.models.find((m) => m.id === "claude/haiku-5.5");
  if (!builtIn) throw new Error("missing Haiku 5.5");
  const runtime = runtimeModel({ ...customModel, id: "haiku-5.5", provider: "claude" }, catalog.providers);
  store.writeRuntimeModel(runtime.id, runtime);
  const history = store.catalogHistory();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let factory: Factory | undefined;
  try {
    factory = new Factory(cfg, { store, policyPath: join(import.meta.dir, "../routing/policy.json") });
    expect(factory.models.filter((m) => m.id === runtime.id)).toEqual([builtIn]);
    factory.tracker.setHealthy("codex", false);
    expect(factory.router.route("triage", "small").candidates[0]).toMatchObject({
      modelId: "claude/haiku-5.5",
      model: "claude-haiku-5-5",
      effort: "medium",
      vendor: "anthropic",
      price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    });
    expect(warn).toHaveBeenCalledWith(
      "[catalog] claude/haiku-5.5: redundant runtime entry; using built-in definition",
    );
    expect(store.runtimeModels()).toEqual([runtime]);
    expect(store.catalogHistory()).toEqual(history);
    expect(() => factory?.catalog.add({ ...customModel, id: "haiku-5.5", provider: "claude" })).toThrow(
      "catalog collision: claude/haiku-5.5",
    );
    expect(
      () =>
        new Factory(cfg, {
          store,
          models: MODELS.map((m) => (m.id === runtime.id ? { ...m, source: "config" } : m)),
        }),
    ).toThrow("catalog collision: claude/haiku-5.5");
    const other = runtimeModel({ ...customModel, id: "luna", provider: "codex" }, catalog.providers);
    store.writeRuntimeModel(other.id, other);
    expect(() => new Factory(cfg, { store })).toThrow("catalog collision: codex/luna");
  } finally {
    warn.mockRestore();
    await factory?.stop();
    store.close();
    fixture.close();
  }
});

test("runtime models stay out of escalation and free widening unless explicitly named", () => {
  const fixture = providerFixture([], "OMLX_API_KEY=fake-key\n");
  const store = new Store(":memory:");
  const factory = new Factory(fixture.load(), { store });
  try {
    factory.catalog.add({ ...customModel, provider: "codex", id: "experimental", tier: 5 });
    factory.catalog.add({ ...customModel, provider: "omlx", id: "experimental", tier: 5, effort: undefined });
    factory.tracker.setHealthy("omlx", true);
    expect(
      factory.router
        .route("implement", "small", { minTier: 5 })
        .candidates.some((m) => m.modelId.endsWith("/experimental")),
    ).toBe(false);
    for (const billing of ["free_first", "free_only"] as const)
      expect(
        factory.router
          .route("triage", "small", { billing })
          .candidates.some((m) => m.modelId === "omlx/experimental"),
      ).toBe(false);
    for (const id of ["omlx/experimental", "codex/experimental"]) {
      expect(factory.router.route("triage", "small", { chain: [id] }).candidates[0]?.modelId).toBe(id);
      factory.routing.setCell("triage", "small", [id]);
      expect(factory.router.route("triage", "small").candidates[0]?.modelId).toBe(id);
    }
    factory.routing.setCell("implement", "small", ["omlx/experimental"]);
    expect(factory.router.route("implement", "small", { minTier: 5 }).candidates[0]?.modelId).toBe(
      "omlx/experimental",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

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
    writeFileSync(path, '{"implement":{"large":["codex/astra@high","claude/opus"]}}');
    expect(() => loadPolicy(path, MODELS)).toThrow("GPT-6 Astra was removed from routing on 2026-10-04");
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
    ["verify", "mtplx/qwen-27b@high|claude/opus"],
  ] as const)
    expect(() => validatePolicy({ [role]: { default: [reference] } }, MODELS)).toThrow("cannot carry effort");
  // Tool-less roles use the HTTP harness, which maps effort; bare IDs work everywhere.
  for (const [role, reference] of [
    ["triage", "openrouter/gpt-6-luna@low"],
    ["chat", "mtplx/qwen-27b@none"],
    ["chat", "omlx/qwen-27b@none"],
    ["triage", "omlx/qwen-27b@high"],
    ["implement", "omlx/qwen-27b"],
    ["summarize", "mtplx/qwen-27b@high"],
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

test("frozen pre-PR identity and export preserve all routing decisions", async () => {
  const baseline = await Bun.file(join(import.meta.dir, "fixtures/routing-identity.json")).json();
  // Keep the captured fixture intact; build expectations for its retired entry inline.
  const retired = baseline.snapshot.providers.filter(
    (id: string) => !resolveCatalog().providers.some((p) => p.id === id),
  );
  expect(retired).toHaveLength(1);
  const retiredModels = new Set<string>(
    baseline.snapshot.models
      .filter((m: { provider: string }) => retired.includes(m.provider))
      .map((m: { id: string }) => m.id),
  );
  baseline.snapshot.providers = baseline.snapshot.providers.filter((id: string) => !retired.includes(id));
  baseline.snapshot.models = baseline.snapshot.models.filter((m: { id: string }) => !retiredModels.has(m.id));
  for (const decision of baseline.decisionTable) {
    decision.candidates = decision.candidates
      .map((i: number) => baseline.candidateTable[i])
      .filter((c: { modelId: string }) => !retiredModels.has(c.modelId));
    decision.skipped = decision.skipped
      .map((i: number) => baseline.skippedTable[i])
      .filter((c: { modelId: string }) => !retiredModels.has(c.modelId.split("@")[0] ?? ""));
  }
  for (const row of baseline.snapshot.decisions) row.decision = baseline.decisionTable[row.decision];
  // Haiku 5.5 is an intentional addition, covered above; retain every frozen assertion for existing models.
  const existingSnapshot = (catalog: ReturnType<typeof resolveCatalog>) => {
    const snapshot = identitySnapshot(catalog);
    snapshot.models = snapshot.models.filter((m) => m.id !== "claude/haiku-5.5");
    for (const row of snapshot.decisions) {
      row.decision.candidates = row.decision.candidates.filter((m) => m.modelId !== "claude/haiku-5.5");
      row.decision.skipped = row.decision.skipped.filter((m) => m.modelId !== "claude/haiku-5.5@medium");
    }
    return snapshot;
  };
  expect(existingSnapshot(resolveCatalog())).toEqual(baseline.snapshot);
  const exported = resolveCatalog(
    (Bun.TOML.parse(exportProviders(resolveCatalog())) as Record<string, unknown>).providers,
  );
  expect(existingSnapshot(exported)).toEqual(baseline.snapshot);
});
