import { expect, jest, test } from "bun:test";
import { MAX_RUN_IDS, type QuotaAlert, type Run, type StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { openGlobalStream } from "../ui/api.ts";
import type { Timers } from "../ui/lib/catch-up.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { waitClock } from "./wait-clock.ts";

// ui/store.ts is a process-wide singleton; a query string gives each test its own instance.
const freshStore = async (tag: string) =>
  (await import(`../ui/store.ts?${tag}`)) as typeof import("../ui/store.ts");
const timers = (clock: ReturnType<typeof waitClock>): Timers => ({
  set: clock.timer.set as typeof setTimeout,
  clear: clock.timer.clear as typeof clearTimeout,
});

function runStates(prompt: string): { failed: Run; resolved: Run } {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const failed: Run = { ...store.createRun(repo, { repo: repo.slug, prompt }), status: "failed" };
    const resolution = { kind: "done_elsewhere" as const, ref: null, note: null, by: "human", at: 1 };
    return { failed, resolved: { ...failed, status: "resolved", resolution } };
  } finally {
    store.close();
  }
}

function liveDeps(
  listRuns: (opts?: { ids?: string[] }) => Promise<Run[]>,
  getAlerts: () => Promise<QuotaAlert[]> = async () => [],
) {
  const stream = { push: (_msg: StreamMessage) => {}, connected: (_connected: boolean) => {} };
  const deps = {
    listRuns,
    getProviders: async () => [],
    getAlerts,
    getHealth: async () => ({ ok: true, uptimeMs: 1, sha: "test", active: [], draining: false }),
    openGlobalStream: (push: (msg: StreamMessage) => void, connected: (connected: boolean) => void) => {
      stream.push = push;
      stream.connected = connected;
      return () => {};
    },
    poll: () => {},
  };
  return { stream, deps };
}

test("the first open fetches once, and a burst of reconnects catches up with one more fetch", async () => {
  const { failed, resolved } = runStates("Fix it");
  const clock = waitClock();
  let runs = [failed];
  let fetches = 0;
  const { stream, deps } = liveDeps(async () => {
    fetches++;
    return runs;
  });
  const { ensureLiveStore, live } = await freshStore("flaps");
  ensureLiveStore(deps, timers(clock));
  await clock.flush();
  // An error before the stream has ever opened is not a gap: the first load covers it.
  stream.connected(false);
  stream.connected(true);
  await clock.advance(1000);
  expect(fetches).toBe(1);

  runs = [resolved];
  for (let flap = 0; flap < 100; flap++) {
    stream.connected(false);
    stream.connected(true);
    await clock.advance(100);
  }
  await clock.advance(1000);
  expect(fetches).toBe(2);
  expect(live.connected()).toBe(true);
  expect(live.runs[failed.id]?.status).toBe("resolved");
});

test("after a gap, runs (including cached ones outside the window) and alerts catch up from REST", async () => {
  const recent = runStates("Recent work");
  const old = runStates("Old work");
  const alert: QuotaAlert = {
    provider: "claude",
    window: "5h",
    utilization: 0.9,
    resetsAt: null,
    severity: "warning",
    routing: "deprioritized",
    createdAt: 1,
  };
  const clock = waitClock();
  let window = [recent.failed];
  let oldRun = old.failed;
  let alerts = [alert];
  const { stream, deps } = liveDeps(
    async (opts) => (opts?.ids ? (opts.ids.includes(oldRun.id) ? [oldRun] : []) : window),
    async () => alerts,
  );
  const { ensureLiveStore, live } = await freshStore("gap");
  ensureLiveStore(deps, timers(clock));
  stream.connected(true);
  await clock.flush();
  // An update to a run older than the 200-run window arrives live.
  stream.push({ kind: "run", run: old.failed });
  expect(Object.keys(live.alerts)).toEqual(["claude:5h"]);

  stream.connected(false);
  expect(live.connected()).toBe(false);
  // All three changed while the stream was down, so no push arrived.
  window = [recent.resolved];
  oldRun = old.resolved;
  alerts = [];
  stream.connected(true);
  await clock.advance(250);
  expect(live.connected()).toBe(true);
  expect(live.runs[recent.failed.id]?.status).toBe("resolved");
  expect(live.runs[old.failed.id]?.status).toBe("resolved");
  expect(Object.keys(live.alerts)).toEqual([]);
});

test("every cached run outside the window is re-read, in sequential batches of at most 200", async () => {
  const { failed } = runStates("Old work");
  const old = Array.from({ length: MAX_RUN_IDS + 1 }, (_, i) => ({ ...failed, id: `old${i}`, createdAt: i }));
  const clock = waitClock();
  const batches: number[] = [];
  let reading = 0;
  let status: Run["status"] = "failed";
  const { stream, deps } = liveDeps(async (opts) => {
    if (!opts?.ids) return [];
    expect(reading).toBe(0);
    reading++;
    batches.push(opts.ids.length);
    await Promise.resolve();
    reading--;
    return old.filter((run) => opts.ids?.includes(run.id)).map((run) => ({ ...run, status }));
  });
  const { ensureLiveStore, live } = await freshStore("batches");
  ensureLiveStore(deps, timers(clock));
  stream.connected(true);
  await clock.flush();
  for (const run of old) stream.push({ kind: "run", run });

  stream.connected(false);
  status = "resolved";
  stream.connected(true);
  await clock.advance(250);
  await clock.flush();
  expect(batches).toEqual([MAX_RUN_IDS, 1]);
  expect(old.filter((run) => live.runs[run.id]?.status !== "resolved")).toEqual([]);
});

test("a catch-up never replaces a newer pushed run, and reconnects while it runs wait for it", async () => {
  const { failed, resolved } = runStates("Fix it");
  const clock = waitClock();
  const snapshots: PromiseWithResolvers<Run[]>[] = [];
  const { stream, deps } = liveDeps(async (opts) => {
    if (opts?.ids) return [];
    const snapshot = Promise.withResolvers<Run[]>();
    snapshots.push(snapshot);
    return snapshot.promise;
  });
  const { ensureLiveStore, live } = await freshStore("race");
  ensureLiveStore(deps, timers(clock));
  stream.connected(true);
  snapshots[0]?.resolve([failed]);
  await clock.flush();

  stream.connected(false);
  stream.connected(true);
  await clock.advance(250);
  expect(snapshots).toHaveLength(2);
  stream.push({ kind: "run", run: resolved });
  stream.connected(false);
  stream.connected(true);
  await clock.advance(250);
  expect(snapshots).toHaveLength(2);
  snapshots[1]?.resolve([failed]);
  await clock.flush();
  expect(live.runs[failed.id]?.status).toBe("resolved");

  // The gap that opened while that fetch ran gets one more.
  await clock.advance(250);
  expect(snapshots).toHaveLength(3);
  snapshots[2]?.resolve([resolved]);
  await clock.advance(1000);
  expect(snapshots).toHaveLength(3);
  expect(live.runs[failed.id]?.status).toBe("resolved");
});

test("the runs API re-reads specific runs by id", async () => {
  const f = await fixture();
  try {
    const store = f.factory.store;
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const create = (prompt: string) => store.createRun(repo, { repo: repo.slug, prompt });
    const first = create("one");
    create("two");
    const third = create("three");
    const list = (createHttpRoutes(f.factory)["/api/runs"] as { GET: Route }).GET;
    const response = await list(
      requestWithParams(`http://localhost:7400/api/runs?ids=${first.id},${third.id}&limit=2`),
      localServer,
    );
    const ids = ((await response.json()) as Run[]).map((run) => run.id).sort();
    expect(ids).toEqual([first.id, third.id].sort());
    const tooMany = Array.from({ length: MAX_RUN_IDS + 1 }, (_, i) => `r${i}`);
    for (const bad of [tooMany, [first.id, "not-a-run-id"]]) {
      const refused = await list(
        requestWithParams(`http://localhost:7400/api/runs?ids=${bad.join(",")}`),
        localServer,
      );
      expect(refused.status).toBe(400);
      expect(() => store.listRuns({ ids: bad })).toThrow("valid run ids");
    }
    expect(store.listRuns({ ids: tooMany.slice(0, MAX_RUN_IDS) })).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a stream the browser gives up on after an HTTP error is reopened; a closed one is not", () => {
  class FakeEventSource {
    static readonly CLOSED = 2;
    static opened: FakeEventSource[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) {
      FakeEventSource.opened.push(this);
    }
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }
  const source = (index: number) => {
    const found = FakeEventSource.opened[index];
    if (!found) throw new Error(`EventSource ${index} was not opened`);
    return found;
  };
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  jest.useFakeTimers();
  try {
    const states: boolean[] = [];
    const messages: StreamMessage[] = [];
    const close = openGlobalStream(
      (msg) => messages.push(msg),
      (connected) => states.push(connected),
    );
    source(0).onopen?.();
    // A dropped connection that the browser retries by itself.
    source(0).onerror?.();
    jest.advanceTimersByTime(10_000);
    expect(FakeEventSource.opened).toHaveLength(1);
    // A reverse proxy's 502 while the daemon restarts: the browser closes the stream for good.
    source(0).readyState = FakeEventSource.CLOSED;
    source(0).onerror?.();
    jest.advanceTimersByTime(3000);
    expect(source(1).url).toBe("/api/stream");
    source(1).onopen?.();
    const update: StreamMessage = {
      kind: "alert",
      alert: null,
      provider: "claude",
      window: "5h",
      created: false,
    };
    source(1).onmessage?.({ data: JSON.stringify(update) });
    expect(states).toEqual([true, false, false, true]);
    expect(messages).toEqual([update]);

    source(1).readyState = FakeEventSource.CLOSED;
    source(1).onerror?.();
    close();
    jest.advanceTimersByTime(10_000);
    expect(FakeEventSource.opened).toHaveLength(2);
  } finally {
    jest.useRealTimers();
    globalThis.EventSource = original;
  }
});
