import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import { loadPolicy } from "../src/router/policy.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evidence, local, subscription } from "./evals-policy-support.ts";
import { evalFixture } from "./evals-support.ts";
import { type Route, requestWithParams } from "./mcp-support.ts";

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
      (routes[route] as Route)(
        requestWithParams(`http://localhost${route}${suffix}`, {}, {}),
        {} as Server<undefined>,
      );
    expect(await (await call("/api/models")).json()).toEqual({ models: MODELS, policy: factory.policy });
    expect(factory.router.route("triage", "small").candidates.map((c) => c.modelId)).toEqual([subscription]);
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
