import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountMcp } from "../src/integrations/mcp-http.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let mcp: ReturnType<typeof mountMcp>;
let route: Route;
beforeEach(async () => {
  f = await fixture();
  mcp = mountMcp(f.factory);
  route = createHttpRoutes(f.factory, {
    routes: { "/mcp": (req, server) => mcp.handle(req, server.requestIP(req)?.address ?? null) },
  })["/mcp"] as Route;
});
afterEach(async () => {
  await mcp.stop();
  await f.close();
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method: string, params: unknown = {}, id: number | undefined = 1) =>
  requestWithParams("http://127.0.0.1:7400/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

test("mounted endpoint initializes, discovers and calls tools without sessions", async () => {
  const init = await route(
    rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    localServer,
  );
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).toBeNull();
  expect((await init.json()).result.capabilities.tools).toEqual({});
  expect(
    (
      await route(
        requestWithParams("http://127.0.0.1:7400/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
        localServer,
      )
    ).status,
  ).toBe(202);
  const list = await route(rpc("tools/list"), localServer);
  expect((await list.json()).result.tools).toHaveLength(6);
  const create = await route(
    rpc("tools/call", { name: "limitless_create_run", arguments: { repo: f.repo, prompt: "hello" } }),
    localServer,
  );
  const run = JSON.parse((await create.json()).result.content[0].text);
  expect(f.factory.store.getRun(run.id)?.source).toBe("mcp");
  const get = await route(
    rpc("tools/call", { name: "limitless_get_run", arguments: { id: run.id } }),
    localServer,
  );
  expect(JSON.parse((await get.json()).result.content[0].text).id).toBe(run.id);
  const dependent = await route(
    rpc("tools/call", {
      name: "limitless_create_run",
      arguments: { repo: f.repo, prompt: "next", dependsOn: [run.id] },
    }),
    localServer,
  );
  expect(JSON.parse((await dependent.json()).result.content[0].text)).toMatchObject({
    status: "waiting",
    dependsOn: [run.id],
  });

  await mcp.stop();
  expect((await route(rpc("tools/list"), localServer)).status).toBe(503);
  expect(f.factory.store.getRun(run.id)?.status).toBe("queued");
});

test("all methods reject tunnel, non-loopback, untrusted origin and rebinding host before dispatch", async () => {
  f.factory.cfg.trustedProxies = ["192.0.2.10"];
  f.factory.cfg.publicOrigins = ["https://limitless.mattflower.net"];
  for (const method of ["POST", "GET", "DELETE", "PUT", "OPTIONS", "HEAD"]) {
    for (const extra of [
      { "cf-connecting-ip": "198.51.100.1" },
      { "cf-connecting-ip": "" },
      { origin: "https://evil.example" },
      { origin: "null" },
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-proto": "http" },
    ] as Record<string, string>[]) {
      const req = requestWithParams("http://127.0.0.1:7400/mcp", {
        method,
        headers: { ...headers, ...extra },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "limitless_create_run", arguments: { repo: f.repo, prompt: "blocked" } },
              }),
            }
          : {}),
      });
      expect((await route(req, localServer)).status).toBe(403);
    }
    for (const address of ["192.0.2.10", null, "127.not.an.ip"]) {
      expect((await mcp.handle(new Request("http://127.0.0.1:7400/mcp", { method }), address)).status).toBe(
        403,
      );
    }
    expect((await mcp.handle(new Request("http://evil.example/mcp", { method }), "127.0.0.1")).status).toBe(
      403,
    );
  }
  expect(f.factory.store.listRuns()).toEqual([]);
});

test("protocol method errors and JSON guard are compatible with stateless MCP; REST remains protected", async () => {
  for (const method of ["GET", "DELETE", "PUT", "OPTIONS", "HEAD"]) {
    const res = await route(requestWithParams("http://127.0.0.1:7400/mcp", { method }), localServer);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  }
  expect(
    (await route(requestWithParams("http://127.0.0.1:7400/mcp", { method: "POST", body: "{}" }), localServer))
      .status,
  ).toBeGreaterThanOrEqual(400);
  for (const address of ["::1", "::ffff:127.0.0.1", "127.0.0.2"]) {
    expect((await mcp.handle(rpc("tools/list"), address)).status).toBe(200);
  }
  const rest = (createHttpRoutes(f.factory)["/api/runs"] as { POST: Route }).POST;
  const cases: { headers: Record<string, string>; expected: number }[] = [
    { headers: { "content-type": "application/json", origin: "https://evil.example" }, expected: 403 },
    { headers: { "content-type": "text/plain" }, expected: 415 },
    { headers: { "content-type": "application/json", "cf-connecting-ip": "" }, expected: 403 },
  ];
  for (const init of cases) {
    const res = await rest(
      requestWithParams("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: init.headers,
        body: JSON.stringify({ repo: f.repo, prompt: "blocked" }),
      }),
      localServer,
    );
    expect(res.status).toBe(init.expected);
  }
  expect(f.factory.store.listRuns()).toEqual([]);
});

test("REST run creation accepts the allow option and prompt directives, and retries keep them", async () => {
  const rest = (createHttpRoutes(f.factory)["/api/runs"] as { POST: Route }).POST;
  const post = (payload: Record<string, unknown>) =>
    rest(
      requestWithParams("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: f.repo, ...payload }),
      }),
      localServer,
    );
  const option = await post({ prompt: "vendor", allow: ["submodules"] });
  expect(option.status).toBe(201);
  const directive = await post({ prompt: "mark fixtures\nAllow: gitattributes" });
  const created = [(await option.json()).id, (await directive.json()).id] as string[];
  expect(created.map((id) => f.factory.store.getRun(id)?.allow)).toEqual([["submodules"], ["gitattributes"]]);
  expect((await f.factory.retryRun(created[0] ?? "")).allow).toEqual(["submodules"]);
  const invalid = await post({ prompt: "vendor", allow: ["submodules", "secrets"] });
  expect(invalid.status).toBeGreaterThanOrEqual(400);
  expect(await invalid.text()).toContain('Invalid allow value \\"secrets\\"');
});
