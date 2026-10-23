import { expect, test } from "bun:test";
import type { Server } from "bun";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { reloadFixture } from "./config-reload-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("config reload uses admin authentication, loopback and mutation protections", async () => {
  const f = reloadFixture("[server]\nrequire_api_token = true\n[limits]\n");
  const token = "a".repeat(64);
  const routes = createHttpRoutes(f.factory, { apiToken: token });
  const route = routes["/api/admin/config/reload"] as { POST: Route; GET?: Route };
  expect(route.GET).toBeUndefined();
  const request = (headers: Record<string, string> = {}) =>
    requestWithParams("http://localhost:7400/api/admin/config/reload", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    });
  f.write("[server]\nrequire_api_token = true\n[limits]\nmax_concurrent_gates = 5\n");
  const response = await route.POST(request(), localServer);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    applied: ["limits.max_concurrent_gates"],
    restartRequired: [],
    unchanged: ["server.require_api_token"],
  });
  for (const authorization of ["", "Bearer wrong"])
    expect((await route.POST(request({ authorization }), localServer)).status).toBe(401);
  expect((await route.POST(request({ origin: "https://evil.example" }), localServer)).status).toBe(403);
  expect((await route.POST(request({ "x-forwarded-for": "127.0.0.1" }), localServer)).status).toBe(403);
  for (const type of ["", "text/plain", "application/jsonp"])
    expect((await route.POST(request({ "content-type": type }), localServer)).status).toBe(415);
  const remote = { requestIP: () => ({ address: "192.0.2.1" }) } as unknown as Server<undefined>;
  expect((await route.POST(request(), remote)).status).toBe(403);
  expect(f.factory.store.readFeed().items).toHaveLength(1);
});

test("reload loader errors return redacted 400 and keep serving", async () => {
  const f = reloadFixture();
  const route = (createHttpRoutes(f.factory)["/api/admin/config/reload"] as { POST: Route }).POST;
  const request = () =>
    requestWithParams("http://localhost:7400/api/admin/config/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  f.write("[invalid");
  expect((await route(request(), localServer)).status).toBe(400);
  expect(f.factory.store.readFeed().items).toEqual([]);
  const secret = crypto.randomUUID();
  registerCredential("RELOAD_ERROR", secret);
  f.write(`[review]\n"${secret}" = true\n`);
  const response = await route(request(), localServer);
  expect(response.status).toBe(400);
  const diagnostic = await response.text();
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).toContain("[redacted]");
  f.write("");
  expect((await route(request(), localServer)).status).toBe(200);
});
