import { expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { loadConfig } from "../src/config.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import { classifyRequest, publicHost } from "../src/server/access.ts";
import { createHttpRoutes, startHttp } from "../src/server/http.ts";
import { buildUi } from "../src/server/ui.ts";
import { fixture, type Route, requestWithParams } from "./mcp-support.ts";

const proxy = "10.0.0.20",
  origin = "https://limitless.example.test";
const peer = (address: string | null) =>
  ({ requestIP: () => (address ? { address } : null), timeout: () => {} }) as unknown as Server<undefined>;

test("classification uses only valid socket peers, with tunnel precedence and normalized IPs", () => {
  for (const [ip, headers, expected] of [
    [proxy, {}, "proxy"],
    ["::ffff:a00:14", {}, "proxy"],
    ["10.0.0.21", {}, "denied"],
    [null, {}, "denied"],
    ["garbage", {}, "denied"],
    ["127.not.an.ip", {}, "denied"],
    ["127.2.3.4", {}, "loopback"],
    ["0:0:0:0:0:0:0:1", {}, "loopback"],
    ["::ffff:7f00:1", {}, "loopback"],
    ["0:0:0:0:0:ffff:127.0.0.1", {}, "loopback"],
    ["127.0.0.1", { "X-FoRwArDeD-For": "" }, "denied"],
    ["::1", { "X-Forwarded-Proto": "https" }, "denied"],
    ["10.0.0.21", { "x-forwarded-for": proxy }, "denied"],
    [proxy, { "cf-connecting-ip": "" }, "tunnel"],
    ["127.0.0.1", { "cf-connecting-ip": "x" }, "tunnel"],
  ] as [string | null, Record<string, string>, string][])
    expect(classifyRequest(ip, new Headers(headers), [proxy])).toBe(expected);
  expect(classifyRequest("2001:db8::1", new Headers(), ["2001:0db8:0:0:0:0:0:1"])).toBe("proxy");
  expect(publicHost("limitless.example.test:8443", [`${origin}:8443`])).toBe(true);
  expect(publicHost("limitless.example.test", [`${origin}:8443`])).toBe(false);
});

test("config validates LAN settings; exact binds share routes, stop together and roll back failure", async () => {
  const f = await fixture();
  try {
    const configDir = join(f.home, "config");
    mkdirSync(configDir);
    const config = (toml: string) => {
      writeFileSync(join(configDir, "config.toml"), `[server]\n${toml}`);
      return loadConfig({ home: join(f.home, "data"), configDir });
    };
    expect(config("")).toMatchObject({
      listenLan: null,
      trustedProxies: [],
      publicOrigins: [],
      auth: "required",
      sessionIdleDays: 30,
      sessionAbsoluteDays: 180,
    });
    expect(config('auth = "proxy"\npublic_origins = ["http://limitless.example.test"]')).toMatchObject({
      auth: "proxy",
    });
    expect(config("[auth]\nidle_days = 7\nabsolute_days = 90.5")).toMatchObject({
      sessionIdleDays: 7,
      sessionAbsoluteDays: 90.5,
    });
    for (const toml of ["[auth]\nidle_days = 0", "[auth]\nabsolute_days = inf", '[auth]\nidle_days = "30"'])
      expect(() => config(toml)).toThrow("auth.");
    for (const value of [
      "0.0.0.0",
      "::",
      "127.0.0.1",
      "::ffff:127.0.0.2",
      "224.0.0.1",
      "ff02::1",
      "host",
      "192.168.1.1/24",
    ])
      expect(() => config(`listen_lan = "${value}"`)).toThrow("server.listen_lan");
    for (const toml of [
      'trusted_proxies = ["host"]',
      "trusted_proxies = [42]",
      'public_origins = "x"',
      ...["ftp://host", "https://u:p@host", "https://host/path", "https://host/?", "https://host/#"].map(
        (x) => `public_origins = ["${x}"]`,
      ),
      'listen_lan = "10.0.0.10"\nhost = "0.0.0.0"',
      'auth = "basic"',
      'public_origins = ["http://limitless.example.test"]',
    ])
      expect(() => config(toml)).toThrow("server.");
    for (const value of ["192.168.1.0/24", "2001:db8::/32", "host", 42])
      expect(() => config(`trusted_proxies = ["${proxy}", ${JSON.stringify(value)}]`)).toThrow(
        `server.trusted_proxies: ${JSON.stringify(value)} must be an individual IP address (no CIDRs or hostnames)`,
      );
    const stops: ReturnType<typeof mock>[] = [];
    const options: { hostname?: string; port?: string | number; routes?: unknown }[] = [];
    const serve = ((opts: (typeof options)[number]) => {
      options.push(opts);
      const stop = mock(() => Promise.resolve());
      stops.push(stop);
      return { stop, port: opts.port, url: new URL("http://localhost:7400") };
    }) as unknown as typeof Bun.serve<undefined>;
    await startHttp(f.factory, {}, serve).stop(true);
    expect(options.map((o) => [o.hostname, o.port])).toEqual([["127.0.0.1", 7400]]);
    Object.assign(
      f.factory.cfg,
      config(
        `listen_lan = "10.0.0.10"\nport = 7401\ntrusted_proxies = ["${proxy}"]\npublic_origins = ["HTTPS://LIMITLESS.EXAMPLE.TEST/"]`,
      ),
    );
    const server = startHttp(f.factory, {}, serve);
    expect(options.slice(1).map((o) => [o.hostname, o.port])).toEqual([
      ["127.0.0.1", 7401],
      ["10.0.0.10", 7401],
    ]);
    expect(options[1]?.routes).toBe(options[2]?.routes);
    await server.stop(true);
    for (const stop of stops) expect(stop).toHaveBeenCalledWith(true);
    let calls = 0;
    expect(() =>
      startHttp(f.factory, {}, ((opts: Parameters<typeof serve>[0]) => {
        if (++calls === 2) throw new Error("bind failed");
        return serve(opts);
      }) as typeof serve),
    ).toThrow("bind failed");
    expect(stops.at(-1)).toHaveBeenCalledWith(true);
  } finally {
    await f.close();
  }
});

test("direct navigation to every UI route serves the SPA shell; unknown API paths stay JSON 404s", async () => {
  const f = await fixture();
  const ui = await buildUi();
  f.factory.cfg.port = 0;
  const server = startHttp(f.factory, { ui });
  try {
    const shell = await ui["/index.html"]?.text();
    if (!shell) throw new Error("missing bundled shell");
    const declared = [...(await Bun.file("ui/main.tsx").text()).matchAll(/<Route path="([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(declared).toEqual(expect.arrayContaining(["/evals", "/evals/:id", "/providers"]));
    const html = { accept: "text/html" };
    for (const path of declared.map((p) => p.replace(/:[^/]+/g, "abc-123")))
      for (const suffix of ["", "?tab=x"]) {
        const res = await fetch(new URL(path + suffix, server.url), { headers: html });
        expect([path, res.status]).toEqual([path, 200]);
        expect(await res.text()).toBe(shell);
      }
    for (const path of ["/api/evals/missing/nope", "/api/nope", "/api/"]) {
      const res = await fetch(new URL(path, server.url), { headers: html });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not found" });
    }
    expect((await fetch(new URL("/unknown", server.url), { headers: html })).status).toBe(404);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("guarded UI/assets, API, SSE, mutations and webhook transports", async () => {
  const f = await fixture();
  try {
    const cfg = f.factory.cfg;
    cfg.auth = "proxy";
    cfg.trustedProxies = [proxy];
    cfg.publicOrigins = [origin];
    cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
    const ui = await buildUi();
    const mcp = mock(() => new Response("dispatch"));
    const routes = createHttpRoutes(f.factory, {
      ui,
      routes: { "/mcp": mcp, "/webhooks/github": githubWebhook(f.factory, async () => ["140.82.112.0/20"]) },
    });
    const call = (
      path: string,
      address = proxy,
      headers: Record<string, string> = { host: "limitless.example.test" },
      method = "GET",
      body?: string,
      signal?: AbortSignal,
    ) => {
      const entry = routes[path] ?? (path.startsWith("/runs/") ? routes["/runs/*"] : routes["/*"]);
      const route =
        typeof entry === "function"
          ? (entry as Route)
          : ((entry as Record<string, Route>)[method] ?? (routes["/*"] as Route));
      return route(
        requestWithParams(`http://localhost:7400${path}`, { method, headers, body, signal }),
        peer(address),
      );
    };
    const asset = Object.keys(ui).find((path) => path.endsWith(".js"));
    if (!asset) throw new Error("missing bundled JS");
    expect(await ui["/index.html"]?.text()).toContain(`src="${asset}"`);
    for (const path of [
      "/",
      "/runs/deep",
      asset,
      "/api/health",
      "/api/stream",
      "/unknown",
      "/api/admin/drain",
      "/mcp",
    ])
      for (const address of [proxy, "127.0.0.1", "10.0.0.21"]) {
        expect(
          (await call(path, address, { "cf-connecting-ip": "", host: "limitless.example.test" })).status,
        ).toBe(403);
        expect((await call(path, "10.0.0.21", { "x-forwarded-for": proxy })).status).toBe(403);
      }
    for (const address of [proxy, "127.0.0.1"]) {
      for (const path of ["/", "/runs/deep", asset, "/api/health"])
        expect((await call(path, address)).status).toBe(200);
      expect((await call("/unknown", address)).status).toBe(404);
      const abort = new AbortController();
      const response = await call(
        "/api/stream",
        address,
        { host: "limitless.example.test" },
        "GET",
        undefined,
        abort.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no SSE");
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
        await f.factory.createRun({ repo: f.repo, prompt: "stream" });
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"run"');
      } finally {
        abort.abort();
        await reader.cancel();
      }
    }
    for (const path of ["/api/admin", "/api/admin/drain", "/api/admin/resume", "/api/admin/deploy", "/mcp"])
      for (const method of ["GET", "HEAD", "POST", "OPTIONS", "DELETE"])
        for (const address of [proxy, "127.0.0.1"])
          for (const host of ["localhost", "limitless.example.test"])
            expect(
              (
                await call(
                  path,
                  address,
                  { host, origin, "x-forwarded-proto": "http", "content-type": "application/json" },
                  method,
                )
              ).status,
            ).toBe(403);
    expect(f.factory.scheduler.draining).toBe(false);
    expect(mcp).not.toHaveBeenCalled();
    const valid = { host: "limitless.example.test", origin, "content-type": "application/json" };
    const before = f.factory.store.listRuns().length;
    for (const headers of [
      { ...valid, host: "foreign.example" },
      { ...valid, host: "" },
      { ...valid, host: "limitless.example.test:8443" },
      { ...valid, host: "limitless.example.test/" },
      { ...valid, origin: "null" },
      { ...valid, origin: "" },
      { ...valid, origin: "https://evil.example" },
      { origin, "content-type": "application/json", "x-forwarded-host": "limitless.example.test" },
      { host: "limitless.example.test", "content-type": "application/json" },
    ] as Record<string, string>[])
      expect(
        (await call("/api/runs", proxy, headers, "POST", JSON.stringify({ repo: f.repo, prompt: "blocked" })))
          .status,
      ).toBe(403);
    expect(f.factory.store.listRuns()).toHaveLength(before);
    expect(
      (await call("/api/runs", proxy, { ...valid, "content-type": "text/plain" }, "POST", "{}")).status,
    ).toBe(415);
    expect(
      (await call("/api/runs", proxy, valid, "POST", JSON.stringify({ repo: f.repo, prompt: "allowed" })))
        .status,
    ).toBe(201);
    cfg.trustedProxies = [];
    cfg.publicOrigins = [];
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", origin: "http://localhost:7400" },
    ] as Record<string, string>[])
      expect(
        (
          await call(
            "/api/runs",
            "127.0.0.1",
            headers,
            "POST",
            JSON.stringify({ repo: f.repo, prompt: "local" }),
          )
        ).status,
      ).toBe(201);
    expect((await call("/api/runs", "127.0.0.1", valid, "POST", "{}")).status).toBe(403);
    cfg.trustedProxies = [proxy];
    cfg.publicOrigins = [origin];
    for (const [address, tunnel] of [
      [proxy, false],
      [proxy, true],
      ["127.0.0.1", false],
      ["10.0.0.21", true],
    ] as const) {
      const body = JSON.stringify({ repository: { full_name: "MattFlower/limitless" } });
      const headers = {
        host: "limitless.example.test",
        "x-github-delivery": `${address}-${tunnel}`,
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
        ...(tunnel ? { "cf-connecting-ip": "140.82.112.1" } : {}),
      };
      expect((await call("/webhooks/github", address, headers, "POST", body)).status).toBe(200);
      expect(
        (
          await call(
            "/webhooks/github",
            address,
            { ...headers, "x-hub-signature-256": "invalid" },
            "POST",
            body,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            "/webhooks/github",
            address,
            { ...headers, "cf-connecting-ip": "192.0.2.1" },
            "POST",
            body,
          )
        ).status,
      ).toBe(403);
    }
  } finally {
    await f.close();
  }
});
