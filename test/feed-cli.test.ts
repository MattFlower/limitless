import { expect, test } from "bun:test";
import { join } from "node:path";
import { ApiError, feedCommand, pollFeed } from "../src/cli/feed.ts";
import type { FeedItem, FeedPage } from "../src/core/types.ts";

const feedItem = (id: number): FeedItem => ({
  id,
  ts: 1,
  kind: "run.failed",
  runId: "r1",
  evalId: null,
  repo: "o/r",
  title: `Run failed: task ${id}`,
  summary: "gates failed",
  data: { status: "failed" },
});

test("long polling retries connection errors and 5xx after daemon restarts with backoff", async () => {
  let clock = 0;
  const delays: number[] = [];
  const waits: string[] = [];
  const api = async <T>(path: string): Promise<T> => {
    waits.push(new URL(path, "http://x").searchParams.get("wait") ?? "");
    if (waits.length === 1) throw new ApiError("connection refused");
    if (waits.length === 2) throw new ApiError("unavailable", 503);
    return { items: [feedItem(5)], nextAfter: 5, pruned: false } as T;
  };
  const page = await pollFeed(
    { after: 4, waitS: 10 },
    api,
    () => clock,
    async (ms) => {
      delays.push(ms);
      clock += ms;
    },
  );
  expect(page.items).toEqual([feedItem(5)]);
  expect(delays).toEqual([1000, 2000]);
  expect(waits).toEqual(["10", "9", "7"]);
});

test("a wait that never reaches the daemon fails with the last error instead of inventing a cursor", async () => {
  let clock = 0;
  const api = async <T>(): Promise<T> => {
    throw new ApiError("connection refused");
  };
  await expect(
    pollFeed(
      { consumer: "orchestrator", waitS: 5 },
      api,
      () => clock,
      async (ms) => {
        clock += ms;
      },
    ),
  ).rejects.toThrow("connection refused");
});

test("retry backoff caps at 15 s and the total deadline returns the last cursor and pruning notice", async () => {
  let clock = 0;
  let calls = 0;
  const delays: number[] = [];
  const api = async <T>(): Promise<T> => {
    if (++calls === 1) return { items: [], nextAfter: 4, pruned: true } as T;
    throw new ApiError("unavailable", 500);
  };
  expect(
    await pollFeed(
      { waitS: 50 },
      api,
      () => clock,
      async (ms) => {
        delays.push(ms);
        clock += ms;
      },
    ),
  ).toEqual({ items: [], nextAfter: 4, pruned: true });
  expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 5000]);
  expect(clock).toBe(50_000);
  expect(calls).toBe(8);
});

test("other errors and reads without a wait fail immediately", async () => {
  for (const [error, waitS] of [
    [new ApiError("bad request", 400), 10],
    [new ApiError("unauthorized", 401), 10],
    [new SyntaxError("invalid JSON"), 10],
    [new ApiError("connection refused"), 0],
  ] as const) {
    let calls = 0;
    await expect(
      pollFeed(
        { waitS },
        async () => {
          calls++;
          throw error;
        },
        () => 0,
        async () => {
          throw new Error("unexpected sleep");
        },
      ),
    ).rejects.toThrow(error.message);
    expect(calls).toBe(1);
  }
});

/** A fake daemon whose long polls take the full requested wait on an injected clock. */
function fakeDaemon(pages: FeedPage[]) {
  let clock = 1_000_000;
  const requests: { path: string; init?: RequestInit }[] = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    requests.push({ path, ...(init ? { init } : {}) });
    if (path === "/api/feed/ack") return JSON.parse(String(init?.body)) as T;
    const query = new URL(path, "http://x").searchParams;
    const next = pages.shift() ?? { items: [], nextAfter: Number(query.get("after") ?? 0), pruned: false };
    if (!next.items.length) clock += Number(query.get("wait")) * 1000;
    return next as T;
  };
  const params = () => requests.map((r) => Object.fromEntries(new URL(r.path, "http://x").searchParams));
  return { api, now: () => clock, requests, params };
}

test("a long wait polls in requests of at most 60 s until a page has items", async () => {
  const daemon = fakeDaemon([
    { items: [], nextAfter: 4, pruned: true },
    { items: [], nextAfter: 4, pruned: false },
    { items: [feedItem(5)], nextAfter: 5, pruned: false },
  ]);
  const page = await pollFeed({ consumer: "orchestrator", waitS: 3600 }, daemon.api, daemon.now);
  expect(page).toEqual({ items: [feedItem(5)], nextAfter: 5, pruned: true });
  expect(daemon.params()).toEqual([
    { wait: "60", consumer: "orchestrator" },
    { wait: "60", consumer: "orchestrator", after: "4" },
    { wait: "60", consumer: "orchestrator", after: "4" },
  ]);
});

test("the total deadline bounds the final request; no wait reads once", async () => {
  const daemon = fakeDaemon([]);
  expect(await pollFeed({ after: 2, waitS: 150 }, daemon.api, daemon.now)).toEqual({
    items: [],
    nextAfter: 2,
    pruned: false,
  });
  expect(daemon.params().map((p) => p.wait)).toEqual(["60", "60", "30"]);
  const once = fakeDaemon([]);
  await pollFeed({ waitS: 0 }, once.api, once.now);
  expect(once.params()).toEqual([{ wait: "0" }]);
});

test("JSON output prints the envelope once; human output lists items and the pruning notice; reads never ack", async () => {
  const pages = (): FeedPage[] => [
    { items: [], nextAfter: 0, pruned: true },
    { items: [feedItem(1), feedItem(2)], nextAfter: 2, pruned: false },
  ];
  const json = fakeDaemon(pages());
  const out: string[] = [];
  await feedCommand([], { consumer: "o", wait: "3600", json: true }, { ...json, print: (l) => out.push(l) });
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0] ?? "")).toEqual({ items: [feedItem(1), feedItem(2)], nextAfter: 2, pruned: true });

  const human = fakeDaemon(pages());
  const lines: string[] = [];
  await feedCommand([], { consumer: "o", wait: "90" }, { ...human, print: (l) => lines.push(l) });
  const text = lines.join("\n");
  expect(text).toContain("pruned");
  expect(text).toContain("#2 run.failed  Run failed: task 2\n    gates failed");
  expect(text).not.toContain("\x1b[");
  expect([...json.requests, ...human.requests].some((r) => r.path.includes("ack"))).toBe(false);

  const acker = fakeDaemon([]);
  await feedCommand(["ack", "7"], { consumer: "o" }, { ...acker, print: () => undefined });
  expect(acker.requests).toEqual([
    { path: "/api/feed/ack", init: { method: "POST", body: JSON.stringify({ consumer: "o", id: 7 }) } },
  ]);
  for (const [rest, values] of [
    [["ack", "7"], {}],
    [["ack", "-1"], { consumer: "o" }],
    [["ack", "1.5"], { consumer: "o" }],
    [[], { wait: "" }],
    [[], { wait: "-1" }],
    [[], { wait: "soon" }],
    [[], { after: "x" }],
    [["extra"], {}],
  ] as const)
    await expect(feedCommand([...rest], values, { ...acker, print: () => undefined })).rejects.toThrow(
      "usage",
    );
});

test("the CLI binary waits through empty pages and prints parseable JSON", async () => {
  const seen: URLSearchParams[] = [];
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/feed/ack") {
        bodies.push(await req.json());
        return Response.json({ consumer: "orchestrator", id: 3 });
      }
      seen.push(url.searchParams);
      return Response.json(
        seen.length < 2
          ? { items: [], nextAfter: 2, pruned: false }
          : { items: [feedItem(3)], nextAfter: 3, pruned: false },
      );
    },
  });
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(["bun", "src/cli/main.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  try {
    const read = await cli("feed", "--consumer", "orchestrator", "--wait", "3600", "--json");
    expect(read).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(read.stdout)).toEqual({ items: [feedItem(3)], nextAfter: 3, pruned: false });
    expect(seen.map((q) => [q.get("consumer"), Number(q.get("wait")) <= 60, q.get("after")])).toEqual([
      ["orchestrator", true, null],
      ["orchestrator", true, "2"],
    ]);
    expect(await cli("feed", "ack", "3", "--consumer", "orchestrator")).toMatchObject({ exit: 0 });
    expect(bodies).toEqual([{ consumer: "orchestrator", id: 3 }]);
  } finally {
    server.stop();
  }
});

// The backoff schedule is tested above with an injected sleep; one real 5xx proves the binary's wiring.
test("the CLI binary retries a 5xx response and then prints items", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      ++calls === 1
        ? Response.json({ error: "restarting" }, { status: 503 })
        : Response.json({ items: [feedItem(1)], nextAfter: 1, pruned: false }),
  });
  try {
    const child = Bun.spawn(["bun", "src/cli/main.ts", "feed", "--wait", "10", "--json"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ items: [feedItem(1)], nextAfter: 1, pruned: false });
    expect(calls).toBe(2);
  } finally {
    server.stop();
  }
});
