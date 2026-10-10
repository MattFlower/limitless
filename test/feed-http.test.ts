import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import type { FeedPage, StreamMessage } from "../src/core/types.ts";
import type { Store } from "../src/db/store.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let store: Store;
let feed: Route;
let ack: Route;
let stream: Route;
beforeEach(async () => {
  f = await fixture();
  store = f.factory.store;
  const routes = createHttpRoutes(f.factory);
  feed = (routes["/api/feed"] as { GET: Route }).GET;
  ack = (routes["/api/feed/ack"] as { POST: Route }).POST;
  stream = routes["/api/stream"] as Route;
});
afterEach(async () => {
  await f.close();
});

const read = async (query: string, init?: RequestInit, server = localServer) =>
  feed(requestWithParams(`http://localhost:7400/api/feed${query}`, init), server);
const page = async (query: string) => {
  const res = await read(query);
  expect(res.status).toBe(200);
  return (await res.json()) as FeedPage;
};
const acknowledge = (
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) =>
  ack(
    requestWithParams("http://localhost:7400/api/feed/ack", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    localServer,
  );
async function item(title = "work"): Promise<number> {
  const run = await f.factory.createRun({ repo: f.repo, prompt: title });
  store.updateRun(run.id, { status: "failed", error: title });
  return store.readFeed({ after: 0, limit: 1000 }).nextAfter;
}
const listeners = () => (store as unknown as { listeners: Set<unknown> }).listeners.size;

test("reads honor cursors and explicit after; acknowledgements are durable, monotonic and per consumer", async () => {
  expect(await page("?consumer=new")).toEqual({ items: [], nextAfter: 0, pruned: false, hasMore: false });
  const ids = [await item("a"), await item("b"), await item("c")];
  expect((await page("?consumer=orchestrator")).items.map((i) => i.id)).toEqual(ids);
  expect(store.feedCursor("orchestrator")).toBe(0);
  expect(await (await acknowledge({ consumer: " orchestrator ", id: ids[1] })).json()).toEqual({
    consumer: "orchestrator",
    id: ids[1],
  });
  expect(await (await acknowledge({ consumer: "orchestrator", id: ids[0] })).json()).toEqual({
    consumer: "orchestrator",
    id: ids[1],
  });
  expect<unknown>((await page("?consumer=orchestrator")).items.map((i) => i.id)).toEqual([ids[2]]);
  expect((await page("?consumer=orchestrator&after=0")).items.map((i) => i.id)).toEqual(ids);
  expect((await page("?consumer=other")).items.map((i) => i.id)).toEqual(ids);
  expect(await page("?after=0&limit=2")).toMatchObject({ nextAfter: ids[1] });
  expect<unknown>(await page(`?consumer=orchestrator&after=${ids[2]}`)).toEqual({
    items: [],
    nextAfter: ids[2],
    pruned: false,
    hasMore: false,
  });
});

test("malformed parameters and acknowledgements are rejected", async () => {
  const id = await item();
  for (const query of [
    "?consumer=",
    "?consumer=%20%20",
    "?after=-1",
    "?after=1.5",
    "?after=abc",
    "?after=",
    "?after=9007199254740992",
    "?limit=0",
    "?limit=1001",
    "?wait=61",
    "?wait=-1",
    "?wait=Infinity",
    "?wait=soon",
    "?from=now&after=0",
    "?from=yesterday",
    "?ownRuns=true",
    "?consumer=a&ownRuns=maybe",
    "?repo=",
  ])
    expect([query, (await read(query)).status]).toEqual([query, 400]);
  for (const body of [
    { consumer: "a" },
    { consumer: "", id },
    { consumer: "a", id: -1 },
    { consumer: "a", id: 1.5 },
  ])
    expect((await acknowledge(body)).status).toBe(400);
  expect(await (await acknowledge({ consumer: "a", id: id + 1 })).json()).toEqual({
    error: `feed id ${id + 1} has not been issued`,
  });
  expect(store.feedCursor("a")).toBe(0);
});

test("feed endpoints keep the runs list access and mutation protections", async () => {
  await item();
  expect((await read("", { headers: { "cf-connecting-ip": "1.2.3.4" } })).status).toBe(403);
  const remote = {
    ...localServer,
    requestIP: () => ({ address: "10.0.0.9" }),
  } as unknown as Server<undefined>;
  expect((await read("", undefined, remote)).status).toBe(403);
  expect((await acknowledge({ consumer: "a", id: 1 }, {})).status).toBe(415);
  expect(
    (
      await acknowledge(
        { consumer: "a", id: 1 },
        { "content-type": "application/json", origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await acknowledge(
        { consumer: "a", id: 1 },
        { "content-type": "application/json", origin: "http://localhost:7400" },
      )
    ).status,
  ).toBe(200);
});

test("long poll returns backlog at once, wakes on a new item, ignores unrelated messages and times out", async () => {
  const timeouts: number[] = [];
  const server = {
    ...localServer,
    timeout: (_: Request, s: number) => timeouts.push(s),
  } as unknown as Server<undefined>;
  const first = await item();
  let started = Date.now();
  expect((await (await read("?wait=60", undefined, server)).json()).items).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(timeouts[0]).toBeGreaterThan(60);

  const pending = read(`?after=${first}&wait=5`);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Bun.sleep(20);
  const run = store.getRun(store.readFeed({ after: 0 }).items[0]?.runId ?? "");
  store.updateRun(run?.id ?? "", { title: "renamed" });
  store.subscribe(() => undefined)();
  await Bun.sleep(20);
  expect(settled).toBe(false);
  started = Date.now();
  const second = await item("second");
  const woke = (await (await pending).json()) as FeedPage;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(woke.items.map((i) => i.id)).toEqual([second]);

  started = Date.now();
  expect(await page(`?after=${second}&wait=0.05`)).toEqual({
    items: [],
    nextAfter: second,
    pruned: false,
    hasMore: false,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  expect(listeners()).toBe(0);
});

test("starting from now snapshots issued history without acknowledging or waiting", async () => {
  expect(await page("?consumer=fresh&from=now")).toEqual({
    items: [],
    nextAfter: 0,
    pruned: false,
    hasMore: false,
  });
  const first = await item("first");
  store.ackFeed("worker", first);
  const newest = await item("second");
  store.pruneFeed(Date.now() + 1);
  const snapshot = await page("?consumer=worker&from=now&wait=60");
  expect(snapshot).toEqual({ items: [], nextAfter: newest, pruned: false, hasMore: false });
  expect(store.feedCursor("worker")).toBe(first);
  const later = await item("later");
  expect((await page(`?consumer=worker&after=${snapshot.nextAfter}`)).items.map((i) => i.id)).toEqual([
    later,
  ]);
  expect((await read("?from=now&after=0")).status).toBe(400);
});

test("repository filtering precedes pagination and hasMore, and uses an exact match", async () => {
  const ids: number[] = [];
  for (const repo of ["owner/one", "owner/one-extra", "owner/two", "owner/one", "owner/two"]) {
    ids.push(await item(repo));
    store.db.query("UPDATE feed SET repo = ? WHERE id = ?").run(repo, ids.at(-1) ?? -1);
  }
  const first = await page("?repo=owner%2Fone&limit=1");
  expect(first).toMatchObject({
    items: [{ id: ids[0], repo: "owner/one" }],
    nextAfter: ids[0],
    hasMore: true,
  });
  const second = await page(`?repo=owner%2Fone&limit=1&after=${first.nextAfter}`);
  expect(second).toMatchObject({
    items: [{ id: ids[3], repo: "owner/one" }],
    nextAfter: ids[3],
    hasMore: false,
  });
  expect((await page(`?repo=owner%2Fone&after=${second.nextAfter}`)).items).toEqual([]);
  expect((await page("?repo=owner%2Fmissing")).hasMore).toBe(false);
});

test("a clamped long poll preserves filters and ignores unrelated feed items", async () => {
  const repo = store.upsertRepo({
    slug: "owner/one",
    kind: "github",
    url: "https://example.test/one",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const other = store.createRun(repo, {
    repo: repo.slug,
    prompt: "other",
    source: "mcp",
    requestedBy: "other",
  });
  const mine = store.createRun(repo, {
    repo: repo.slug,
    prompt: "mine",
    source: "mcp",
    requestedBy: "worker",
  });
  const pending = read("?after=100000&consumer=worker&ownRuns=true&repo=owner%2Fone&wait=30");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await item("unrelated repo");
  store.updateRun(other.id, { status: "failed" });
  await Promise.resolve();
  expect(settled).toBe(false);
  store.updateRun(mine.id, { status: "failed" });
  const result = (await (await pending).json()) as FeedPage;
  expect(result.items).toMatchObject([{ runId: mine.id, repo: "owner/one" }]);
  expect(result.items).toHaveLength(1);
  expect(store.feedCursor("worker")).toBe(0);
});

test("an item committed while the wait is being set up still wakes it", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  const original = store.readFeed.bind(store);
  let reads = 0;
  // Commit an item right after the first read, before the wait has armed its timer.
  store.readFeed = (opts) => {
    const result = original(opts);
    if (reads++ === 0) store.updateRun(run.id, { status: "failed" });
    return result;
  };
  const started = Date.now();
  const result = await page("?wait=30");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result.items.map((i) => i.kind)).toEqual(["run.failed"]);
  expect(reads).toBe(2);
});

test("aborting a long poll releases its listener and timer", async () => {
  const controller = new AbortController();
  const pending = read("?wait=30", { signal: controller.signal });
  await Bun.sleep(10);
  expect(listeners()).toBe(1);
  controller.abort();
  await pending;
  expect(listeners()).toBe(0);
});

test("committed items are published on the global SSE stream", async () => {
  const controller = new AbortController();
  const res = await stream(
    requestWithParams("http://localhost:7400/api/stream", { signal: controller.signal }),
    localServer,
  );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const id = await item();
  let text = "";
  let message: StreamMessage | undefined;
  while (!message) {
    const chunk = await reader.read();
    text += decoder.decode(chunk.value, { stream: true });
    message = text
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.slice(6)) as StreamMessage)
      .find((m) => m.kind === "feed");
  }
  controller.abort();
  expect(message).toEqual({ kind: "feed", item: store.readFeed({ after: id - 1 }).items[0] as never });
});
