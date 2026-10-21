import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { PROVIDERS } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { customProvider, providerFixture } from "./provider-config-support.ts";

test("provider mutations persist, publish, and use existing request guards", async () => {
  const f = await fixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const call = (
      action: "enable" | "disable",
      id = "fake",
      headers: Record<string, string> = { "content-type": "application/json" },
    ) => {
      const route = (routes[`/api/providers/:id/${action}`] as { POST: Route }).POST;
      return route(
        requestWithParams(
          `http://localhost:7400/api/providers/${id}/${action}`,
          { method: "POST", headers },
          { id },
        ),
        localServer,
      );
    };
    const id = f.factory.tracker.all()[0]?.id;
    if (!id) throw new Error("fixture has no provider");
    const messages: unknown[] = [];
    const unsubscribe = f.factory.store.subscribe((message) => messages.push(message));
    for (const action of ["disable", "disable", "enable", "enable"] as const) {
      expect((await call(action, id)).status).toBe(200);
      expect(f.factory.tracker.isEnabled(id)).toBe(action === "enable");
    }
    expect(messages.filter((message) => (message as { kind?: string }).kind === "provider")).toHaveLength(4);
    unsubscribe();
    const unknown = await call("disable", "unknown");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown provider unknown" });
    expect(f.factory.store.getProviderEnabledOverride("unknown")).toBeNull();
    for (const action of ["enable", "disable"] as const) {
      expect(
        (await call(action, id, { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }))
          .status,
      ).toBe(403);
      expect(
        (await call(action, id, { "content-type": "application/json", origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect((await call(action, id, { "content-type": "text/plain" })).status).toBe(415);
      expect((await call(action, id, {})).status).toBe(415);
    }
  } finally {
    await f.close();
  }
});

test("fast settings default off and survive Store/tracker restart independently of enablement", () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-fast-"));
  const path = join(dir, "db.sqlite");
  const reserves = loadConfig().reserves;
  let store = new Store(path);
  try {
    let tracker = new ProviderTracker(PROVIDERS, store, reserves, {});
    for (const id of ["codex", "claude"]) {
      expect(tracker.status(id)?.fast).toBe(false);
      expect(tracker.status(id)?.supportsFast).toBe(true);
      tracker.setEnabled(id, false);
      tracker.setFast(id, true);
      expect(tracker.isEnabled(id)).toBe(false);
    }
    store.close();
    store = new Store(path);
    tracker = new ProviderTracker(PROVIDERS, store, reserves, {});
    for (const id of ["codex", "claude"]) {
      expect(tracker.isFast(id)).toBe(true);
      expect(tracker.isEnabled(id)).toBe(false);
      tracker.setEnabled(id, true);
      expect(tracker.isFast(id)).toBe(true);
      tracker.setFast(id, false);
      expect(tracker.isEnabled(id)).toBe(true);
    }
    store.close();
    store = new Store(path);
    tracker = new ProviderTracker(PROVIDERS, store, reserves, {});
    expect(tracker.isFast("claude")).toBe(false);
    expect(tracker.isEnabled("claude")).toBe(true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast API toggles native providers, publishes status, and rejects invalid requests without mutation", async () => {
  const f = await fixture();
  try {
    const tracker = new ProviderTracker(PROVIDERS, f.factory.store, f.factory.cfg.reserves, {});
    // The route uses the same tracker API with native provider definitions.
    Object.defineProperty(f.factory, "tracker", { value: tracker });
    const routes = createHttpRoutes(f.factory);
    const route = (routes["/api/providers/:id/fast"] as { POST: Route }).POST;
    const call = (id: string, value: unknown, headers = { "content-type": "application/json" }) =>
      route(
        requestWithParams(
          `http://localhost:7400/api/providers/${id}/fast`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(value),
          },
          { id },
        ),
        localServer,
      );
    const messages: unknown[] = [];
    const unsubscribe = f.factory.store.subscribe((message) => messages.push(message));
    for (const id of ["codex", "claude"]) {
      for (const on of [true, false, true]) {
        const response = await call(id, { on });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id, fast: on, enabled: true, supportsFast: true });
      }
      const before = f.factory.store.getProviderRow(id);
      for (const value of [null, {}, { on: "true" }, { on: 1 }, { on: null }, [], true]) {
        expect((await call(id, value)).status).toBe(400);
        expect(f.factory.store.getProviderRow(id)).toEqual(before);
      }
      for (const headers of [
        { "content-type": "text/plain" },
        { "content-type": "application/json", origin: "https://evil.example" },
        { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      ]) {
        expect((await call(id, { on: false }, headers)).status).toBe(
          headers["content-type"] === "text/plain" ? 415 : 403,
        );
        expect(tracker.isFast(id)).toBe(true);
      }
    }
    for (const id of ["unknown", "openrouter", "omlx"]) {
      expect((await call(id, { on: true })).status).toBe(400);
      expect(f.factory.store.getProviderRow(id)).toBeNull();
    }
    expect(messages.filter((message) => (message as { kind?: string }).kind === "provider")).toHaveLength(6);
    unsubscribe();
    tracker.observeFast("claude", true, {
      fastModeState: "off",
      fastModeDisabledReason: "extra_usage_disabled",
    });
    expect(tracker.status("claude")?.fastModeUnavailableReason).toBe("extra_usage_disabled");
    tracker.observeFast("claude", false, {});
    expect(tracker.status("claude")?.fastModeUnavailableReason).toBe("extra_usage_disabled");
    tracker.observeFast("claude", true, {});
    expect(tracker.status("claude")?.fastModeUnavailableReason).toBeNull();
  } finally {
    await f.close();
  }
});

test("configured provider status and model APIs include metadata but never credential values", async () => {
  const fixture = providerFixture(
    [
      customProvider,
      { ...customProvider, id: "missing", label: "Needs a key", api_key_env: "LIMITLESS_TEST_MISSING_KEY" },
    ],
    "LIMITLESS_TEST_MLX_KEY=never-publish-sentinel\n",
  );
  const store = new Store(":memory:");
  try {
    const factory = new Factory(fixture.load(), { store });
    const routes = createHttpRoutes(factory);
    const response = await (routes["/api/providers"] as Route)(
      requestWithParams("http://localhost/api/providers", {}, {}),
      localServer,
    );
    const body = await response.text();
    expect(body).not.toContain("never-publish-sentinel");
    expect(JSON.parse(body)).toContainEqual(
      expect.objectContaining({
        id: "mac-mlx",
        label: "My MLX",
        kind: "openai-compatible",
        enabled: true,
        maxConcurrent: 4,
      }),
    );
    expect(JSON.parse(body)).toContainEqual(
      expect.objectContaining({
        id: "missing",
        reason: "missing key LIMITLESS_TEST_MISSING_KEY",
        enabled: false,
      }),
    );
    const events: unknown[] = [];
    const unsubscribe = store.subscribe((e) => events.push(e));
    const enable = (routes["/api/providers/:id/enable"] as { POST: Route }).POST;
    const enabled = await enable(
      requestWithParams(
        "http://localhost/api/providers/missing/enable",
        { method: "POST", headers: { "content-type": "application/json" } },
        { id: "missing" },
      ),
      localServer,
    );
    expect(await enabled.json()).toMatchObject({
      kind: "openai-compatible",
      label: "Needs a key",
      enabled: false,
      reason: "missing key LIMITLESS_TEST_MISSING_KEY",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "provider",
        provider: expect.objectContaining({ kind: "openai-compatible", enabled: false }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("never-publish-sentinel");
    unsubscribe();
    const modelResponse = await (routes["/api/models"] as Route)(
      requestWithParams("http://localhost/api/models", {}, {}),
      localServer,
    );
    expect((await modelResponse.json()).models).toContainEqual(
      expect.objectContaining({ id: "mac-mlx/flash", model: "org/backend" }),
    );
    const evalResponse = await (routes["/api/evals/policy"] as Route)(
      requestWithParams("http://localhost/api/evals/policy", {}, {}),
      localServer,
    );
    const evalBody = await evalResponse.text();
    expect(evalBody).not.toContain("never-publish-sentinel");
    expect(evalBody).not.toContain("mtplx-local");
  } finally {
    store.close();
    fixture.close();
  }
});

test("provider stats preserve chat/calendar totals while historical cutoffs affect only pipeline/eval work", async () => {
  const f = await fixture();
  try {
    const store = f.factory.store;
    store.db.exec("PRAGMA foreign_keys = OFF");
    const at = Date.now() - 1000;
    store.db
      .query(`INSERT INTO invocations
      (run_id, role, harness, provider, model, model_id, status, started_at, finished_at,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_equiv_usd)
      VALUES ('r', 'spec', 'fake', 'retired', 'm', 'm', 'ok', ?, ?, 10, 2, 3, 5, 0.5)`)
      .run(at, at + 100);
    store.db
      .query(`INSERT INTO chat_calls
      (conversation_id, provider, model_id, result_json, cost_usd, started_at, duration_ms)
      VALUES ('c', 'retired', 'm', ?, 0, ?, 200)`)
      .run(JSON.stringify({ usage: { input: 4, output: 2 }, costEquivUsd: 0.25 }), at);
    const route = createHttpRoutes(f.factory)["/api/stats/providers"] as Route;
    const get = (since?: string) =>
      route(
        requestWithParams(
          `http://localhost/api/stats/providers${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`,
        ),
        localServer,
      );
    const response = await get();
    expect(response.status).toBe(200);
    const rows = await response.json();
    expect(rows).toMatchObject([
      {
        provider: "retired",
        sevenDays: { invocations: 2, tokensIn: 19, tokensOut: 7, wallTimeMs: 300, costEquivUsd: 0.75 },
        production: { totals: { invocations: 1, tokensIn: 15, inputTokens: 10 } },
        eval: { totals: { invocations: 0 } },
      },
    ]);
    const inclusive = await (await get(new Date(at).toISOString())).json();
    expect(inclusive).toEqual(rows);
    const future = await (await get("2100-01-01")).json();
    expect(future[0].today).toEqual(rows[0].today);
    expect(future[0].sevenDays).toEqual(rows[0].sevenDays);
    expect(future[0].production.totals).toMatchObject({
      invocations: 0,
      successfulShare: 0,
      p50WallTimeMs: null,
    });
    const offset = new Date(at).toISOString().replace("Z", "+00:00");
    expect(await (await get(offset)).json()).toEqual(inclusive);
    for (const value of ["", "yesterday", "2026-02-30", "2026-02-30T10:00:00Z"]) {
      const invalid = await get(value);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("invalid ISO-8601") });
    }
  } finally {
    await f.close();
  }
});
