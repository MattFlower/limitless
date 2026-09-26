import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { MODELS, type ModelDef, type Policy, PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
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
    tier: 4,
    price: { input: 2, output: 10 },
  },
  {
    id: "claude/opus",
    provider: "claude",
    model: "claude-opus-5-5",
    vendor: "anthropic",
    tier: 5,
    price: { input: 4, output: 20 },
  },
  {
    id: "codex/sol",
    provider: "codex",
    model: "gpt-6-sol",
    vendor: "openai",
    tier: 4,
    price: { input: 2, output: 10 },
  },
  {
    id: "openrouter/ds",
    provider: "openrouter",
    model: "deepseek/x",
    vendor: "deepseek",
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

describe("Router", () => {
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
