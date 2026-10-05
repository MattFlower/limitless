import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { RuntimePolicy } from "../src/router/runtime-policy.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-runtime-policy-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const tracker = new ProviderTracker(PROVIDERS, store, loadConfig().reserves, {});
  const router = new Router(tracker);
  const runtime = new RuntimePolicy(store, router, MODELS, PROVIDERS, ["claude"], DEFAULT_POLICY, {
    triage: { default: ["claude/opus", "codex/sol"] },
  });
  return { router, runtime };
}

test("cells change the same Router, reveal eval/code on reset, and audit every edit", () => {
  const { router, runtime } = setup();
  const messages: unknown[] = [];
  store.subscribe((msg) => messages.push(msg));
  expect(router.route("triage", "small").candidates[0]?.modelId).toBe("claude/opus");
  runtime.setCell("triage", "default", ["codex/luna@low"], "depleted", "operator-a");
  expect(router.route("triage", "small").candidates[0]?.targetId).toBe("codex/luna@low");
  expect(runtime.snapshot().effective.triage?.default).toEqual({
    groups: ["codex/luna@low"],
    layer: "operator",
    evals: ["claude/opus", "codex/sol"],
  });
  expect(store.routingCells()).toMatchObject([
    { note: "depleted", updatedBy: "operator-a", updatedAt: expect.any(Number) },
  ]);
  runtime.setCell("triage", "default", ["codex/sol"]);
  runtime.setCell("triage", "default", null);
  expect(router.route("triage", "small").candidates[0]?.modelId).toBe("claude/opus");
  expect(runtime.snapshot().effective.triage?.default?.layer).toBe("evals");
  runtime.setCell("chat", "default", ["codex/sol"]);
  runtime.setCell("chat", "default", null);
  expect(router.getPolicy().chat.default).toEqual(DEFAULT_POLICY.chat.default);
  expect(runtime.snapshot().effective.chat?.default?.layer).toBe("code");
  expect(store.routingHistory().map((c) => [c.key, c.oldValue, c.newValue])).toEqual([
    ["chat.default", ["codex/sol"], null],
    ["chat.default", null, ["codex/sol"]],
    ["triage.default", ["codex/sol"], null],
    ["triage.default", ["codex/luna@low"], ["codex/sol"]],
    ["triage.default", null, ["codex/luna@low"]],
  ]);
  expect(store.routingHistory().at(-1)).toMatchObject({ note: "depleted", by: "operator-a" });
  expect(messages).toHaveLength(5);
  expect(messages.every((m) => (m as { kind: string }).kind === "routing")).toBe(true);
});

test.each([
  ["no-role", "small", ["codex/sol"], "unknown role"],
  ["implement", "no-cell", ["codex/sol"], "unknown cell"],
  ["implement", "small", [], "Too small"],
  ["implement", "small", ["missing"], "unknown model ID"],
  ["implement", "small", ["claude/fable"], "owner decision"],
  ["implement", "small", ["omlx/qwen-flash@high"], "cannot carry effort"],
  ["implement", "small", ["typesafe/jev-1.13"], "no decisions mapping"],
  ["implement", "small", ["claude/opus@xhigh"], "Unsupported effort"],
  ["implement", "small", ["codex/sol|"], "empty model ID"],
] as const)("rejects %s.%s %j without mutation", (role, cell, groups, reason) => {
  const { runtime, router } = setup();
  const before = runtime.snapshot();
  const policy = router.getPolicy();
  expect(() => runtime.setCell(role, cell, groups)).toThrow(`${role}.${cell}`);
  expect(() => runtime.setCell(role, cell, groups)).toThrow(reason);
  expect(runtime.snapshot()).toEqual(before);
  expect(router.getPolicy()).toEqual(policy);
  expect(store.routingCells()).toEqual([]);
});

test.each(["unknown", "codex/sol", "claude/fable", 42])("rejects provider preference %s atomically", (id) => {
  const { runtime } = setup();
  const before = runtime.snapshot();
  expect(() => runtime.setPrefer([id])).toThrow("prefer:");
  if (id === "claude/fable") expect(() => runtime.setPrefer([id])).toThrow("owner decision");
  expect(runtime.snapshot()).toEqual(before);
});

test("history insertion failure rolls back the current cell and leaves routing unchanged", () => {
  const { runtime, router } = setup();
  const before = router.getPolicy();
  store.db.exec(
    "CREATE TRIGGER reject_history BEFORE INSERT ON routing_history BEGIN SELECT RAISE(ABORT, 'history failure'); END",
  );
  expect(() => runtime.setCell("triage", "default", ["codex/sol"])).toThrow("history failure");
  expect(store.routingCells()).toEqual([]);
  expect(store.routingHistory()).toEqual([]);
  expect(router.getPolicy()).toEqual(before);
});

test("startup validates persisted operator cells and preferences against today's catalog", () => {
  store.writeRouting("triage.default", ["claude/fable"], null, "previous release");
  expect(setup).toThrow("triage.default");
  expect(setup).toThrow("owner decision");
  store.writeRouting("triage.default", null, null, "tester");
  store.writeRouting("prefer", ["codex/sol"], null, "previous release");
  expect(setup).toThrow("prefer: unknown provider codex/sol");
  expect(store.routingHistory()).toHaveLength(3);
});

test("Factory startup restores cells and preferences; clearing preference restores config after reopen", () => {
  const overlay = join(dir, "evals.json");
  writeFileSync(overlay, JSON.stringify({ triage: { default: ["claude/opus"] } }));
  const cfg = loadConfig({ home: dir, configDir: dir });
  cfg.preferProviders = ["claude"];
  const reopen = () => new Factory(cfg, { store, policyPath: overlay });
  let factory = reopen();
  factory.routing.setCell("triage", "default", ["codex/luna"]);
  factory.routing.setPrefer(["codex"], "spread load");
  expect(factory.router.route("implement", "small").candidates[0]?.provider).toBe("codex");
  store.close();
  store = new Store(join(dir, "db.sqlite"));
  factory = reopen();
  expect(factory.router.route("triage", "small").candidates[0]?.modelId).toBe("codex/luna");
  expect(factory.policy.triage.default).toEqual(["codex/luna"]);
  expect(factory.router.route("implement", "small").candidates[0]?.provider).toBe("codex");
  factory.routing.setPrefer([]);
  expect(factory.routing.snapshot().prefer).toEqual([]);
  factory.routing.setPrefer(null);
  expect(factory.router.route("implement", "small").candidates[0]?.provider).toBe("claude");
  store.close();
  store = new Store(join(dir, "db.sqlite"));
  factory = reopen();
  expect(factory.routing.snapshot().prefer).toEqual(["claude"]);
  expect(factory.router.route("implement", "small").candidates[0]?.provider).toBe("claude");
  expect(store.routingHistory().map((c) => [c.key, c.oldValue, c.newValue])).toEqual([
    ["prefer", [], null],
    ["prefer", ["codex"], []],
    ["prefer", null, ["codex"]],
    ["triage.default", null, ["codex/luna"]],
  ]);
});
