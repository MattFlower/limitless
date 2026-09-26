import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationCommandDataResolvable } from "discord.js";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { QuotaAlert, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { DiscordCommand, DiscordMessage, DiscordPort } from "../src/integrations/discord.ts";
import { mountDiscord } from "../src/integrations/discord.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { createHttpRoutes } from "../src/server/http.ts";

class FakeDiscord implements DiscordPort {
  posts: { channel: string; content: string }[] = [];
  fail = false;
  async start(
    _command: (command: DiscordCommand) => Promise<void>,
    _message: (message: DiscordMessage) => Promise<void>,
  ): Promise<void> {}
  async register(_guild: string, _definitions: readonly ApplicationCommandDataResolvable[]): Promise<void> {}
  async createThread(): Promise<string> {
    return "thread";
  }
  async sendMessage(channel: string, content: string): Promise<void> {
    if (this.fail) throw new Error("send failed");
    this.posts.push({ channel, content });
  }
  async stop(): Promise<void> {}
}

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
    tier: 4,
    price: { input: 0, output: 0 },
  },
  {
    id: "codex/model",
    provider: "codex",
    model: "test",
    vendor: "openai",
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
  dir = mkdtempSync(join(tmpdir(), "limitless-quota-alerts-"));
  now = 1_800_000_000_000;
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "config") });
  cfg.secrets.DISCORD_BOT_TOKEN = "token";
  cfg.secrets.DISCORD_APP_ID = "app";
  cfg.secrets.DISCORD_GUILD_ID = "guild";
  cfg.discordOwnerId = "owner";
  cfg.discordChannelId = "alerts";
  store = new Store(cfg.paths.db);
  factory = new Factory(cfg, { store, providers, models, policy, clock: () => now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const alerts = (): QuotaAlert[] => store.listAlerts(now);

test("threshold, exhaustion, and reset produce one alert per window with live updates", () => {
  const changes: StreamMessage[] = [];
  const unsubscribe = store.subscribe((msg) => changes.push(msg));
  const reset = now + 100_000;
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.59, resetsAt: reset } });
  expect(alerts()).toEqual([]);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.6, resetsAt: reset } });
  expect(alerts()).toMatchObject([
    { provider: "claude", window: "five_hour", utilization: 0.6, severity: "warning", resetsAt: reset },
  ]);
  expect(alerts()[0]?.routing).toContain("codex");
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.8, resetsAt: reset } });
  expect(alerts()[0]?.severity).toBe("exhausted");
  expect(alerts()[0]?.routing).toContain("Router skips claude");
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.61, resetsAt: reset } });
  expect(alerts()[0]?.severity).toBe("exhausted");
  expect(changes.filter((m) => m.kind === "alert" && m.created)).toHaveLength(1);
  now = reset + 1;
  expect(alerts()).toEqual([]);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.1, resetsAt: now + 100_000 } });
  expect(alerts()).toEqual([]);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.7, resetsAt: now + 100_000 } });
  expect(alerts()).toHaveLength(1);
  expect(changes.filter((m) => m.kind === "alert" && m.created)).toHaveLength(2);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.8, resetsAt: reset } });
  expect(alerts()).toMatchObject([{ severity: "warning", resetsAt: now + 100_000 }]);
  unsubscribe();
});

test("quota rejection alerts, but health failures and metered budgets do not", () => {
  factory.tracker.record("claude", "unavailable");
  factory.tracker.record("claude", "unavailable");
  factory.tracker.record("claude", "unavailable");
  expect(alerts()).toEqual([]);
  factory.tracker.record("claude", "quota");
  expect(alerts()).toMatchObject([{ window: "hard_limit", severity: "exhausted", resetsAt: null }]);
  expect(alerts()[0]?.routing).toContain("codex");
  factory.tracker.record("codex", "quota");
  expect(alerts().find((a) => a.provider === "codex")?.routing).toContain("No eligible fallback");
});

test("Discord sends once across flapping and restart; failure leaves alert visible", async () => {
  const port = new FakeDiscord();
  let mounted = mountDiscord(factory, port);
  const reset = now + 100_000;
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.6, resetsAt: reset } });
  factory.tracker.record("claude", "quota", { exhaustedUntil: reset });
  factory.tracker.record("claude", "ok");
  factory.tracker.record("claude", "quota", { exhaustedUntil: reset });
  await mounted.stop();
  expect(port.posts).toHaveLength(1);
  expect(port.posts[0]?.channel).toBe("alerts");
  factory = new Factory(factory.cfg, { store, providers, models, policy, clock: () => now });
  mounted = mountDiscord(factory, port);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.8, resetsAt: reset } });
  await mounted.stop();
  expect(port.posts).toHaveLength(1);
  now = reset + 1;
  mounted = mountDiscord(factory, port);
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.7, resetsAt: now + 100_000 } });
  await mounted.stop();
  expect(port.posts).toHaveLength(2);
  port.fail = true;
  mounted = mountDiscord(factory, port);
  factory.tracker.observeWindows("codex", { five_hour: { utilization: 0.7, resetsAt: now + 100_000 } });
  await mounted.stop();
  expect(
    alerts()
      .map((a) => a.provider)
      .sort(),
  ).toEqual(["claude", "codex"]);
  expect(port.posts).toHaveLength(2);
});

test("disabled Discord and unavailable alternatives leave alerts in the API", async () => {
  factory.cfg.secrets.DISCORD_BOT_TOKEN = "";
  const port = new FakeDiscord();
  expect(mountDiscord(factory, port).note).toContain("disabled");
  factory.tracker.record("codex", "quota");
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.7, resetsAt: now + 100_000 } });
  expect(alerts().find((a) => a.provider === "claude")?.routing).toContain("No eligible fallback");
  expect(port.posts).toEqual([]);
  const route = createHttpRoutes(factory)["/api/alerts"] as (
    req: Request,
    server: never,
  ) => Promise<Response>;
  const response = await route(new Request("http://localhost/api/alerts"), undefined as never);
  expect((await response.json()) as QuotaAlert[]).toHaveLength(2);
});

test("alerts API returns current alerts and store publishes dashboard changes", async () => {
  const route = createHttpRoutes(factory)["/api/alerts"] as (
    req: Request,
    server: never,
  ) => Promise<Response>;
  const read = async () =>
    (await (
      await route(new Request("http://localhost/api/alerts"), undefined as never)
    ).json()) as QuotaAlert[];
  const changes: StreamMessage[] = [];
  const unsubscribe = store.subscribe((msg) => changes.push(msg));
  const reset = now + 100_000;
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.7, resetsAt: reset } });
  expect(await read()).toHaveLength(1);
  expect(changes.some((m) => m.kind === "alert" && m.alert?.severity === "warning")).toBe(true);
  now = reset + 1;
  factory.tracker.observeWindows("claude", { five_hour: { utilization: 0.1, resetsAt: now + 100_000 } });
  expect(await read()).toEqual([]);
  expect(changes.some((m) => m.kind === "alert" && m.alert === null)).toBe(true);
  unsubscribe();
});
