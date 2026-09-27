import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext } from "../src/pipeline/context.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { requestWithParams } from "./mcp-support.ts";

const providers: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    harness: "fake",
    billing: "metered",
    maxConcurrent: 2,
    apiKeySecret: "OPENROUTER_API_KEY",
  },
  { id: "fallback", label: "Fallback", harness: "fake", billing: "subscription", maxConcurrent: 2 },
];
const models: ModelDef[] = [
  {
    id: "openrouter/test",
    provider: "openrouter",
    model: "test",
    vendor: "other",
    tier: 3,
    price: { input: 1, output: 1 },
  },
  {
    id: "fallback/test",
    provider: "fallback",
    model: "test",
    vendor: "other",
    tier: 3,
    price: { input: 1, output: 1 },
  },
];
const policy = {
  implement: { default: ["openrouter/test", "fallback/test"] },
  chat: { default: ["openrouter/test", "fallback/test"] },
} as Policy;
let home: string;
let factory: Factory;
let now: number;
let monthly: number;
let called: string[];
let requests: number;

function setup() {
  home = mkdtempSync(join(tmpdir(), "limitless-openrouter-"));
  const cfg = loadConfig({ home, configDir: join(home, "config") });
  cfg.secrets = { OPENROUTER_API_KEY: "sentinel-key" };
  now = 1_000_000;
  monthly = 51;
  called = [];
  requests = 0;
  factory = new Factory(cfg, {
    providers,
    models,
    policy,
    clock: () => now,
    fetch: (async () => {
      requests++;
      return Response.json({
        data: {
          usage: monthly,
          usage_daily: monthly,
          usage_weekly: monthly,
          usage_monthly: monthly,
          limit: 100,
          limit_remaining: 49,
          limit_reset: "daily",
          label: "sentinel-label",
        },
      });
    }) as unknown as typeof fetch,
    harnesses: {
      fake: fakeHarness((spec) => {
        called.push(spec.target.provider);
        return { structured: { action: { type: "reply", text: "hello" } } };
      }),
    },
  });
}

afterEach(async () => {
  if (!factory) return;
  await factory.stop();
  factory.store.close();
  rmSync(home, { recursive: true, force: true });
});

test("pipeline and chat refresh exhausted key before harness and use fallback", async () => {
  setup();
  const repo = factory.store.upsertRepo({
    slug: "local/test",
    kind: "local",
    localPath: home,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, { repo: "local/test", prompt: "do work" });
  const ctx = new RunContext(factory.deps, run, repo, new AbortController().signal);
  const stage = factory.store.startStage(run.id, "implement", 0);
  const outcome = await ctx.invoke({
    role: "implement",
    stage,
    prompt: "do work",
    mode: "readonly",
    complexity: "small",
  });
  expect(outcome.target.provider).toBe("fallback");
  expect(called).toEqual(["fallback"]);
  expect(requests).toBe(1);

  monthly = 1;
  now += 120_001;
  await factory.tracker.refreshOpenRouter();
  monthly = 51;
  now += 120_001;
  const chat = await factory.concierge.submit("chat", { type: "text", text: "hi" });
  expect(chat.messages.at(-1)?.content).toBe("hello");
  expect(called).toEqual(["fallback", "fallback"]);
  expect(requests).toBe(3);
});

test("provider API returns usage fields without key or label", async () => {
  setup();
  factory.tracker.observeWindows("fallback", { five_hour: { utilization: 0.721, resetsAt: null } });
  await factory.tracker.refreshOpenRouter();
  const route = createHttpRoutes(factory)["/api/providers"] as (
    req: Request,
    server: Server<undefined>,
  ) => Promise<Response>;
  const response = await route(requestWithParams("http://localhost/api/providers"), {} as Server<undefined>);
  const body = await response.text();
  expect(body).toContain('"reportedUsageUsd":51');
  expect(body).toContain('"reportedAt":1000000');
  expect(body).toContain('"limitRemaining":49');
  expect(body).toContain('"limitReset":"daily"');
  const statuses = JSON.parse(body) as {
    id: string;
    windows: Record<string, { utilization: number; observedAt: number | null }>;
  }[];
  expect(statuses.find((p) => p.id === "fallback")?.windows.five_hour).toMatchObject({
    utilization: 0.721,
    observedAt: now,
  });
  expect(body).not.toContain("sentinel-key");
  expect(body).not.toContain("sentinel-label");
  expect(factory.tracker.status("fallback")?.reportedUsageUsd).toBeUndefined();
});
