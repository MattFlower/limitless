import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { type AgentResult, emptyUsage } from "../src/harness/types.ts";
import {
  DEFAULT_POLICY,
  MODELS,
  type ModelDef,
  type Policy,
  PROVIDERS,
  type ProviderDef,
} from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";

const providers: ProviderDef[] = [
  { id: "claude", label: "Claude", harness: "claude", billing: "subscription", maxConcurrent: 1 },
  { id: "codex", label: "Codex", harness: "codex", billing: "subscription", maxConcurrent: 1 },
  {
    id: "openrouter",
    label: "OR",
    harness: "claude",
    billing: "metered",
    maxConcurrent: 2,
    baseUrl: "https://openrouter.ai/api",
    apiKeySecret: "OPENROUTER_API_KEY",
  },
];
const models: ModelDef[] = [
  {
    id: "claude/sonnet",
    provider: "claude",
    model: "claude-sonnet-5",
    vendor: "anthropic",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 2, output: 10 },
  },
  {
    id: "claude/opus",
    provider: "claude",
    model: "claude-opus-5-5",
    vendor: "anthropic",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 5,
    price: { input: 4, output: 20 },
  },
  {
    id: "codex/sol",
    provider: "codex",
    model: "gpt-6-sol",
    vendor: "openai",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 2, output: 10 },
  },
  {
    id: "openrouter/ds",
    provider: "openrouter",
    model: "deepseek/x",
    vendor: "deepseek",
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    tier: 4,
    price: { input: 0.3, output: 0.8 },
  },
];
const policy = {
  implement: { default: ["claude/sonnet|codex/sol", "openrouter/ds"] },
  review: { default: ["codex/sol|claude/sonnet"] },
} as unknown as Policy;
const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-router-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(secrets: Record<string, string> = {}) {
  const tracker = new ProviderTracker(providers, store, reserves, secrets, { openrouter: 50 });
  return { tracker, router: new Router(tracker, policy, models) };
}

test("quota windows keep independent observation times and reject older boundaries", () => {
  let now = 1_000_000;
  const tracker = new ProviderTracker(providers, store, reserves, {}, {}, () => now);
  tracker.observeWindows("claude", {
    five_hour: { utilization: 0.721, resetsAt: 2_000_000 },
    seven_day: { utilization: 0.2, resetsAt: 9_000_000 },
  });
  now += 12 * 60_000;
  tracker.observeWindows("claude", { five_hour: { utilization: 0.75, resetsAt: 2_000_000 } });
  expect(tracker.status("claude")?.windows).toMatchObject({
    five_hour: { utilization: 0.75, observedAt: now },
    seven_day: { utilization: 0.2, observedAt: 1_000_000 },
  });
  now += 60_000;
  tracker.observeWindows("claude", { five_hour: { utilization: 0.1, resetsAt: 1_900_000 } });
  expect(tracker.status("claude")?.windows.five_hour).toMatchObject({
    utilization: 0.75,
    observedAt: 1_720_000,
  });
});

test("quota observation times survive reload and legacy windows remain unknown", () => {
  let now = 1_000_000;
  const dbPath = join(dir, "db.sqlite");
  const tracker = new ProviderTracker(providers, store, reserves, {}, {}, () => now);
  tracker.observeWindows("claude", { five_hour: { utilization: 0.721, resetsAt: 2_000_000 } });
  // A pre-migration row has windows_json but no observation timestamps.
  store.putProviderRow({
    provider: "codex",
    state: "ok",
    reason: null,
    until: null,
    windows: { seven_day: { utilization: 0.3, resetsAt: null } },
    windowObservedAt: {},
    consecutiveFailures: 0,
  });
  store.db.query("UPDATE provider_state SET window_observed_at_json = NULL WHERE provider = 'codex'").run();
  store.close();
  store = new Store(dbPath);
  now += 12 * 60_000;
  const reloaded = new ProviderTracker(providers, store, reserves, {}, {}, () => now);
  expect(reloaded.status("claude")?.windows.five_hour).toEqual({
    utilization: 0.721,
    resetsAt: 2_000_000,
    observedAt: 1_000_000,
  });
  expect(reloaded.status("codex")?.windows.seven_day).toEqual({
    utilization: 0.3,
    resetsAt: null,
    observedAt: null,
  });
});

describe("Router", () => {
  test("free-first orders policy free targets before catalog defaults and partitions vendors within billing", () => {
    const alpha = models[0];
    const beta = models[2];
    if (!alpha || !beta) throw new Error("missing fixture models");
    const defs: ProviderDef[] = [
      ...providers,
      { id: "local-a", label: "A", harness: "claude", billing: "free", maxConcurrent: 1 },
      { id: "local-b", label: "B", harness: "claude", billing: "free", maxConcurrent: 1 },
    ];
    const catalog: ModelDef[] = [
      ...models,
      {
        ...alpha,
        id: "local-a/policy",
        provider: "local-a",
        supportedEfforts: ["low", "high"],
        effort: "low",
      },
      { ...beta, id: "local-b/catalog", provider: "local-b", supportedEfforts: ["low"], effort: "low" },
      { ...alpha, id: "local-a/catalog", provider: "local-a", supportedEfforts: ["low"], effort: "low" },
    ];
    const routing = new Router(
      new ProviderTracker(defs, store, reserves, {}, {}),
      {
        ...policy,
        implement: { default: ["claude/sonnet", "local-a/policy@high", "codex/sol", "openrouter/ds"] },
      },
      catalog,
    );
    const ids = (constraints = {}) =>
      routing.route("implement", "small", constraints).candidates.map((m) => m.targetId);
    expect(ids()).toEqual(["claude/sonnet", "local-a/policy@high", "codex/sol"]);
    expect(ids({ billing: "free_first" })).toEqual([
      "local-a/policy@high",
      "local-b/catalog@low",
      "local-a/catalog@low",
      "claude/sonnet",
      "codex/sol",
    ]);
    expect(ids({ billing: "free_first", prefer: "local-a/catalog@low" })).toEqual([
      "local-a/catalog@low",
      "local-a/policy@high",
      "local-b/catalog@low",
      "claude/sonnet",
      "codex/sol",
    ]);
    expect(ids({ billing: "free_first", avoidVendor: "anthropic", prefer: "claude/sonnet" })).toEqual([
      "claude/sonnet",
      "local-b/catalog@low",
      "local-a/policy@high",
      "local-a/catalog@low",
      "codex/sol",
    ]);
  });

  test("free-first filters unavailable and ineligible free models before policy fallback", () => {
    const alpha = models[0];
    if (!alpha) throw new Error("missing fixture model");
    const defs: ProviderDef[] = [
      ...providers,
      { id: "local", label: "Local", harness: "claude", billing: "free", maxConcurrent: 1 },
    ];
    const catalog: ModelDef[] = [
      ...models,
      { ...alpha, id: "local/low", provider: "local", tier: 2 },
      { ...alpha, id: "local/effort", provider: "local", supportedEfforts: ["high"], effort: "high" },
      { ...alpha, id: "local/eligible", provider: "local" },
    ];
    const tracker = new ProviderTracker(defs, store, reserves, {}, {});
    const routing = new Router(
      tracker,
      { ...policy, implement: { default: ["claude/sonnet", "codex/sol"] } },
      catalog,
    );
    const route = (constraints = {}) =>
      routing.route("implement", "small", { billing: "free_first", ...constraints });
    expect(route({ minTier: 4, excludeModels: ["local/eligible"] }).candidates.map((m) => m.modelId)).toEqual(
      ["local/effort", "claude/sonnet", "codex/sol", "claude/opus"],
    );
    tracker.blockModel("local/effort", "unsupported");
    expect(route({ minTier: 4, excludeModels: ["local/eligible"] }).candidates[0]?.modelId).toBe(
      "claude/sonnet",
    );
    tracker.setEnabled("local", false);
    expect(route().candidates.map((m) => m.modelId)).toEqual(["claude/sonnet", "codex/sol"]);
    tracker.setEnabled("local", true);
    tracker.setHealthy("local", false);
    expect(route().candidates.map((m) => m.modelId)).toEqual(["claude/sonnet", "codex/sol"]);
  });

  test("disabled providers are skipped on ordinary, preferred, and escalation routes", () => {
    const { tracker, router } = setup();
    tracker.setEnabled("claude", false);
    for (const constraints of [{}, { prefer: "claude/sonnet" }, { minTier: 5 }]) {
      const decision = router.route("implement", "small", constraints);
      expect(decision.candidates.every((candidate) => candidate.provider !== "claude")).toBe(true);
      expect(decision.skipped).toContainEqual({
        modelId: constraints.minTier ? "claude/opus" : "claude/sonnet",
        reason: "disabled",
      });
    }
    // A verifier picked from a configured list never falls back to an unlisted model.
    expect(router.route("review", "small", { only: "claude/opus" }).candidates).toEqual([]);
    tracker.setEnabled("claude", true);
    expect(router.route("review", "small", { only: "claude/opus" }).candidates.map((m) => m.modelId)).toEqual(
      ["claude/opus"],
    );
    expect(
      router.route("implement", "small").candidates.some((candidate) => candidate.provider === "claude"),
    ).toBe(true);
  });

  test("enablement overrides survive restart and cannot replace credentials", () => {
    let tracker = setup().tracker;
    tracker.setEnabled("claude", false);
    tracker.setEnabled("codex", true);
    tracker.setEnabled("openrouter", true);
    expect(tracker.status("openrouter")).toMatchObject({
      enabled: false,
      reason: "missing OPENROUTER_API_KEY",
    });
    expect(() => tracker.setEnabled("unknown", false)).toThrow("unknown provider unknown");
    expect(store.getProviderEnabledOverride("unknown")).toBeNull();
    store.close();
    store = new Store(join(dir, "db.sqlite"));
    tracker = setup().tracker;
    expect(tracker.status("claude")).toMatchObject({ enabled: false, reason: "disabled" });
    expect(tracker.status("codex")?.enabled).toBe(true);
    expect(tracker.status("openrouter")?.enabled).toBe(false);
    expect(store.getProviderEnabledOverride("claude")).toBe(false);
    expect(store.getProviderEnabledOverride("codex")).toBe(true);
  });

  test("disabled local providers receive no startup or tick probes and resume on enable", async () => {
    const defs: ProviderDef[] = [
      {
        id: "local",
        label: "Local",
        harness: "claude",
        billing: "free",
        maxConcurrent: 1,
        healthUrl: "http://local/health",
      },
    ];
    store.setProviderEnabledOverride("local", false);
    let calls = 0;
    const fetchHealth = (async () => {
      calls++;
      return Response.json({});
    }) as unknown as typeof fetch;
    const tracker = new ProviderTracker(
      defs,
      store,
      reserves,
      {},
      {},
      Date.now,
      fetch,
      undefined,
      fetchHealth,
    );
    tracker.start();
    await tracker.probe();
    expect(calls).toBe(0);
    tracker.setEnabled("local", true);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(tracker.status("local")?.state).toBe("ok");
    tracker.setEnabled("local", false);
    await tracker.probe();
    expect(calls).toBe(1);
    tracker.stop();
  });
  test("OpenAI URLs are distinct from agentic backends and protected providers need keys", () => {
    const targets = new Router(
      new ProviderTracker(PROVIDERS, store, reserves, { OPENROUTER_API_KEY: "or", TWILIGHT_API_KEY: "tw" }),
      policy,
      MODELS,
    );
    for (const [id, url] of [
      ["mtplx/qwen-27b", "http://127.0.0.1:8000/v1"],
      ["twilight/qwen-27b", "http://twilight:8080/v1"],
      ["openrouter/deepseek-v4-pro", "https://openrouter.ai/api/v1"],
    ] as const) {
      const model = targets.model(id);
      if (!model) throw new Error(`missing ${id}`);
      const target = targets.toTarget(model);
      expect(target.openai?.baseUrl).toBe(url);
      expect(target.backend?.baseUrl).not.toBe(url);
      expect(target.harness).toBe("claude");
    }
    const withoutKeys = new ProviderTracker(PROVIDERS, store, reserves, {});
    expect(withoutKeys.isAvailable("openrouter")).toBe(false);
    expect(withoutKeys.isAvailable("twilight")).toBe(false);
  });
  test("orders interchangeable models by quota headroom", () => {
    const { tracker, router } = setup();
    tracker.observeWindows("claude", { five_hour: { utilization: 0.7, resetsAt: Date.now() + 3_600_000 } });
    tracker.observeWindows("codex", { seven_day: { utilization: 0.1, resetsAt: Date.now() + 86_400_000 } });
    const ids = router.route("implement", "small").candidates.map((c) => c.modelId);
    expect(ids[0]).toBe("codex/sol");
    expect(ids[1]).toBe("claude/sonnet");
  });

  test("skips providers without credentials and explains why", () => {
    const { router } = setup();
    const d = router.route("implement", "small");
    expect(d.candidates.map((c) => c.modelId)).not.toContain("openrouter/ds");
    expect(d.skipped.find((s) => s.modelId === "openrouter/ds")?.reason).toContain("OPENROUTER_API_KEY");
  });

  test("falls back when a subscription is exhausted", () => {
    const { tracker, router } = setup({ OPENROUTER_API_KEY: "k" });
    tracker.record("claude", "quota", { exhaustedUntil: Date.now() + 60_000, error: "limit" });
    tracker.observeWindows("codex", { seven_day: { utilization: 0.95, resetsAt: Date.now() + 86_400_000 } });
    const ids = router.route("implement", "small").candidates.map((c) => c.modelId);
    expect(ids).toEqual(["openrouter/ds"]);
  });

  test("honors the Codex 10% reserve", () => {
    const { tracker } = setup();
    tracker.observeWindows("codex", { seven_day: { utilization: 0.89, resetsAt: Date.now() + 86_400_000 } });
    expect(tracker.isAvailable("codex")).toBe(true);
    tracker.observeWindows("codex", { seven_day: { utilization: 0.9, resetsAt: Date.now() + 86_400_000 } });
    expect(tracker.unavailableReason("codex")).toBe("at reserve limit");
  });

  test("ignores utilization from windows that already reset", () => {
    const { tracker } = setup();
    tracker.observeWindows("claude", { five_hour: { utilization: 0.99, resetsAt: Date.now() - 1000 } });
    expect(tracker.isAvailable("claude")).toBe(true);
  });

  test("prefers a different vendor for review but falls back to the same vendor", () => {
    const { tracker, router } = setup();
    let ids = router.route("review", "small", { avoidVendor: "anthropic" }).candidates.map((c) => c.modelId);
    expect(ids).toEqual(["codex/sol", "claude/sonnet"]);
    tracker.record("codex", "quota", { exhaustedUntil: Date.now() + 60_000 });
    ids = router.route("review", "small", { avoidVendor: "anthropic" }).candidates.map((c) => c.modelId);
    expect(ids).toEqual(["claude/sonnet"]);
  });

  test("avoids every listed vendor, and falls back to them when nothing else is left", () => {
    const { router } = setup();
    const ids = (avoidVendor: string[]) =>
      router.route("review", "small", { avoidVendor }).candidates.map((c) => c.modelId);
    expect(ids(["google", "openai"])).toEqual(["claude/sonnet", "codex/sol"]);
    expect(ids(["openai", "anthropic"])).toEqual(ids([]));
  });

  test("escalation adds higher-tier models beyond the policy list", () => {
    const { router } = setup();
    const ids = router.route("implement", "small", { minTier: 5, exclude: ["claude/sonnet"] }).candidates;
    expect(ids.map((c) => c.modelId)).toEqual(["claude/opus"]);
  });

  test("opens a circuit after repeated provider failures", () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) tracker.record("claude", "unavailable");
    expect(tracker.unavailableReason("claude")).toContain("circuit open");
    expect(tracker.status("claude")?.state).toBe("down");
  });

  test("metered target carries backend credentials", () => {
    const { router } = setup({ OPENROUTER_API_KEY: "secret" });
    const t = router.route("implement", "small", { exclude: ["claude/sonnet", "codex/sol"] }).candidates[0];
    expect(t?.backend).toEqual({ baseUrl: "https://openrouter.ai/api", authToken: "secret" });
    expect(t?.billing).toBe("metered");
  });
});

describe("ProviderTracker concurrency", () => {
  test("uses an overridden limit for admission and status", async () => {
    const overridden = providers.map((provider) => ({
      ...provider,
      maxConcurrent: provider.id === "claude" ? 3 : provider.maxConcurrent,
    }));
    const tracker = new ProviderTracker(overridden, store, reserves, {});
    const signal = new AbortController().signal;
    const releases = await Promise.all(Array.from({ length: 3 }, () => tracker.acquire("claude", signal)));
    expect(tracker.status("claude")?.maxConcurrent).toBe(3);
    expect(tracker.status("claude")?.inFlight).toBe(3);
    let admitted = false;
    const waiting = tracker.acquire("claude", signal).then((release) => {
      admitted = true;
      return release;
    });
    await Bun.sleep(10);
    expect(admitted).toBe(false);
    releases[0]?.();
    const release = await waiting;
    expect(admitted).toBe(true);
    expect(tracker.status("claude")?.inFlight).toBe(3);
    release();
    for (const done of releases.slice(1)) done();
  });

  test("acquire blocks at maxConcurrent until released", async () => {
    const { tracker } = setup();
    const ac = new AbortController();
    const release1 = await tracker.acquire("claude", ac.signal);
    let second = false;
    const p = tracker.acquire("claude", ac.signal).then((r) => {
      second = true;
      return r;
    });
    await Bun.sleep(10);
    expect(second).toBe(false);
    release1();
    const release2 = await p;
    expect(second).toBe(true);
    release2();
    expect(tracker.status("claude")?.inFlight).toBe(0);
  });
});

describe("provider preference", () => {
  test("preferred providers go first among interchangeable models", () => {
    const tracker = new ProviderTracker(providers, store, reserves, {}, { openrouter: 50 });
    tracker.observeWindows("codex", { seven_day: { utilization: 0.6, resetsAt: Date.now() + 86_400_000 } });
    const plain = new Router(tracker, policy, models);
    expect(plain.route("implement", "small").candidates[0]?.modelId).toBe("claude/sonnet");
    const preferring = new Router(tracker, policy, models, ["codex"]);
    expect(preferring.route("implement", "small").candidates[0]?.modelId).toBe("codex/sol");
  });
});

describe("OpenRouter reconciliation", () => {
  let now = 1_000_000;
  let calls = 0;
  let payload: unknown;
  let fail = false;
  let tick: (() => void) | null = null;
  let intervalMs = 0;
  const reading = (monthly: number, remaining = 20, label = "private-label") => ({
    data: {
      usage: monthly,
      usage_daily: monthly,
      usage_weekly: monthly,
      usage_monthly: monthly,
      limit: 20,
      limit_remaining: remaining,
      limit_reset: "daily",
      label,
    },
  });
  const result = (costUsd: number): AgentResult => ({
    status: "ok",
    finalText: "",
    structured: null,
    sessionId: null,
    usage: emptyUsage(),
    numTurns: 0,
    costUsd,
    costEquivUsd: 0,
    error: null,
    quota: null,
  });
  const make = (key = "sentinel-key") => {
    const fetchKey = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(init?.headers).toEqual({ authorization: `Bearer ${key}` });
      if (fail) throw new Error("offline sentinel-key");
      return Response.json(payload);
    }) as typeof fetch;
    const timer = {
      set: ((fn: () => void, ms: number) => {
        tick = fn;
        intervalMs = ms;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clear: ((_id: ReturnType<typeof setInterval>) => {
        tick = null;
      }) as typeof clearInterval,
    };
    return new ProviderTracker(
      providers,
      store,
      reserves,
      key ? { OPENROUTER_API_KEY: key } : {},
      { openrouter: 50 },
      () => now,
      fetchKey,
      timer,
    );
  };
  beforeEach(() => {
    now = 1_000_000;
    calls = 0;
    payload = reading(0);
    fail = false;
    tick = null;
    intervalMs = 0;
  });

  test("uses the larger reported or local spend and retains exhausted readings", async () => {
    const tracker = make();
    expect(await tracker.preflight("openrouter")).toBe(true);
    store.recordChatCall("chat", "openrouter", "openrouter/ds", now, result(60));
    expect(tracker.headroom("openrouter")).toBeLessThanOrEqual(0);
    payload = reading(51);
    now += 120_001;
    await tracker.refreshOpenRouter();
    expect(tracker.headroom("openrouter")).toBeLessThanOrEqual(0);
    expect(tracker.status("openrouter")?.spendUsd).toBe(60);
    expect(tracker.status("openrouter")?.reportedUsageUsd).toBe(51);
    expect(JSON.stringify(tracker.status("openrouter"))).not.toContain("sentinel-key");
    expect(JSON.stringify(tracker.status("openrouter"))).not.toContain("private-label");
  });

  test("failed and malformed readings retain the last successful value and exhaustion", async () => {
    const tracker = make();
    fail = true;
    expect(await tracker.preflight("openrouter")).toBe(false);
    payload = reading(10, 0);
    fail = false;
    expect(await tracker.preflight("openrouter")).toBe(false);
    const at = tracker.status("openrouter")?.reportedAt;
    now += 120_001;
    fail = true;
    expect(await tracker.preflight("openrouter")).toBe(false);
    fail = false;
    payload = { data: { ...reading(1).data, usage_monthly: "1" } };
    expect(await tracker.refreshOpenRouter()).toBe(false);
    expect(tracker.status("openrouter")?.reportedAt).toBe(at);
    expect(tracker.status("openrouter")?.limitRemaining).toBe(0);
    payload = reading(11, 10);
    expect(await tracker.preflight("openrouter")).toBe(true);
  });

  test("polls enabled keys at startup and ten minute ticks; coalesces preflight", async () => {
    const disabled = make("");
    disabled.start();
    expect(calls).toBe(0);
    const tracker = make();
    tracker.start();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(intervalMs).toBe(10 * 60_000);
    now += 119_000;
    expect(await tracker.preflight("openrouter")).toBe(true);
    expect(calls).toBe(1);
    now += 2_000;
    await Promise.all([tracker.preflight("openrouter"), tracker.preflight("openrouter")]);
    expect(calls).toBe(2);
    now += 10 * 60_000;
    tick?.();
    await Bun.sleep(0);
    expect(calls).toBe(3);
    tracker.stop();
    expect(tick).toBeNull();
  });

  test("override stops key polling and re-enable resumes it", async () => {
    store.setProviderEnabledOverride("openrouter", false);
    const tracker = make();
    tracker.start();
    expect(calls).toBe(0);
    expect(tick).toBeNull();
    tracker.setEnabled("openrouter", true);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    tracker.setEnabled("openrouter", false);
    expect(tick).toBeNull();
    expect(await tracker.refreshOpenRouter()).toBe(false);
    expect(calls).toBe(1);
    tracker.stop();
  });

  test("persists reading across restart and failed refresh", async () => {
    let tracker = make();
    payload = reading(55, 0);
    await tracker.refreshOpenRouter();
    store.close();
    store = new Store(join(dir, "db.sqlite"));
    tracker = make();
    fail = true;
    now += 120_001;
    expect(await tracker.preflight("openrouter")).toBe(false);
    expect(tracker.status("openrouter")?.reportedUsageUsd).toBe(55);
    expect(tracker.headroom("openrouter")).toBeLessThanOrEqual(0);
  });

  test("warns only for material drift and ignores monthly reset", async () => {
    const tracker = make();
    await tracker.refreshOpenRouter();
    now += 1_000;
    payload = reading(0.04);
    await tracker.refreshOpenRouter();
    expect(store.listEvents("provider:openrouter")).toHaveLength(0);
    now += 1_000;
    payload = reading(0);
    await tracker.refreshOpenRouter();
    now += 1_000;
    store.recordChatCall("chat", "openrouter", "openrouter/ds", now, result(1));
    now += 1_000;
    payload = reading(1.05);
    await tracker.refreshOpenRouter();
    expect(store.listEvents("provider:openrouter")).toHaveLength(0);
    now += 1_000;
    store.recordChatCall("chat", "openrouter", "openrouter/ds", now, result(1));
    now += 1_000;
    payload = reading(2.35);
    await tracker.refreshOpenRouter();
    const events = store.listEvents("provider:openrouter");
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
    expect(events[0]?.data).toMatchObject({ localUsd: 1, reportedUsd: 1.3 });
    expect(JSON.stringify(events)).not.toContain("private-label");
    now += 1_000;
    payload = reading(0.01);
    await tracker.refreshOpenRouter();
    expect(store.listEvents("provider:openrouter")).toHaveLength(1);
  });
});

test("effort pairs preserve order, aliases, preference and underlying eligibility", () => {
  const { tracker } = setup();
  const catalog = models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"], effort: "low" }));
  const routing = new Router(
    tracker,
    {
      ...policy,
      implement: { default: ["claude/sonnet@high", "claude/sonnet|claude/sonnet@low", "codex/sol@high"] },
    },
    catalog,
  );
  const route = (constraints = {}) => routing.route("implement", "small", constraints).candidates;
  expect(route().map((t) => t.targetId)).toEqual([
    "claude/sonnet@high",
    "claude/sonnet@low",
    "codex/sol@high",
  ]);
  expect(route({ exclude: ["claude/sonnet@high"] })[0]?.effort).toBe("low");
  expect(route({ exclude: ["claude/sonnet"] }).map((t) => t.targetId)).not.toContain("claude/sonnet@low");
  expect(route({ prefer: "claude/sonnet@low" })[0]?.targetId).toBe("claude/sonnet@low");
  expect(route({ avoidVendor: "anthropic" })[0]?.provider).toBe("codex");
  expect(route({ excludeModels: ["claude/sonnet"] }).map((t) => t.modelId)).toEqual(["codex/sol"]);
  expect(route({ minTier: 5 }).map((t) => t.targetId)).toEqual(["claude/opus@low"]);
  expect(catalog.find((m) => m.id === "claude/sonnet")?.effort).toBe("low");
  route();
  expect(routing.describeFallback("claude", true)).toContain("codex/sol@high");
  tracker.setHealthy("claude", false);
  expect(route().map((t) => t.targetId)).toEqual(["codex/sol@high"]);
  tracker.setHealthy("claude", true);
  tracker.blockModel("claude/sonnet", "blocked");
  expect(route().map((t) => t.modelId)).toEqual(["codex/sol"]);
  tracker.setHealthy("codex", false);
  expect(route()).toEqual([]);
});

test("saved selections preserve unset effort across catalog changes and exclusions", () => {
  const { tracker } = setup();
  const catalog = models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"], effort: "low" }));
  const routing = new Router(tracker, policy, catalog);
  const saved = { modelId: "claude/sonnet", effort: null };
  const decision = routing.route("implement", "small", { prefer: saved });
  expect(decision.candidates[0]?.targetId).toBe("claude/sonnet");
  expect(decision.candidates[0]?.effort).toBeUndefined();
  expect(decision.candidates.some((t) => t.targetId === "claude/sonnet@low")).toBe(true);
  expect(
    routing
      .route("implement", "small", { prefer: saved, exclude: [saved] })
      .candidates.map((t) => t.targetId),
  ).not.toContain("claude/sonnet");
  expect(routing.route("implement", "small", { prefer: "claude/sonnet@high" }).candidates[0]?.effort).toBe(
    "high",
  );
  tracker.setHealthy("claude", false);
  expect(
    routing.route("implement", "small", { prefer: saved }).candidates.every((t) => t.provider !== "claude"),
  ).toBe(true);
});

test("router skips effort targets whose harness cannot carry effort for the role", () => {
  const { tracker } = setup();
  const catalog = models.map((m): ModelDef => ({ ...m, supportedEfforts: ["low", "high"] }));
  const reference = "openrouter/ds@low";
  const routing = new Router(
    tracker,
    { ...policy, review: { default: [reference, "codex/sol"] }, triage: { default: [reference] } },
    catalog,
  );
  const review = routing.route("review", "medium");
  expect(review.candidates.map((t) => t.targetId)).toEqual(["codex/sol"]);
  expect(review.skipped.find((s) => s.modelId === reference)?.reason).toContain("cannot carry effort");
  expect(() => routing.resolveFor("review", reference)).toThrow("cannot carry effort");
  expect(routing.resolveFor("review", "openrouter/ds").targetId).toBe("openrouter/ds");
  // Without an HTTP endpoint even tool-less roles run through the Claude CLI.
  expect(routing.route("triage", "medium").candidates).toEqual([]);
});

test("oMLX catalog targets and authenticated health gate routing", async () => {
  let calls = 0,
    status = 200;
  const probe = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("http://127.0.0.1:8989/v1/models");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    if (!status) throw new Error("offline");
    return new Response("", { status });
  }) as typeof fetch;
  const defs = PROVIDERS.filter((p) => ["omlx", "claude", "codex"].includes(p.id));
  const trackerFor = (secrets: Record<string, string>) =>
    new ProviderTracker(defs, store, reserves, secrets, {}, Date.now, probe, undefined, probe);
  const tracker = trackerFor({ OMLX_API_KEY: "key" });
  const router = new Router(tracker);
  for (const effort of [undefined, "none", "high"] as const) {
    const resolved = router.resolve(`omlx/qwen-27b${effort ? `@${effort}` : ""}`);
    expect(resolved.model).toMatchObject({
      model: "Swift-1.5-Qwen3.8-27b-oQ8e-mtp",
      vendor: "qwen",
      origin: "CN",
      baseOrigin: "CN",
      tier: 2,
      supportedEfforts: ["none", "high"],
      price: { input: 0, output: 0 },
    });
    expect(router.toTarget(resolved.model, resolved.effort)).toMatchObject({
      provider: "omlx",
      harness: "claude",
      effortMapping: "qwen",
      backend: { baseUrl: "http://127.0.0.1:8989", authToken: "key" },
      openai: { baseUrl: "http://127.0.0.1:8989/v1", authToken: "key" },
    });
    expect(resolved.effort).toBe(effort);
  }
  expect(router.resolve("mtplx/qwen-27b").model.provider).toBe("mtplx");
  expect(() => router.resolve("omlx/qwen-27b@low")).toThrow("Unsupported effort");
  for (status of [200, 401, 503, 0]) {
    await tracker.probe();
    expect(tracker.isAvailable("omlx")).toBe(status === 200);
    expect(router.route("triage", "small").candidates[0]?.provider === "omlx").toBe(status === 200);
  }
  expect(calls).toBe(4);
  const missing = trackerFor({});
  await missing.probe();
  expect(missing.unavailableReason("omlx")).toBe("missing OMLX_API_KEY");
  store.setProviderEnabledOverride("omlx", false);
  const disabled = trackerFor({ OMLX_API_KEY: "key" });
  await disabled.probe();
  expect(disabled.unavailableReason("omlx")).toBe("disabled");
  expect(calls).toBe(4);
});

test("preferVendor, preferNotVendor, free_only and independence-first order review candidates", () => {
  const local: ProviderDef = {
    id: "local",
    label: "Local",
    harness: "fake",
    billing: "free",
    maxConcurrent: 1,
  };
  const [sonnet] = models;
  if (!sonnet) throw new Error("fixture");
  const tracker = new ProviderTracker([...providers, local], store, reserves, { OPENROUTER_API_KEY: "k" });
  const review = { review: { default: ["codex/sol|claude/sonnet", "openrouter/ds"] } } as unknown as Policy;
  const all = [...models, { ...sonnet, id: "local/q", provider: "local", vendor: "qwen" as const }];
  const router = new Router(tracker, review, all);
  const ids = (c: Parameters<Router["route"]>[2]) =>
    router.route("review", "small", c).candidates.map((t) => t.modelId);
  expect(ids({ preferVendor: "anthropic" })).toEqual(["claude/sonnet", "codex/sol", "openrouter/ds"]);
  expect(ids({ preferVendor: "openai" })).toEqual(["codex/sol", "claude/sonnet", "openrouter/ds"]);
  // Other vendors, then the implementer's (preferNotVendor), then avoided ones, then last-resort models.
  expect(ids({ avoidVendor: ["openai"], preferNotVendor: ["deepseek"] })).toEqual([
    "claude/sonnet",
    "openrouter/ds",
    "codex/sol",
  ]);
  expect(ids({ preferNotModels: ["claude/sonnet"], avoidVendor: ["openai"] })).toEqual([
    "openrouter/ds",
    "codex/sol",
    "claude/sonnet",
  ]);
  // free_only never offers a paid model, even a pinned one, and offers nothing when local is down.
  expect(ids({ billing: "free_only", prefer: "codex/sol" })).toEqual(["local/q"]);
  // Free-first ranks billing above independence unless independence comes first.
  expect(ids({ billing: "free_first", avoidVendor: ["qwen"] })[0]).toBe("local/q");
  expect(ids({ billing: "free_first", avoidVendor: ["qwen"], independenceFirst: true }).at(-1)).toBe(
    "local/q",
  );
  expect(ids({ billing: "free_first", independenceFirst: true })[0]).toBe("local/q");
  tracker.setHealthy("local", false);
  expect(ids({ billing: "free_only" })).toEqual([]);
});

test("with the default policy, a verifier never reuses a raising model and prefers another vendor", async () => {
  const { verifierConstraints } = await import("../src/pipeline/engine.ts");
  const tracker = new ProviderTracker(PROVIDERS, store, reserves, {});
  const router = new Router(tracker, DEFAULT_POLICY, MODELS);
  const verifier = (
    vendors: string[],
    raisedBy: string[],
    implementer = { vendor: "anthropic", modelId: "claude/opus" },
  ) =>
    router.route("review", "small", verifierConstraints(vendors, raisedBy, implementer)).candidates[0]
      ?.modelId;
  // Raised by an OpenAI finder only: the implementer's vendor, but not its model.
  expect(verifier(["openai"], ["codex/sol"])).toBe("claude/sonnet");
  // Raised by both vendors (adversarial and careful): no clean vendor, so another model, never a raiser.
  tracker.observeWindows("codex", { seven_day: { utilization: 0.8, resetsAt: Date.now() + 86_400_000 } });
  const both = verifier(["anthropic", "openai"], ["codex/sol", "claude/sonnet"]);
  expect(both).toBeDefined();
  expect(["codex/sol", "claude/sonnet", "claude/opus"]).not.toContain(both);
  // Deep profile: adversarial on codex/astra, careful on the implementer's claude/opus. Both vendors
  // raised it, so the one that did not implement verifies, even with more Claude headroom.
  const deep = router.route(
    "review",
    "large",
    verifierConstraints(["anthropic", "openai"], ["codex/astra", "claude/opus"], {
      vendor: "anthropic",
      modelId: "claude/opus",
    }),
  );
  expect(deep.candidates[0]?.vendor).toBe("openai");
  expect(deep.skipped).toContainEqual({
    modelId: "claude/opus",
    reason: "raised a candidate it would verify",
  });
});
