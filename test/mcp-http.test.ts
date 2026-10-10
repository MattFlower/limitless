import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FeedPage, Run } from "../src/core/types.ts";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
import { httpBackend } from "../src/integrations/mcp.ts";
import { mountMcp } from "../src/integrations/mcp-http.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { connect, fixture, localServer, type Route, requestWithParams, resultValue } from "./mcp-support.ts";

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

test("no HTTP MCP tool result or error includes owner diagnostics", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "diagnostic transport" });
  const marker = "OWNER_MCP_HTTP_ONLY_423";
  f.factory.store.recordOwnerDiagnostic({ runId: run.id, kind: "run-error", text: marker }, "public");
  expect(ownerDiagnostics(f.factory.store.db, run.id)).toMatchObject([{ text: marker }]);
  f.factory.store.updateRun(run.id, { status: "failed", error: "public" });
  f.factory.store.addEvent({ runId: run.id, type: "log", message: "public event" });
  const reads = [
    [
      "limitless_get_run",
      { id: run.id },
      {
        id: run.id,
        error: "public",
        events: expect.arrayContaining([expect.objectContaining({ message: "public event" })]),
      },
    ],
    ["limitless_list_runs", { status: "failed", limit: 1 }, [{ id: run.id, error: "public" }]],
    ["limitless_feed", { after: 0, wait: 0 }, { items: [{ runId: run.id }] }],
    ["limitless_status", { run: run.id }, { run: run.id, state: "Failed" }],
    ["limitless_providers", {}, [{ id: "fake" }]],
  ] as const;
  for (const [name, args, expected] of reads) {
    const response = await route(rpc("tools/call", { name, arguments: args }), localServer);
    expect(response.status).toBe(200);
    const message = await response.json();
    expect(message.error).toBeUndefined();
    expect(message.result.isError).not.toBe(true);
    expect(resultValue(message.result)).toMatchObject(expected);
    expect(JSON.stringify(message)).not.toContain(marker);
  }
  const tools = (await (await route(rpc("tools/list"), localServer)).json()).result.tools as {
    name: string;
  }[];
  for (const tool of tools) {
    if (reads.some(([name]) => name === tool.name)) continue;
    const response = await route(rpc("tools/call", { name: tool.name, arguments: {} }), localServer);
    const message = await response.json();
    expect(message.result.isError).toBe(true);
    expect(JSON.stringify(message)).not.toContain(marker);
  }
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
  expect((await list.json()).result.tools).toHaveLength(12);
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
  const status = await route(
    rpc("tools/call", { name: "limitless_status", arguments: { run: run.id } }),
    localServer,
  );
  expect(JSON.parse((await status.json()).result.content[0].text)).toMatchObject({
    run: run.id,
    state: "Work pending",
  });
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
  const resolve = (id: string) =>
    route(
      rpc("tools/call", { name: "limitless_resolve_run", arguments: { id, kind: "wont_do" } }),
      localServer,
    );
  const queued = (await (await resolve(run.id)).json()).result;
  expect(queued.isError).toBe(true);
  expect(queued.content[0].text).toContain("run is queued");
  const blocked = await f.factory.createRun({ repo: f.repo, prompt: "blocked" });
  f.factory.store.updateRun(blocked.id, { status: "needs_human" });
  const resolved = (await (await resolve(blocked.id)).json()).result;
  expect(JSON.parse(resolved.content[0].text).resolution).toMatchObject({ kind: "wont_do", by: "human" });

  await mcp.stop();
  expect((await route(rpc("tools/list"), localServer)).status).toBe(503);
  expect(f.factory.store.getRun(run.id)?.status).toBe("queued");
});

test("all methods reject tunnel, non-loopback, untrusted origin and rebinding host before dispatch", async () => {
  f.factory.cfg.trustedProxies = ["192.0.2.10"];
  f.factory.cfg.publicOrigins = ["https://limitless.example.test"];
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
  for (const payload of [{ prompt: "binary fixture", allow: ["binary"] }, { prompt: "Allow: binary" }]) {
    const response = await post(payload);
    expect(response.status).toBe(201);
    const id = (await response.json()).id as string;
    expect(f.factory.store.getRun(id)?.allow).toEqual(["binary"]);
    expect((await f.factory.retryRun(id)).allow).toEqual(["binary"]);
  }
  const invalid = await post({ prompt: "vendor", allow: ["submodules", "secrets"] });
  expect(invalid.status).toBeGreaterThanOrEqual(400);
  expect(await invalid.text()).toContain('Invalid allow value \\"secrets\\"');
});

test("the mounted endpoint serves the feed tools", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  f.factory.store.updateRun(run.id, { status: "succeeded" });
  const read = await route(
    rpc("tools/call", { name: "limitless_feed", arguments: { consumer: "codex" } }),
    localServer,
  );
  const page = JSON.parse((await read.json()).result.content[0].text);
  expect(page).toEqual(f.factory.store.readFeed({ consumer: "codex" }));
  const ack = await route(
    rpc("tools/call", { name: "limitless_feed_ack", arguments: { consumer: "codex", id: page.nextAfter } }),
    localServer,
  );
  expect(JSON.parse((await ack.json()).result.content[0].text)).toEqual({
    consumer: "codex",
    id: page.nextAfter,
  });
  expect(f.factory.store.feedCursor("codex")).toBe(page.nextAfter);
});

test("HTTP-backed MCP records consumers and filters only their MCP-created runs", async () => {
  const routes = createHttpRoutes(f.factory);
  const proxy = await connect(
    httpBackend("http://localhost:7400", async (url, init) => {
      const entry = routes[new URL(url).pathname];
      const handler = (entry as Record<string, Route>)[init?.method ?? "GET"] as Route;
      return handler(requestWithParams(url, init), localServer);
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
  try {
    const mine = resultValue<Run>(
      await call("create_run", { repo: f.repo, prompt: "mine", consumer: " worker " }),
    );
    const other = resultValue<Run>(
      await call("create_run", { repo: f.repo, prompt: "other", consumer: "other" }),
    );
    const legacy = resultValue<Run>(await call("create_run", { repo: f.repo, prompt: "legacy" }));
    const ui = await f.factory.createRun({ repo: f.repo, prompt: "ui", source: "ui", requestedBy: "worker" });
    const store = f.factory.store;
    expect(store.getRun(mine.id)).toMatchObject({ source: "mcp", requestedBy: "worker" });
    const repo = store.upsertRepo({
      slug: "owner/other",
      kind: "github",
      url: "https://example.test/other",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const elsewhere = store.createRun(repo, {
      repo: repo.slug,
      prompt: "elsewhere",
      source: "mcp",
      requestedBy: "worker",
    });
    for (const run of [mine, other, legacy, ui, elsewhere]) store.updateRun(run.id, { status: "failed" });
    store.daemonStarted("boot", "test", "sha");
    const own = resultValue<FeedPage>(await call("feed", { consumer: "worker", ownRuns: true }));
    expect(own.items.map((i) => i.runId)).toEqual([mine.id, elsewhere.id]);
    expect(own.hasMore).toBe(false);
    const combined = resultValue<FeedPage>(
      await call("feed", { consumer: "worker", ownRuns: true, repo: mine.repoSlug }),
    );
    expect(combined.items.map((i) => i.runId)).toEqual([mine.id]);
    expect(
      resultValue<FeedPage>(await call("feed", { consumer: "other", ownRuns: true })).items.map(
        (i) => i.runId,
      ),
    ).toEqual([other.id]);
    expect((await call("feed", { ownRuns: true })).isError).toBe(true);
    expect((await call("feed", { from: "now", after: 0 })).isError).toBe(true);
    const snapshot = resultValue<FeedPage>(
      await call("feed", { consumer: "worker", from: "now", ownRuns: true }),
    );
    expect(snapshot).toMatchObject({ items: [], nextAfter: 6, hasMore: false });
    expect(store.feedCursor("worker")).toBe(0);
    store.askQuestion(mine.id, "Next action?");
    expect(
      resultValue<FeedPage>(
        await call("feed", { consumer: "worker", ownRuns: true, after: snapshot.nextAfter }),
      ).items,
    ).toMatchObject([{ runId: mine.id, kind: "run.question" }]);
    // The MCP response preserves the HTTP page's byte bound and truncation marker.
    store.updateRun(mine.id, { status: "needs_human", error: "🙂".repeat(10000) });
    const oversized = resultValue<FeedPage>(await call("feed", { after: 7 }));
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(16 * 1024);
    expect(oversized.items).toMatchObject([{ runId: mine.id, truncated: true }]);
  } finally {
    await proxy.close();
  }
});

test("MCP's byte budget includes privacy substitutions that expand the page", async () => {
  registerCredential("FEED_TEST_CREDENTIAL", "short-feed-key");
  const data = JSON.stringify({ messages: Array(900).fill("short-feed-key") });
  f.factory.store.db
    .query(`INSERT INTO feed (ts, kind, title, summary, data, dedupe_key)
    VALUES (1, 'daemon.started', 't', 's', ?, 'privacy-budget')`)
    .run(data);
  const original = f.factory.store.readFeed({});
  expect(original.items[0]?.truncated).toBeUndefined();
  const response = await route(rpc("tools/call", { name: "limitless_feed", arguments: {} }), localServer);
  const result = (await response.json()).result;
  const page = resultValue<FeedPage>(result);
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(16 * 1024);
  expect(page).toMatchObject({
    items: [{ id: 1, kind: "daemon.started", truncated: true }],
    nextAfter: 1,
    hasMore: false,
  });
});

test("an HTTP client disconnecting from a feed long poll releases its listener", async () => {
  const listeners = () => (f.factory.store as unknown as { listeners: Set<unknown> }).listeners.size;
  const idle = listeners();
  const controller = new AbortController();
  const req = requestWithParams("http://127.0.0.1:7400/mcp", {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "limitless_feed", arguments: { wait: 30 } },
    }),
  });
  const started = Date.now();
  const pending = route(req, localServer).catch(() => "aborted");
  await Bun.sleep(20);
  expect(listeners()).toBe(idle + 1);
  controller.abort();
  await pending;
  expect(Date.now() - started).toBeLessThan(5_000);
  await Bun.sleep(20);
  expect(listeners()).toBe(idle);
});
