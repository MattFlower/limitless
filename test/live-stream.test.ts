import { expect, jest, test } from "bun:test";
import type { QuotaAlert, Run, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { openGlobalStream } from "../ui/api.ts";

// ui/store.ts is a process-wide singleton; a query string gives each test its own instance.
const freshStore = async (tag: string) =>
  (await import(`../ui/store.ts?${tag}`)) as typeof import("../ui/store.ts");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function runStates(): { failed: Run; resolved: Run } {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo({
      slug: "MattFlower/limitless",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const failed: Run = { ...store.createRun(repo, { repo: repo.slug, prompt: "Fix it" }), status: "failed" };
    const resolution = { kind: "done_elsewhere" as const, ref: null, note: null, by: "human", at: 1 };
    return { failed, resolved: { ...failed, status: "resolved", resolution } };
  } finally {
    store.close();
  }
}

function liveDeps(listRuns: () => Promise<Run[]>, getAlerts: () => Promise<QuotaAlert[]> = async () => []) {
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

test("after a gap in the global stream, runs and alerts catch up from REST without a reload", async () => {
  const { failed, resolved } = runStates();
  const alert: QuotaAlert = {
    provider: "claude",
    window: "5h",
    utilization: 0.9,
    resetsAt: null,
    severity: "warning",
    routing: "deprioritized",
    createdAt: 1,
  };
  let runs = [failed];
  let alerts = [alert];
  const { stream, deps } = liveDeps(
    async () => runs,
    async () => alerts,
  );
  const { ensureLiveStore, live } = await freshStore("gap");
  ensureLiveStore(deps);
  stream.connected(true);
  await settle();
  expect(live.runs[failed.id]?.status).toBe("failed");
  expect(Object.keys(live.alerts)).toEqual(["claude:5h"]);

  stream.connected(false);
  expect(live.connected()).toBe(false);
  // Both changed while the stream was down, so neither push arrived.
  runs = [resolved];
  alerts = [];
  stream.connected(true);
  await settle();
  expect(live.connected()).toBe(true);
  expect(live.runs[failed.id]?.status).toBe("resolved");
  expect(Object.keys(live.alerts)).toEqual([]);
});

test("a REST snapshot never replaces a newer pushed run or a later snapshot", async () => {
  const { failed, resolved } = runStates();
  const snapshots: PromiseWithResolvers<Run[]>[] = [];
  const { stream, deps } = liveDeps(() => {
    const snapshot = Promise.withResolvers<Run[]>();
    snapshots.push(snapshot);
    return snapshot.promise;
  });
  const { ensureLiveStore, live } = await freshStore("race");
  ensureLiveStore(deps);
  stream.connected(true);
  snapshots[0]?.resolve([failed]);
  await settle();

  stream.connected(false);
  stream.connected(true);
  stream.push({ kind: "run", run: resolved });
  snapshots[1]?.resolve([failed]);
  await settle();
  expect(live.runs[failed.id]?.status).toBe("resolved");

  // Two quick reconnects: the first snapshot, taken earlier, resolves after the second.
  stream.connected(false);
  stream.connected(true);
  stream.connected(false);
  stream.connected(true);
  snapshots[3]?.resolve([resolved]);
  snapshots[2]?.resolve([failed]);
  await settle();
  expect(snapshots).toHaveLength(4);
  expect(live.runs[failed.id]?.status).toBe("resolved");
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
