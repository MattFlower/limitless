import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Question, Run } from "../src/core/types.ts";
import { createMcpServer, type Fetch, factoryBackend, httpBackend } from "../src/integrations/mcp.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { connect, fixture, localServer, type Route, requestWithParams, resultValue } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

test("proxy maps all six tools to REST and matches Factory results, including filtered event tail", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const match = path.match(/^\/api\/runs\/([^/]+)(\/events|\/cancel|\/answer)?$/);
    const key = match ? `/api/runs/:id${match[2] ?? ""}` : path;
    const entry = routes[key];
    const handler = (
      typeof entry === "function" ? entry : (entry as Record<string, Route>)[init?.method ?? "GET"]
    ) as Route;
    return handler(
      requestWithParams(url, init, match ? { id: decodeURIComponent(match[1] ?? "") } : {}),
      localServer,
    );
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400/", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  try {
    const call = (name: string, args: Record<string, unknown> = {}) =>
      proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
    const run = resultValue<Run>(await call("create_run", { repo: f.repo, prompt: "Do work" }));
    expect(run).toMatchObject({ source: "mcp", status: "queued", profile: "auto" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:7400/api/runs");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ source: "mcp", profile: "auto" });
    f.factory.store.db.transaction(() => {
      for (let i = 0; i < 5100; i++)
        f.factory.store.addEvent({
          runId: run.id,
          type: "log",
          level: i % 2 ? "debug" : "info",
          message: String(i),
        });
    })();
    for (const [name, args] of [
      ["get_run", { id: run.id }],
      ["list_runs", { status: "queued", limit: 1 }],
    ] as const) {
      expect(await call(name, args)).toEqual(
        await direct.client.callTool({ name: `limitless_${name}`, arguments: args }),
      );
    }
    expect(requests.some((r) => r.url.endsWith("/events?tail=true&excludeDebug=true&limit=20"))).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/api/runs?limit=1&status=queued"))).toBe(true);
    const legacy = await fetcher(`http://127.0.0.1:7400/api/runs/${run.id}/events?limit=6000`);
    const legacyEvents = await legacy.json();
    expect(legacyEvents).toHaveLength(5000);
    expect(legacyEvents[0].message).toBe("Run created from mcp");
    expect(resultValue(await call("providers"))).toMatchObject([
      { id: "fake", enabled: true, windows: {}, spendUsd: null, budgetUsd: null },
    ]);
    expect(requests.at(-1)?.url).toEndWith("/api/providers");
    const waiting = resultValue<Run>(
      await call("create_run", { repo: f.repo, prompt: "next", dependsOn: [` ${run.id} `, run.id] }),
    );
    expect(waiting).toMatchObject({ status: "waiting", dependsOn: [run.id] });
    expect(resultValue(await call("get_run", { id: waiting.id }))).toMatchObject({
      dependsOn: [run.id],
      status: "waiting",
    });
    expect(resultValue<Run[]>(await call("list_runs", { status: "waiting" })).map((r) => r.id)).toEqual([
      waiting.id,
    ]);
    expect((await call("create_run", { repo: f.repo, prompt: "bad", dependsOn: ["unknown"] })).isError).toBe(
      true,
    );
    for (const dependsOn of [null, [""], [false], ["unknown"]]) {
      const response = await fetcher("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: f.repo, prompt: "bad", dependsOn }),
      });
      expect(response.status).toBe(400);
    }

    f.factory.store.askQuestion(run.id, "What?");
    const answer = resultValue<Question[]>(await call("answer_question", { id: run.id, answer: "All good" }));
    expect(answer[0]).toMatchObject({ answer: "All good", answeredBy: "mcp" });
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "All good", by: "mcp" }),
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: true,
    });
    expect(requests.at(-1)?.url).toEndWith(`/api/runs/${run.id}/cancel`);
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: false,
    });
    for (const name of ["get_run", "cancel_run", "answer_question"]) {
      const result = await call(name, {
        id: "missing",
        ...(name === "answer_question" ? { answer: "x" } : {}),
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not found");
    }
    expect((await call("answer_question", { id: run.id, answer: "again" })).isError).toBe(true);
    const before = requests.length;
    expect((await call("create_run", { repo: "", prompt: "x" })).isError).toBe(true);
    expect(requests).toHaveLength(before);
  } finally {
    await proxy.close();
    await direct.close();
  }
});

test("ids are encoded in every proxy path", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "x" });
  const urls: string[] = [];
  const backend = httpBackend("http://localhost:7400", async (url) => {
    urls.push(url);
    return Response.json(f.factory.store.getRunDetail(run.id));
  });
  const id = "id/with ?#%";
  await backend.detail(id);
  await backend.events(id);
  await backend.cancel(id);
  await backend.answer(id, "answer");
  expect(
    urls.every((url) => url.startsWith(`http://localhost:7400/api/runs/${encodeURIComponent(id)}`)),
  ).toBe(true);
});

test("connection, HTTP and malformed responses are MCP errors and mutations are never retried", async () => {
  for (const [response, expected] of [
    [
      () => {
        throw new Error("offline");
      },
      "Cannot reach",
    ],
    [() => new Response("upstream failed", { status: 503 }), "HTTP 503"],
    [() => new Response("not JSON"), "Malformed JSON"],
    [() => Response.json({ unexpected: true }), "Invalid"],
  ] as const) {
    let calls = 0;
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async () => {
        calls++;
        return response();
      }),
    );
    try {
      const result = await proxy.client.callTool({
        name: "limitless_create_run",
        arguments: { repo: f.repo, prompt: "x" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(expected);
      expect(calls).toBe(1);
      expect((await proxy.client.listTools()).tools).toHaveLength(8);
    } finally {
      await proxy.close();
    }
  }
});

test("stdio streams emit only protocol JSON and survive daemon errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const server = createMcpServer(
    httpBackend("http://daemon.invalid", async () => {
      throw new Error("offline");
    }),
  );
  await server.connect(new StdioServerTransport(stdin, stdout));
  try {
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "limitless_providers", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    ])
      stdin.write(`${JSON.stringify(message)}\n`);
    for (let i = 0; i < 100 && output.trim().split("\n").length < 3; i++) await Bun.sleep(5);
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
    expect(messages.find((m) => m.id === 2).result.isError).toBe(true);
    expect(messages.find((m) => m.id === 3).result.tools).toHaveLength(8);
  } finally {
    await server.close();
    stdin.destroy();
    stdout.destroy();
  }
});

test("proxy feed tools match the direct backend and allow a 60-second long poll", async () => {
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname as "/api/feed" | "/api/feed/ack";
    const handler = (routes[path] as Record<string, Route>)[init?.method ?? "GET"] as Route;
    return handler(requestWithParams(url, init), localServer);
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  const timeouts = spyOn(AbortSignal, "timeout");
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
    f.factory.store.updateRun(run.id, { status: "needs_human", error: "pick a name" });
    f.factory.store.askQuestion(run.id, "Which name?");
    const read = (conn: typeof proxy, args: Record<string, unknown>) =>
      conn.client.callTool({ name: "limitless_feed", arguments: args });
    for (const args of [{ consumer: "proxy" }, { after: 1 }, {}])
      expect(resultValue(await read(proxy, args))).toEqual(resultValue(await read(direct, args)));
    timeouts.mockClear();
    expect(resultValue(await read(proxy, { consumer: "proxy", wait: 60 }))).toEqual(
      resultValue(await read(direct, { consumer: "proxy", wait: 60 })),
    );
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([90_000]);
    timeouts.mockClear();
    const ack = await proxy.client.callTool({
      name: "limitless_feed_ack",
      arguments: { consumer: "proxy", id: 1 },
    });
    expect(resultValue<unknown>(ack)).toEqual({ consumer: "proxy", id: 1 });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
    const page = resultValue<{ items: { id: number }[] }>(await read(proxy, { consumer: "proxy" }));
    expect(page.items.map((i) => i.id)).toEqual([2]);
    expect(resultValue(await read(proxy, { consumer: "proxy" }))).toEqual(
      resultValue(await read(direct, { consumer: "proxy" })),
    );
    expect((await read(proxy, { wait: 61 })).isError).toBe(true);
  } finally {
    timeouts.mockRestore();
    await proxy.close();
    await direct.close();
  }
});

test("cancelling a proxied feed long poll aborts the daemon request", async () => {
  let seen: AbortSignal | undefined;
  const fetcher: Fetch = (_url, init) =>
    new Promise((_, reject) => {
      seen = init?.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
    });
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  try {
    const controller = new AbortController();
    const pending = proxy.client
      .callTool({ name: "limitless_feed", arguments: { wait: 60 } }, undefined, { signal: controller.signal })
      .catch(() => "cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toBe("cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(true);
  } finally {
    await proxy.close();
  }
});
