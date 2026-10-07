import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS, REMOVED_MODELS } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { RuntimePolicy } from "../src/router/runtime-policy.ts";
import { customProvider } from "./provider-config-support.ts";

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

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected validation failure");
}

test.each([
  [
    ["codex/astra"],
    `routing.prefer: "codex/astra" is a retired model ID: ${REMOVED_MODELS.get("codex/astra")}`,
  ],
  [
    ["claude/fable"],
    `routing.prefer: "claude/fable" is a retired model ID: ${REMOVED_MODELS.get("claude/fable")}`,
  ],
  [
    ["claude/opus"],
    'routing.prefer: "claude/opus" is a model ID, not a provider; prefer takes provider IDs (use "claude")',
  ],
  [
    ["codex/sol"],
    'routing.prefer: "codex/sol" is a model ID, not a provider; prefer takes provider IDs (use "codex")',
  ],
  [
    ["mac-mlx/flash"],
    'routing.prefer: "mac-mlx/flash" is a model ID, not a provider; prefer takes provider IDs (use "mac-mlx")',
  ],
  [["nonexistent"], 'routing.prefer: "nonexistent" is not a known provider ID'],
  [["unknown"], 'routing.prefer: "unknown" is not a known provider ID'],
  ["codex", "routing.prefer must be an array of provider IDs"],
  [[42], "routing.prefer[0] must be a provider ID string"],
  [["codex", 3], "routing.prefer[1] must be a provider ID string"],
  [["codex"], null],
  [["mac-mlx", "codex"], null],
  [["codex", "mac-mlx", "codex"], null],
  [[], null],
] as const)("config and runtime validate prefer %j identically", (prefer, expectedError) => {
  const config = (value: unknown) =>
    loadConfig({
      home: dir,
      configDir: dir,
      raw: { providers: [customProvider], routing: { prefer: value } },
    });
  const cfg = config(["claude"]);
  const catalog = cfg.catalog;
  if (!catalog) throw new Error("missing catalog");
  const tracker = new ProviderTracker(catalog.providers, store, cfg.reserves, {});
  const router = new Router(tracker, DEFAULT_POLICY, catalog.models);
  const runtime = new RuntimePolicy(store, router, catalog.models, catalog.providers, cfg.preferProviders);
  if (expectedError === null) {
    expect(config(prefer).preferProviders).toEqual<unknown>(prefer);
    expect(runtime.setPrefer(prefer).prefer).toEqual<unknown>(prefer);
    expect(store.routingPrefer()).toEqual<unknown>(prefer);
  } else {
    runtime.setPrefer(["codex"]);
    const before = runtime.snapshot();
    const route = router.route("implement", "small");
    const configError = errorMessage(() => config(prefer));
    expect(configError).toBe(expectedError);
    expect(errorMessage(() => runtime.setPrefer(prefer))).toBe(configError);
    expect(runtime.snapshot()).toEqual(before);
    expect(store.routingPrefer()).toEqual(["codex"]);
    expect(router.route("implement", "small")).toEqual(route);
  }
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
  expect(setup).toThrow(
    'routing.prefer: "codex/sol" is a model ID, not a provider; prefer takes provider IDs (use "codex")',
  );
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

test("saved implementer revisions survive restart and only later cell edits dislodge escalation", () => {
  const cfg = loadConfig({ home: dir, configDir: dir });
  const reopen = () => new Factory(cfg, { store });
  let factory = reopen();
  factory.routing.setCell("implement", "small", ["codex/sol"]);
  const constraints = {
    prefer: "claude/opus",
    preferPolicyRevision: factory.router.cellRevision("implement", "small"),
  };
  const selected = () => factory.router.route("implement", "small", constraints).candidates[0]?.modelId;
  expect(selected()).toBe("claude/opus");
  store.close();
  store = new Store(join(dir, "db.sqlite"));
  factory = reopen();
  expect(selected()).toBe("claude/opus");
  factory.routing.setCell("triage", "default", ["codex/luna"]);
  factory.routing.setPrefer(["codex"]);
  expect(selected()).toBe("claude/opus");
  factory.routing.setCell("implement", "small", ["codex/sol"], "note only");
  expect(selected()).toBe("claude/opus");
  store.close();
  store = new Store(join(dir, "db.sqlite"));
  factory = reopen();
  expect(selected()).toBe("claude/opus");
  factory.routing.setCell("implement", "small", ["codex/luna"]);
  factory.routing.setCell("implement", "small", ["codex/sol"]);
  expect(selected()).toBe("codex/sol");
});

test("an eval update beneath an unchanged override preserves the saved implementer after reopen", () => {
  const overlay = join(dir, "evals.json");
  writeFileSync(overlay, JSON.stringify({ implement: { small: ["codex/sol"] } }));
  const cfg = loadConfig({ home: dir, configDir: dir });
  const reopen = () => new Factory(cfg, { store, policyPath: overlay });
  let factory = reopen();
  // Installing an override equal to the eval cell must have a stable revision too.
  factory.routing.setCell("implement", "small", ["codex/sol"]);
  const constraints = {
    prefer: "claude/opus",
    preferPolicyRevision: factory.router.cellRevision("implement", "small"),
  };
  const selected = () => factory.router.route("implement", "small", constraints).candidates[0]?.modelId;
  expect(selected()).toBe("claude/opus");
  factory.routing.setCell("implement", "small", ["codex/sol"], "note only");
  store.close();
  writeFileSync(overlay, JSON.stringify({ implement: { small: ["codex/luna"] } }));
  store = new Store(join(dir, "db.sqlite"));
  factory = reopen();
  expect(factory.policy.implement.small).toEqual(["codex/sol"]);
  expect(factory.router.cellRevision("implement", "small")).toBe(constraints.preferPolicyRevision);
  expect(selected()).toBe("claude/opus");
  factory.routing.setCell("implement", "small", null);
  expect(factory.policy.implement.small).toEqual(["codex/luna"]);
  expect(selected()).toBe("codex/luna");
});
