import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { QuotaAlert, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";

const providers: ProviderDef[] = [
  { id: "claude", label: "Claude", harness: "claude", billing: "subscription", maxConcurrent: 1 },
  { id: "codex", label: "Codex", harness: "codex", billing: "subscription", maxConcurrent: 1 },
];
const models: ModelDef[] = [
  {
    id: "claude/model",
    provider: "claude",
    model: "test",
    vendor: "anthropic",
    origin: "unknown",
    baseOrigin: "unknown",
    tier: 4,
    price: { input: 0, output: 0 },
  },
  {
    id: "codex/model",
    provider: "codex",
    model: "test",
    vendor: "openai",
    origin: "unknown",
    baseOrigin: "unknown",
    tier: 4,
    price: { input: 0, output: 0 },
  },
];
const policy = { implement: { default: ["claude/model|codex/model"] } } as Policy;
let dir: string;
let store: Store;
let factory: Factory;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hidden-quota-"));
  now = 1_800_000_000_000;
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "config") });
  store = new Store(cfg.paths.db);
  factory = new Factory(cfg, { store, providers, models, policy, clock: () => now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const alerts = (): QuotaAlert[] => store.listAlerts(now);

function recordChanges(): { created: () => StreamMessage[]; stop: () => void } {
  const changes: StreamMessage[] = [];
  const stop = store.subscribe((message) => changes.push(message));
  return {
    created: () => changes.filter((message) => message.kind === "alert" && message.created),
    stop,
  };
}

test("a quota rejection is attributed to the window that reached its reserve", () => {
  const changes = recordChanges();
  const fiveReset = now + 100_000;
  const sevenReset = now + 700_000;
  // Default reserves: claude five_hour 0.8, seven_day 0.85.
  factory.tracker.observeWindows("claude", {
    five_hour: { utilization: 0.4, resetsAt: fiveReset },
    seven_day: { utilization: 0.85, resetsAt: sevenReset },
  });
  factory.tracker.record("claude", "quota", { exhaustedUntil: now + 20_000 });
  expect(alerts()).toMatchObject([
    { provider: "claude", window: "seven_day", severity: "exhausted", resetsAt: sevenReset },
  ]);
  expect(changes.created()).toHaveLength(1);

  // After the (unexhausted) five-hour window resets, another rejection is the same seven-day alert.
  now = fiveReset + 1;
  factory.tracker.record("claude", "quota", { exhaustedUntil: now + 20_000 });
  expect(alerts()).toMatchObject([{ window: "seven_day", resetsAt: sevenReset }]);
  expect(alerts()).toHaveLength(1);
  expect(changes.created()).toHaveLength(1);
  changes.stop();
});

test("a five-hour window at its reserve is still named when it resets first", () => {
  const fiveReset = now + 100_000;
  factory.tracker.observeWindows("claude", {
    five_hour: { utilization: 0.9, resetsAt: fiveReset },
    seven_day: { utilization: 0.3, resetsAt: now + 700_000 },
  });
  factory.tracker.record("claude", "quota", { exhaustedUntil: now + 20_000 });
  expect(alerts()).toMatchObject([{ provider: "claude", window: "five_hour", resetsAt: fiveReset }]);
});

test("when no known window is at its reserve, the rejection is a deduplicated hard limit", () => {
  const changes = recordChanges();
  const exhaustedUntil = now + 300_000;
  factory.tracker.observeWindows("claude", {
    five_hour: { utilization: 0.4, resetsAt: now + 100_000 },
    seven_day: { utilization: 0.5, resetsAt: now + 700_000 },
  });
  factory.tracker.record("claude", "quota", { exhaustedUntil });
  const createdAt = alerts()[0]?.createdAt;
  for (let i = 0; i < 3; i++) {
    now += 10;
    factory.tracker.record("claude", "quota", { exhaustedUntil: now + 300_000 });
  }
  expect(alerts()).toMatchObject([
    { provider: "claude", window: "hard_limit", severity: "exhausted", resetsAt: exhaustedUntil, createdAt },
  ]);
  expect(alerts()).toHaveLength(1);
  expect(changes.created()).toHaveLength(1);
  changes.stop();
});

test("a rejection with no known windows still uses a hard limit", () => {
  const exhaustedUntil = now + 300_000;
  factory.tracker.record("codex", "quota", { exhaustedUntil });
  expect(alerts()).toMatchObject([{ provider: "codex", window: "hard_limit", resetsAt: exhaustedUntil }]);
});
