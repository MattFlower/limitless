import { expect, test } from "bun:test";
import { join } from "node:path";
import { feedCommand, pollFeed } from "../src/cli/feed.ts";
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
