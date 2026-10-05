import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

let dir: string;
let factory: Factory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-routing-http-"));
  const overlay = join(dir, "policy.json");
  writeFileSync(overlay, JSON.stringify({ triage: { default: ["claude/opus"] } }));
  const cfg = loadConfig({ home: dir, configDir: dir, port: 7400 });
  cfg.preferProviders = ["claude"];
  factory = new Factory(cfg, { store: new Store(":memory:"), policyPath: overlay });
});
afterEach(() => {
  factory.store.close();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const routes = createHttpRoutes(factory);
  return (
    path: string,
    method = "GET",
    input?: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
    server = localServer,
  ) => {
    const parts = path.split("/");
    const key = path.startsWith("/api/routing/cells/")
      ? "/api/routing/cells/:role/:cell"
      : (path.split("?")[0] ?? "");
    const entry = routes[key];
    const route = typeof entry === "function" ? entry : (entry as Record<string, Route>)[method];
    return (route as Route)(
      requestWithParams(
        `http://localhost:7400${path}`,
        {
          method,
          headers,
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
        { role: parts[4] ?? "", cell: parts[5] ?? "" },
      ),
      server,
    );
  };
}

test("routing API reports provenance, applies cell/prefer edits and resets, and streams each change", async () => {
  const call = client();
  const events: unknown[] = [];
  factory.store.subscribe((message) => events.push(message));
  expect((await (await call("/api/routing")).json()).effective.triage.default.layer).toBe("evals");
  const response = await call("/api/routing/cells/triage/default", "PUT", {
    groups: ["codex/sol@high"],
    note: "depleted",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).effective.triage.default).toEqual({
    groups: ["codex/sol@high"],
    layer: "operator",
    evals: ["claude/opus"],
  });
  const preview = await call("/api/routing/preview?role=triage&complexity=small");
  expect(await preview.json()).toEqual([{ modelId: "codex/sol@high", eligible: true, reason: null }]);
  expect((await call("/api/routing/cells/triage/default", "DELETE")).status).toBe(200);
  expect(factory.router.route("triage", "small").candidates[0]?.modelId).toBe("claude/opus");
  expect((await call("/api/routing/prefer", "PUT", { prefer: ["codex"] })).status).toBe(200);
  expect(factory.routing.prefer).toEqual(["codex"]);
  expect((await call("/api/routing/prefer", "DELETE")).status).toBe(200);
  expect(factory.routing.prefer).toEqual(["claude"]);
  const changes = events.filter((e) => (e as { kind: string }).kind === "routing");
  expect(changes).toHaveLength(4);
  expect(factory.store.routingHistory()).toHaveLength(4);
});

test("routing mutations reject invalid payloads and honor the provider endpoint guards", async () => {
  const call = client();
  for (const path of ["/api/routing/cells/triage/default", "/api/routing/prefer"]) {
    for (const method of ["PUT", "DELETE"]) {
      const value = path.endsWith("prefer") ? { prefer: ["codex"] } : { groups: ["codex/sol"] };
      expect((await call(path, method, value, {})).status).toBe(415);
      expect((await call(path, method, value, { "content-type": "text/plain" })).status).toBe(415);
      expect(
        (
          await call(path, method, value, {
            "content-type": "application/json",
            origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(path, method, value, {
            "content-type": "application/json",
            "cf-connecting-ip": "1.2.3.4",
          })
        ).status,
      ).toBe(403);
    }
    for (const value of [null, {}, [], { groups: null }, { prefer: null }])
      expect((await call(path, "PUT", value)).status).toBe(400);
  }
  for (const [entry, groups, reason] of [
    ["unknown/default", ["codex/sol"], "unknown.default"],
    ["triage/unknown", ["codex/sol"], "triage.unknown"],
    ["triage/default", [], "triage.default"],
    ["triage/default", ["claude/fable"], "owner decision"],
  ] as const) {
    const response = await call(`/api/routing/cells/${entry}`, "PUT", { groups });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(reason);
  }
  for (const value of [{ prefer: ["codex/sol"] }, { prefer: ["claude/fable"] }, { prefer: ["unknown"] }])
    expect((await call("/api/routing/prefer", "PUT", value)).status).toBe(400);
  expect((await call("/api/routing/preview?role=triage&complexity=default")).status).toBe(400);
  expect((await call("/api/routing/preview?role=unknown&complexity=small")).status).toBe(400);
  expect(factory.routing.snapshot().effective.triage?.default?.layer).toBe("evals");
  expect(factory.store.routingHistory()).toEqual([]);
});

test("the global SSE endpoint sends routing change messages after edits and resets", async () => {
  const call = client();
  const response = await call("/api/stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing stream body");
  const decode = new TextDecoder();
  try {
    expect(decode.decode((await reader.read()).value)).toBe(": connected\n\n");
    for (const method of ["PUT", "DELETE"]) {
      expect(
        (await call("/api/routing/cells/triage/default", method, { groups: ["codex/sol"] })).status,
      ).toBe(200);
      const data = decode.decode((await reader.read()).value);
      expect(JSON.parse(data.slice("data: ".length))).toMatchObject({
        kind: "routing",
        change: { key: "triage.default", newValue: method === "PUT" ? ["codex/sol"] : null },
      });
    }
  } finally {
    await reader.cancel();
  }
});

test("routing API requires a session through an authenticated proxy", async () => {
  factory.cfg.auth = "required";
  factory.cfg.trustedProxies = ["10.0.0.20"];
  factory.cfg.publicOrigins = ["https://limitless.example.test"];
  const call = client();
  const server = {
    ...localServer,
    requestIP: () => ({ address: "10.0.0.20", family: "IPv4" as const, port: 40000 }),
  };
  const headers = {
    host: "limitless.example.test",
    origin: "https://limitless.example.test",
    "content-type": "application/json",
  };
  for (const [path, method] of [
    ["/api/routing", "GET"],
    ["/api/routing/preview?role=triage", "GET"],
    ["/api/routing/cells/triage/default", "PUT"],
    ["/api/routing/prefer", "DELETE"],
  ]) {
    expect((await call(path ?? "", method, undefined, headers, server)).status).toBe(401);
  }
  const auth = new Auth(factory.store, factory.cfg);
  const cookie = auth.signIn("password", "test").split(";")[0] ?? "";
  expect(
    (await call("/api/routing/prefer", "PUT", { prefer: ["codex"] }, { ...headers, cookie }, server)).status,
  ).toBe(200);
  expect(factory.routing.prefer).toEqual(["codex"]);
});
